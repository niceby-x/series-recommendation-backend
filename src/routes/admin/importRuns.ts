// src/routes/admin/importRuns.ts -- trigger + poll the TMDB discovery import
// job (admin only). Actual run state/process management lives in
// services/importRuns.ts, shared with index.ts's boot-time reconciliation.

import { Router, Request, Response } from 'express';
import { supabase } from '../../services/supabase';
import { requireAdmin } from '../../middleware/auth';
import { importRunState, startImportRun } from '../../services/importRuns';

const router = Router();

// Route 16 - Trigger a new TMDB discovery run (admin only). Only one run
// at a time -- concurrent runs would double-queue candidates and fight
// over TMDB's rate limit -- so this 409s if one's already in progress
// instead of silently starting a second. Returns immediately; poll
// GET /admin/import/status for progress and the tail of its log output.
router.post('/run', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    if (importRunState.running) {
        return res.status(409).json({ message: 'An import is already running.' });
    }

    const limitInput = parseInt(req.body?.limit);
    const limit = Number.isFinite(limitInput) && limitInput > 0 ? limitInput : 150;

    await startImportRun(limit);

    res.status(202).json({ message: 'Import started', limit });
});
// Route 17 - Poll the status and log tail of the current (or most recent)
// discovery run (admin only). If this process has a run actually in
// flight, its live in-memory state (with the live log tail) is
// authoritative and gets returned as-is. Otherwise -- nothing running in
// this process, whether because nothing's been started yet or because a
// restart wiped the in-memory state mid-run -- falls back to the most
// recent row in `import_runs`, normalized into the same shape, so the
// frontend still shows a real last-known status (including 'interrupted'
// if reconcileOrphanedImportRun caught a restart) instead of going blank.
router.get('/status', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    if (importRunState.running) {
        return res.json({ message: 'Import status', ...importRunState });
    }

    const { data, error } = await supabase
        .from('import_runs')
        .select('status, limit_per_type, started_at, finished_at, exit_code, log, error_message')
        .order('started_at', { ascending: false })
        .limit(1);

    if (error || !data || data.length === 0) {
        return res.json({ message: 'Import status', ...importRunState });
    }

    const lastRun = data[0];
    res.json({
        message: 'Import status',
        running: false,
        startedAt: lastRun.started_at,
        finishedAt: lastRun.finished_at,
        exitCode: lastRun.exit_code,
        limit: lastRun.limit_per_type,
        logTail: lastRun.log ? lastRun.log.split('\n') : [],
        error: lastRun.error_message,
        interrupted: lastRun.status === 'interrupted',
    });
});

export default router;
