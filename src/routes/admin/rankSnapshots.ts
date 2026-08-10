// src/routes/admin/rankSnapshots.ts -- trigger the rank-snapshot job
// (admin only). H2-01.
//
// No cron scheduler exists in this app yet, so this is the same
// "admin-triggered job" shape as /admin/import/run: an external
// scheduler (e.g. a daily GitHub Action or hosting-provider cron hitting
// this route with the admin token) or a human can call it. Synchronous
// and fast (one ratings scan + one upsert), unlike the TMDB import run,
// so there's no run-state/polling machinery here -- it just runs and
// responds.

import { Router, Request, Response } from 'express';
import { requireAdmin } from '../../middleware/auth';
import { computeAndStoreSnapshot } from '../../services/rankSnapshots';
import { logAdminAction } from '../../services/auditLog';

const router = Router();

// Route - Compute today's popularity rank for every rated series and
// store it in series_rank_snapshots (admin only). Safe to call more
// than once in a day -- upserted on (series_id, snapshot_date), so a
// re-run just updates today's row.
router.post('/run', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    try {
        const { snapshotDate, count } = await computeAndStoreSnapshot();
        await logAdminAction(req, 'rank_snapshot.run', 'snapshot_date:' + snapshotDate);
        res.json({ message: 'Rank snapshot computed', snapshot_date: snapshotDate, count });
    } catch (err) {
        res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to compute rank snapshot' });
    }
});

export default router;
