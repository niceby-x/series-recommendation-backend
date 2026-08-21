// src/routes/admin/importRuns.ts -- trigger + poll the TMDB discovery import
// job (admin only). Actual run state/process management lives in
// services/importRuns.ts, shared with index.ts's boot-time reconciliation.

import { Router, Request, Response } from 'express';
import { supabase } from '../../services/supabase';
import { requireAdmin } from '../../middleware/auth';
import { importRunState, startImportRun, stopImportRun, DEFAULT_IMPORT_LIMIT } from '../../services/importRuns';
import { getImportSchedule, updateImportSchedule } from '../../services/importSchedule';

const router = Router();

// Route 16 - Trigger a new TMDB discovery run (admin only). Only one run
// at a time -- concurrent runs would double-queue candidates and fight
// over TMDB's rate limit -- so this 409s if one's already in progress
// instead of silently starting a second. Returns immediately; poll
// GET /admin/import/status for progress and the tail of its log output.
router.post('/run', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    // Cheap first check, no DB round trip -- see startImportRun's insert
    // (guarded by the import_runs_one_running_idx partial unique index,
    // migrations/013) for the authoritative guard this backs up.
    if (importRunState.running) {
        return res.status(409).json({ message: 'An import is already running.' });
    }

    const limitInput = parseInt(req.body?.limit);
    const requestedLimit = Number.isFinite(limitInput) && limitInput > 0 ? limitInput : DEFAULT_IMPORT_LIMIT;
    // IMP2-03: Boolean(...) rather than a truthy check on the raw value --
    // req.body?.dryRun could arrive as the string "false" from some
    // clients (e.g. a plain HTML form field), which is truthy in JS but
    // means false here. Booleans on a JSON body (the only kind this route
    // actually expects) pass through Boolean() unchanged either way.
    const dryRun = Boolean(req.body?.dryRun);

    // IMP3-02: only forwards a string body value through -- anything else
    // (missing, null, a number, etc.) is left undefined so
    // startImportRun's own trim/default/clamp (single source of truth,
    // same reasoning as IMP1-03's limit clamp) falls back to
    // DEFAULT_KEYWORD instead of this route trying to validate it twice.
    const keywordInput = typeof req.body?.keyword === 'string' ? req.body.keyword : undefined;

    // IMP1-03: the actual clamp against MAX_IMPORT_LIMIT happens inside
    // startImportRun (single source of truth for every caller, including
    // a future scheduler) -- result.limit is the post-clamp value, echoed
    // back here so the admin sees what actually ran, not just what they
    // requested.
    const result = await startImportRun(requestedLimit, dryRun, keywordInput);

    if (!result.started) {
        return res.status(409).json({ message: 'An import is already running.' });
    }

    res.status(202).json({ message: 'Import started', limit: result.limit, dryRun: result.dryRun, keyword: result.keyword });
});

// IMP2-01 - Stop the currently-running import (admin only). importChild
// was already tracked in services/importRuns.ts for the stdout/stderr/
// close wiring; this just exposes a way to signal it short of restarting
// the whole server. 409s the same way /run's conflict case does when
// there's nothing to stop, so the frontend can treat both routes'
// error shape consistently.
router.post('/stop', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const result = stopImportRun();

    if (!result.stopped) {
        return res.status(409).json({ message: 'No import is currently running.' });
    }

    // Stopping is asynchronous -- this confirms the signal was sent, not
    // that the process has exited yet. The frontend's existing status
    // poll picks up running: false (and status: 'cancelled' once the
    // close handler's DB update lands) the same way it already detects
    // any other run ending.
    res.status(202).json({ message: 'Stop signal sent' });
});
// Route 17 - Poll the status and log tail of the current (or most recent)
// discovery run (admin only). If this process has ever seen a run --
// whether it's still going or just finished -- its in-memory state (with
// the live log tail) is authoritative and gets returned as-is; see the
// comment below for why "just finished" also needs to stay on in-memory
// state rather than falling back to the DB. Only a process that has
// never seen a run at all (e.g. right after boot, or after a restart
// wiped the in-memory state) falls back to the most recent row in
// `import_runs`, normalized into the same shape, so the frontend still
// shows a real last-known status (including 'interrupted' if
// reconcileOrphanedImportRun caught a restart) instead of going blank.
router.get('/status', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    // Prefer in-memory state whenever this process has ANY record of a
    // run -- not just while running: true. The child-process 'close'/
    // 'error' handlers in services/importRuns.ts update import_runs in
    // the DB, but that update is intentionally fire-and-forget (not
    // awaited), so there's a real window right after a run finishes where
    // importRunState.running has already flipped to false but the DB row
    // hasn't been written yet. Falling back to the DB query in that
    // window would read a stale row -- and since the frontend stops
    // polling the moment it sees running: false, that stale result would
    // never self-correct. importRunState.startedAt is only null before
    // this process has ever seen a run start (e.g. right after boot),
    // which is the only case that actually needs the DB fallback below.
    if (importRunState.running || importRunState.startedAt !== null) {
        return res.json({ message: 'Import status', ...importRunState });
    }

    const { data, error } = await supabase
        .from('import_runs')
        .select('status, limit_per_type, started_at, finished_at, exit_code, log, error_message, dry_run, summary, keyword')
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
        // This branch only runs by reading a row that made it into
        // import_runs, so persistence obviously succeeded for it --
        // IMP1-04's persisted: false only ever comes from the live
        // importRunState.persisted returned by the branch above.
        persisted: true,
        // IMP2-01: mirrors the live branch's importRunState.cancelled --
        // a run stopped by an admin is recorded as status: 'cancelled'
        // in import_runs (see the close handler in services/importRuns.ts),
        // so this branch can tell it apart from a normal success/error
        // finish the same way it already does for 'interrupted'.
        cancelled: lastRun.status === 'cancelled',
        // IMP2-03: mirrors the live branch's importRunState.dryRun --
        // persisted directly on the row (migrations/014) rather than
        // inferred from status, since a dry run can itself succeed,
        // error, get interrupted, or get cancelled just like a real one.
        dryRun: lastRun.dry_run,
        // IMP3-01: mirrors the live branch's importRunState.summary --
        // null for any row from before this migration, or for a run that
        // errored/was stopped/got interrupted before the script reached
        // its final __IMPORT_SUMMARY__ line, same as the live branch.
        summary: lastRun.summary,
        // IMP3-02: mirrors the live branch's importRunState.keyword --
        // persisted directly on the row (migrations/016), defaulted at
        // the DB level to the same keyword every pre-migration row was
        // actually searched for, so this is never null/empty for a real
        // row, live or historical.
        keyword: lastRun.keyword,
    });
});

