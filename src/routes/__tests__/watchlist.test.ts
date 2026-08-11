// src/routes/__tests__/watchlist.test.ts
//
// P2-03: covers the new zod schema on POST /watchlist -- same cases the
// old ad hoc if-check covered (missing series_id, missing/invalid status),
// plus confirming a valid request still reaches the upsert.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../middleware/auth', () => ({
    getOrCreateUserId: vi.fn(),
}));

// H2-03: same reasoning as ratings.test.ts's own comment -- POST
// /watchlist fires-and-forgets a gamification call after a successful
// upsert, mocked here so these tests don't depend on it or hit
// unmocked supabase calls.
vi.mock('../../services/gamification', () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));

const upsertSelectMock = vi.fn();

vi.mock('../../services/supabase', () => ({
    supabase: {
        from: vi.fn(() => ({
            upsert: vi.fn(() => ({
                select: upsertSelectMock,
            })),
        })),
    },
}));

import { getOrCreateUserId } from '../../middleware/auth';
import watchlistRouter from '../watchlist';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/watchlist', watchlistRouter);
    return app;
}

describe('POST /watchlist', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
    });

    it('rejects a missing series_id with 400', async () => {
        const res = await request(buildApp())
            .post('/watchlist')
            .send({ status: 'watching' });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/series_id and a valid status/i);
    });

    it('rejects an invalid status with 400', async () => {
        const res = await request(buildApp())
            .post('/watchlist')
            .send({ series_id: 1, status: 'bogus' });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/series_id and a valid status/i);
    });

    it('upserts and returns 200 on a valid submission', async () => {
        upsertSelectMock.mockResolvedValue({
            data: [{ id: 1, user_id: 42, series_id: 1, status: 'watching' }],
            error: null,
        });

        const res = await request(buildApp())
            .post('/watchlist')
            .send({ series_id: 1, status: 'watching' });

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ series_id: 1, status: 'watching' });
    });
});
