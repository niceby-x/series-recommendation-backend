// src/routes/__tests__/admin/genres.test.ts
//
// A3-01: covers genre list/rename/merge/delete. Rename and merge also
// cover A2-01's zod schemas (the shared mergeIdsSchema in particular,
// since it's exercised identically here and in tags.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockSupabase, allowAdmin, rejectAdmin } from './testUtils';

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
vi.mock('../../../middleware/auth', () => ({ requireAdmin: requireAdminMock }));

const { supabase, queue } = mockSupabase();
vi.mock('../../../services/supabase', () => ({ get supabase() { return supabase; } }));

import genresRouter from '../../admin/genres';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/admin/genres', genresRouter);
    return app;
}

beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockImplementation(allowAdmin());
});

describe('GET /admin/genres', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).get('/admin/genres');

        expect(res.status).toBe(403);
    });

    it('returns each genre with its series_count computed from series_genres links', async () => {
        queue('genres', { data: [{ id: 1, name: 'Romance' }, { id: 2, name: 'Comedy' }], error: null });
        queue('series_genres', { data: [{ genre_id: 1 }, { genre_id: 1 }, { genre_id: 2 }], error: null });

        const res = await request(buildApp()).get('/admin/genres');

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([
            { id: 1, name: 'Romance', series_count: 2 },
            { id: 2, name: 'Comedy', series_count: 1 },
        ]);
    });
});

describe('PATCH /admin/genres/:id (A2-01)', () => {
    it('rejects a missing name with 400', async () => {
        const res = await request(buildApp()).patch('/admin/genres/1').send({});

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/name is required/i);
    });

    it('rejects a whitespace-only name with 400', async () => {
        const res = await request(buildApp()).patch('/admin/genres/1').send({ name: '   ' });

        expect(res.status).toBe(400);
    });

    it('returns 404 when the genre does not exist', async () => {
        queue('genres', { data: null, error: null }); // maybeSingle -- not found

        const res = await request(buildApp()).patch('/admin/genres/999').send({ name: 'Drama' });

        expect(res.status).toBe(404);
    });

    it('rejects a rename that collides case-insensitively with another genre', async () => {
        queue('genres', { data: { id: 1 }, error: null }); // exists
        queue('genres', { data: [{ id: 2, name: 'romance' }], error: null }); // siblings

        const res = await request(buildApp()).patch('/admin/genres/1').send({ name: 'Romance' });

        expect(res.status).toBe(409);
        expect(res.body.message).toMatch(/already exists/);
    });

    it('renames on success', async () => {
        queue('genres', { data: { id: 1 }, error: null });
        queue('genres', { data: [{ id: 2, name: 'Comedy' }], error: null });
        queue('genres', { data: { id: 1, name: 'Drama' }, error: null });

        const res = await request(buildApp()).patch('/admin/genres/1').send({ name: 'Drama' });

        expect(res.status).toBe(200);
        expect(res.body.data.name).toBe('Drama');
    });
});

describe('POST /admin/genres/merge (A2-01, shared mergeIdsSchema)', () => {
    it('rejects a missing target_id/source_ids with 400', async () => {
        const res = await request(buildApp()).post('/admin/genres/merge').send({});

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/target_id and at least one distinct source_id/);
    });

    it('returns 404 when one of the involved genres does not exist', async () => {
        queue('genres', { data: [{ id: 1 }], error: null }); // only 1 of 2 found

        const res = await request(buildApp())
            .post('/admin/genres/merge')
            .send({ target_id: 1, source_ids: [2] });

        expect(res.status).toBe(404);
    });

    it('relinks series not already on the target, skips ones that are, then deletes the source genre', async () => {
        queue('genres', { data: [{ id: 1 }, { id: 2 }], error: null }); // involved check
        queue('series_genres', { data: [{ series_id: 100 }], error: null }); // target's existing links
        queue('series_genres', { data: [{ series_id: 100 }, { series_id: 200 }], error: null }); // source's links
        queue('series_genres', { data: null, error: null }); // insert relink (only series 200)
        queue('series_genres', { data: null, error: null }); // delete source links
        queue('genres', { data: null, error: null }); // delete source genre

        const res = await request(buildApp())
            .post('/admin/genres/merge')
            .send({ target_id: 1, source_ids: [2] });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ target_id: 1, merged_ids: [2] });
    });
});

describe('DELETE /admin/genres/:id', () => {
    it('deletes series_genres links before deleting the genre', async () => {
        queue('series_genres', { data: null, error: null });
        queue('genres', { data: null, error: null });

        const res = await request(buildApp()).delete('/admin/genres/1');

        expect(res.status).toBe(200);
    });
});