// Route 18 - Paginated list of past import runs, newest first (admin
// only) -- IMP3-03. GET /admin/import/status only ever exposes the
// current/most-recent run; this is the audit trail for everything before
// that, so trends and recurring failures over time are actually visible
// rather than lost the moment a newer run starts. Same page/limit/
// has_more pagination shape GET /collections already uses (see that
// route's own header comment) for consistency across the admin panel's
// paginated lists -- the frontend's history tab loads more pages on
// demand rather than this route ever returning the whole table at once.
router.get('/history', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    // 50 is a generous page size for a row this light (a handful of
    // scalar fields plus one small jsonb blob) -- collections caps at 100
    // for the same reason on a heavier joined row; this just matches the
    // spirit, not the exact number, since a run-history table realistically
    // never needs more than a screenful at a time regardless of page size.
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit as string) || 20));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, error, count } = await supabase
        .from('import_runs')
        .select('id, status, started_at, finished_at, exit_code, limit_per_type, keyword, dry_run, summary', {
            count: 'exact',
        })
        .order('started_at', { ascending: false })
        .range(from, to);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    const runs = (data || []).map((row: any) => ({
        id: row.id,
        // 'running' | 'success' | 'error' | 'interrupted' | 'cancelled' --
        // whatever's actually in the DB, including the current run if one
        // happens to be in progress (this is a straight read of the
        // table, not a live in-memory view like GET /status -- that's
        // fine here, since a still-running row just shows "Running" in
        // the history the same way it already does in the status badge).
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        exitCode: row.exit_code,
        limit: row.limit_per_type,
        keyword: row.keyword,
        dryRun: row.dry_run,
        summary: row.summary,
    }));

    const total = count ?? runs.length;
    res.json({
        message: 'Import run history',
        data: runs,
        pagination: { page, limit, total, has_more: page * limit < total },
    });
});

// IMP4-01 - Read the current schedule (admin only). Response shape is the
// contract the frontend's settings form is built against:
// { enabled, runHourUtc, keyword, limitPerType, lastTriggeredAt, updatedAt }
// -- keyword/limitPerType are null when unset (falls back to the same
// defaults a manual run without those fields would use, resolved by
// startImportRun at trigger time, not here).
router.get('/schedule', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const config = await getImportSchedule();

    if (!config) {
        return res.status(500).json({ message: 'Import schedule is not configured. Has migrations/017_import_schedule_table.sql been run?' });
    }

    res.json({ message: 'Import schedule', data: config });
});

// IMP4-01 - Update the schedule (admin only). Body:
// { enabled: boolean, runHourUtc: number (0-23), keyword?: string | null, limitPerType?: number | null }
// keyword/limitPerType are optional and nullable -- omit or pass null to
// fall back to the defaults at trigger time (see updateImportSchedule's
// own comment on why those aren't clamped/defaulted here).
router.put('/schedule', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const enabled = Boolean(req.body?.enabled);
    const runHourUtc = Number(req.body?.runHourUtc);
    const keyword = typeof req.body?.keyword === 'string' ? req.body.keyword : null;
    const limitInput = Number(req.body?.limitPerType);
    const limitPerType = Number.isFinite(limitInput) && limitInput > 0 ? limitInput : null;

    const result = await updateImportSchedule({ enabled, runHourUtc, keyword, limitPerType });

    if (!result.ok) {
        return res.status(400).json({ message: result.error });
    }

    res.json({ message: 'Import schedule updated', data: result.config });
});

export default router;
