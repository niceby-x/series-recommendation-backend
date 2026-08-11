// src/routes/__tests__/watchlist-progress.test.ts
//
// H2-02: covers the new episode-progress surface on the watchlist router
// -- PUT /:seriesId/progress (validation + upsert) and GET /'s progress
// embed (merged in from the separate user_episode_progress table, since
// it isn't FK-linked to user_lists -- see watchlist.ts's own comments).
// Uses the shared mockSupabase/queue helper since GET / now makes two
// sequential .from() calls that need to resolve independently.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockSupabase } from './admin/testUtils';

vi.mock('../../middleware/auth', () => ({
    getOrCreateUserId: vi.fn(),
}));

vi.mock('../../services/gamification', () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));

const { supabase, queue } = mockSupabase();
vi.mock('../../services/supabase', () => ({ get supabase() { return supabase; } }));

import { getOrCreateUserId } from '../../middleware/auth';
import watchlistRouter from '../watchlist';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/watchlist', watchlistRouter);
    return app;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOrCreateUserId).mockResolvedValue(42);
});

describe('PUT /watchlist/:seriesId/progress', () => {
    it('rejects a signed-out request with 401', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(null);

        const res = await request(buildApp()).put('/watchlist/10/progress').send({ current_episode: 3 });

        expect(res.status).toBe(401);
    });

    it('rejects a missing current_episode with 400', async () => {
        const res = await request(buildApp()).put('/watchlist/10/progress').send({});

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/current_episode is required/i);
    });

    it('rejects a non-positive current_episode with 400', async () => {
        const res = await request(buildApp()).put('/watchlist/10/progress').send({ current_episode: 0 });

        expect(res.status).toBe(400);
    });

    it('upserts and returns 200, with minutes_remaining defaulting to null when omitted', async () => {
        queue('user_episode_progress', {
            data: [{ id: 1, user_id: 42, series_id: 10, current_episode: 4, minutes_remaining: null }],
            error: null,
        });

        const res = await request(buildApp()).put('/watchlist/10/progress').send({ current_episode: 4 });

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ series_id: 10, current_episode: 4, minutes_remaining: null });
    });

    it('accepts an explicit minutes_remaining', async () => {
        queue('user_episode_progress', {
            data: [{ id: 1, user_id: 42, series_id: 10, current_episode: 4, minutes_remaining: 18 }],
            error: null,
        });

        const res = await request(buildApp()).put('/watchlist/10/progress').send({ current_episode: 4, minutes_remaining: 18 });

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ minutes_remaining: 18 });
    });

    it('returns 500 if the upsert errors', async () => {
        queue('user_episode_progress', { data: null, error: { message: 'db down' } });

        const res = await request(buildApp()).put('/watchlist/10/progress').send({ current_episode: 4 });

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});

describe('GET /watchlist (progress embed, H2-02)', () => {
    it('rejects a signed-out request with 401', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(null);

        const res = await request(buildApp()).get('/watchlist');

        expect(res.status).toBe(401);
    });

    it('attaches progress for series that have it, and null for series that don\'t', async () => {
        queue('user_lists', {
            data: [
                { id: 1, status: 'watching', updated_at: '2026-08-10T00:00:00.000Z', series: { id: 10, title: 'Semantic Error', episode_count: 8 } },
                { id: 2, status: 'plan_to_watch', updated_at: '2026-08-01T00:00:00.000Z', series: { id: 20, title: 'Not Started', episode_count: 12 } },
            ],
            error: null,
        });
        queue('user_episode_progress', {
            data: [
                { series_id: 10, current_episode: 7, minutes_remaining: 18, updated_at: '2026-08-11T00:00:00.000Z' },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/watchlist');

        expect(res.status).toBe(200);
        const withProgress = res.body.data.find((row: any) => row.series.id === 10);
        const withoutProgress = res.body.data.find((row: any) => row.series.id === 20);

        expect(withProgress.progress).toMatchObject({ current_episode: 7, total_episodes: 8, minutes_remaining: 18 });
        expect(withoutProgress.progress).toBeNull();
    });

    it('returns 500 if the progress lookup errors', async () => {
        queue('user_lists', { data: [], error: null });
        queue('user_episode_progress', { data: null, error: { message: 'db down' } });

        const res = await request(buildApp()).get('/watchlist');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});
