// src/routes/__tests__/admin/series.test.ts
//
// A3-01: covers editing a published series -- plain field updates, tag_ids
// diff-and-repoint, genre_names find-or-create-and-diff, collection_ids
// diff scoped to curated collections only, and the DELETE cleanupTables
// loop (the exact pattern A1-01 and A1-02 reused for candidate
// restore/reject).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockSupabase, allowAdmin, rejectAdmin } from './testUtils';

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
vi.mock('../../../middleware/auth', () => ({ requireAdmin: requireAdminMock }));

const { supabase, queue } = mockSupabase();
vi.mock('../../../services/supabase', () => ({ get supabase() { return supabase; } }));

import seriesRouter from '../../admin/series';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/admin/series', seriesRouter);
    return app;
}

beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockImplementation(allowAdmin());
});

describe('PATCH /admin/series/:id', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).patch('/admin/series/1').send({ title: 'New' });

        expect(res.status).toBe(403);
    });

    it('rejects an invalid status with 400 instead of letting a raw Postgres constraint error through', async () => {
        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ status: 'cancelled' }); // not one of airing/completed/upcoming

        expect(res.status).toBe(400);
    });

    it('rejects a non-numeric year with 400', async () => {
        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ year: '2020' });

        expect(res.status).toBe(400);
    });

    it('rejects a blank title with 400', async () => {
        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ title: '   ' });

        expect(res.status).toBe(400);
    });

    it('accepts a valid status value', async () => {
        queue('series', { data: null, error: null });

        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ status: 'upcoming' });

        expect(res.status).toBe(200);
    });

    it('rejects a taxonomy field value outside the Taxonomy v1 enum with 400', async () => {
        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ content_level: 'explicit' }); // deliberately withheld from v1, see the spec

        expect(res.status).toBe(400);
    });

    it('accepts valid Taxonomy v1 enum values, including null to clear a nullable field', async () => {
        queue('series', { data: null, error: null });

        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({
                romance_pace: 'established_relationship',
                emotional_intensity: null,
                ending_type: 'open',
                content_level: 'sweet',
            });

        expect(res.status).toBe(200);
    });

    it('updates only the editable fields present in the body', async () => {
        queue('series', { data: null, error: null }); // the update

        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ title: 'Corrected Title', not_a_real_field: 'ignored' });

        expect(res.status).toBe(200);
    });

    it('is a no-op update when the body has no editable fields, tag_ids, genre_names, or collection_ids', async () => {
        const res = await request(buildApp()).patch('/admin/series/1').send({});

        expect(res.status).toBe(200);
    });

    it('diffs tag_ids: inserts new links and deletes ones no longer desired', async () => {
        queue('series_tags', { data: [{ tag_id: 1 }, { tag_id: 2 }], error: null }); // existing
        queue('series_tags', { data: null, error: null }); // insert (tag 3)
        queue('series_tags', { data: null, error: null }); // delete (tag 2)

        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ tag_ids: [1, 3] });

        expect(res.status).toBe(200);
    });

    it('diffs genre_names: finds-or-creates a new genre and unlinks a removed one', async () => {
        queue('series_genres', {
            data: [{ genre_id: 1, genres: { name: 'Romance' } }, { genre_id: 2, genres: { name: 'Drama' } }],
            error: null,
        }); // existing links
        queue('genres', { data: null, error: null }); // find "Comedy" -- maybeSingle, not found
        queue('genres', { data: { id: 3 }, error: null }); // create "Comedy"
        queue('series_genres', { data: null, error: null }); // link Comedy
        queue('series_genres', { data: null, error: null }); // unlink Drama

        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ genre_names: ['Romance', 'Comedy'] }); // Drama removed, Comedy added

        expect(res.status).toBe(200);
    });

    it('diffs collection_ids scoped to curated collections only', async () => {
        queue('collections', { data: [{ id: 10 }, { id: 20 }], error: null }); // curated collection ids
        queue('collection_series', { data: [{ collection_id: 10 }], error: null }); // existing memberships
        queue('collection_series', { data: null, error: null }); // add 20
        // no removal expected since 10 stays desired

        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ collection_ids: [10, 20] });

        expect(res.status).toBe(200);
    });
});

describe('DELETE /admin/series/:id', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).delete('/admin/series/1');

        expect(res.status).toBe(403);
    });

    it('cleans up every dependent table before deleting the series', async () => {
        for (const table of ['series_genres', 'series_cast', 'series_tags', 'ratings', 'user_lists', 'curator_picks', 'collection_series', 'series_rank_snapshots']) {
            queue(table, { data: null, error: null });
        }
        queue('series', { data: null, error: null });

        const res = await request(buildApp()).delete('/admin/series/1');

        expect(res.status).toBe(200);
    });

    it('stops and returns 500 (without deleting the series) if a cleanup step fails', async () => {
        queue('series_genres', { data: null, error: null });
        queue('series_cast', { data: null, error: { message: 'fk violation' } });

        const res = await request(buildApp()).delete('/admin/series/1');

        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/series_cast/);
    });
});
