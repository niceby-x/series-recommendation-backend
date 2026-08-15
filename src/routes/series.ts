// src/routes/series.ts -- GET /series, GET /series/:id (public, no auth).

import { Router, Request, Response } from 'express';
import { supabase } from '../services/supabase';
import { Series, ApiResponse } from '../types';
import { getRankTrends } from '../services/rankSnapshots';
import { getRelatedSeries } from '../services/recommendations';

const router = Router();

//Route 2 - Get ALL series
// series_tags -> tags joined in and flattened to a plain `tags` array per
// row (same flatten-the-join-table approach as the genre join below and
// the candidate tag_ids flattening) -- previously this route returned no
// mood/trope/etc. info at all, so the Moods and Tropes pages had nothing
// real to match series against and fell back to purely positional mock
// data. Purely additive: existing consumers that don't read `tags` are
// unaffected.
// Route 2 - Get all series (optionally filtered, sorted, and paginated)
//
// D2-01: search/filter/sort moved server-side instead of the frontend's
// client-side .filter()/.sort() over whatever page happens to be loaded.
// Supported query params (all optional, all combine with AND):
//   q            -- case-insensitive substring match on title
//   country      -- exact match
//   genre        -- exact match against a series' genre_names
//   year_min / year_max   -- inclusive range on the year column (pass the
//                             same value to both for an exact-year match)
//   status       -- 'airing' | 'completed' | 'upcoming', exact match
//   episode_min / episode_max -- inclusive range on episode_count
//   rating_min   -- minimum average_rating (series with no ratings yet,
//                   average_rating: null, never match a rating_min filter)
//   sort         -- 'newest' | 'top_rated' | 'hidden_gems' | 'popular'
//                   (omit for a stable default order by id -- see D2-04)
//
// q/country/status/year_min/year_max/episode_min/episode_max, plus a
// sort=newest request, are all pushed into the Supabase query itself since
// they're real columns. genre, rating_min, and sort=top_rated/hidden_gems/
// popular depend on genre_names/average_rating/rank -- fields that only
// exist after this route's own join-flattening below -- so those are
// applied in JS afterward instead.
//
// This means pagination has to branch on whether any JS-only filter/sort
// is in play:
//   - none of them requested -> keep the original DB-level .range() +
//     count: 'exact' behavior exactly (one page fetched, not the table)
//   - genre / rating_min / a computed sort requested -> the DB can't
//     apply that filter/order itself, so this fetches the full
//     SQL-filtered set, filters/sorts it in JS, then paginates via
//     .slice() -- total/has_more are computed off that JS-filtered length
//
// Pagination itself stays opt-in via `page`/`limit`, same as before: other
// pages call this route expecting the full (now optionally filtered) list
// back, so an unrequested default limit would still silently truncate them.
router.get('/', async (req: Request, res: Response) => {
    const hasPagination = req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 20));

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const country = typeof req.query.country === 'string' ? req.query.country : undefined;
    const genre = typeof req.query.genre === 'string' ? req.query.genre : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const yearMin = req.query.year_min !== undefined ? parseInt(req.query.year_min as string) : undefined;
    const yearMax = req.query.year_max !== undefined ? parseInt(req.query.year_max as string) : undefined;
    const episodeMin = req.query.episode_min !== undefined ? parseInt(req.query.episode_min as string) : undefined;
    const episodeMax = req.query.episode_max !== undefined ? parseInt(req.query.episode_max as string) : undefined;
    const ratingMin = req.query.rating_min !== undefined ? parseFloat(req.query.rating_min as string) : undefined;
    const sort = typeof req.query.sort === 'string' ? req.query.sort : undefined;
    const computedSort = sort === 'top_rated' || sort === 'hidden_gems' || sort === 'popular';
    const needsJsPagination = !!genre || ratingMin !== undefined || computedSort;

    // P2-05: tags, genres, ratings, and curated-collection membership are
    // all pulled in as nested embeds on this one query, instead of the
    // four separate round trips this route used to make (main query +
    // curated-collection-ids query + collection_series-memberships query +
    // ratings query). collection_series -> series and
    // collection_series -> collections are both FK-backed (see
    // migrations/004_collections_tables.sql) -- same relationship
    // GET /series/:id below already embeds successfully, just walked from
    // the other direction (series -> collection_series -> collections
    // instead of collection_series -> collections directly), which is why
    // a single .select() can pull it in here too, filtered client-side to
    // is_curated afterward.
    let query = supabase
        .from('series')
        .select(
            `*,
            series_tags (tags (id, dimension, value_key, display_label, display_emoji)),
            series_genres (genres (name)),
            ratings (score),
            collection_series (collection_id, collections (is_curated))`,
            hasPagination && !needsJsPagination ? { count: 'exact' } : {}
        );

    if (q) query = query.ilike('title', `%${q}%`);
    if (country) query = query.eq('country', country);
    if (status) query = query.eq('status', status);
    if (yearMin !== undefined && !Number.isNaN(yearMin)) query = query.gte('year', yearMin);
    if (yearMax !== undefined && !Number.isNaN(yearMax)) query = query.lte('year', yearMax);
    if (episodeMin !== undefined && !Number.isNaN(episodeMin)) query = query.gte('episode_count', episodeMin);
    if (episodeMax !== undefined && !Number.isNaN(episodeMax)) query = query.lte('episode_count', episodeMax);
    if (sort === 'newest') {
        // 'year' alone isn't unique -- series sharing a year would still
        // have unstable relative order without a tiebreaker.
        query = query.order('year', { ascending: false }).order('id', { ascending: true });
    } else {
        // D2-04: previously no ORDER BY at all outside sort=newest, so the
        // .range() pagination below relied on Postgres's default row
        // order, which it does not guarantee to be stable across separate
        // queries -- under concurrent writes or table maintenance this
        // could skip or duplicate rows across pages. `id` is a real,
        // indexed, always-unique column, so it's a safe default order for
        // every other request shape (no sort param, or a JS-only sort like
        // top_rated/hidden_gems/popular that re-sorts after this query
        // anyway and just needs *some* stable base order to paginate a
        // consistent underlying set from).
        query = query.order('id', { ascending: true });
    }

    if (hasPagination && !needsJsPagination) {
        const from = (page - 1) * limit;
        const to = from + limit - 1;
        query = query.range(from, to);
    }

    const { data, error, count } = await query;

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    // H2-01: real week-over-week trend data, replacing the frontend's
    // hardcoded TRENDS array. A series with no snapshot yet (job never
    // run, or too new/unrated to have been ranked) gets rank: null,
    // rank_trend: null rather than a fabricated 'flat' -- callers should
    // treat null as "no trend data," not as "unchanged."
    const rankTrends = await getRankTrends();

    let flattened = data.map((row: any) => {
        const { series_tags, series_genres, ratings, collection_series, ...rest } = row;
        const tags = (series_tags || []).map((t: any) => t.tags).filter(Boolean);
        const genre_names = (series_genres || []).map((g: any) => g.genres?.name).filter(Boolean);
        const scores = (ratings || []).map((r: any) => r.score);
        const average_rating = scores.length > 0 ? scores.reduce((a: number, b: number) => a + b, 0) / scores.length : null;
        // Only curated collections belong in collection_ids here -- same
        // scope as the old two-query version (personal collections were
        // never included), just filtered in JS instead of a second query.
        const collection_ids = (collection_series || [])
            .filter((cs: any) => cs.collections?.is_curated)
            .map((cs: any) => cs.collection_id);
        const rankTrend = rankTrends.get(row.id);
        return {
            ...rest,
            tags,
            genre_names,
            collection_ids,
            average_rating,
            rating_count: scores.length,
            rank: rankTrend?.rank ?? null,
            rank_trend: rankTrend?.trend ?? null,
        };
    });

    // genre and rating_min depend on fields that only exist post-flatten
    // (genre_names, average_rating) -- can't be pushed into the Supabase
    // query above, so they're applied here instead.
    if (genre) {
        flattened = flattened.filter((row: any) => (row.genre_names || []).includes(genre));
    }
    if (ratingMin !== undefined && !Number.isNaN(ratingMin)) {
        flattened = flattened.filter((row: any) => row.average_rating !== null && row.average_rating >= ratingMin);
    }

    // 'newest' was already pushed into the SQL .order() above (real
    // column). 'top_rated'/'hidden_gems'/'popular' order by
    // average_rating/rank, both computed above, not real columns an
    // .order() call could reach, so those sort here instead. No `sort`
    // param falls through to the baseline `id` order added above (D2-04).
    if (sort === 'top_rated') {
        flattened = [...flattened].sort((a: any, b: any) => (b.average_rating ?? 0) - (a.average_rating ?? 0));
    } else if (sort === 'hidden_gems') {
        flattened = [...flattened].sort((a: any, b: any) => (a.average_rating ?? 0) - (b.average_rating ?? 0));
    } else if (sort === 'popular') {
        // Nulls (no rank-snapshot data yet) sort last, not first.
        flattened = [...flattened].sort((a: any, b: any) => {
            if (a.rank === null && b.rank === null) return 0;
            if (a.rank === null) return 1;
            if (b.rank === null) return -1;
            return a.rank - b.rank;
        });
    }

    // needsJsPagination: the DB couldn't filter/sort/paginate this request
    // itself (see above), so total/has_more come from the JS-filtered
    // array length and pagination is a .slice() over it. Otherwise this
    // mirrors the original behavior exactly: total comes from the DB's
    // exact count, and `data` is already just the one page Supabase's
    // own .range() returned.
    const paged = hasPagination && needsJsPagination
        ? flattened.slice((page - 1) * limit, (page - 1) * limit + limit)
        : flattened;
    const total = needsJsPagination ? flattened.length : (count ?? flattened.length);

    const response: ApiResponse<Series[]> & { pagination?: { page: number; limit: number; total: number; has_more: boolean } } = {
        message: 'List of BL Series',
        count: paged.length,
        data: paged,
        ...(hasPagination && {
            pagination: {
                page,
                limit,
                total,
                has_more: page * limit < total,
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

// Route 4 - Get series related to one series (Q2-02), for the "more like
// this" section on the detail page. Public, no auth -- reuses the same
// tag/genre overlap scoring as GET /me/recommendations (see
// services/recommendations.ts's getRelatedSeries), just seeded from this
// series' own tags/genres instead of a signed-in user's taste history.
router.get('/:id/related', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit as string) || 10));

    try {
        const data = await getRelatedSeries(id, limit);
        res.json({
            message: 'Related series',
            count: data.length,
            data,
        });
    } catch (err) {
        res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to load related series' });
    }
});

export default router;
