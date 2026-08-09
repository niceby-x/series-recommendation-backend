// src/routes/admin/series.ts -- edit/delete a published series, including
// tag/genre/curated-collection reassignment (admin only).

import { Router, Request, Response } from 'express';
import { supabase } from '../../services/supabase';
import { requireAdmin } from '../../middleware/auth';

const router = Router();

// Route 18 - Edit a published series (admin only). Unlike candidate
// approval's `overrides`, this mutates a LIVE row directly -- there was
// previously no way to fix a typo, swap a wrong poster, or correct a
// field on anything already published. Every field is optional (only
// what's sent gets updated); genre_names, if present, is the COMPLETE
// desired genre list and gets diffed against what's currently linked
// (find-or-create each, same pattern as the approve route), not appended.
router.patch('/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const body = req.body || {};

    const editableFields = [
        'title', 'original_title', 'synopsis', 'country', 'year', 'episode_count', 'status',
        'poster_url', 'backdrop_url', 'romance_pace', 'emotional_intensity', 'ending_type', 'content_level',
    ] as const;

    const update: Record<string, unknown> = {};
    for (const field of editableFields) {
        if (body[field] !== undefined) update[field] = body[field];
    }

    if (Object.keys(update).length > 0) {
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
router.delete('/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const cleanupTables = ['series_genres', 'series_cast', 'series_tags', 'ratings', 'user_lists', 'curator_picks', 'collection_series'];

    for (const table of cleanupTables) {
        const { error } = await supabase.from(table).delete().eq('series_id', id);
        if (error) {
            return res.status(500).json({ message: 'Failed to clean up ' + table + ': ' + error.message });
        }
    }

    const { error: deleteError } = await supabase.from('series').delete().eq('id', id);

    if (deleteError) {
        return res.status(500).json({ message: deleteError.message });
    }

    res.status(200).json({ message: 'Series deleted' });
});

export default router;
