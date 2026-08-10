// src/routes/__tests__/admin/curatorPicks.test.ts
//
// A3-01: covers curator picks add/edit/remove -- especially the
// is_feature single-row invariant (setting one pick as the feature unsets
// every other row first) on both POST / and PATCH /:id.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockSupabase, allowAdmin, rejectAdmin } from './testUtils';

const { requireAdminMock, fetchCuratorPicksJoinedMock } = vi.hoisted(() => ({
    requireAdminMock: vi.fn(),
    fetchCuratorPicksJoinedMock: vi.fn(),
}));

vi.mock('../../../middleware/auth', () => ({ requireAdmin: requireAdminMock }));
vi.mock('../../../services/curatorPicks', () => ({ fetchCuratorPicksJoined: fetchCuratorPicksJoinedMock }));

const { supabase, queue } = mockSupabase();
vi.mock('../../../services/supabase', () => ({ get supabase() { return supabase; } }));

import curatorPicksRouter from '../../admin/curatorPicks';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/admin/curator-picks', curatorPicksRouter);
    return app;
}

beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockImplementation(allowAdmin());
});

describe('GET /admin/curator-picks', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).get('/admin/curator-picks');

        expect(res.status).toBe(403);
    });

    it('lists picks', async () => {
        fetchCuratorPicksJoinedMock.mockResolvedValue({ data: [{ id: 1, series_id: 5 }], error: null });

        const res = await request(buildApp()).get('/admin/curator-picks');

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
    });
});

describe('POST /admin/curator-picks (A2-01)', () => {
    it('rejects a missing series_id with 400', async () => {
        const res = await request(buildApp()).post('/admin/curator-picks').send({});

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/series_id is required/i);
    });

    it('unsets every other feature pick first when is_feature is true', async () => {
        queue('curator_picks', { data: null, error: null }); // unset-others update
        queue('curator_picks', { data: [{ sort_order: 2 }], error: null }); // max sort_order lookup
        queue('curator_picks', { data: { id: 9, series_id: 5, is_feature: true }, error: null }); // insert

        const res = await request(buildApp())
            .post('/admin/curator-picks')
            .send({ series_id: 5, is_feature: true });

        expect(res.status).toBe(201);
        expect(res.body.data.is_feature).toBe(true);
    });

    it('does not touch other rows when is_feature is not set', async () => {
        queue('curator_picks', { data: [], error: null }); // max sort_order lookup (no unset-others call)
        queue('curator_picks', { data: { id: 9, series_id: 5, is_feature: false }, error: null });

        const res = await request(buildApp()).post('/admin/curator-picks').send({ series_id: 5 });

        expect(res.status).toBe(201);
    });

    it('returns 409 when the series is already a curator pick', async () => {
        queue('curator_picks', { data: [], error: null });
        queue('curator_picks', { data: null, error: { code: '23505', message: 'duplicate' } });

        const res = await request(buildApp()).post('/admin/curator-picks').send({ series_id: 5 });

        expect(res.status).toBe(409);
    });
});

describe('PATCH /admin/curator-picks/:id', () => {
    it('unsets every OTHER row (excluding itself) when is_feature is set true', async () => {
        queue('curator_picks', { data: null, error: null }); // unset-others (neq id)
        queue('curator_picks', { data: { id: 1, is_feature: true }, error: null }); // the update itself

        const res = await request(buildApp())
            .patch('/admin/curator-picks/1')
            .send({ is_feature: true });

        expect(res.status).toBe(200);
    });

    it('updates only the fields provided', async () => {
        queue('curator_picks', { data: { id: 1, blurb: 'Updated' }, error: null });

        const res = await request(buildApp())
            .patch('/admin/curator-picks/1')
            .send({ blurb: 'Updated' });

        expect(res.status).toBe(200);
        expect(res.body.data.blurb).toBe('Updated');
    });
});

describe('DELETE /admin/curator-picks/:id', () => {
    it('removes the pick', async () => {
        queue('curator_picks', { data: null, error: null });

        const res = await request(buildApp()).delete('/admin/curator-picks/1');

        expect(res.status).toBe(200);
    });
});
