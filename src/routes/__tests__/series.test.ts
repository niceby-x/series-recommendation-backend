// src/routes/__tests__/series.test.ts
//
// P2-05: GET /series had zero coverage before this. These tests lock in
// the flattening logic added when the four separate round trips (main +
// curated-collection-ids + memberships + ratings) were collapsed into one
// query with nested embeds -- tags, genre_names, average_rating/
// rating_count, and collection_ids (curated-only) all need to come out
// the other end the same shape they did before, just computed from the
// embedded arrays instead of side-fetched Maps.
//
// This can't verify the embed query itself resolves against a real
// Supabase schema (that needs a live DB) -- only that *given* the nested
// shape PostgREST is expected to return, the flattening produces the
// right output.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const selectMock = vi.fn();

vi.mock('../../services/supabase', () => ({
    supabase: {
        from: vi.fn(() => ({
            select: selectMock,
        })),
    },
}));

// H2-01: GET /series merges in rank/rank_trend via this service, which
// hits supabase itself -- mocked separately from the generic supabase
// mock above (same reasoning as mocking services/curatorPicks in the
// admin curator-picks tests) so these tests can control trend data
// per-case without it colliding with the ratings/tags/genres query mock.
const { getRankTrendsMock } = vi.hoisted(() => ({ getRankTrendsMock: vi.fn() }));
vi.mock('../../services/rankSnapshots', () => ({ getRankTrends: getRankTrendsMock }));

// Q2-02: GET /:id/related is a thin pass-through to this service (same
// shape as GET /me/recommendations' own route) -- mocked here so these
// tests cover the route's auth/error/response-shape behavior without
// re-deriving the scoring logic, which is already covered directly in
// services/__tests__/recommendations.test.ts.
const { getRelatedSeriesMock } = vi.hoisted(() => ({ getRelatedSeriesMock: vi.fn() }));
vi.mock('../../services/recommendations', () => ({ getRelatedSeries: getRelatedSeriesMock }));

import seriesRouter from '../series';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/series', seriesRouter);
    return app;
}

// select() itself needs to be awaitable directly (no pagination -> no
// .range() call), so this returns a real Promise with a .range() method
// attached for the paginated case.
//
// D2-01: GET /series now also chains .ilike()/.eq()/.gte()/.lte()/
// .order() onto the query for q/country/status/year/episode/sort=newest
// filters before awaiting it (or calling .range()) -- each needs to
// return the same chainable/awaitable object so the route's builder
// pattern (`query = query.eq(...)`) keeps working under test the same
// way it does against the real Supabase client.
function mockSelectResult(result: { data: any[]; error: null; count?: number | null }) {
    const chainable: any = {
        then: (resolve: any) => Promise.resolve(result).then(resolve),
        ilike: vi.fn(() => chainable),
        eq: vi.fn(() => chainable),
        gte: vi.fn(() => chainable),
        lte: vi.fn(() => chainable),
        order: vi.fn(() => chainable),
        range: vi.fn(() => Promise.resolve(result)),
    };
    selectMock.mockReturnValue(chainable);
    return chainable;
}

