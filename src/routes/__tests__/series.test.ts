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
function mockSelectResult(result: { data: any[]; error: null; count?: number | null }) {
    const promise = Object.assign(Promise.resolve(result), {
        range: vi.fn(() => Promise.resolve(result)),
    });
    selectMock.mockReturnValue(promise);
}

describe('GET /series', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
});
