// src/routes/__tests__/me.test.ts
//
// H4-02: covers GET /me -- the new route the greeting fix depends on.
// Confirms it 401s when signed out and returns the user's own row
// (including username, the field the frontend half needs) when signed in.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../middleware/auth', () => ({
    getOrCreateUserId: vi.fn(),
}));

const singleMock = vi.fn();

vi.mock('../../services/supabase', () => ({
    supabase: {
        from: vi.fn(() => ({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    single: singleMock,
                })),
            })),
        })),
    },
}));

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
        singleMock.mockResolvedValue({
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
        singleMock.mockResolvedValue({ data: null, error: { message: 'db down' } });

        const res = await request(buildApp()).get('/me');

        expect(res.status).toBe(500);
        expect(res.body.message).toBe('db down');
    });
});
