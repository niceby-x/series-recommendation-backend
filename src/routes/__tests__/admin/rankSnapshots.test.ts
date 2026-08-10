// src/routes/__tests__/admin/rankSnapshots.test.ts
//
// H2-01: covers the admin trigger for the rank-snapshot job -- admin
// gating, the success shape GET /series's H2-01 tests assume nothing
// about (this is the only place that shape is asserted), the audit-log
// call, and that a thrown error from the service surfaces as a 500
// instead of an unhandled rejection.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { allowAdmin, rejectAdmin } from './testUtils';

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
const { computeAndStoreSnapshotMock } = vi.hoisted(() => ({ computeAndStoreSnapshotMock: vi.fn() }));
const { logAdminActionMock } = vi.hoisted(() => ({ logAdminActionMock: vi.fn() }));

vi.mock('../../../middleware/auth', () => ({ requireAdmin: requireAdminMock }));
vi.mock('../../../services/rankSnapshots', () => ({ computeAndStoreSnapshot: computeAndStoreSnapshotMock }));
vi.mock('../../../services/auditLog', () => ({ logAdminAction: logAdminActionMock }));

import rankSnapshotsRouter from '../../admin/rankSnapshots';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/admin/rank-snapshots', rankSnapshotsRouter);
    return app;
}

beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockImplementation(allowAdmin());
});

describe('POST /admin/rank-snapshots/run', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).post('/admin/rank-snapshots/run');

        expect(res.status).toBe(403);
        expect(computeAndStoreSnapshotMock).not.toHaveBeenCalled();
    });

    it('computes the snapshot, logs the action, and returns its date/count', async () => {
        computeAndStoreSnapshotMock.mockResolvedValue({ snapshotDate: '2026-08-10', count: 37 });

        const res = await request(buildApp()).post('/admin/rank-snapshots/run');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ snapshot_date: '2026-08-10', count: 37 });
        expect(logAdminActionMock).toHaveBeenCalledWith(
            expect.anything(),
            'rank_snapshot.run',
            'snapshot_date:2026-08-10'
        );
    });

    it('returns 500 with the error message if the job throws', async () => {
        computeAndStoreSnapshotMock.mockRejectedValue(new Error('Failed to store rank snapshot: fk violation'));

        const res = await request(buildApp()).post('/admin/rank-snapshots/run');

        expect(res.status).toBe(500);
        expect(res.body.message).toMatch(/Failed to store rank snapshot/);
        expect(logAdminActionMock).not.toHaveBeenCalled();
    });
});
