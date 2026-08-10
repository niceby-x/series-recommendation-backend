// src/routes/__tests__/admin/tags.test.ts
//
// A3-01: covers tag create/toggle/rename/merge/delete plus per-tag series
// membership. create and rename cover A2-01's zod schemas; merge covers
// both the shared mergeIdsSchema and the tags-specific same-dimension
// guard that genres.ts's merge doesn't have.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockSupabase, allowAdmin, rejectAdmin } from './testUtils';

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
vi.mock('../../../middleware/auth', () => ({ requireAdmin: requireAdminMock }));

const { supabase, queue } = mockSupabase();
vi.mock('../../../services/supabase', () => ({ get supabase() { return supabase; } }));

import tagsRouter from '../../admin/tags';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/admin/tags', tagsRouter);
    return app;
}

beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockImplementation(allowAdmin());
});

describe('GET /admin/tags', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).get('/admin/tags');

        expect(res.status).toBe(403);
    });

    it('groups tags by dimension', async () => {
        queue('tags', {
            data: [
                { id: 1, dimension: 'mood', display_label: 'Angsty' },
                { id: 2, dimension: 'trope', display_label: 'Enemies to Lovers' },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/admin/tags');

        expect(res.status).toBe(200);
        expect(Object.keys(res.body.data)).toEqual(['mood', 'trope']);
    });
});

describe('POST /admin/tags (A2-01)', () => {
    it('rejects an invalid dimension with 400', async () => {
        const res = await request(buildApp())
            .post('/admin/tags')
            .send({ dimension: 'not-a-real-dimension', display_label: 'X' });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/dimension must be one of/);
    });

    it('rejects a missing display_label with 400', async () => {
        const res = await request(buildApp()).post('/admin/tags').send({ dimension: 'mood' });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/display_label is required/);
    });

    it('derives value_key from display_label when none is given, and appends after the current max sort_order', async () => {
        queue('tags', { data: [{ sort_order: 4 }], error: null }); // existing max lookup
        queue('tags', { data: { id: 1, dimension: 'mood', value_key: 'slow_burn', display_label: 'Slow Burn' }, error: null }); // insert

        const res = await request(buildApp())
            .post('/admin/tags')
            .send({ dimension: 'mood', display_label: 'Slow Burn' });

        expect(res.status).toBe(201);
        expect(res.body.data.value_key).toBe('slow_burn');
    });

    it('returns 409 on a Postgres unique-violation (duplicate dimension+value_key)', async () => {
        queue('tags', { data: [], error: null }); // no existing max
        queue('tags', { data: null, error: { code: '23505', message: 'duplicate key' } }); // insert fails

        const res = await request(buildApp())
            .post('/admin/tags')
            .send({ dimension: 'mood', display_label: 'Slow Burn', value_key: 'slow_burn' });

        expect(res.status).toBe(409);
    });
});

describe('PATCH /admin/tags/:id/toggle', () => {
    it('flips is_active and reports which direction it went', async () => {
        queue('tags', { data: { is_active: true }, error: null }); // current
        queue('tags', { data: { id: 1, is_active: false }, error: null }); // updated

        const res = await request(buildApp()).patch('/admin/tags/1/toggle');

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Tag deactivated');
    });

    it('returns 404 when the tag does not exist', async () => {
        queue('tags', { data: null, error: { message: 'not found' } });

        const res = await request(buildApp()).patch('/admin/tags/999/toggle');

        expect(res.status).toBe(404);
    });
});

describe('PATCH /admin/tags/:id (A2-01)', () => {
    it('rejects a missing display_label with 400', async () => {
        const res = await request(buildApp()).patch('/admin/tags/1').send({});

        expect(res.status).toBe(400);
    });

    it('rejects a rename that collides within the same dimension', async () => {
        queue('tags', { data: { id: 1, dimension: 'mood' }, error: null });
        queue('tags', { data: [{ id: 2, display_label: 'Angsty' }], error: null });

        const res = await request(buildApp()).patch('/admin/tags/1').send({ display_label: 'angsty' });

        expect(res.status).toBe(409);
    });
});

describe('POST /admin/tags/merge (A2-01 + same-dimension guard)', () => {
    it('rejects a missing target_id/source_ids with 400', async () => {
        const res = await request(buildApp()).post('/admin/tags/merge').send({});

        expect(res.status).toBe(400);
    });

    it('rejects merging tags from different dimensions', async () => {
        queue('tags', {
            data: [{ id: 1, dimension: 'mood' }, { id: 2, dimension: 'trope' }],
            error: null,
        });

        const res = await request(buildApp())
            .post('/admin/tags/merge')
            .send({ target_id: 1, source_ids: [2] });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/same dimension/);
    });

    it('merges series_tags and series_candidate_tags links, then deletes the source tag', async () => {
        queue('tags', { data: [{ id: 1, dimension: 'mood' }, { id: 2, dimension: 'mood' }], error: null });
        queue('series_tags', { data: [], error: null }); // target's series links
        queue('series_tags', { data: [{ series_id: 10 }], error: null }); // source's series links
        queue('series_tags', { data: null, error: null }); // insert relink
        queue('series_tags', { data: null, error: null }); // delete source series links
        queue('series_candidate_tags', { data: [], error: null }); // target's candidate links
        queue('series_candidate_tags', { data: [], error: null }); // source's candidate links (none to relink)
        queue('series_candidate_tags', { data: null, error: null }); // delete source candidate links
        queue('tags', { data: null, error: null }); // delete source tag

        const res = await request(buildApp())
            .post('/admin/tags/merge')
            .send({ target_id: 1, source_ids: [2] });

        expect(res.status).toBe(200);
    });
});

describe('POST /admin/tags/:id/series (A2-01)', () => {
    it('rejects a missing series_id with 400', async () => {
        const res = await request(buildApp()).post('/admin/tags/1/series').send({});

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/series_id is required/);
    });

    it('returns 409 when the series is already tagged (unique violation)', async () => {
        queue('series_tags', { data: null, error: { code: '23505', message: 'duplicate' } });

        const res = await request(buildApp()).post('/admin/tags/1/series').send({ series_id: 5 });

        expect(res.status).toBe(409);
    });

    it('adds the series to the tag on success', async () => {
        queue('series_tags', { data: null, error: null });

        const res = await request(buildApp()).post('/admin/tags/1/series').send({ series_id: 5 });

        expect(res.status).toBe(201);
    });
});
