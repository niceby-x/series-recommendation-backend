// src/routes/__tests__/admin/importRuns.test.ts
//
// A3-01: covers triggering and polling the TMDB discovery import job --
// the single-run-at-a-time 409 guard, the limit default/validation, and
// status falling back to the last `import_runs` row when nothing is live
// in this process's memory.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockSupabase, allowAdmin, rejectAdmin } from './testUtils';

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
const { importRunStateMock, startImportRunMock } = vi.hoisted(() => ({
    importRunStateMock: { running: false } as any,
    startImportRunMock: vi.fn(),
}));

vi.mock('../../../middleware/auth', () => ({ requireAdmin: requireAdminMock }));
vi.mock('../../../services/importRuns', () => ({
    importRunState: importRunStateMock,
    startImportRun: startImportRunMock,
}));

const { supabase, queue } = mockSupabase();
vi.mock('../../../services/supabase', () => ({ get supabase() { return supabase; } }));

import importRunsRouter from '../../admin/importRuns';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/admin/import', importRunsRouter);
    return app;
}

beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockImplementation(allowAdmin());
    importRunStateMock.running = false;
});

describe('POST /admin/import/run', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).post('/admin/import/run');

        expect(res.status).toBe(403);
    });

    it('returns 409 when a run is already in progress', async () => {
        importRunStateMock.running = true;

        const res = await request(buildApp()).post('/admin/import/run');

        expect(res.status).toBe(409);
        expect(startImportRunMock).not.toHaveBeenCalled();
    });

    it('defaults limit to 150 when none/invalid is given', async () => {
        const res = await request(buildApp()).post('/admin/import/run').send({});

        expect(res.status).toBe(202);
        expect(res.body.limit).toBe(150);
        expect(startImportRunMock).toHaveBeenCalledWith(150);
    });

    it('uses the given limit when it is a valid positive number', async () => {
        const res = await request(buildApp()).post('/admin/import/run').send({ limit: 50 });

        expect(res.status).toBe(202);
        expect(startImportRunMock).toHaveBeenCalledWith(50);
    });
});

describe('GET /admin/import/status', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).get('/admin/import/status');

        expect(res.status).toBe(403);
    });

    it('returns the live in-memory state when a run is actually in progress', async () => {
        importRunStateMock.running = true;
        importRunStateMock.logTail = ['line 1'];

        const res = await request(buildApp()).get('/admin/import/status');

        expect(res.status).toBe(200);
        expect(res.body.running).toBe(true);
        expect(res.body.logTail).toEqual(['line 1']);
    });

    it('falls back to the most recent import_runs row when nothing is live', async () => {
        queue('import_runs', {
            data: [{ status: 'interrupted', started_at: '2026-01-01', finished_at: null, exit_code: null, log: 'a\nb', error_message: 'restarted' }],
            error: null,
        });

        const res = await request(buildApp()).get('/admin/import/status');

        expect(res.status).toBe(200);
        expect(res.body.running).toBe(false);
        expect(res.body.interrupted).toBe(true);
        expect(res.body.logTail).toEqual(['a', 'b']);
    });

    it('falls back to the in-memory state when the import_runs table has no rows', async () => {
        queue('import_runs', { data: [], error: null });

        const res = await request(buildApp()).get('/admin/import/status');

        expect(res.status).toBe(200);
        expect(res.body.running).toBe(false);
    });
});
