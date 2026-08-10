// src/routes/admin/candidates.ts -- TMDB import candidate review queue:
// list/counts, taxonomy edits, approve/reject/restore (admin only).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../../services/supabase';
import { requireAdmin } from '../../middleware/auth';
import { logAdminAction } from '../../services/auditLog';
import { validateBody } from '../../middleware/validate';

const router = Router();

// Allowed values per BLumi Taxonomy v1 (blumi-taxonomy-v1.md), §2.1-2.4.
// Emotional Intensity and Content Level are legitimately nullable per the
// spec ("may be blank until Level 2... blank should mean genuinely
// unreviewed, never a defaulted value") -- Romance Pace and Ending Type
// are Level 1 "required," but that's a publish-readiness rule, not a
// constraint on this PATCH endpoint itself (a partial update may
// legitimately not touch them), so all four stay optional here too.
const ROMANCE_PACE_VALUES = ['slow_burn', 'natural_progression', 'instant_attraction', 'established_relationship'] as const;
const EMOTIONAL_INTENSITY_VALUES = ['lighthearted', 'balanced', 'emotionally_heavy'] as const;
const ENDING_TYPE_VALUES = ['happy', 'bittersweet', 'open', 'tragic'] as const;
const CONTENT_LEVEL_VALUES = ['sweet', 'mature'] as const;

const candidateTaxonomySchema = z
    .object({
        romance_pace: z.enum(ROMANCE_PACE_VALUES).nullable().optional(),
        emotional_intensity: z.enum(EMOTIONAL_INTENSITY_VALUES).nullable().optional(),
        ending_type: z.enum(ENDING_TYPE_VALUES).nullable().optional(),
        content_level: z.enum(CONTENT_LEVEL_VALUES).nullable().optional(),
        tag_ids: z.array(z.number()).optional(),
    })
    .strip();

