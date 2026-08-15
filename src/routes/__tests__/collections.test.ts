// src/routes/__tests__/collections.test.ts
//
// P2-03: covers the new zod schemas on POST /collections, PATCH
// /collections/:id, and POST /collections/:id/series. loadEditableCollection
// is mocked directly (it does its own auth/db work, out of scope here) so
// these tests isolate what the schemas themselves accept or reject.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// vi.mock() calls are hoisted above imports and these const declarations,
// so any mock referenced inside a factory has to go through vi.hoisted()
// (Vitest's documented pattern for this) rather than a plain top-level
// const -- otherwise the factory runs before the const is initialized.
const { insertSingleMock, updateSingleMock, loadEditableCollectionMock } = vi.hoisted(() => ({
    insertSingleMock: vi.fn(),
    updateSingleMock: vi.fn(),
    loadEditableCollectionMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
    getOrCreateUserId: vi.fn(),
}));

vi.mock('../../services/supabase', () => ({
    supabase: {
        from: vi.fn(() => ({
            insert: vi.fn(() => ({
                select: vi.fn(() => ({
                    single: insertSingleMock,
                })),
            })),
            update: vi.fn(() => ({
                eq: vi.fn(() => ({
                    select: vi.fn(() => ({
                        single: updateSingleMock,
                    })),
                })),
            })),
        })),
    },
}));

vi.mock('../../services/collections', () => ({
    fetchCollectionsJoined: vi.fn(),
    loadEditableCollection: loadEditableCollectionMock,
}));

import { getOrCreateUserId } from '../../middleware/auth';
import { fetchCollectionsJoined } from '../../services/collections';
import collectionsRouter from '../collections';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/collections', collectionsRouter);
    return app;
}

// G1-02: fetchCollectionsJoined itself is mocked here (its own
// pagination/sort/query-building logic is covered in
// services/__tests__/collections.test.ts) -- these tests are just GET
// /collections' own request/response shaping: parsing page/limit/sort,
// forwarding them, and building the same opt-in `pagination` envelope
// GET /series uses.
describe('GET /collections', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getOrCreateUserId).mockResolvedValue(null);
    });

    it('does not forward a pagination arg or include a pagination envelope when page/limit are omitted', async () => {
        vi.mocked(fetchCollectionsJoined).mockResolvedValue({ error: null, data: [{ id: 1 }] as any, total: 1 });

        const res = await request(buildApp()).get('/collections');

        expect(res.status).toBe(200);
        expect(fetchCollectionsJoined).toHaveBeenCalledWith({ is_curated: true }, null, undefined, undefined);
        expect(res.body.pagination).toBeUndefined();
    });

    it('forwards page/limit and includes a pagination envelope when given', async () => {
        vi.mocked(fetchCollectionsJoined).mockResolvedValue({ error: null, data: [{ id: 1 }] as any, total: 25 });

        const res = await request(buildApp()).get('/collections?page=2&limit=10');

        expect(res.status).toBe(200);
        expect(fetchCollectionsJoined).toHaveBeenCalledWith({ is_curated: true }, null, { page: 2, limit: 10 }, undefined);
        expect(res.body.pagination).toEqual({ page: 2, limit: 10, total: 25, has_more: true });
    });

    it('applies the same pagination envelope to ?mine=true', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(9);
        vi.mocked(fetchCollectionsJoined).mockResolvedValue({ error: null, data: [{ id: 1 }] as any, total: 3 });

        const res = await request(buildApp()).get('/collections?mine=true&page=1&limit=20');

        expect(res.status).toBe(200);
        expect(fetchCollectionsJoined).toHaveBeenCalledWith(
            { is_curated: false, owner_user_id: 9 },
            9,
            { page: 1, limit: 20 },
            undefined
        );
        expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 3, has_more: false });
    });

    it('still requires auth for ?mine=true regardless of pagination params', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(null);

        const res = await request(buildApp()).get('/collections?mine=true&page=1&limit=20');

        expect(res.status).toBe(401);
        expect(fetchCollectionsJoined).not.toHaveBeenCalled();
    });

    it.each(['updated', 'alpha', 'most_series'])('forwards a recognized sort value (%s)', async (sortValue) => {
        vi.mocked(fetchCollectionsJoined).mockResolvedValue({ error: null, data: [], total: 0 });

        await request(buildApp()).get('/collections?sort=' + sortValue);

        expect(fetchCollectionsJoined).toHaveBeenCalledWith({ is_curated: true }, null, undefined, sortValue);
    });

    it('ignores an unrecognized sort value rather than passing it through', async () => {
        vi.mocked(fetchCollectionsJoined).mockResolvedValue({ error: null, data: [], total: 0 });

        await request(buildApp()).get('/collections?sort=nonsense');

        expect(fetchCollectionsJoined).toHaveBeenCalledWith({ is_curated: true }, null, undefined, undefined);
    });
});

describe('POST /collections', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
    });

    it('rejects a missing title with 400', async () => {
        const res = await request(buildApp()).post('/collections').send({});

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/title is required/i);
    });

    it('rejects a blank/whitespace-only title with 400', async () => {
        const res = await request(buildApp())
            .post('/collections')
            .send({ title: '   ' });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/title is required/i);
    });

    it('creates a collection and returns 201 on a valid title', async () => {
        insertSingleMock.mockResolvedValue({
            data: { id: 1, title: 'My List', is_curated: false },
            error: null,
        });

        const res = await request(buildApp())
            .post('/collections')
            .send({ title: '  My List  ' });

        expect(res.status).toBe(201);
    });
});

describe('PATCH /collections/:id', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        loadEditableCollectionMock.mockResolvedValue({ id: 1, is_curated: false });
    });

    it('rejects a blank title with 400', async () => {
        const res = await request(buildApp())
            .patch('/collections/1')
            .send({ title: '   ' });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/title is required/i);
    });

    it('allows an update with no title change (description only)', async () => {
        updateSingleMock.mockResolvedValue({
            data: { id: 1, description: 'Updated' },
            error: null,
        });

        const res = await request(buildApp())
            .patch('/collections/1')
            .send({ description: 'Updated' });

        expect(res.status).toBe(200);
    });
});

describe('POST /collections/:id/series', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        loadEditableCollectionMock.mockResolvedValue({ id: 1, is_curated: false });
    });

    it('rejects a missing series_id with 400', async () => {
        const res = await request(buildApp())
            .post('/collections/1/series')
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/series_id is required/i);
    });
});
