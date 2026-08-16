// src/routes/__tests__/me.test.ts
//
// H4-02: covers GET /me -- the new route the greeting fix depends on.
// Confirms it 401s when signed out and returns the user's own row
// (including username, the field the frontend half needs) when signed in.
//
// H2-04: covers GET /me/activity -- merging ratings + watchlist +
// (H2-02) episode-progress rows into one newest-first feed, and that a
// signed-out request 401s the same way GET /me does.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockSupabase } from './admin/testUtils';

vi.mock('../../middleware/auth', () => ({
    getOrCreateUserId: vi.fn(),
}));

// H2-03: GET /me/gamification delegates entirely to
// getGamificationSummary (unit tested in services/__tests__/gamification.
// test.ts) -- mocked here so this file only asserts the route's own
// auth-gate/pass-through/error-mapping behavior.
vi.mock('../../services/gamification', () => ({ getGamificationSummary: vi.fn() }));

// H3-01: same reasoning as gamification above -- getRecommendationsForUser
// is unit tested in services/__tests__/recommendations.test.ts.
vi.mock('../../services/recommendations', () => ({ getRecommendationsForUser: vi.fn() }));

const { supabase, queue } = mockSupabase();
vi.mock('../../services/supabase', () => ({ get supabase() { return supabase; } }));

import { getOrCreateUserId } from '../../middleware/auth';
import { getGamificationSummary } from '../../services/gamification';
import { getRecommendationsForUser } from '../../services/recommendations';
import meRouter from '../me';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/me', meRouter);
    return app;
}

describe('GET /me', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a signed-out request with 401', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(null);

        const res = await request(buildApp()).get('/me');

        expect(res.status).toBe(401);
        expect(res.body.message).toMatch(/must be signed in/i);
    });

    it('returns the signed-in user\'s own row, including username', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('users', {
            data: {
                id: 42,
                email: 'jamie@example.com',
                username: 'jamie',
                created_at: '2026-01-01T00:00:00.000Z',
                is_admin: false,
            },
            error: null,
        });

        const res = await request(buildApp()).get('/me');

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ id: 42, username: 'jamie' });
    });

    it('returns 500 if the lookup errors', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('users', { data: null, error: { message: 'db down' } });

        const res = await request(buildApp()).get('/me');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});

describe('GET /me/activity (H2-04)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a signed-out request with 401', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(null);

        const res = await request(buildApp()).get('/me/activity');

        expect(res.status).toBe(401);
        expect(res.body.message).toMatch(/must be signed in/i);
    });

    it('merges ratings, watchlist, and progress rows, newest first, capped at the limit', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('ratings', {
            data: [
                { id: 1, series_id: 10, score: 9, created_at: '2026-08-09T12:00:00.000Z', series: { title: 'Cherry Magic' } },
            ],
            error: null,
        });
        queue('user_lists', {
            data: [
                { id: 5, series_id: 20, status: 'completed', updated_at: '2026-08-10T08:00:00.000Z', series: { title: 'Step by Step' } },
                { id: 6, series_id: 30, status: 'plan_to_watch', updated_at: '2026-08-01T00:00:00.000Z', series: { title: 'Old Add' } },
            ],
            error: null,
        });
        queue('user_episode_progress', {
            data: [
                { id: 9, series_id: 40, current_episode: 7, updated_at: '2026-08-11T00:00:00.000Z', series: { title: 'Semantic Error', episode_count: 8 } },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/me/activity');

        expect(res.status).toBe(200);
        // Newest first regardless of which table it came from.
        expect(res.body.data.map((e: any) => e.id)).toEqual(['progress:9', 'watchlist:5', 'rating:1', 'watchlist:6']);
        expect(res.body.data[0]).toMatchObject({
            kind: 'progress',
            series_title: 'Semantic Error',
            current_episode: 7,
            total_episodes: 8,
        });
        expect(res.body.data[1]).toMatchObject({ kind: 'watchlist', series_title: 'Step by Step', status: 'completed' });
        expect(res.body.data[2]).toMatchObject({ kind: 'rating', series_title: 'Cherry Magic', score: 9 });
    });

    it('falls back to "Unknown series" when the series join comes back empty', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('ratings', {
            data: [{ id: 1, series_id: 10, score: 7, created_at: '2026-08-09T12:00:00.000Z', series: null }],
            error: null,
        });
        queue('user_lists', { data: [], error: null });
        queue('user_episode_progress', { data: [], error: null });

        const res = await request(buildApp()).get('/me/activity');

        expect(res.body.data[0].series_title).toBe('Unknown series');
    });

    it('returns 500 if the ratings lookup errors', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('ratings', { data: null, error: { message: 'db down' } });
        queue('user_lists', { data: [], error: null });
        queue('user_episode_progress', { data: [], error: null });

        const res = await request(buildApp()).get('/me/activity');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });

    it('returns 500 if the watchlist lookup errors', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('ratings', { data: [], error: null });
        queue('user_lists', { data: null, error: { message: 'db down' } });
        queue('user_episode_progress', { data: [], error: null });

        const res = await request(buildApp()).get('/me/activity');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });

    it('returns 500 if the progress lookup errors', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('ratings', { data: [], error: null });
        queue('user_lists', { data: [], error: null });
        queue('user_episode_progress', { data: null, error: { message: 'db down' } });

        const res = await request(buildApp()).get('/me/activity');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});