// Route 9 - List TMDB import candidates by review status (admin only).
// Defaults to 'pending'; pass ?status=approved or ?status=rejected for the history views.
// A2-03: pagination is opt-in via page/limit, same convention P2-04 used for
// GET /series -- omitting them preserves today's full-queue-in-one-shot
// behavior exactly, since it's not known here whether every admin caller of
// this route has been updated to expect a paginated shape.
router.get('/', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const validStatuses = ['pending', 'approved', 'rejected'];
    const statusParam = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const status = validStatuses.includes(statusParam) ? statusParam : 'pending';

    const hasPagination = req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 20));

    // Pending candidates are shown oldest-first (a queue to work through);
    // approved/rejected history is shown most-recent-first (what you just did).
    const ascending = status === 'pending';

    let query = supabase
        .from('series_candidates')
        .select('*, series_candidate_tags (tag_id)', hasPagination ? { count: 'exact' } : {})
        .eq('review_status', status)
        .order('created_at', { ascending });

    if (hasPagination) {
        const from = (page - 1) * limit;
        const to = from + limit - 1;
        query = query.range(from, to);
    }

    const { data, error, count } = await query;

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    // Flatten the joined tag rows into a plain tag_ids array — the nested
    // series_candidate_tags shape is a Supabase/Postgres join artifact,
    // not something the frontend should need to know about.
    const flattened = data.map((row: any) => {
        const { series_candidate_tags, ...rest } = row;
        return { ...rest, tag_ids: (series_candidate_tags || []).map((t: any) => t.tag_id) };
    });

    res.json({
        message: status.charAt(0).toUpperCase() + status.slice(1) + ' candidates',
        count: flattened.length,
        data: flattened,
        ...(hasPagination && {
            pagination: {
                page,
                limit,
                total: count ?? flattened.length,
                has_more: page * limit < (count ?? 0),
            },
        }),
    });
});
// Route 9b - Lightweight counts for all three review statuses at once (admin only).
// Uses count-only queries (head: true) so this stays cheap even with a large queue.
router.get('/counts', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const [pending, approved, rejected] = await Promise.all([
        supabase.from('series_candidates').select('*', { count: 'exact', head: true }).eq('review_status', 'pending'),
        supabase.from('series_candidates').select('*', { count: 'exact', head: true }).eq('review_status', 'approved'),
        supabase.from('series_candidates').select('*', { count: 'exact', head: true }).eq('review_status', 'rejected'),
    ]);

    if (pending.error || approved.error || rejected.error) {
        return res.status(500).json({
            message: pending.error?.message || approved.error?.message || rejected.error?.message
        });
    }

    res.json({
        message: 'Candidate counts',
        pending: pending.count || 0,
        approved: approved.count || 0,
        rejected: rejected.count || 0,
    });
});
// Route 9f - Save a candidate's taxonomy (Curated Attributes + Discovery Tags) (admin only).
// Persists immediately, independent of approve/reject — this is what lets curation happen
// progressively across sessions, per BLumi Taxonomy v1. Body: { romance_pace?, emotional_intensity?,
// ending_type?, content_level?, tag_ids?: number[] }. tag_ids, if present, is the COMPLETE
// desired set of tag ids across all 5 Discovery Tag dimensions — this route diffs against
// what's currently linked rather than requiring the client to compute the diff.
router.patch('/:id/taxonomy', validateBody(candidateTaxonomySchema), async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { romance_pace, emotional_intensity, ending_type, content_level, tag_ids } = req.body;

    const attributeUpdate: Record<string, unknown> = {};
    if (romance_pace !== undefined) attributeUpdate.romance_pace = romance_pace;
    if (emotional_intensity !== undefined) attributeUpdate.emotional_intensity = emotional_intensity;
    if (ending_type !== undefined) attributeUpdate.ending_type = ending_type;
    if (content_level !== undefined) attributeUpdate.content_level = content_level;
    // content_level intentionally has no default fallback — a client-sent `null` is a
    // deliberate "needs review" state (per Taxonomy v1 §2.4), not an error to correct.

    if (Object.keys(attributeUpdate).length > 0) {
        const { error: attrError } = await supabase
            .from('series_candidates')
            .update(attributeUpdate)
            .eq('id', id);

        if (attrError) {
            return res.status(500).json({ message: attrError.message });
        }
    }

    if (Array.isArray(tag_ids)) {
        const { data: existing, error: fetchError } = await supabase
            .from('series_candidate_tags')
            .select('tag_id')
            .eq('candidate_id', id);

        if (fetchError) {
            return res.status(500).json({ message: fetchError.message });
        }

        const existingIds = new Set((existing || []).map((row) => row.tag_id));
        const desiredIds = new Set(tag_ids as number[]);

        const toInsert = (tag_ids as number[]).filter((tagId) => !existingIds.has(tagId));
        const toDelete = [...existingIds].filter((tagId) => !desiredIds.has(tagId));

        if (toInsert.length > 0) {
            const { error: insertError } = await supabase
                .from('series_candidate_tags')
                .insert(toInsert.map((tagId) => ({ candidate_id: id, tag_id: tagId })));

            if (insertError) {
                return res.status(500).json({ message: insertError.message });
            }
        }

        if (toDelete.length > 0) {
            const { error: deleteError } = await supabase
                .from('series_candidate_tags')
                .delete()
                .eq('candidate_id', id)
                .in('tag_id', toDelete);

            if (deleteError) {
                return res.status(500).json({ message: deleteError.message });
            }
        }
    }

    res.status(200).json({ message: 'Taxonomy saved' });
});
// Route 10 - Approve a candidate: copies it into `series`, marks it approved (admin only).
// Accepts optional field overrides in the request body (title, original_title, country,
// year, episode_count, status, synopsis) so corrections made during review are saved —
// both on the series_candidates record itself and on the series row it creates.
router.post('/:id/approve', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const overrides = req.body || {};

    const { data: candidate, error: fetchError } = await supabase
        .from('series_candidates')
        .select('*')
        .eq('id', id)
        .single();

    if (fetchError || !candidate) {
        return res.status(404).json({ message: 'Candidate not found' });
    }

    const finalValues = {
        title: overrides.title ?? candidate.title,
        original_title: overrides.original_title ?? candidate.original_title,
        synopsis: overrides.synopsis ?? candidate.synopsis,
        country: overrides.country ?? candidate.country,
        year: overrides.year ?? candidate.year,
        episode_count: overrides.episode_count ?? candidate.episode_count,
        status: overrides.status ?? candidate.status,
        romance_pace: overrides.romance_pace ?? candidate.romance_pace,
        emotional_intensity: overrides.emotional_intensity ?? candidate.emotional_intensity,
        ending_type: overrides.ending_type ?? candidate.ending_type,
        content_level: overrides.content_level ?? candidate.content_level,
    };

    // NOTE: Taxonomy v1 Level 1 fields (Romance Pace, Ending Type, Mood/Trope/
    // Relationship Dynamics tags) are NOT required to approve a candidate. A title
    // can go live with just its Core Metadata (title, genres, cast, synopsis) and
    // simply won't surface in mood/trope-based discovery until tagged — it stays
    // browsable by title/genre/country in the meantime. Curation Level exists as an
    // admin-visible signal of what's missing, not a publish gate. This was
    // deliberately relaxed from an earlier hard-block version once the pending
    // queue reached ~300 titles and manual per-title tagging became the bottleneck
    // for approving anything at all.

    const { data: newSeries, error: insertError } = await supabase
        .from('series')
        .insert([{
            title: finalValues.title,
            original_title: finalValues.original_title,
            synopsis: finalValues.synopsis,
            country: finalValues.country,
            year: finalValues.year,
            episode_count: finalValues.episode_count,
            status: finalValues.status,
            romance_pace: finalValues.romance_pace,
            emotional_intensity: finalValues.emotional_intensity,
            ending_type: finalValues.ending_type,
            content_level: finalValues.content_level,
            poster_url: candidate.poster_url,
            backdrop_url: candidate.backdrop_url,
            tmdb_id: candidate.tmdb_id,
            is_animated: candidate.is_animated,
            number_of_seasons: candidate.number_of_seasons,
            media_type: candidate.media_type,
        }])
        .select('id')
        .single();

    if (insertError || !newSeries) {
        return res.status(500).json({ message: insertError?.message || 'Failed to create series' });
    }

    // Link genres: find-or-create each by name, then link via series_genres.
    // Failures here are logged but don't block the approval — the series itself is already saved.
    for (const genreName of (candidate.genre_names || [])) {
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
            .insert([{ series_id: newSeries.id, genre_id: genreId }]);

        if (linkError) {
            console.error('Failed to link genre "' + genreName + '": ' + linkError.message);
        }
    }

    // Link cast: find-or-create each cast member by name, then link via series_cast.
    // First two cast entries (TMDB's own billing order) are marked as leads.
    const castList = (candidate.cast_json || []) as { name: string; character: string; photo_url: string | null }[];

    for (let i = 0; i < castList.length; i++) {
        const castEntry = castList[i];

        const { data: existingCast } = await supabase
            .from('cast_members')
            .select('id')
            .eq('name', castEntry.name)
            .maybeSingle();

        let castMemberId = existingCast?.id;

        if (!castMemberId) {
            const { data: createdCast, error: castError } = await supabase
                .from('cast_members')
                .insert([{ name: castEntry.name, photo_url: castEntry.photo_url, bio: null }])
                .select('id')
                .single();

            if (castError || !createdCast) {
                console.error('Failed to create cast member "' + castEntry.name + '": ' + castError?.message);
                continue;
            }
            castMemberId = createdCast.id;
        }

        const { error: castLinkError } = await supabase
            .from('series_cast')
            .insert([{
                series_id: newSeries.id,
                cast_member_id: castMemberId,
                role_name: castEntry.character || null,
                is_lead: i < 2,
            }]);

        if (castLinkError) {
            console.error('Failed to link cast member "' + castEntry.name + '": ' + castLinkError.message);
        }
    }

    // Copy taxonomy tags: unlike genres/cast, tag_ids already point into the shared
    // `tags` table, so this is a straight copy — no find-or-create needed.
    const { error: candidateTagsForCopyError, data: tagsToCopy } = await supabase
        .from('series_candidate_tags')
        .select('tag_id')
        .eq('candidate_id', id);

    if (candidateTagsForCopyError) {
        console.error('Failed to fetch candidate tags for copy: ' + candidateTagsForCopyError.message);
    } else if (tagsToCopy && tagsToCopy.length > 0) {
        const { error: tagCopyError } = await supabase
            .from('series_tags')
            .insert(tagsToCopy.map((row) => ({ series_id: newSeries.id, tag_id: row.tag_id })));

        if (tagCopyError) {
            console.error('Failed to copy tags to series ' + newSeries.id + ': ' + tagCopyError.message);
        }
    }

    const { error: updateError } = await supabase
        .from('series_candidates')
        .update({ ...finalValues, review_status: 'approved' })
        .eq('id', id);

    if (updateError) {
        return res.status(500).json({ message: updateError.message });
    }

    await logAdminAction(req, 'candidate.approve', 'candidate:' + id);

    res.status(200).json({ message: 'Approved and added to catalog' });
});
// Route 11 - Reject a candidate (admin only). A1-02: if it was previously
// approved, this also removes the corresponding row from `series` first --
// same as restore below -- so a rejected candidate can't leave an orphaned,
// unreviewable title live in the public catalog.
router.post('/:id/reject', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { data: candidate, error: fetchError } = await supabase
        .from('series_candidates')
        .select('*')
        .eq('id', id)
        .single();

    if (fetchError || !candidate) {
        return res.status(404).json({ message: 'Candidate not found' });
    }

    if (candidate.review_status === 'approved') {
        const { data: seriesRow } = await supabase
            .from('series')
            .select('id')
            .eq('tmdb_id', candidate.tmdb_id)
            .maybeSingle();

        if (seriesRow) {
            // Same cleanupTables pattern as restore below and DELETE
            // /admin/series/:id -- clean up every table that references
            // series_id before the delete, rather than relying on
            // ON DELETE CASCADE being configured.
            const cleanupTables = ['series_genres', 'series_cast', 'series_tags', 'ratings', 'user_lists', 'curator_picks', 'collection_series'];

            for (const table of cleanupTables) {
                const { error: cleanupError } = await supabase
                    .from(table)
                    .delete()
                    .eq('series_id', seriesRow.id);

                if (cleanupError) {
                    return res.status(500).json({ message: 'Failed to clean up ' + table + ': ' + cleanupError.message });
                }
            }
        }

        const { error: deleteError } = await supabase
            .from('series')
            .delete()
            .eq('tmdb_id', candidate.tmdb_id);

        if (deleteError) {
            return res.status(500).json({ message: deleteError.message });
        }
    }

    const { error: updateError } = await supabase
        .from('series_candidates')
        .update({ review_status: 'rejected' })
        .eq('id', id);

    if (updateError) {
        return res.status(500).json({ message: updateError.message });
    }

    await logAdminAction(req, 'candidate.reject', 'candidate:' + id);

    res.status(200).json({ message: 'Rejected' });
});
// Route 12 - Restore a candidate back to pending (admin only).
// If it was approved, this also removes the corresponding row from `series` first,
// so the catalog stays in sync with what's actually still approved.
router.post('/:id/restore', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { data: candidate, error: fetchError } = await supabase
        .from('series_candidates')
        .select('*')
        .eq('id', id)
        .single();

    if (fetchError || !candidate) {
        return res.status(404).json({ message: 'Candidate not found' });
    }

    if (candidate.review_status === 'approved') {
        const { data: seriesRow } = await supabase
            .from('series')
            .select('id')
            .eq('tmdb_id', candidate.tmdb_id)
            .maybeSingle();

        if (seriesRow) {
            // A1-01: clean up every table that references series_id first --
            // link tables plus ratings/watchlist/curator/collection rows real
            // users may have created -- rather than relying on ON DELETE CASCADE
            // being configured. Same cleanupTables pattern as DELETE
            // /admin/series/:id, so a series with real engagement can't hard-fail
            // this restore with a raw Postgres FK-violation error.
            const cleanupTables = ['series_genres', 'series_cast', 'series_tags', 'ratings', 'user_lists', 'curator_picks', 'collection_series'];

            for (const table of cleanupTables) {
                const { error: cleanupError } = await supabase
                    .from(table)
                    .delete()
                    .eq('series_id', seriesRow.id);

                if (cleanupError) {
                    return res.status(500).json({ message: 'Failed to clean up ' + table + ': ' + cleanupError.message });
                }
            }
        }

        const { error: deleteError } = await supabase
            .from('series')
            .delete()
            .eq('tmdb_id', candidate.tmdb_id);

        if (deleteError) {
            return res.status(500).json({ message: deleteError.message });
        }
    }

    const { error: updateError } = await supabase
        .from('series_candidates')
        .update({ review_status: 'pending' })
        .eq('id', id);

    if (updateError) {
        return res.status(500).json({ message: updateError.message });
    }

    await logAdminAction(req, 'candidate.restore', 'candidate:' + id);

    res.status(200).json({ message: 'Restored to pending' });
});

export default router;
