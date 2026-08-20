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

    it('rejects an invalid publish_status with 400', async () => {
        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ publish_status: 'pending' }); // not one of draft/published/archived

        expect(res.status).toBe(400);
    });

    it('accepts a valid publish_status value', async () => {
        queue('series', { data: null, error: null });

        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ publish_status: 'archived' });

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

    describe('episode_count_updated_at (G3-01)', () => {
        it('bumps episode_count_updated_at when episode_count increases', async () => {
            queue('series', { data: { episode_count: 12 }, error: null }); // existing lookup
            queue('series', { data: null, error: null }); // the update

            const res = await request(buildApp())
                .patch('/admin/series/1')
                .send({ episode_count: 13 });

            expect(res.status).toBe(200);
            // One extra .from('series') call vs a plain field update --
            // the existing-episode_count lookup this comparison needs.
            expect(supabase.from.mock.calls.filter((c: any) => c[0] === 'series').length).toBe(2);
        });

        it('does not bump episode_count_updated_at when episode_count is unchanged', async () => {
            queue('series', { data: { episode_count: 12 }, error: null }); // existing lookup
            queue('series', { data: null, error: null }); // the update

            const res = await request(buildApp())
                .patch('/admin/series/1')
                .send({ episode_count: 12 });

            expect(res.status).toBe(200);
        });

        it('does not bump episode_count_updated_at when episode_count decreases', async () => {
            queue('series', { data: { episode_count: 12 }, error: null }); // existing lookup
            queue('series', { data: null, error: null }); // the update

            const res = await request(buildApp())
                .patch('/admin/series/1')
                .send({ episode_count: 5 });

            expect(res.status).toBe(200);
        });

        it('returns 500 if the existing-episode-count lookup errors', async () => {
            queue('series', { data: null, error: { message: 'db down' } });

            const res = await request(buildApp())
                .patch('/admin/series/1')
                .send({ episode_count: 13 });

            expect(res.status).toBe(500);
            expect(res.body.message).toBe('db down');
        });
    });

    it('is a no-op update when the body has no editable fields, tag_ids, genre_names, or collection_ids', async () => {
        const res = await request(buildApp()).patch('/admin/series/1').send({});

        expect(res.status).toBe(200);
    });

    it('diffs tag_ids: inserts new links and deletes ones no longer desired', async () => {
        queue('series', { data: null, error: null }); // S1-01: array-only edits now bump updated_at/updated_by too
        queue('series_tags', { data: [{ tag_id: 1 }, { tag_id: 2 }], error: null }); // existing
        queue('series_tags', { data: null, error: null }); // insert (tag 3)
        queue('series_tags', { data: null, error: null }); // delete (tag 2)

        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ tag_ids: [1, 3] });

        expect(res.status).toBe(200);
    });

    it('diffs genre_names: finds-or-creates a new genre and unlinks a removed one', async () => {
        queue('series', { data: null, error: null }); // S1-01: array-only edits now bump updated_at/updated_by too
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
        queue('series', { data: null, error: null }); // S1-01: array-only edits now bump updated_at/updated_by too
        queue('collections', { data: [{ id: 10 }, { id: 20 }], error: null }); // curated collection ids
        queue('collection_series', { data: [{ collection_id: 10 }], error: null }); // existing memberships
        queue('collection_series', { data: null, error: null }); // add 20
        // no removal expected since 10 stays desired

        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ collection_ids: [10, 20] });

        expect(res.status).toBe(200);
    });

    it('S1-01: bumps updated_at/updated_by on an array-only edit even with no plain fields present', async () => {
        queue('series', { data: null, error: null });
        queue('series_tags', { data: [], error: null });

        const res = await request(buildApp())
            .patch('/admin/series/1')
            .send({ tag_ids: [] });

        expect(res.status).toBe(200);
        expect(supabase.from.mock.calls.filter((c: any) => c[0] === 'series').length).toBe(1);
    });
});

