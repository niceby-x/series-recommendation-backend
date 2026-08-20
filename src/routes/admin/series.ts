// src/routes/admin/series.ts -- edit/delete a published series, including
// tag/genre/curated-collection reassignment (admin only).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../../services/supabase';
import { requireAdmin } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';

const router = Router();

// status is a real, confirmed enum -- src/types.ts's Series interface
// declares exactly these three values, and the TMDB import script
// (src/scripts/discover-series-by-keyword.ts's mapStatus()) only ever
// produces 'airing'/'completed' from that same set, so this is safe to
// enforce strictly rather than just type-check. Without this, a bad value
// here previously surfaced as a raw Postgres CHECK-constraint error
// instead of a clean 400.
const SERIES_STATUS_VALUES = ['airing', 'completed', 'upcoming'] as const;

// S1-01: publish-workflow status -- see migrations/012_series_publish_status.sql
// for why this is a separate concept from SERIES_STATUS_VALUES above.
const PUBLISH_STATUS_VALUES = ['draft', 'published', 'archived'] as const;
const MEDIA_TYPE_VALUES = ['tv', 'movie'] as const;

// romance_pace/emotional_intensity/ending_type/content_level: allowed
// values per BLumi Taxonomy v1 (blumi-taxonomy-v1.md), §2.1-2.4 -- same
// enums as candidates.ts's taxonomy schema. Emotional Intensity and
// Content Level are legitimately nullable per the spec (blank means
// "genuinely unreviewed," not a default).
const ROMANCE_PACE_VALUES = ['slow_burn', 'natural_progression', 'instant_attraction', 'established_relationship'] as const;
const EMOTIONAL_INTENSITY_VALUES = ['lighthearted', 'balanced', 'emotionally_heavy'] as const;
const ENDING_TYPE_VALUES = ['happy', 'bittersweet', 'open', 'tragic'] as const;
const CONTENT_LEVEL_VALUES = ['sweet', 'mature'] as const;

const editSeriesSchema = z
    .object({
        title: z.string().trim().min(1).optional(),
        original_title: z.string().nullable().optional(),
        synopsis: z.string().nullable().optional(),
        country: z.string().trim().min(1).optional(),
        year: z.number().int().optional(),
        episode_count: z.number().int().nonnegative().optional(),
        status: z.enum(SERIES_STATUS_VALUES).optional(),
        publish_status: z.enum(PUBLISH_STATUS_VALUES).optional(),
        media_type: z.enum(MEDIA_TYPE_VALUES).optional(),
        poster_url: z.string().nullable().optional(),
        backdrop_url: z.string().nullable().optional(),
        romance_pace: z.enum(ROMANCE_PACE_VALUES).nullable().optional(),
        emotional_intensity: z.enum(EMOTIONAL_INTENSITY_VALUES).nullable().optional(),
        ending_type: z.enum(ENDING_TYPE_VALUES).nullable().optional(),
        content_level: z.enum(CONTENT_LEVEL_VALUES).nullable().optional(),
        tag_ids: z.array(z.number()).optional(),
        genre_names: z.array(z.string()).optional(),
        collection_ids: z.array(z.number()).optional(),
    })
    .strip();

