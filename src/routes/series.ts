// src/routes/series.ts -- GET /series, GET /series/:id (public, no auth).

import { Router, Request, Response } from 'express';
import { supabase } from '../services/supabase';
import { Series, ApiResponse } from '../types';

const router = Router();

//Route 2 - Get ALL series
// series_tags -> tags joined in and flattened to a plain `tags` array per
// row (same flatten-the-join-table approach as the genre join below and
// the candidate tag_ids flattening) -- previously this route returned no
// mood/trope/etc. info at all, so the Moods and Tropes pages had nothing
// real to match series against and fell back to purely positional mock
// data. Purely additive: existing consumers that don't read `tags` are
// unaffected.
// Route 2 - Get all series (optionally paginated)
//
// Pagination is opt-in via `page`/`limit` query params rather than a
// forced default: 12 different frontend pages currently call this route
// expecting the full catalog back (they do their own client-side
// filtering/sorting over it), and none of them are in scope here -- so an
// unrequested default limit would silently truncate every one of those
// pages, which isn't something this task should do as a side effect.
// Passing `page`/`limit` genuinely paginates via Supabase's .range() and
// returns a `pagination` block; omitting them preserves today's full-list
// behavior exactly.
router.get('/', async (req: Request, res: Response) => {
    const hasPagination = req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 20));

    let query = supabase
        .from('series')
        .select('*, series_tags (tags (id, dimension, value_key, display_label, display_emoji)), series_genres (genres (name))', hasPagination ? { count: 'exact' } : {});

    if (hasPagination) {
        const from = (page - 1) * limit;
        const to = from + limit - 1;
        query = query.range(from, to);
    }

    const { data, error, count } = await query;

    if (error) {
        return res.status(500).json({ message: error.message});
    }

    // Curated-collection membership per series, for SeriesEditModal's
    // Collections picker (mirrors tag_ids/genre_names in spirit -- though
    // unlike those two, this is actually populated below rather than left
    // for the frontend to default to empty). Two small queries (curated
    // collection ids, then their memberships) rather than a nested filter
    // through the join table, since supabase-js can't filter a nested
    // relation's own relation in one .select() call.
    const { data: curatedCollections } = await supabase.from('collections').select('id').eq('is_curated', true);
    const curatedIds = (curatedCollections || []).map((c) => c.id);

    const collectionIdsBySeries = new Map<number, number[]>();
    if (curatedIds.length > 0) {
        const { data: memberships } = await supabase
            .from('collection_series')
            .select('series_id, collection_id')
            .in('collection_id', curatedIds);
        for (const row of memberships || []) {
            const list = collectionIdsBySeries.get(row.series_id) || [];
            list.push(row.collection_id);
            collectionIdsBySeries.set(row.series_id, list);
        }
    }

    // Real average_rating/rating_count per series, computed from actual
    // `ratings` rows -- same aggregation getCuratorPicksData() already does
    // for the homepage's Curator's Picks section. Previously nothing here
    // read the ratings table at all, so every card fell back to the
    // hardcoded REAL_TRENDING_OVERRIDES/mock rating helpers regardless of
    // what anyone had actually rated.
    const seriesIds = data.map((row: any) => row.id);
    const ratingsBySeries = new Map<number, number[]>();
    if (seriesIds.length > 0) {
        const { data: ratingsRows } = await supabase.from('ratings').select('series_id, score').in('series_id', seriesIds);
        for (const row of ratingsRows || []) {
            const list = ratingsBySeries.get(row.series_id) || [];
            list.push(row.score);
            ratingsBySeries.set(row.series_id, list);
        }
    }

    const flattened = data.map((row: any) => {
        const { series_tags, series_genres, ...rest } = row;
        const tags = (series_tags || []).map((t: any) => t.tags).filter(Boolean);
        const genre_names = (series_genres || []).map((g: any) => g.genres?.name).filter(Boolean);
        const scores = ratingsBySeries.get(row.id) || [];
        const average_rating = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        return {
            ...rest,
            tags,
            genre_names,
            collection_ids: collectionIdsBySeries.get(row.id) || [],
            average_rating,
            rating_count: scores.length,
        };
    });

    const response: ApiResponse<Series[]> & { pagination?: { page: number; limit: number; total: number; has_more: boolean } } = {
        message: 'List of BL Series',
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
    };

    res.json(response);
});
//Route 3 - Get ONE series by id
router.get('/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);

    // Genres joined in and flattened to a plain genre_names array (same
    // flattening approach as GET /admin/candidates does for tag_ids) --
    // previously this route returned no genre info at all, so nothing
    // in the app (including this endpoint's own consumers) could show a
    // series' genres. Purely additive: existing consumers that don't
    // read genre_names are unaffected.
    //
    // series_tags -> tags is joined the same way, exposed both as the full
    // `tags` objects (dimension/value_key/display_label/display_emoji, for
    // rendering on the public detail page) and as a flat `tag_ids` array
    // (mirrors series_candidates' tag_ids shape) so SeriesEditModal's tag
    // picker can reuse the exact same selected-ids-as-a-Set pattern the
    // candidates Taxonomy modal already uses.
    const { data, error } = await supabase
        .from('series')
        .select('*, series_genres (genres (name)), series_tags (tags (id, dimension, value_key, display_label, display_emoji))')
        .eq('id', id)
        .single();

    if (error) {
        return res.status(404).json({
            message: "Series not found",
            error
        });
    }

    const { series_genres, series_tags, ...rest } = data as any;
    const genre_names = (series_genres || []).map((row: any) => row.genres?.name).filter(Boolean);
    const tags = (series_tags || []).map((row: any) => row.tags).filter(Boolean);
    const tag_ids = tags.map((t: any) => t.id);

    // Real average_rating/rating_count for this series, same aggregation
    // as GET /series -- the detail page previously showed no rating at
    // all, since nothing anywhere read the `ratings` table back.
    const { data: ratingsRows } = await supabase.from('ratings').select('score').eq('series_id', id);
    const scores = (ratingsRows || []).map((r: any) => r.score);
    const average_rating = scores.length > 0 ? scores.reduce((a: number, b: number) => a + b, 0) / scores.length : null;
    const rating_count = scores.length;

    // Curated-collection membership, same flat-ids shape as tag_ids above,
    // for SeriesEditModal's Collections picker. Personal (non-curated)
    // collections are deliberately excluded -- this is the admin edit
    // screen, it should never surface or let anyone touch what's in some
    // individual user's own collection.
    const { data: curatedMemberships } = await supabase
        .from('collection_series')
        .select('collection_id, collections!inner (is_curated)')
        .eq('series_id', id)
        .eq('collections.is_curated', true);
    const collection_ids = (curatedMemberships || []).map((row: any) => row.collection_id);

    res.json({
        message: "Success",
        data: { ...rest, genre_names, tags, tag_ids, collection_ids, average_rating, rating_count }
    });
});

export default router;
