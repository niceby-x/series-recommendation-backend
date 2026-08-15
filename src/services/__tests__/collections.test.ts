// src/services/__tests__/collections.test.ts
//
// G1-02: covers fetchCollectionsJoined's new opt-in pagination -- when a
// `pagination` arg is given, page/limit should reach the Supabase query
// as a real .range() call with count: 'exact' requested, and `total`
// should come back from that count. Omitted, behavior is unchanged from
// before this task (every matching collection, total = data.length).
// GET /collections' own request/response shaping (query param parsing,
// the `pagination` envelope) is covered separately in
// routes/__tests__/collections.test.ts, which mocks this function
// directly -- these tests are just the query-building logic itself.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fromMock = vi.fn();
vi.mock('../supabase', () => ({ supabase: { from: (...args: any[]) => fromMock(...args) } }));

import { fetchCollectionsJoined } from '../collections';

// Supabase's query builder is thenable (chain methods return `this`,
// awaiting it resolves to { data, error, count }) -- mirrors the mocking
// style already used in services/__tests__/rankSnapshots.test.ts.
function createQueryMock(result: { data: any; error: any; count?: number | null }) {
    const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        order: vi.fn(() => chain),
        range: vi.fn(() => chain),
        then: (resolve: any) => resolve(result),
    };
    return chain;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('fetchCollectionsJoined', () => {
    it('does not call .range() and uses data.length as total when no pagination is given', async () => {
        const query = createQueryMock({
            data: [
                { id: 1, title: 'Faves', description: null, is_curated: true, owner_user_id: null, created_at: 't', updated_at: 't', collection_series: [] },
            ],
            error: null,
        });
        fromMock.mockReturnValue(query);

        const { data, total, error } = await fetchCollectionsJoined({ is_curated: true }, null);

        expect(error).toBeNull();
        expect(data).toHaveLength(1);
        expect(total).toBe(1);
        expect(query.range).not.toHaveBeenCalled();
        // count: 'exact' is only worth asking Supabase for when it'll
        // actually be read -- unpaginated callers use data.length instead.
        expect(query.select).toHaveBeenCalledWith(expect.any(String), undefined);
    });

    it('pushes page/limit into .range() and requests count: "exact" when pagination is given', async () => {
        const query = createQueryMock({
            data: [
                { id: 1, title: 'Faves', description: null, is_curated: true, owner_user_id: null, created_at: 't', updated_at: 't', collection_series: [] },
            ],
            error: null,
            count: 42,
        });
        fromMock.mockReturnValue(query);

        const { data, total } = await fetchCollectionsJoined({ is_curated: true }, null, { page: 2, limit: 10 });

        expect(data).toHaveLength(1);
        expect(total).toBe(42); // from the DB's count, not data.length
        expect(query.range).toHaveBeenCalledWith(10, 19); // page 2, limit 10 -> rows 10-19
        expect(query.select).toHaveBeenCalledWith(expect.any(String), { count: 'exact' });
    });

    it('falls back to data.length as total if count comes back null', async () => {
        const query = createQueryMock({
            data: [
                { id: 1, title: 'A', description: null, is_curated: false, owner_user_id: 5, created_at: 't', updated_at: 't', collection_series: [] },
                { id: 2, title: 'B', description: null, is_curated: false, owner_user_id: 5, created_at: 't', updated_at: 't', collection_series: [] },
            ],
            error: null,
            count: null,
        });
        fromMock.mockReturnValue(query);

        const { total } = await fetchCollectionsJoined({ is_curated: false, owner_user_id: 5 }, 5, { page: 1, limit: 20 });

        expect(total).toBe(2);
    });

    it('still filters by owner_user_id when both filter and pagination are given', async () => {
        const query = createQueryMock({ data: [], error: null, count: 0 });
        fromMock.mockReturnValue(query);

        await fetchCollectionsJoined({ is_curated: false, owner_user_id: 7 }, 7, { page: 1, limit: 20 });

        expect(query.eq).toHaveBeenCalledWith('is_curated', false);
        expect(query.eq).toHaveBeenCalledWith('owner_user_id', 7);
    });

    it('pushes sort=alpha into .order("title"), still using SQL-level .range() + count', async () => {
        const query = createQueryMock({
            data: [{ id: 1, title: 'A', description: null, is_curated: true, owner_user_id: null, created_at: 't', updated_at: 't', collection_series: [] }],
            error: null,
            count: 5,
        });
        fromMock.mockReturnValue(query);

        const { total } = await fetchCollectionsJoined({ is_curated: true }, null, { page: 1, limit: 20 }, 'alpha');

        expect(query.order).toHaveBeenCalledWith('title', { ascending: true });
        expect(query.range).toHaveBeenCalledWith(0, 19); // still SQL-paginated -- alpha is a real column
        expect(query.select).toHaveBeenCalledWith(expect.any(String), { count: 'exact' });
        expect(total).toBe(5);
    });

    it('defaults to .order("updated_at") when sort is omitted or "updated"', async () => {
        const query = createQueryMock({ data: [], error: null, count: 0 });
        fromMock.mockReturnValue(query);

        await fetchCollectionsJoined({ is_curated: true }, null, { page: 1, limit: 20 }, 'updated');

        expect(query.order).toHaveBeenCalledWith('updated_at', { ascending: false });
    });

    it('sort=most_series fetches the full set (no SQL .range()), JS-sorts by series_count desc, then slices', async () => {
        const query = createQueryMock({
            data: [
                { id: 1, title: 'Two Series', description: null, is_curated: true, owner_user_id: null, created_at: 't', updated_at: 't', collection_series: [{ series_id: 10 }, { series_id: 11 }] },
                { id: 2, title: 'Zero Series', description: null, is_curated: true, owner_user_id: null, created_at: 't', updated_at: 't', collection_series: [] },
                { id: 3, title: 'One Series', description: null, is_curated: true, owner_user_id: null, created_at: 't', updated_at: 't', collection_series: [{ series_id: 12 }] },
            ],
            error: null,
        });
        fromMock.mockReturnValue(query);

        const { data, total } = await fetchCollectionsJoined({ is_curated: true }, null, { page: 1, limit: 2 }, 'most_series');

        // No SQL-level range/count -- the DB can't sort by a computed
        // field, so the full matching set has to come back before JS can
        // sort it correctly (same reasoning GET /series' computed sorts
        // use).
        expect(query.range).not.toHaveBeenCalled();
        expect(query.select).toHaveBeenCalledWith(expect.any(String), undefined);
        // Sorted by series_count desc (2, 1, 0), then sliced to page 1 of 2.
        expect(data.map((c: any) => c.id)).toEqual([1, 3]);
        // total reflects the full JS-computed set, not just this page.
        expect(total).toBe(3);
    });

    it('sort=most_series paginates the second page correctly off the JS-sorted set', async () => {
        const query = createQueryMock({
            data: [
                { id: 1, title: 'Two', description: null, is_curated: true, owner_user_id: null, created_at: 't', updated_at: 't', collection_series: [{ series_id: 1 }, { series_id: 2 }] },
                { id: 2, title: 'Zero', description: null, is_curated: true, owner_user_id: null, created_at: 't', updated_at: 't', collection_series: [] },
                { id: 3, title: 'One', description: null, is_curated: true, owner_user_id: null, created_at: 't', updated_at: 't', collection_series: [{ series_id: 3 }] },
            ],
            error: null,
        });
        fromMock.mockReturnValue(query);

        const { data } = await fetchCollectionsJoined({ is_curated: true }, null, { page: 2, limit: 2 }, 'most_series');

        expect(data.map((c: any) => c.id)).toEqual([2]);
    });
});