describe('GET /me/gamification (H2-03)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a signed-out request with 401', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(null);

        const res = await request(buildApp()).get('/me/gamification');

        expect(res.status).toBe(401);
        expect(res.body.message).toMatch(/must be signed in/i);
    });

    it('returns the getGamificationSummary result for a signed-in user', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        vi.mocked(getGamificationSummary).mockResolvedValue({
            level: 12,
            label: 'Devoted Reader',
            xp: 620,
            xp_to_next: 900,
            total_xp: 4620,
            current_streak_days: 5,
            longest_streak_days: 9,
            week: [],
            week_completed_count: 5,
            week_goal: 7,
        } as any);

        const res = await request(buildApp()).get('/me/gamification');

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ level: 12, xp: 620, week_completed_count: 5 });
        expect(getGamificationSummary).toHaveBeenCalledWith(42);
    });

    it('returns 500 if the summary lookup throws', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        vi.mocked(getGamificationSummary).mockRejectedValue(new Error('db down'));

        const res = await request(buildApp()).get('/me/gamification');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});

describe('GET /me/notifications (G3-01)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a signed-out request with 401', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(null);

        const res = await request(buildApp()).get('/me/notifications');

        expect(res.status).toBe(401);
        expect(res.body.message).toMatch(/must be signed in/i);
    });

    it('treats a never-opened bell (null notifications_seen_at) as everything with a real bump being unread', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('users', { data: { notifications_seen_at: null }, error: null });
        queue('user_lists', {
            data: [
                {
                    series_id: 10,
                    series: {
                        id: 10,
                        title: 'Semantic Error',
                        poster_url: '/semantic-error.jpg',
                        episode_count: 9,
                        episode_count_updated_at: '2026-08-10T00:00:00.000Z',
                    },
                },
                {
                    series_id: 20,
                    series: {
                        id: 20,
                        title: 'Never Bumped',
                        poster_url: null,
                        episode_count: 12,
                        episode_count_updated_at: null,
                    },
                },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/me/notifications');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
        expect(res.body.data).toEqual([
            {
                series_id: 10,
                series_title: 'Semantic Error',
                poster_url: '/semantic-error.jpg',
                episode_count: 9,
                episode_count_updated_at: '2026-08-10T00:00:00.000Z',
            },
        ]);
    });

    it('only includes series bumped after notifications_seen_at, newest first', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('users', { data: { notifications_seen_at: '2026-08-05T00:00:00.000Z' }, error: null });
        queue('user_lists', {
            data: [
                {
                    series_id: 1,
                    series: {
                        id: 1,
                        title: 'Bumped Before Seen',
                        poster_url: null,
                        episode_count: 4,
                        episode_count_updated_at: '2026-08-01T00:00:00.000Z',
                    },
                },
                {
                    series_id: 2,
                    series: {
                        id: 2,
                        title: 'Older Bump After Seen',
                        poster_url: null,
                        episode_count: 6,
                        episode_count_updated_at: '2026-08-06T00:00:00.000Z',
                    },
                },
                {
                    series_id: 3,
                    series: {
                        id: 3,
                        title: 'Newest Bump After Seen',
                        poster_url: null,
                        episode_count: 8,
                        episode_count_updated_at: '2026-08-12T00:00:00.000Z',
                    },
                },
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/me/notifications');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);
        expect(res.body.data.map((n: any) => n.series_id)).toEqual([3, 2]);
    });

    it('returns 500 if the user lookup errors', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('users', { data: null, error: { message: 'db down' } });

        const res = await request(buildApp()).get('/me/notifications');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });

    it('returns 500 if the watchlist lookup errors', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('users', { data: { notifications_seen_at: null }, error: null });
        queue('user_lists', { data: null, error: { message: 'db down' } });

        const res = await request(buildApp()).get('/me/notifications');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});

describe('POST /me/notifications/seen (G3-01)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a signed-out request with 401', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(null);

        const res = await request(buildApp()).post('/me/notifications/seen');

        expect(res.status).toBe(401);
        expect(res.body.message).toMatch(/must be signed in/i);
    });

    it('marks notifications as seen for a signed-in user', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('users', { data: null, error: null });

        const res = await request(buildApp()).post('/me/notifications/seen');

        expect(res.status).toBe(200);
        expect(res.body.message).toMatch(/marked as seen/i);
    });

    it('returns 500 if the update errors', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('users', { data: null, error: { message: 'db down' } });

        const res = await request(buildApp()).post('/me/notifications/seen');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});

describe('GET /me/recommendations (H3-01)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a signed-out request with 401', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(null);

        const res = await request(buildApp()).get('/me/recommendations');

        expect(res.status).toBe(401);
        expect(res.body.message).toMatch(/must be signed in/i);
    });

    it('passes through has_enough_signal: false for a cold-start user', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        vi.mocked(getRecommendationsForUser).mockResolvedValue({ has_enough_signal: false, data: [] });

        const res = await request(buildApp()).get('/me/recommendations');

        expect(res.status).toBe(200);
        expect(res.body.has_enough_signal).toBe(false);
        expect(res.body.data).toEqual([]);
    });

    it('returns scored recommendations for a user with signal', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        vi.mocked(getRecommendationsForUser).mockResolvedValue({
            has_enough_signal: true,
            data: [
                { id: 3, title: 'Strong Match', poster_url: null, year: 2025, country: 'TH', score: 14, match_reasons: ['Enemies to Lovers'] },
            ],
        });

        const res = await request(buildApp()).get('/me/recommendations?limit=5');

        expect(res.status).toBe(200);
        expect(res.body.has_enough_signal).toBe(true);
        expect(res.body.data[0]).toMatchObject({ id: 3, title: 'Strong Match' });
        expect(getRecommendationsForUser).toHaveBeenCalledWith(42, 5);
    });

    it('returns 500 if the recommendation lookup throws', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        vi.mocked(getRecommendationsForUser).mockRejectedValue(new Error('db down'));

        const res = await request(buildApp()).get('/me/recommendations');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});