describe('GET /series', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: no snapshot data, so existing tests (written before
        // H2-01) get rank: null / rank_trend: null without having to
        // know about the rank-trends service themselves.
        getRankTrendsMock.mockResolvedValue(new Map());
    });

    it('flattens tags, genre_names, ratings, and curated-only collection_ids', async () => {
        mockSelectResult({
            data: [
                {
                    id: 1,
                    title: 'Series One',
                    series_tags: [
                        { tags: { id: 10, dimension: 'trope', value_key: 'ceo', display_label: 'CEO', display_emoji: '💼' } },
                    ],
                    series_genres: [{ genres: { name: 'Romance' } }],
                    ratings: [{ score: 8 }, { score: 10 }],
                    collection_series: [
                        { collection_id: 100, collections: { is_curated: true } },
                        { collection_id: 200, collections: { is_curated: false } },
                    ],
                },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/series');

        expect(res.status).toBe(200);
        const series = res.body.data[0];
        expect(series.tags).toEqual([
            { id: 10, dimension: 'trope', value_key: 'ceo', display_label: 'CEO', display_emoji: '💼' },
        ]);
        expect(series.genre_names).toEqual(['Romance']);
        expect(series.average_rating).toBe(9);
        expect(series.rating_count).toBe(2);
        // Only the curated collection should survive the filter.
        expect(series.collection_ids).toEqual([100]);
        // Embedded join fields shouldn't leak into the flattened output.
        expect(series.series_tags).toBeUndefined();
        expect(series.series_genres).toBeUndefined();
        expect(series.ratings).toBeUndefined();
        expect(series.collection_series).toBeUndefined();
    });

    it('defaults to null average_rating and empty arrays when a series has none of the above', async () => {
        mockSelectResult({
            data: [
                {
                    id: 2,
                    title: 'Unrated Series',
                    series_tags: [],
                    series_genres: [],
                    ratings: [],
                    collection_series: [],
                },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/series');

        const series = res.body.data[0];
        expect(series.tags).toEqual([]);
        expect(series.genre_names).toEqual([]);
        expect(series.average_rating).toBeNull();
        expect(series.rating_count).toBe(0);
        expect(series.collection_ids).toEqual([]);
    });

    it('sets rank and rank_trend to null when the rank-snapshot job has never run for a series (H2-01)', async () => {
        mockSelectResult({
            data: [{ id: 3, title: 'No Snapshot Yet', series_tags: [], series_genres: [], ratings: [], collection_series: [] }],
            error: null,
        });

        const res = await request(buildApp()).get('/series');

        expect(res.body.data[0].rank).toBeNull();
        expect(res.body.data[0].rank_trend).toBeNull();
    });

    it('merges rank and rank_trend from getRankTrends by series id (H2-01)', async () => {
        getRankTrendsMock.mockResolvedValue(new Map([
            [1, { rank: 2, trend: 'up' }],
            [2, { rank: 5, trend: 'new' }],
        ]));
        mockSelectResult({
            data: [
                { id: 1, title: 'Climbing Series', series_tags: [], series_genres: [], ratings: [], collection_series: [] },
                { id: 2, title: 'Newly Ranked Series', series_tags: [], series_genres: [], ratings: [], collection_series: [] },
                { id: 3, title: 'Untracked Series', series_tags: [], series_genres: [], ratings: [], collection_series: [] },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/series');

        expect(res.body.data[0]).toMatchObject({ rank: 2, rank_trend: 'up' });
        expect(res.body.data[1]).toMatchObject({ rank: 5, rank_trend: 'new' });
        expect(res.body.data[2]).toMatchObject({ rank: null, rank_trend: null });
    });

    it('returns a pagination block only when page/limit are provided', async () => {
        mockSelectResult({ data: [], error: null, count: 42 });

        const res = await request(buildApp()).get('/series?page=2&limit=10');

        expect(res.status).toBe(200);
        expect(res.body.pagination).toEqual({ page: 2, limit: 10, total: 42, has_more: true });
    });

    it('omits the pagination block when no page/limit are given', async () => {
        mockSelectResult({ data: [], error: null });

        const res = await request(buildApp()).get('/series');

        expect(res.body.pagination).toBeUndefined();
    });

    // D2-01: q/country/status/year_min/year_max/episode_min/episode_max
    // are real columns and get pushed straight into the Supabase query
    // builder, rather than filtered in JS.
    it('pushes q/country/status/year/episode filters into the Supabase query builder', async () => {
        const chain = mockSelectResult({ data: [], error: null });

        await request(buildApp()).get(
            '/series?q=cherry&country=Thailand&status=airing&year_min=2020&year_max=2024&episode_min=8&episode_max=16'
        );

        expect(chain.ilike).toHaveBeenCalledWith('title', '%cherry%');
        expect(chain.eq).toHaveBeenCalledWith('country', 'Thailand');
        expect(chain.eq).toHaveBeenCalledWith('status', 'airing');
        expect(chain.gte).toHaveBeenCalledWith('year', 2020);
        expect(chain.lte).toHaveBeenCalledWith('year', 2024);
        expect(chain.gte).toHaveBeenCalledWith('episode_count', 8);
        expect(chain.lte).toHaveBeenCalledWith('episode_count', 16);
    });

    it('pushes sort=newest into the Supabase query as year desc, id asc (id as a tiebreaker)', async () => {
        const chain = mockSelectResult({ data: [], error: null });

        await request(buildApp()).get('/series?sort=newest');

        expect(chain.order).toHaveBeenCalledWith('year', { ascending: false });
        expect(chain.order).toHaveBeenCalledWith('id', { ascending: true });
    });

    // D2-04: GET /series previously had no ORDER BY at all outside
    // sort=newest, so .range()-based pagination relied on Postgres's
    // default row order, which isn't guaranteed stable across separate
    // queries -- a real risk of skipped/duplicated rows across pages.
    it('orders by id as a stable default when no sort param is given', async () => {
        const chain = mockSelectResult({ data: [], error: null });

        await request(buildApp()).get('/series');

        expect(chain.order).toHaveBeenCalledWith('id', { ascending: true });
    });

    it('orders by id as a stable default even when a JS-only sort is requested', async () => {
        const chain = mockSelectResult({ data: [], error: null });

        await request(buildApp()).get('/series?sort=popular');

        expect(chain.order).toHaveBeenCalledWith('id', { ascending: true });
    });

    // genre depends on genre_names, a join-flattened field the DB query
    // itself never sees -- filtered in JS after flattening instead.
    it('filters by genre against the flattened genre_names, in JS', async () => {
        mockSelectResult({
            data: [
                { id: 1, title: 'Romance Pick', series_tags: [], series_genres: [{ genres: { name: 'Romance' } }], ratings: [], collection_series: [] },
                { id: 2, title: 'Comedy Pick', series_tags: [], series_genres: [{ genres: { name: 'Comedy' } }], ratings: [], collection_series: [] },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/series?genre=Romance');

        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].id).toBe(1);
    });

    // rating_min depends on average_rating, also only computed post-flatten
    // -- a series with no ratings yet (average_rating: null) should never
    // match a rating_min filter.
    it('filters by rating_min against the computed average_rating, excluding unrated series', async () => {
        mockSelectResult({
            data: [
                { id: 1, title: 'High Rated', series_tags: [], series_genres: [], ratings: [{ score: 9 }, { score: 10 }], collection_series: [] },
                { id: 2, title: 'Low Rated', series_tags: [], series_genres: [], ratings: [{ score: 3 }], collection_series: [] },
                { id: 3, title: 'Unrated', series_tags: [], series_genres: [], ratings: [], collection_series: [] },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/series?rating_min=8');

        expect(res.body.data.map((s: any) => s.id)).toEqual([1]);
    });

    // G1-01: release_date is a real column, so min/max are pushed
    // straight into the Supabase query, same as year_min/year_max.
    it('pushes release_date_min/release_date_max into the Supabase query builder', async () => {
        const chain = mockSelectResult({ data: [], error: null });

        await request(buildApp()).get('/series?release_date_min=2026-01-01&release_date_max=2026-02-01');

        expect(chain.gte).toHaveBeenCalledWith('release_date', '2026-01-01');
        expect(chain.lte).toHaveBeenCalledWith('release_date', '2026-02-01');
    });

    it('pushes sort=newest_release into the Supabase query as release_date desc, id asc', async () => {
        const chain = mockSelectResult({ data: [], error: null });

        await request(buildApp()).get('/series?sort=newest_release');

        expect(chain.order).toHaveBeenCalledWith('release_date', { ascending: false });
        expect(chain.order).toHaveBeenCalledWith('id', { ascending: true });
    });

    it('does not change sort=newest (year-based) behavior now that newest_release exists', async () => {
        const chain = mockSelectResult({ data: [], error: null });

        await request(buildApp()).get('/series?sort=newest');

        expect(chain.order).toHaveBeenCalledWith('year', { ascending: false });
        expect(chain.order).not.toHaveBeenCalledWith('release_date', { ascending: false });
    });

    // G1-01: tag_dimension+tag_key depend on the flattened `tags` array,
    // so -- like genre -- this is a JS-side filter, matching value_key or
    // display_label after normalization (same rules as the frontend's old
    // lib/moodMatch.ts).
    it('filters by tag_dimension+tag_key against the flattened tags, in JS', async () => {
        mockSelectResult({
            data: [
                {
                    id: 1,
                    title: 'Romantic Pick',
                    series_tags: [
                        { tags: { id: 10, dimension: 'mood', value_key: 'romantic', display_label: 'Romantic', display_emoji: '💕' } },
                    ],
                    series_genres: [],
                    ratings: [],
                    collection_series: [],
                },
                {
                    id: 2,
                    title: 'Sad Pick',
                    series_tags: [
                        { tags: { id: 11, dimension: 'mood', value_key: 'sad', display_label: 'Sad', display_emoji: '😢' } },
                    ],
                    series_genres: [],
                    ratings: [],
                    collection_series: [],
                },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/series?tag_dimension=mood&tag_key=romantic');

        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].id).toBe(1);
    });

    it('matches tag_key against a normalized value_key or display_label, ignoring case/punctuation', async () => {
        mockSelectResult({
            data: [
                {
                    id: 1,
                    title: 'Enemies Pick',
                    series_tags: [
                        { tags: { id: 20, dimension: 'trope', value_key: 'enemies_to_lovers', display_label: 'Enemies to Lovers', display_emoji: '⚔️' } },
                    ],
                    series_genres: [],
                    ratings: [],
                    collection_series: [],
                },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/series?tag_dimension=trope&tag_key=enemies-to-lovers');

        expect(res.body.data).toHaveLength(1);
    });

    it('does not filter by tag when only tag_dimension or only tag_key is given', async () => {
        mockSelectResult({
            data: [
                { id: 1, title: 'A', series_tags: [], series_genres: [], ratings: [], collection_series: [] },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/series?tag_dimension=mood');

        expect(res.body.data).toHaveLength(1);
    });

    it('sorts by sort=top_rated using the computed average_rating', async () => {
        mockSelectResult({
            data: [
                { id: 1, title: 'Mid', series_tags: [], series_genres: [], ratings: [{ score: 6 }], collection_series: [] },
                { id: 2, title: 'Best', series_tags: [], series_genres: [], ratings: [{ score: 10 }], collection_series: [] },
                { id: 3, title: 'Worst', series_tags: [], series_genres: [], ratings: [{ score: 2 }], collection_series: [] },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/series?sort=top_rated');

        expect(res.body.data.map((s: any) => s.id)).toEqual([2, 1, 3]);
    });

    it('sorts by sort=popular using rank, with null ranks (no snapshot yet) sorted last', async () => {
        getRankTrendsMock.mockResolvedValue(new Map([
            [1, { rank: 2, trend: 'flat' }],
            [3, { rank: 1, trend: 'up' }],
        ]));
        mockSelectResult({
            data: [
                { id: 1, title: 'Rank Two', series_tags: [], series_genres: [], ratings: [], collection_series: [] },
                { id: 2, title: 'No Snapshot', series_tags: [], series_genres: [], ratings: [], collection_series: [] },
                { id: 3, title: 'Rank One', series_tags: [], series_genres: [], ratings: [], collection_series: [] },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/series?sort=popular');

        expect(res.body.data.map((s: any) => s.id)).toEqual([3, 1, 2]);
    });

    // When a JS-only filter/sort (genre/rating_min/top_rated/hidden_gems/
    // popular) is combined with pagination, the DB can't paginate itself
    // (see needsJsPagination) -- total/has_more should reflect the
    // JS-filtered length, not a DB count, and .range() should never be
    // called since the full matching set has to be fetched first.
    it('paginates in JS (not via .range()) when a JS-only filter is combined with page/limit', async () => {
        const chain = mockSelectResult({
            data: [
                { id: 1, title: 'A', series_tags: [], series_genres: [{ genres: { name: 'Romance' } }], ratings: [], collection_series: [] },
                { id: 2, title: 'B', series_tags: [], series_genres: [{ genres: { name: 'Romance' } }], ratings: [], collection_series: [] },
                { id: 3, title: 'C', series_tags: [], series_genres: [{ genres: { name: 'Comedy' } }], ratings: [], collection_series: [] },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/series?genre=Romance&page=1&limit=1');

        expect(chain.range).not.toHaveBeenCalled();
        expect(res.body.data).toHaveLength(1);
        expect(res.body.pagination).toEqual({ page: 1, limit: 1, total: 2, has_more: true });
    });

    // G1-01: Moods/Tropes now call this route per-key with a small limit
    // (e.g. limit=4 for a mood section, limit=3 for a trope's poster
    // strip) instead of fetching the whole catalog -- tag filtering has
    // to go through the same JS-pagination path as genre for that to work.
    it('paginates in JS when tag_dimension+tag_key is combined with page/limit', async () => {
        mockSelectResult({
            data: [
                { id: 1, title: 'A', series_tags: [{ tags: { dimension: 'mood', value_key: 'romantic', display_label: 'Romantic' } }], series_genres: [], ratings: [], collection_series: [] },
                { id: 2, title: 'B', series_tags: [{ tags: { dimension: 'mood', value_key: 'romantic', display_label: 'Romantic' } }], series_genres: [], ratings: [], collection_series: [] },
                { id: 3, title: 'C', series_tags: [{ tags: { dimension: 'mood', value_key: 'sad', display_label: 'Sad' } }], series_genres: [], ratings: [], collection_series: [] },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/series?tag_dimension=mood&tag_key=romantic&page=1&limit=1');

        expect(res.body.data).toHaveLength(1);
        expect(res.body.pagination).toEqual({ page: 1, limit: 1, total: 2, has_more: true });
    });
});

describe('GET /series/:id/related (Q2-02)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getRankTrendsMock.mockResolvedValue(new Map());
    });

    it('passes the parsed id and limit through to getRelatedSeries', async () => {
        getRelatedSeriesMock.mockResolvedValue([]);

        await request(buildApp()).get('/series/7/related?limit=5');

        expect(getRelatedSeriesMock).toHaveBeenCalledWith(7, 5);
    });

    it('defaults to a limit of 10 when none is given', async () => {
        getRelatedSeriesMock.mockResolvedValue([]);

        await request(buildApp()).get('/series/7/related');

        expect(getRelatedSeriesMock).toHaveBeenCalledWith(7, 10);
    });

    it('returns the related series with a count', async () => {
        getRelatedSeriesMock.mockResolvedValue([
            { id: 2, title: 'Related Show', poster_url: null, year: 2024, country: 'TH', score: 3, match_reasons: ['Slow Burn'] },
        ]);

        const res = await request(buildApp()).get('/series/7/related');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        expect(res.body.data[0]).toMatchObject({ id: 2, title: 'Related Show' });
    });

    it('returns 500 if the service throws', async () => {
        getRelatedSeriesMock.mockRejectedValue(new Error('db down'));

        const res = await request(buildApp()).get('/series/7/related');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});
