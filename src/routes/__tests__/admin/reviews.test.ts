// src/routes/__tests__/admin/reviews.test.ts
//
// A3-01: covers listing and removing ratings/reviews (admin moderation).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockSupabase, allowAdmin, rejectAdmin } from './testUtils';

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
vi.mock('../../../middleware/auth', () => ({ requireAdmin: requireAdminMock }));

const { supabase, queue } = mockSupabase();
vi.mock('../../../services/supabase', () => ({ get supabase() { return supabase; } }));

import reviewsRouter from '../../admin/reviews';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/admin/reviews', reviewsRouter);
    return app;
}

beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockImplementation(allowAdmin());
});

describe('GET /admin/reviews', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).get('/admin/reviews');

        expect(res.status).toBe(403);
    });

    it('lists every rating/review with user and series info joined', async () => {
        queue('ratings', {
            data: [{ id: 1, score: 8, review_text: 'Great', users: { username: 'a' }, series: { title: 'Show' } }],
            error: null,
        });

        const res = await request(buildApp()).get('/admin/reviews');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(1);
    });

    it('propagates a query error as 500', async () => {
        queue('ratings', { data: null, error: { message: 'db down' } });

        const res = await request(buildApp()).get('/admin/reviews');

        expect(res.status).toBe(500);
    });
});

describe('DELETE /admin/reviews/:id', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).delete('/admin/reviews/1');

        expect(res.status).toBe(403);
    });

    it('deletes the rating row', async () => {
        queue('ratings', { data: null, error: null });

        const res = await request(buildApp()).delete('/admin/reviews/1');

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Review removed');
    });
});