// Route 18 - Edit a published series (admin only). Unlike candidate
// approval's `overrides`, this mutates a LIVE row directly -- there was
// previously no way to fix a typo, swap a wrong poster, or correct a
// field on anything already published. Every field is optional (only
// what's sent gets updated); genre_names, if present, is the COMPLETE
// desired genre list and gets diffed against what's currently linked
// (find-or-create each, same pattern as the approve route), not appended.
router.patch('/:id', validateBody(editSeriesSchema), async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const body = req.body || {};

    const editableFields = [
        'title', 'original_title', 'synopsis', 'country', 'year', 'episode_count', 'status',
        'publish_status', 'media_type', 'poster_url', 'backdrop_url', 'romance_pace',
        'emotional_intensity', 'ending_type', 'content_level',
    ] as const;

    const update: Record<string, unknown> = {};
    for (const field of editableFields) {
        if (body[field] !== undefined) update[field] = body[field];
    }

    // G3-01: bump episode_count_updated_at whenever episode_count actually
    // goes UP -- this is what the notifications bell (GET /me/notifications)
    // uses to detect "new episodes" on a watchlisted series. Only on an
    // increase, not any edit that happens to touch episode_count: a
    // correction down (fixing a miscount) or a same-value resave shouldn't
    // notify every watchlister the way a real new episode should.
    if (update.episode_count !== undefined) {
        const { data: existingSeries, error: existingSeriesError } = await supabase
            .from('series')
            .select('episode_count')
            .eq('id', id)
            .maybeSingle();

        if (existingSeriesError) {
            return res.status(500).json({ message: existingSeriesError.message });
        }

        const previousCount = existingSeries?.episode_count ?? null;
        if (previousCount !== null && (update.episode_count as number) > previousCount) {
            update.episode_count_updated_at = new Date().toISOString();
        }
    }

    // S1-01 (revised): a tag_ids/genre_names/collection_ids-only edit is
    // still an edit -- it should bump "Updated <date> / by <admin>" on the
    // admin table too, not just plain-field changes. hasArrayEdit checks
    // the raw body rather than the diff outcome below, since even a
    // no-op-in-practice diff (resubmitting the same set) still counts as
    // the admin having saved the form.
    const hasArrayEdit = Array.isArray(body.tag_ids) || Array.isArray(body.genre_names) || Array.isArray(body.collection_ids);

    if (Object.keys(update).length > 0 || hasArrayEdit) {
        // Stamps the admin table's "Updated <date> / by <admin>" column.
        // Added here (rather than unconditionally at the top) so a request
        // with zero editable fields AND no tag/genre/collection arrays --
        // the genuine no-op case -- still skips the update call entirely.
        update.updated_at = new Date().toISOString();
        update.updated_by = req.adminActor?.email ?? null;

        const { error: updateError } = await supabase
            .from('series')
            .update(update)
            .eq('id', id);

        if (updateError) {
            return res.status(500).json({ message: updateError.message });
        }
    }

    // Tag reassignment (mood/trope/relationship_dynamic/theme/content_warning):
    // unlike genres this points straight into the shared `tags` table by id,
    // so it's a diff-and-repoint rather than a find-or-create -- identical
    // logic to PATCH /admin/candidates/:id/taxonomy's tag_ids handling, just
    // against series_tags instead of series_candidate_tags. tag_ids, if
    // present, is the COMPLETE desired set across all dimensions.
    if (Array.isArray(body.tag_ids)) {
        const { data: existingTagLinks, error: fetchTagsError } = await supabase
            .from('series_tags')
            .select('tag_id')
            .eq('series_id', id);

        if (fetchTagsError) {
            return res.status(500).json({ message: fetchTagsError.message });
        }

        const existingTagIds = new Set((existingTagLinks || []).map((row) => row.tag_id));
        const desiredTagIds = new Set(body.tag_ids as number[]);

        const tagsToInsert = (body.tag_ids as number[]).filter((tagId) => !existingTagIds.has(tagId));
        const tagsToDelete = [...existingTagIds].filter((tagId) => !desiredTagIds.has(tagId));

        if (tagsToInsert.length > 0) {
            const { error: insertTagsError } = await supabase
                .from('series_tags')
                .insert(tagsToInsert.map((tagId) => ({ series_id: id, tag_id: tagId })));

            if (insertTagsError) {
                return res.status(500).json({ message: insertTagsError.message });
            }
        }

        if (tagsToDelete.length > 0) {
            const { error: deleteTagsError } = await supabase
                .from('series_tags')
                .delete()
                .eq('series_id', id)
                .in('tag_id', tagsToDelete);

            if (deleteTagsError) {
                return res.status(500).json({ message: deleteTagsError.message });
            }
        }
    }

    // Genre reassignment: find-or-create each named genre, then diff against
    // what's currently linked so this can both add and remove genres from an
    // existing series (not just append).
    if (Array.isArray(body.genre_names)) {
        const { data: existingLinks, error: existingLinksError } = await supabase
            .from('series_genres')
            .select('genre_id, genres (name)')
            .eq('series_id', id);

        if (existingLinksError) {
            return res.status(500).json({ message: existingLinksError.message });
        }

        const currentNames = new Set(
            (existingLinks || []).map((row: any) => row.genres?.name).filter(Boolean)
        );
        const desiredNames = new Set((body.genre_names as string[]).filter(Boolean));

        const namesToAdd = [...desiredNames].filter((name) => !currentNames.has(name));
        const linksToRemove = (existingLinks || []).filter(
            (row: any) => row.genres?.name && !desiredNames.has(row.genres.name)
        );

        for (const genreName of namesToAdd) {
            const { data: existingGenre } = await supabase
                .from('genres')
                .select('id')
                .eq('name', genreName)
                .maybeSingle();

            let genreId = existingGenre?.id;

            if (!genreId) {
                const { data: createdGenre, error: genreError } = await supabase
                    .from('genres')
                    .insert([{ name: genreName }])
                    .select('id')
                    .single();

                if (genreError || !createdGenre) {
                    console.error('Failed to create genre "' + genreName + '": ' + genreError?.message);
                    continue;
                }
                genreId = createdGenre.id;
            }

            const { error: linkError } = await supabase
                .from('series_genres')
                .insert([{ series_id: id, genre_id: genreId }]);

            if (linkError) {
                console.error('Failed to link genre "' + genreName + '": ' + linkError.message);
            }
        }

        for (const row of linksToRemove as any[]) {
            const { error: unlinkError } = await supabase
                .from('series_genres')
                .delete()
                .eq('series_id', id)
                .eq('genre_id', row.genre_id);

            if (unlinkError) {
                console.error('Failed to unlink genre id ' + row.genre_id + ': ' + unlinkError.message);
            }
        }
    }

    // Curated-collection membership: same diff-and-repoint approach as
    // genres/tags above, but scoped to is_curated collections only -- a
    // series can also sit in any number of individual users' personal
    // collections, and this admin screen must never touch those.
    if (Array.isArray(body.collection_ids)) {
        const { data: curatedCollections, error: curatedError } = await supabase
            .from('collections')
            .select('id')
            .eq('is_curated', true);

        if (curatedError) {
            return res.status(500).json({ message: curatedError.message });
        }

        const curatedIds = new Set((curatedCollections || []).map((c) => c.id));

        const { data: existingMemberships, error: fetchMembershipsError } = await supabase
            .from('collection_series')
            .select('collection_id')
            .eq('series_id', id)
            .in('collection_id', [...curatedIds]);

        if (fetchMembershipsError) {
            return res.status(500).json({ message: fetchMembershipsError.message });
        }

        const existingIds = new Set((existingMemberships || []).map((row) => row.collection_id));
        const desiredIds = new Set((body.collection_ids as number[]).filter((cid) => curatedIds.has(cid)));

        const toAdd = [...desiredIds].filter((cid) => !existingIds.has(cid));
        const toRemove = [...existingIds].filter((cid) => !desiredIds.has(cid));

        if (toAdd.length > 0) {
            const { error: insertError } = await supabase
                .from('collection_series')
                .insert(toAdd.map((collectionId) => ({ collection_id: collectionId, series_id: id })));
            if (insertError) {
                return res.status(500).json({ message: insertError.message });
            }
        }

        if (toRemove.length > 0) {
            const { error: removeError } = await supabase
                .from('collection_series')
                .delete()
                .eq('series_id', id)
                .in('collection_id', toRemove);
            if (removeError) {
                return res.status(500).json({ message: removeError.message });
            }
        }
    }

    res.status(200).json({ message: 'Series updated' });
});
// Route 19 - Permanently remove a published series (admin only). Cleans up
// every table that references series_id first -- link tables plus
// ratings/watchlist entries real users may have created -- rather than
// relying on ON DELETE CASCADE being configured (same caution as the
// candidate restore route above), so this can't fail partway with orphaned
// rows left behind or a foreign-key error on the final delete.
//
// S1-01: extracted out of the DELETE /:id handler below so POST /bulk's
// action: 'delete' can reuse the exact same cleanup-then-delete sequence
// per id, instead of a second copy of this table list drifting out of
// sync with this one over time.
async function deleteSeriesCascade(id: number): Promise<{ error: string | null }> {
    const cleanupTables = ['series_genres', 'series_cast', 'series_tags', 'ratings', 'user_lists', 'curator_picks', 'collection_series', 'series_rank_snapshots'];

    for (const table of cleanupTables) {
        const { error } = await supabase.from(table).delete().eq('series_id', id);
        if (error) {
            return { error: 'Failed to clean up ' + table + ': ' + error.message };
        }
    }

    const { error: deleteError } = await supabase.from('series').delete().eq('id', id);
    if (deleteError) {
        return { error: deleteError.message };
    }

    return { error: null };
}

