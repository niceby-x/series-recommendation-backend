// src/routes/__tests__/admin/candidates.test.ts
//
// A3-01: covers the candidate review queue -- especially A1-01 (restore
// cleaning up every FK-dependent table before deleting a series), A1-02
// (reject removing an approved candidate's published series), and A2-03
// (opt-in pagination on the list route). approve is covered for the
// requireAdmin gate and the "candidate not found" path; its full
// insert-series-then-link-genres/cast/tags happy path is exercised with
// empty genre_names/cast_json/tags so the loops are no-ops -- the loop
// bodies themselves are logged-and-continue on failure (see the route's
// own comments) rather than branching logic worth a dedicated test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockSupabase, allowAdmin, rejectAdmin } from './testUtils';

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
const { logAdminActionMock } = vi.hoisted(() => ({ logAdminActionMock: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../../../middleware/auth', () => ({ requireAdmin: requireAdminMock }));
vi.mock('../../../services/auditLog', () => ({ logAdminAction: logAdminActionMock }));

const { supabase, queue } = mockSupabase();
vi.mock('../../../services/supabase', () => ({ get supabase() { return supabase; } }));

import candidatesRouter from '../../admin/candidates';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/admin/candidates', candidatesRouter);
    return app;
}

beforeEach(() => {
    vi.clearAllMocks();
    logAdminActionMock.mockResolvedValue(undefined);
});

describe('GET /admin/candidates', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).get('/admin/candidates');

        expect(res.status).toBe(403);
    });

    it('defaults to status=pending and returns an unpaginated shape when no page/limit given', async () => {
        requireAdminMock.mockImplementation(allowAdmin());
        queue('series_candidates', {
            data: [{ id: 1, title: 'Show A', review_status: 'pending', series_candidate_tags: [{ tag_id: 5 }] }],
            error: null,
        });

        const res = await request(buildApp()).get('/admin/candidates');

        expect(res.status).toBe(200);
        expect(res.body.data[0].tag_ids).toEqual([5]);
        expect(res.body.data[0].series_candidate_tags).toBeUndefined();
        expect(res.body.pagination).toBeUndefined();
    });

    it('includes a pagination envelope when page/limit are passed (A2-03)', async () => {
        requireAdminMock.mockImplementation(allowAdmin());
        queue('series_candidates', {
            data: [{ id: 1, title: 'Show A', review_status: 'pending', series_candidate_tags: [] }],
            error: null,
            count: 45,
        });

        const res = await request(buildApp()).get('/admin/candidates?page=2&limit=20');

        expect(res.status).toBe(200);
        expect(res.body.pagination).toEqual({ page: 2, limit: 20, total: 45, has_more: true });
    });
});

describe('POST /admin/candidates/:id/reject (A1-02)', () => {
    beforeEach(() => {
        requireAdminMock.mockImplementation(allowAdmin());
    });

    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).post('/admin/candidates/1/reject');

        expect(res.status).toBe(403);
    });

    it('returns 404 when the candidate does not exist', async () => {
        queue('series_candidates', { data: null, error: { message: 'not found' } });

        const res = await request(buildApp()).post('/admin/candidates/999/reject');

        expect(res.status).toBe(404);
    });

    it('just flips review_status when the candidate was never approved (no series to remove)', async () => {
        queue('series_candidates', { data: { id: 1, review_status: 'pending', tmdb_id: 555 }, error: null });
        queue('series_candidates', { data: null, error: null }); // the update

        const res = await request(buildApp()).post('/admin/candidates/1/reject');

        expect(res.status).toBe(200);
        expect(logAdminActionMock).toHaveBeenCalledWith(expect.anything(), 'candidate.reject', 'candidate:1');
    });

    it('removes the published series and its FK dependents when the candidate was approved', async () => {
        queue('series_candidates', { data: { id: 1, review_status: 'approved', tmdb_id: 555 }, error: null });
        queue('series', { data: { id: 42 }, error: null }); // series lookup by tmdb_id
        // cleanupTables loop -- one queued success per table, in the exact order the route deletes them
        for (const table of ['series_genres', 'series_cast', 'series_tags', 'ratings', 'user_lists', 'curator_picks', 'collection_series', 'series_rank_snapshots']) {
            queue(table, { data: null, error: null });
        }
        queue('series', { data: null, error: null }); // the series delete itself
        queue('series_candidates', { data: null, error: null }); // the review_status update

        const res = await request(buildApp()).post('/admin/candidates/1/reject');

        expect(res.status).toBe(200);
        expect(logAdminActionMock).toHaveBeenCalledWith(expect.anything(), 'candidate.reject', 'candidate:1');
    });

    it('surfaces a 500 if cleaning up a dependent table fails, without deleting the series', async () => {
        queue('series_candidates', { data: { id: 1, review_status: 'approved', tmdb_id: 555 }, error: null });
        queue('series', { data: { id: 42 }, error: null });
        queue('series_genres', { data: null, error: { message: 'fk violation' } });

        const res = await request(buildApp()).post('/admin/candidates/1/reject');

        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/series_genres/);
    });
});

