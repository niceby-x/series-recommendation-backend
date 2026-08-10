// src/routes/__tests__/me.test.ts
//
// H4-02: covers GET /me -- the new route the greeting fix depends on.
// Confirms it 401s when signed out and returns the user's own row
// (including username, the field the frontend half needs) when signed in.
//
// H2-04: covers GET /me/activity -- merging ratings + watchlist rows
// into one newest-first feed, and that a signed-out request 401s the
// same way GET /me does.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockSupabase } from './admin/testUtils';

vi.mock('../../middleware/auth', () => ({
    getOrCreateUserId: vi.fn(),
}));

const { supabase, queue } = mockSupabase();
vi.mock('../../services/supabase', () => ({ get supabase() { return supabase; } }));

import { getOrCreateUserId } from '../../middleware/auth';
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

    it('merges ratings and watchlist rows, newest first, capped at the limit', async () => {
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

        const res = await request(buildApp()).get('/me/activity');

        expect(res.status).toBe(200);
        // Newest first regardless of which table it came from.
        expect(res.body.data.map((e: any) => e.id)).toEqual(['watchlist:5', 'rating:1', 'watchlist:6']);
        expect(res.body.data[0]).toMatchObject({ kind: 'watchlist', series_title: 'Step by Step', status: 'completed' });
        expect(res.body.data[1]).toMatchObject({ kind: 'rating', series_title: 'Cherry Magic', score: 9 });
    });

    it('falls back to "Unknown series" when the series join comes back empty', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('ratings', {
            data: [{ id: 1, series_id: 10, score: 7, created_at: '2026-08-09T12:00:00.000Z', series: null }],
            error: null,
        });
        queue('user_lists', { data: [], error: null });

        const res = await request(buildApp()).get('/me/activity');

        expect(res.body.data[0].series_title).toBe('Unknown series');
    });

    it('returns 500 if the ratings lookup errors', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('ratings', { data: null, error: { message: 'db down' } });
        queue('user_lists', { data: [], error: null });

        const res = await request(buildApp()).get('/me/activity');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });

    it('returns 500 if the watchlist lookup errors', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        queue('ratings', { data: [], error: null });
        queue('user_lists', { data: null, error: { message: 'db down' } });

        const res = await request(buildApp()).get('/me/activity');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});