router.delete('/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { error } = await deleteSeriesCascade(id);

    if (error) {
        return res.status(500).json({ message: error });
    }

    res.status(200).json({ message: 'Series deleted' });
});

// Route 20 - List series/movies for the admin Series & Movies table (S1-01).
// Deliberately a single unfiltered `select` followed by JS-side
// search/filter/sort/paginate, rather than pushing each param into the
// Supabase query the way GET /series does -- this catalog is admin-scale
// (currently ~100 titles), and doing it in JS means one query builds
// `counts` (the All/Series/Movies/Drafts/Published/Archived tab badges)
// and `filters` (the country/genre dropdown option lists) off the exact
// same full result set the request itself filters down from, with no risk
// of the two drifting out of sync across separate queries.
router.get('/', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { data, error } = await supabase
        .from('series')
        .select('id, title, media_type, country, year, episode_count, poster_url, status, publish_status, updated_at, updated_by, series_genres (genres (name))');

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    // Rows created before the TMDB import populated media_type on every row
    // (see types.ts's Series.media_type comment) fall back to 'tv' here --
    // treated as a Series, not a Movie, since that's what every title on
    // this catalog was before Movies existed as a concept.
    let rows = (data || []).map((row: any) => {
        const { series_genres, ...rest } = row;
        const genre_names = (series_genres || []).map((g: any) => g.genres?.name).filter(Boolean);
        return { ...rest, media_type: rest.media_type === 'movie' ? 'movie' : 'tv', genre_names };
    });

    // Tab counts computed off the FULL set, before this request's own
    // q/type/publish_status/country/genre filters are applied below --
    // same "counts don't collapse to zero just because you're already
    // filtered onto that tab" behavior as GET /admin/candidates' counts.
    const counts = {
        all: rows.length,
        series: rows.filter((r: any) => r.media_type === 'tv').length,
        movies: rows.filter((r: any) => r.media_type === 'movie').length,
        drafts: rows.filter((r: any) => r.publish_status === 'draft').length,
        published: rows.filter((r: any) => r.publish_status === 'published').length,
        archived: rows.filter((r: any) => r.publish_status === 'archived').length,
    };

    const filters = {
        countries: [...new Set(rows.map((r: any) => r.country).filter(Boolean))].sort() as string[],
        genres: [...new Set(rows.flatMap((r: any) => r.genre_names))].sort() as string[],
    };

    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const publishStatus = typeof req.query.publish_status === 'string' ? req.query.publish_status : undefined;
    const country = typeof req.query.country === 'string' ? req.query.country : undefined;
    const genre = typeof req.query.genre === 'string' ? req.query.genre : undefined;
    const sort = typeof req.query.sort === 'string' ? req.query.sort : 'updated_desc';
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 10));

    if (q) {
        rows = rows.filter((r: any) => r.title.toLowerCase().includes(q) || (r.country || '').toLowerCase().includes(q));
    }
    if (type === 'series') rows = rows.filter((r: any) => r.media_type === 'tv');
    if (type === 'movie') rows = rows.filter((r: any) => r.media_type === 'movie');
    if (publishStatus === 'draft' || publishStatus === 'published' || publishStatus === 'archived') {
        rows = rows.filter((r: any) => r.publish_status === publishStatus);
    }
    if (country) rows = rows.filter((r: any) => r.country === country);
    if (genre) rows = rows.filter((r: any) => (r.genre_names as string[]).includes(genre));

    const sorters: Record<string, (a: any, b: any) => number> = {
        updated_desc: (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
        updated_asc: (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime(),
        title_asc: (a, b) => a.title.localeCompare(b.title),
        title_desc: (a, b) => b.title.localeCompare(a.title),
        year_desc: (a, b) => (b.year ?? 0) - (a.year ?? 0),
        year_asc: (a, b) => (a.year ?? 0) - (b.year ?? 0),
    };
    rows = [...rows].sort(sorters[sort] || sorters.updated_desc);

    const total = rows.length;
    const paged = rows.slice((page - 1) * limit, (page - 1) * limit + limit);

    res.json({
        message: 'Admin series list',
        data: paged,
        pagination: { page, limit, total, has_more: page * limit < total },
        counts,
        filters,
    });
});