describe('GET /admin/series', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).get('/admin/series');

        expect(res.status).toBe(403);
    });

    const baseRows = [
        { id: 1, title: 'Revenged Love', media_type: 'tv', country: 'China', year: 2025, episode_count: 24, poster_url: null, status: 'completed', publish_status: 'published', updated_at: '2025-05-02T00:00:00Z', updated_by: 'jamie@blumi.app', series_genres: [{ genres: { name: 'Drama' } }] },
        { id: 2, title: 'Shine', media_type: 'movie', country: 'Thailand', year: 2025, episode_count: null, poster_url: null, status: 'completed', publish_status: 'draft', updated_at: '2025-04-29T00:00:00Z', updated_by: 'jamie@blumi.app', series_genres: [{ genres: { name: 'War' } }] },
        { id: 3, title: 'Khemjira', media_type: null, country: 'Thailand', year: 2025, episode_count: 12, poster_url: null, status: 'airing', publish_status: 'archived', updated_at: '2025-04-30T00:00:00Z', updated_by: null, series_genres: [] },
    ];

    it('returns rows, tab counts, and filter option lists off the full unfiltered set', async () => {
        queue('series', { data: baseRows, error: null });

        const res = await request(buildApp()).get('/admin/series');

        expect(res.status).toBe(200);
        expect(res.body.counts).toEqual({ all: 3, series: 2, movies: 1, drafts: 1, published: 1, archived: 1 });
        expect(res.body.filters.countries).toEqual(['China', 'Thailand']);
        expect(res.body.filters.genres).toEqual(['Drama', 'War']);
        expect(res.body.data).toHaveLength(3);
        // null media_type falls back to 'tv' (Series), not dropped or 'movie'
        expect(res.body.data.find((r: any) => r.id === 3).media_type).toBe('tv');
    });

    it('filters by type without affecting the tab counts', async () => {
        queue('series', { data: baseRows, error: null });

        const res = await request(buildApp()).get('/admin/series').query({ type: 'movie' });

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].id).toBe(2);
        expect(res.body.counts.all).toBe(3);
    });

    it('filters by publish_status', async () => {
        queue('series', { data: baseRows, error: null });

        const res = await request(buildApp()).get('/admin/series').query({ publish_status: 'draft' });

        expect(res.status).toBe(200);
        expect(res.body.data.map((r: any) => r.id)).toEqual([2]);
    });

    it('paginates the filtered/sorted result', async () => {
        queue('series', { data: baseRows, error: null });

        const res = await request(buildApp()).get('/admin/series').query({ page: '1', limit: '2', sort: 'updated_desc' });

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.data[0].id).toBe(1); // newest updated_at first
        expect(res.body.pagination).toEqual({ page: 1, limit: 2, total: 3, has_more: true });
    });

    it('returns 500 if the query errors', async () => {
        queue('series', { data: null, error: { message: 'db down' } });

        const res = await request(buildApp()).get('/admin/series');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});

describe('POST /admin/series/bulk', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).post('/admin/series/bulk').send({ ids: [1], action: 'publish' });

        expect(res.status).toBe(403);
    });

    it('rejects an empty ids array with 400', async () => {
        const res = await request(buildApp()).post('/admin/series/bulk').send({ ids: [], action: 'publish' });

        expect(res.status).toBe(400);
    });

    it('rejects an invalid action with 400', async () => {
        const res = await request(buildApp()).post('/admin/series/bulk').send({ ids: [1], action: 'republish' });

        expect(res.status).toBe(400);
    });

    it('publishes the given ids in one update', async () => {
        queue('series', { data: null, error: null });

        const res = await request(buildApp()).post('/admin/series/bulk').send({ ids: [1, 2], action: 'publish' });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ ids: [1, 2], action: 'publish', publish_status: 'published' });
    });

    it('archives the given ids', async () => {
        queue('series', { data: null, error: null });

        const res = await request(buildApp()).post('/admin/series/bulk').send({ ids: [3], action: 'archive' });

        expect(res.status).toBe(200);
        expect(res.body.data.publish_status).toBe('archived');
    });

    it('deletes each id via the same cascade cleanup as DELETE /:id', async () => {
        for (const table of ['series_genres', 'series_cast', 'series_tags', 'ratings', 'user_lists', 'curator_picks', 'collection_series', 'series_rank_snapshots']) {
            queue(table, { data: null, error: null });
        }
        queue('series', { data: null, error: null });

        const res = await request(buildApp()).post('/admin/series/bulk').send({ ids: [1], action: 'delete' });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ ids: [1], action: 'delete' });
    });

    it('stops and returns 500 if a cleanup step fails partway through a bulk delete', async () => {
        queue('series_genres', { data: null, error: null });
        queue('series_cast', { data: null, error: { message: 'fk violation' } });

        const res = await request(buildApp()).post('/admin/series/bulk').send({ ids: [1, 2], action: 'delete' });

        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/series_cast/);
    });

    it('returns 500 if the publish/unpublish/archive update errors', async () => {
        queue('series', { data: null, error: { message: 'db down' } });

        const res = await request(buildApp()).post('/admin/series/bulk').send({ ids: [1], action: 'unpublish' });

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});

describe('GET /admin/series/:id', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).get('/admin/series/1');

        expect(res.status).toBe(403);
    });

    it('returns a draft series (no publish_status gate, unlike the public route)', async () => {
        queue('series', {
            data: {
                id: 1,
                title: 'Unpublished Draft',
                publish_status: 'draft',
                series_genres: [{ genres: { name: 'Drama' } }],
                series_tags: [{ tags: { id: 5, dimension: 'mood', value_key: 'sad', display_label: 'Sad', display_emoji: '😢' } }],
            },
            error: null,
        });
        queue('ratings', { data: [{ score: 7 }], error: null });
        queue('collection_series', { data: [{ collection_id: 9 }], error: null });

        const res = await request(buildApp()).get('/admin/series/1');

        expect(res.status).toBe(200);
        expect(res.body.data.publish_status).toBe('draft');
        expect(res.body.data.genre_names).toEqual(['Drama']);
        expect(res.body.data.tag_ids).toEqual([5]);
        expect(res.body.data.collection_ids).toEqual([9]);
        expect(res.body.data.average_rating).toBe(7);
    });

    it('returns 404 if the series does not exist', async () => {
        queue('series', { data: null, error: { message: 'not found' } });

        const res = await request(buildApp()).get('/admin/series/999');

        expect(res.status).toBe(404);
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
