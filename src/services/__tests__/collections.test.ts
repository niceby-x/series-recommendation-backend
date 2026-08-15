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
});