const bulkActionSchema = z
    .object({
        ids: z.array(z.number().int()).min(1, 'ids must be a non-empty array.'),
        action: z.enum(['publish', 'unpublish', 'archive', 'delete']),
    })
    .strip();

// Route 21 - Bulk publish/unpublish/archive/delete (admin only), backing
// the admin table's row-selection checkboxes + bulk-actions bar (S1-01).
// publish/unpublish/archive are a single `.in('id', ids)` update; delete
// loops deleteSeriesCascade per id since each one touches several
// dependent tables that a single bulk `.in()` delete can't clean up first.
router.post('/bulk', validateBody(bulkActionSchema), async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { ids, action } = req.body as { ids: number[]; action: 'publish' | 'unpublish' | 'archive' | 'delete' };

    if (action === 'delete') {
        for (const id of ids) {
            const { error } = await deleteSeriesCascade(id);
            if (error) {
                return res.status(500).json({ message: error });
            }
        }
        return res.status(200).json({ message: 'Deleted ' + ids.length + ' title(s)', data: { ids, action } });
    }

    const publishStatus = action === 'publish' ? 'published' : action === 'unpublish' ? 'draft' : 'archived';

    const { error } = await supabase
        .from('series')
        .update({
            publish_status: publishStatus,
            updated_at: new Date().toISOString(),
            updated_by: req.adminActor?.email ?? null,
        })
        .in('id', ids);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(200).json({ message: 'Updated ' + ids.length + ' title(s)', data: { ids, action, publish_status: publishStatus } });
});

export default router;
