// src/routes/__tests__/ratings.test.ts
//
// P4-06: first real test coverage in this repo. Scoped to the ratings
// router since it's small, self-contained, and carries the most
// recently-added business logic worth locking in (P1-05's upsert +
// prefill-lookup, P2-08's review_text length cap). Not an attempt at full
// coverage of every route -- see the note in package.json's test script
// and the checklist for follow-up.
//
// getOrCreateUserId and the supabase client are both mocked so these run
// against real Express routing/validation logic without touching a real
// database or Supabase project.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../middleware/auth', () => ({
    getOrCreateUserId: vi.fn(),
}));

// H2-03: POST /ratings fires-and-forgets a gamification recordActivity()
// call after a successful upsert. Mocked here the same way H2-01/H2-04
// mock their own side-effect services, so these tests aren't asserting
// anything about gamification (that's rankSnapshots.test.ts's own file's
// job) and don't hit real supabase calls that aren't otherwise mocked.
vi.mock('../../services/gamification', () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));

const upsertSelectMock = vi.fn();
const maybeSingleMock = vi.fn();

vi.mock('../../services/supabase', () => ({
    supabase: {
        from: vi.fn(() => ({
            upsert: vi.fn(() => ({
                select: upsertSelectMock,
            })),
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    eq: vi.fn(() => ({
                        maybeSingle: maybeSingleMock,
                    })),
                })),
            })),
        })),
    },
}));

import { getOrCreateUserId } from '../../middleware/auth';
import { recordActivity } from '../../services/gamification';
import ratingsRouter from '../ratings';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/ratings', ratingsRouter);
    return app;
}

describe('POST /ratings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Q3-03: the route now checks for an existing rating before
        // upserting, to decide whether to fire recordActivity(). Default
        // to "no existing rating" (first-time submission) so the
        // pre-existing tests below -- written before this check existed
        // -- don't all have to opt into it individually.
        maybeSingleMock.mockResolvedValue({ data: null, error: null });
    });

    it('rejects unauthenticated requests with 401', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(null);

        const res = await request(buildApp())
            .post('/ratings')
            .send({ series_id: 1, score: 8 });

        expect(res.status).toBe(401);
    });

    it('rejects a missing series_id or score with 400', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);

        const res = await request(buildApp())
            .post('/ratings')
            .send({ series_id: 1 }); // no score

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/series_id and score/i);
    });

    it('rejects a score outside 1-10 with 400', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);

        const res = await request(buildApp())
            .post('/ratings')
            .send({ series_id: 1, score: 11 });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/between 1 and 10/i);
    });

    // Q1-04: only reachable by a client bypassing the UI's ten discrete
    // rating buttons -- a real defense-in-depth gap, not a user-facing bug.
    it('rejects a non-integer score with 400', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);

        const res = await request(buildApp())
            .post('/ratings')
            .send({ series_id: 1, score: 7.5 });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/integer/i);
    });

    it('rejects review_text over 2000 characters with 400 (P2-08)', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);

        const res = await request(buildApp())
            .post('/ratings')
            .send({ series_id: 1, score: 8, review_text: 'a'.repeat(2001) });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/2000 characters/);
    });

    it('accepts review_text at exactly 2000 characters', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        upsertSelectMock.mockResolvedValue({
            data: [{ id: 1, user_id: 42, series_id: 1, score: 8, review_text: 'a'.repeat(2000) }],
            error: null,
        });

        const res = await request(buildApp())
            .post('/ratings')
            .send({ series_id: 1, score: 8, review_text: 'a'.repeat(2000) });

        expect(res.status).toBe(201);
    });

    it('upserts and returns 201 on a valid submission', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        upsertSelectMock.mockResolvedValue({
            data: [{ id: 1, user_id: 42, series_id: 1, score: 9, review_text: 'Great show' }],
            error: null,
        });

        const res = await request(buildApp())
            .post('/ratings')
            .send({ series_id: 1, score: 9, review_text: 'Great show' });

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ series_id: 1, score: 9 });
        expect(recordActivity).toHaveBeenCalledWith(42, 'rating');
    });

    // Q3-03: updating an existing rating (a fresh score for a series
    // this user already rated) should not pay out gamification credit a
    // second time -- only a genuinely first-time rating should.
    it('does not call recordActivity when updating an existing rating', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        maybeSingleMock.mockResolvedValue({ data: { id: 1 }, error: null });
        upsertSelectMock.mockResolvedValue({
            data: [{ id: 1, user_id: 42, series_id: 1, score: 6, review_text: 'Changed my mind' }],
            error: null,
        });

        const res = await request(buildApp())
            .post('/ratings')
            .send({ series_id: 1, score: 6, review_text: 'Changed my mind' });

        expect(res.status).toBe(201);
        expect(recordActivity).not.toHaveBeenCalled();
    });

    it('returns 500 when the existing-rating lookup fails', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        maybeSingleMock.mockResolvedValue({ data: null, error: { message: 'db down' } });

        const res = await request(buildApp())
            .post('/ratings')
            .send({ series_id: 1, score: 8 });

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});

describe('GET /ratings/mine/:seriesId', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects unauthenticated requests with 401', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(null);

        const res = await request(buildApp()).get('/ratings/mine/1');

        expect(res.status).toBe(401);
    });

    it('returns null data when the user has not rated this series', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        maybeSingleMock.mockResolvedValue({ data: null, error: null });

        const res = await request(buildApp()).get('/ratings/mine/1');

        expect(res.status).toBe(200);
        expect(res.body.data).toBeNull();
    });

    it('returns the existing score/review_text when the user has rated this series', async () => {
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
        maybeSingleMock.mockResolvedValue({
            data: { score: 7, review_text: 'Solid' },
            error: null,
        });

        const res = await request(buildApp()).get('/ratings/mine/1');

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ score: 7, review_text: 'Solid' });
    });
});
