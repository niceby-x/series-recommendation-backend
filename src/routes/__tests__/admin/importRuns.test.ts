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
    importRunStateMock: { running: false, startedAt: null } as any,
    startImportRunMock: vi.fn(),
}));

vi.mock('../../../middleware/auth', () => ({ requireAdmin: requireAdminMock }));
vi.mock('../../../services/importRuns', () => ({
    importRunState: importRunStateMock,
    startImportRun: startImportRunMock,
    DEFAULT_IMPORT_LIMIT: 150,
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
    importRunStateMock.startedAt = null;
    // Echoes back whatever limit the route passed in, matching
    // startImportRun's real { started, limit } shape -- individual tests
    // override this where the clamp (IMP1-03) or a conflict (IMP1-01)
    // needs to be simulated.
    startImportRunMock.mockImplementation((limit: number) => Promise.resolve({ started: true, limit }));
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

    // IMP1-01: the in-memory `importRunState.running` check above can
    // miss a same-process race (see startImportRun's own synchronous
    // check for that), and can never see a conflict from a different
    // process/instance at all -- that's what the DB-level
    // import_runs_one_running_idx partial unique index is for. Either
    // way, startImportRun is the one that finds out, via a 23505 on its
    // insert, and reports back with `started: false`. The route must
    // still surface that as a 409 even though the cheap in-memory check
    // right here passed.
    it('returns 409 when startImportRun reports a conflict it detected itself', async () => {
        startImportRunMock.mockResolvedValue({ started: false, conflict: true });

        const res = await request(buildApp()).post('/admin/import/run').send({ limit: 50 });

        expect(res.status).toBe(409);
    });

    // IMP1-03: the route no longer trusts its own locally-computed limit
    // for the response -- it echoes back whatever startImportRun reports
    // as the actual (post-clamp) limit, since the clamp against
    // MAX_IMPORT_LIMIT lives in the service, not here.
    it('echoes back the clamped limit from startImportRun, not the requested one', async () => {
        startImportRunMock.mockResolvedValue({ started: true, limit: 500 });

        const res = await request(buildApp()).post('/admin/import/run').send({ limit: 5000 });

        expect(res.status).toBe(202);
        expect(res.body.limit).toBe(500);
        expect(startImportRunMock).toHaveBeenCalledWith(5000);
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

    // IMP1-02: the child-process 'close' handler in services/importRuns.ts
    // flips importRunState.running to false and updates import_runs in
    // the DB, but that DB update is fire-and-forget (not awaited) -- so a
    // poll landing right after a run finishes must not fall back to the
    // DB, or it risks reading a still-stale row and the frontend (which
    // stops polling on running: false) would never see the correction.
    it('prefers in-memory state right after a run finishes, even if the DB row is still stale', async () => {
        importRunStateMock.running = false;
        importRunStateMock.startedAt = '2026-08-20T10:00:00.000Z';
        importRunStateMock.finishedAt = '2026-08-20T10:05:00.000Z';
        importRunStateMock.exitCode = 0;
        importRunStateMock.limit = 150;
        importRunStateMock.logTail = ['done'];
        importRunStateMock.error = null;
        // Deliberately NOT queuing an import_runs result -- if the route
        // fell back to the DB branch here, mockSupabase would throw on
        // the unqueued .from('import_runs') call, failing this test.

        const res = await request(buildApp()).get('/admin/import/status');

        expect(res.status).toBe(200);
        expect(res.body.running).toBe(false);
        expect(res.body.exitCode).toBe(0);
        expect(res.body.logTail).toEqual(['done']);
    });
});
