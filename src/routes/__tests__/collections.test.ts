// src/routes/__tests__/collections.test.ts
//
// P2-03: covers the new zod schemas on POST /collections, PATCH
// /collections/:id, and POST /collections/:id/series. loadEditableCollection
// is mocked directly (it does its own auth/db work, out of scope here) so
// these tests isolate what the schemas themselves accept or reject.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// vi.mock() calls are hoisted above imports and these const declarations,
// so any mock referenced inside a factory has to go through vi.hoisted()
// (Vitest's documented pattern for this) rather than a plain top-level
// const -- otherwise the factory runs before the const is initialized.
const { insertSingleMock, updateSingleMock, loadEditableCollectionMock } = vi.hoisted(() => ({
    insertSingleMock: vi.fn(),
    updateSingleMock: vi.fn(),
    loadEditableCollectionMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
    getOrCreateUserId: vi.fn(),
}));

vi.mock('../../services/supabase', () => ({
    supabase: {
        from: vi.fn(() => ({
            insert: vi.fn(() => ({
                select: vi.fn(() => ({
                    single: insertSingleMock,
                })),
            })),
            update: vi.fn(() => ({
                eq: vi.fn(() => ({
                    select: vi.fn(() => ({
                        single: updateSingleMock,
                    })),
                })),
            })),
        })),
    },
}));

vi.mock('../../services/collections', () => ({
    fetchCollectionsJoined: vi.fn(),
    loadEditableCollection: loadEditableCollectionMock,
}));

import { getOrCreateUserId } from '../../middleware/auth';
import collectionsRouter from '../collections';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/collections', collectionsRouter);
    return app;
}

describe('POST /collections', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getOrCreateUserId).mockResolvedValue(42);
    });

    it('rejects a missing title with 400', async () => {
        const res = await request(buildApp()).post('/collections').send({});

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/title is required/i);
    });

    it('rejects a blank/whitespace-only title with 400', async () => {
        const res = await request(buildApp())
            .post('/collections')
            .send({ title: '   ' });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/title is required/i);
    });

    it('creates a collection and returns 201 on a valid title', async () => {
        insertSingleMock.mockResolvedValue({
            data: { id: 1, title: 'My List', is_curated: false },
            error: null,
        });

        const res = await request(buildApp())
            .post('/collections')
            .send({ title: '  My List  ' });

        expect(res.status).toBe(201);
    });
});

describe('PATCH /collections/:id', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        loadEditableCollectionMock.mockResolvedValue({ id: 1, is_curated: false });
    });

    it('rejects a blank title with 400', async () => {
        const res = await request(buildApp())
            .patch('/collections/1')
            .send({ title: '   ' });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/title is required/i);
    });

    it('allows an update with no title change (description only)', async () => {
        updateSingleMock.mockResolvedValue({
            data: { id: 1, description: 'Updated' },
            error: null,
        });

        const res = await request(buildApp())
            .patch('/collections/1')
            .send({ description: 'Updated' });

        expect(res.status).toBe(200);
    });
});

describe('POST /collections/:id/series', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        loadEditableCollectionMock.mockResolvedValue({ id: 1, is_curated: false });
    });

    it('rejects a missing series_id with 400', async () => {
        const res = await request(buildApp())
            .post('/collections/1/series')
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/series_id is required/i);
    });
});