describe('POST /admin/candidates/:id/restore (A1-01)', () => {
    beforeEach(() => {
        requireAdminMock.mockImplementation(allowAdmin());
    });

    it('returns 404 when the candidate does not exist', async () => {
        queue('series_candidates', { data: null, error: { message: 'not found' } });

        const res = await request(buildApp()).post('/admin/candidates/999/restore');

        expect(res.status).toBe(404);
    });

    it('cleans up ratings/user_lists/curator_picks/collection_series before deleting the series, then restores to pending', async () => {
        queue('series_candidates', { data: { id: 1, review_status: 'approved', tmdb_id: 555 }, error: null });
        queue('series', { data: { id: 42 }, error: null });
        for (const table of ['series_genres', 'series_cast', 'series_tags', 'ratings', 'user_lists', 'curator_picks', 'collection_series', 'series_rank_snapshots']) {
            queue(table, { data: null, error: null });
        }
        queue('series', { data: null, error: null });
        queue('series_candidates', { data: null, error: null });

        const res = await request(buildApp()).post('/admin/candidates/1/restore');

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Restored to pending');
        expect(logAdminActionMock).toHaveBeenCalledWith(expect.anything(), 'candidate.restore', 'candidate:1');
    });

    it('skips the cleanup/delete entirely when the candidate was never approved', async () => {
        queue('series_candidates', { data: { id: 1, review_status: 'pending', tmdb_id: 555 }, error: null });
        queue('series_candidates', { data: null, error: null }); // just the restore update

        const res = await request(buildApp()).post('/admin/candidates/1/restore');

        expect(res.status).toBe(200);
    });
});

describe('POST /admin/candidates/:id/approve', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).post('/admin/candidates/1/approve');

        expect(res.status).toBe(403);
    });

    it('returns 404 when the candidate does not exist', async () => {
        requireAdminMock.mockImplementation(allowAdmin());
        queue('series_candidates', { data: null, error: { message: 'not found' } });

        const res = await request(buildApp()).post('/admin/candidates/999/approve');

        expect(res.status).toBe(404);
    });

    it('creates the series and marks the candidate approved when genres/cast/tags are all empty', async () => {
        requireAdminMock.mockImplementation(allowAdmin());
        queue('series_candidates', {
            data: { id: 1, title: 'Show A', genre_names: [], cast_json: [], tmdb_id: 555 },
            error: null,
        });
        queue('series', { data: { id: 42 }, error: null }); // insert into series
        queue('series_candidate_tags', { data: [], error: null }); // tagsToCopy fetch
        queue('series_candidates', { data: null, error: null }); // final update to approved

        const res = await request(buildApp()).post('/admin/candidates/1/approve');

        expect(res.status).toBe(200);
        expect(logAdminActionMock).toHaveBeenCalledWith(expect.anything(), 'candidate.approve', 'candidate:1');
    });
});

describe('PATCH /admin/candidates/:id/taxonomy', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).patch('/admin/candidates/1/taxonomy').send({});

        expect(res.status).toBe(403);
    });

    it('rejects a non-string romance_pace with 400', async () => {
        requireAdminMock.mockImplementation(allowAdmin());

        const res = await request(buildApp())
            .patch('/admin/candidates/1/taxonomy')
            .send({ romance_pace: 42 });

        expect(res.status).toBe(400);
    });

    it('rejects a romance_pace value outside the Taxonomy v1 enum with 400', async () => {
        requireAdminMock.mockImplementation(allowAdmin());

        const res = await request(buildApp())
            .patch('/admin/candidates/1/taxonomy')
            .send({ romance_pace: 'slowburn' }); // real value is 'slow_burn'

        expect(res.status).toBe(400);
    });

    it('accepts a valid enum value for every taxonomy field, and null to explicitly clear one', async () => {
        requireAdminMock.mockImplementation(allowAdmin());
        queue('series_candidates', { data: null, error: null }); // attributeUpdate

        const res = await request(buildApp())
            .patch('/admin/candidates/1/taxonomy')
            .send({
                romance_pace: 'slow_burn',
                emotional_intensity: null, // legitimately nullable per the spec ("genuinely unreviewed")
                ending_type: 'bittersweet',
                content_level: 'mature',
            });

        expect(res.status).toBe(200);
    });

    it('rejects a tag_ids array containing a non-number with 400', async () => {
        requireAdminMock.mockImplementation(allowAdmin());

        const res = await request(buildApp())
            .patch('/admin/candidates/1/taxonomy')
            .send({ tag_ids: [1, 'two', 3] });

        expect(res.status).toBe(400);
    });

    it('is a no-op (200) when the body has no attribute fields and no tag_ids', async () => {
        requireAdminMock.mockImplementation(allowAdmin());

        const res = await request(buildApp()).patch('/admin/candidates/1/taxonomy').send({});

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Taxonomy saved');
    });

    it('diffs and applies only the tag additions/removals needed to reach the desired tag_ids', async () => {
        requireAdminMock.mockImplementation(allowAdmin());
        queue('series_candidate_tags', { data: [{ tag_id: 1 }, { tag_id: 2 }], error: null }); // existing
        queue('series_candidate_tags', { data: null, error: null }); // insert (tag 3)
        queue('series_candidate_tags', { data: null, error: null }); // delete (tag 2)

        const res = await request(buildApp())
            .patch('/admin/candidates/1/taxonomy')
            .send({ tag_ids: [1, 3] });

        expect(res.status).toBe(200);
    });
});
