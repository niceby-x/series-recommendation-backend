// src/routes/__tests__/admin/collections.test.ts
//
// A3-01: covers the admin curated-collections router. loadEditableCollection
// is mocked directly (it does its own auth/ownership logic; out of scope
// here), same approach the existing top-level collections.test.ts uses for
// the public router. GET/POST / still go through requireAdmin directly, so
// those two are covered end to end.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockSupabase, allowAdmin, rejectAdmin } from './testUtils';

const { requireAdminMock, getOrCreateUserIdMock, loadEditableCollectionMock, fetchCollectionsJoinedMock } = vi.hoisted(() => ({
    requireAdminMock: vi.fn(),
    getOrCreateUserIdMock: vi.fn(),
    loadEditableCollectionMock: vi.fn(),
    fetchCollectionsJoinedMock: vi.fn(),
}));

vi.mock('../../../middleware/auth', () => ({
    requireAdmin: requireAdminMock,
    getOrCreateUserId: getOrCreateUserIdMock,
}));
vi.mock('../../../services/collections', () => ({
    fetchCollectionsJoined: fetchCollectionsJoinedMock,
    loadEditableCollection: loadEditableCollectionMock,
}));

const { supabase, queue } = mockSupabase();
vi.mock('../../../services/supabase', () => ({ get supabase() { return supabase; } }));

import adminCollectionsRouter from '../../admin/collections';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/admin/collections', adminCollectionsRouter);
    return app;
}

beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockImplementation(allowAdmin());
    getOrCreateUserIdMock.mockResolvedValue(1);
});

describe('GET /admin/collections', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).get('/admin/collections');

        expect(res.status).toBe(403);
    });

    it('lists curated collections', async () => {
        fetchCollectionsJoinedMock.mockResolvedValue({ data: [{ id: 1, title: 'Faves', is_curated: true }], error: null });

        const res = await request(buildApp()).get('/admin/collections');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
    });
});

describe('POST /admin/collections (A2-01)', () => {
    it('rejects a missing title with 400', async () => {
        const res = await request(buildApp()).post('/admin/collections').send({});

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/title is required/i);
    });

    it('creates a curated collection tied to the creating admin', async () => {
        queue('collections', { data: { id: 1, title: 'Enemies to Lovers', is_curated: true }, error: null });

        const res = await request(buildApp())
            .post('/admin/collections')
            .send({ title: '  Enemies to Lovers  ' });

        expect(res.status).toBe(201);
    });
});

describe('PATCH /admin/collections/:id', () => {
    it('returns early (response already sent) when loadEditableCollection rejects access', async () => {
        loadEditableCollectionMock.mockImplementation(async (_req: any, res: any) => {
            res.status(403).json({ message: 'Not allowed' });
            return null;
        });

        const res = await request(buildApp()).patch('/admin/collections/1').send({ title: 'New' });

        expect(res.status).toBe(403);
    });

    it('updates title/description when allowed', async () => {
        loadEditableCollectionMock.mockResolvedValue({ id: 1, is_curated: true });
        queue('collections', { data: { id: 1, title: 'New Title' }, error: null });

        const res = await request(buildApp()).patch('/admin/collections/1').send({ title: 'New Title' });

        expect(res.status).toBe(200);
    });
});

describe('DELETE /admin/collections/:id', () => {
    it('deletes collection_series links before deleting the collection', async () => {
        loadEditableCollectionMock.mockResolvedValue({ id: 1, is_curated: true });
        queue('collection_series', { data: null, error: null });
        queue('collections', { data: null, error: null });

        const res = await request(buildApp()).delete('/admin/collections/1');

        expect(res.status).toBe(200);
    });
});

describe('POST /admin/collections/:id/series (A2-01)', () => {
    beforeEach(() => {
        loadEditableCollectionMock.mockResolvedValue({ id: 1, is_curated: true });
    });

    it('rejects a missing series_id with 400', async () => {
        const res = await request(buildApp()).post('/admin/collections/1/series').send({});

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/series_id is required/i);
    });

    it('appends after the current max sort_order', async () => {
        queue('collection_series', { data: [{ sort_order: 3 }], error: null }); // existing max
        queue('collection_series', { data: null, error: null }); // insert
        queue('collections', { data: null, error: null }); // updated_at touch

        const res = await request(buildApp()).post('/admin/collections/1/series').send({ series_id: 5 });

        expect(res.status).toBe(201);
    });

    it('returns 409 when the series is already in the collection', async () => {
        queue('collection_series', { data: [], error: null });
        queue('collection_series', { data: null, error: { code: '23505', message: 'duplicate' } });

        const res = await request(buildApp()).post('/admin/collections/1/series').send({ series_id: 5 });

        expect(res.status).toBe(409);
    });
});

describe('DELETE /admin/collections/:id/series/:seriesId', () => {
    it('removes the series and touches updated_at', async () => {
        loadEditableCollectionMock.mockResolvedValue({ id: 1, is_curated: true });
        queue('collection_series', { data: null, error: null });
        queue('collections', { data: null, error: null });

        const res = await request(buildApp()).delete('/admin/collections/1/series/5');

        expect(res.status).toBe(200);
    });
});
