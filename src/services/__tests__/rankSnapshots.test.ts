// src/services/__tests__/rankSnapshots.test.ts
//
// H2-01: covers the two pieces GET /series and the admin trigger route
// build on -- computeAndStoreSnapshot's ranking/scoring and upsert
// shape, and getRankTrends' up/down/flat/new derivation from the two
// most recent snapshot dates.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fromMock = vi.fn();
vi.mock('../supabase', () => ({ supabase: { from: (...args: any[]) => fromMock(...args) } }));

import { computeAndStoreSnapshot, getRankTrends } from '../rankSnapshots';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('computeAndStoreSnapshot', () => {
    it('ranks series by rating-weighted popularity score, highest first', async () => {
        const selectMock = vi.fn().mockResolvedValue({
            data: [
                // Series 1: one 10 -> average 10, count 1 -- high average, low volume.
                { series_id: 1, score: 10 },
                // Series 2: ten 8s -> average 8, count 10 -- lower average, high volume.
                ...Array.from({ length: 10 }, () => ({ series_id: 2, score: 8 })),
            ],
            error: null,
        });
        const upsertMock = vi.fn().mockResolvedValue({ error: null });

        fromMock.mockImplementation((table: string) => {
            if (table === 'ratings') return { select: selectMock };
            if (table === 'series_rank_snapshots') return { upsert: upsertMock };
            throw new Error('unexpected table ' + table);
        });

        const result = await computeAndStoreSnapshot();

        expect(result.count).toBe(2);
        const rows = upsertMock.mock.calls[0][0];
        // Volume-weighted score should put the 10-rating, 10-count series
        // ahead of the single 10/10 rating despite the lower raw average.
        const series2 = rows.find((r: any) => r.series_id === 2);
        const series1 = rows.find((r: any) => r.series_id === 1);
        expect(series2.rank).toBe(1);
        expect(series1.rank).toBe(2);
        expect(upsertMock.mock.calls[0][1]).toEqual({ onConflict: 'series_id,snapshot_date' });
    });

    it('excludes unrated series and returns count 0 without upserting', async () => {
        const selectMock = vi.fn().mockResolvedValue({ data: [], error: null });
        const upsertMock = vi.fn();
        fromMock.mockImplementation((table: string) => {
            if (table === 'ratings') return { select: selectMock };
            if (table === 'series_rank_snapshots') return { upsert: upsertMock };
            throw new Error('unexpected table ' + table);
        });

        const result = await computeAndStoreSnapshot();

        expect(result.count).toBe(0);
        expect(upsertMock).not.toHaveBeenCalled();
    });

    it('throws if fetching ratings fails', async () => {
        fromMock.mockImplementation((table: string) => {
            if (table === 'ratings') return { select: vi.fn().mockResolvedValue({ data: null, error: { message: 'db down' } }) };
            throw new Error('unexpected table ' + table);
        });

        await expect(computeAndStoreSnapshot()).rejects.toThrow(/db down/);
    });

    it('throws if the upsert fails', async () => {
        const selectMock = vi.fn().mockResolvedValue({ data: [{ series_id: 1, score: 9 }], error: null });
        const upsertMock = vi.fn().mockResolvedValue({ error: { message: 'fk violation' } });
        fromMock.mockImplementation((table: string) => {
            if (table === 'ratings') return { select: selectMock };
            if (table === 'series_rank_snapshots') return { upsert: upsertMock };
            throw new Error('unexpected table ' + table);
        });

        await expect(computeAndStoreSnapshot()).rejects.toThrow(/fk violation/);
    });
});

describe('getRankTrends', () => {
    function mockSnapshotRows(rows: { series_id: number; snapshot_date: string; rank: number }[]) {
        const orderMock = vi.fn().mockResolvedValue({ data: rows, error: null });
        fromMock.mockImplementation((table: string) => {
            if (table === 'series_rank_snapshots') return { select: vi.fn(() => ({ order: orderMock })) };
            throw new Error('unexpected table ' + table);
        });
    }

    it('returns an empty map when no snapshots exist yet', async () => {
        mockSnapshotRows([]);

        const trends = await getRankTrends();

        expect(trends.size).toBe(0);
    });

    it('marks a series with no prior snapshot as new', async () => {
        mockSnapshotRows([{ series_id: 1, snapshot_date: '2026-08-10', rank: 3 }]);

        const trends = await getRankTrends();

        expect(trends.get(1)).toEqual({ rank: 3, trend: 'new' });
    });

    it('derives up/down/flat by comparing the two most recent snapshot dates', async () => {
        mockSnapshotRows([
            // Latest date
            { series_id: 1, snapshot_date: '2026-08-10', rank: 1 }, // improved (was 3)
            { series_id: 2, snapshot_date: '2026-08-10', rank: 5 }, // worsened (was 2)
            { series_id: 3, snapshot_date: '2026-08-10', rank: 4 }, // unchanged
            // Previous date
            { series_id: 1, snapshot_date: '2026-08-03', rank: 3 },
            { series_id: 2, snapshot_date: '2026-08-03', rank: 2 },
            { series_id: 3, snapshot_date: '2026-08-03', rank: 4 },
            // An older date should be ignored entirely once a prior date exists.
            { series_id: 1, snapshot_date: '2026-07-27', rank: 9 },
        ]);

        const trends = await getRankTrends();

        expect(trends.get(1)).toEqual({ rank: 1, trend: 'up' });
        expect(trends.get(2)).toEqual({ rank: 5, trend: 'down' });
        expect(trends.get(3)).toEqual({ rank: 4, trend: 'flat' });
    });
});
