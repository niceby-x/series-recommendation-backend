// src/services/importRuns.ts
//
// In-memory + persisted state for the TMDB discovery import job (P4-04
// split of the old monolithic src/index.ts). importRunState/startImportRun
// back POST/GET /admin/import/* (routes/admin/importRuns.ts);
// reconcileOrphanedImportRun is called once at server boot (see index.ts)
// to close out any run left dangling 'running' by a previous process that
// died mid-run.

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { supabase } from './supabase';

// State for the currently-running (or most recently run) TMDB discovery
// import. The live log tail while a run is in progress stays in memory
// only (polled every few seconds by the frontend; persisting every log
// line to the DB would be a write per stdout chunk, not worth it) -- but
// each run's outcome (status/timestamps/exit code/final log) is also
// persisted to the `import_runs` table (see migrations/import_runs.sql),
// specifically so a run's result survives this server restarting or
// redeploying mid-run, which in-memory-only state can't do: the run
// itself still dies with the process either way, but at least the record
// of "a run was in progress and got cut off" survives instead of
// vanishing without a trace.
export interface ImportRunState {
    running: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
    limit: number | null;
    logTail: string[];
    error: string | null;
}

const MAX_IMPORT_LOG_LINES = 300;
const LOG_PERSIST_INTERVAL_MS = 5000;

export const importRunState: ImportRunState = {
    running: false,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    limit: null,
    logTail: [],
    error: null,
};

let importChild: ChildProcess | null = null;
let importRunDbId: number | null = null;
let importLogFlushTimer: ReturnType<typeof setInterval> | null = null;

function appendImportLog(chunk: string) {
    const lines = chunk.toString().split('\n').filter((l) => l.trim().length > 0);
    importRunState.logTail.push(...lines);
    if (importRunState.logTail.length > MAX_IMPORT_LOG_LINES) {
        importRunState.logTail = importRunState.logTail.slice(-MAX_IMPORT_LOG_LINES);
    }
}

async function persistImportLog() {
    if (importRunDbId === null) return;
    await supabase
        .from('import_runs')
        .update({ log: importRunState.logTail.join('\n') })
        .eq('id', importRunDbId);
}

// Runs once at server boot. If the last row in `import_runs` is still
// marked 'running', this process definitely isn't the one running it --
// importChild is null on a fresh boot -- so that row can only be left over
// from a previous process that died (restart/redeploy/crash) before it
// could mark its own run finished. Close it out as 'interrupted' instead
// of leaving a stale 'running' row that would otherwise claim an import is
// in progress forever.
export async function reconcileOrphanedImportRun() {
    const { data, error } = await supabase
        .from('import_runs')
        .select('id')
        .eq('status', 'running')
        .order('started_at', { ascending: false })
        .limit(1);

    if (error || !data || data.length === 0) return;

    await supabase
        .from('import_runs')
        .update({
            status: 'interrupted',
            finished_at: new Date().toISOString(),
            error_message: 'Server restarted or redeployed while this run was in progress.',
        })
        .eq('id', data[0].id);
}

// Spawns discover-series-by-keyword.ts as its own process rather than
// importing and calling it inline -- the script is a standalone CLI tool
// (reads --limit from argv, runs to completion, exits) built and tested on
// its own, and a real run can take minutes. Running it inline inside this
// request handler would block the whole API server and blow past any
// HTTP/proxy timeout long before it finished.
//
// Always spawns plain `node` (never `npx`/`npx.cmd`/the tsx CLI binary) --
// `node --import tsx <file>.ts` runs a TypeScript file directly via tsx's
// documented loader-hook entry point, with no npx involved. This matters
// on Windows specifically: npx is a .cmd shim, which either fails outright
// (spawn ENOENT) or, once routed through cmd.exe, adds enough process
// layers (cmd.exe -> npx.cmd -> npx's own node process -> tsx) that stdout
// can sit fully buffered and never reach us, making a real run look hung
// with zero log output. `node` is always a genuine, directly-executable
// binary on every OS, so this sidesteps all of that. In a compiled build
// the file's already plain JS, so the flag is skipped entirely -- it's not
// needed and node would just ignore an unknown loader for a .js file.
export async function startImportRun(limit: number) {
    const runningCompiled = __filename.endsWith('.js');
    const scriptPath = path.join(
        __dirname,
        '..',
        'scripts',
        runningCompiled ? 'discover-series-by-keyword.js' : 'discover-series-by-keyword.ts'
    );
    const command = process.platform === 'win32' ? 'node.exe' : 'node';
    const args = runningCompiled
        ? [scriptPath, '--limit=' + limit]
        : ['--import', 'tsx', scriptPath, '--limit=' + limit];

    importRunState.running = true;
    importRunState.startedAt = new Date().toISOString();
    importRunState.finishedAt = null;
    importRunState.exitCode = null;
    importRunState.limit = limit;
    importRunState.logTail = [];
    importRunState.error = null;

    const { data: runRow, error: insertError } = await supabase
        .from('import_runs')
        .insert({ status: 'running', limit_per_type: limit, started_at: importRunState.startedAt })
        .select('id')
        .single();

    importRunDbId = insertError ? null : runRow.id;

    // Throttled rather than per-chunk -- a per-line DB write would fire
    // dozens of times a second during a real run for no real benefit,
    // since the live log tail the frontend actually polls comes from
    // memory (importRunState.logTail), not this table. This is purely so
    // a restart mid-run leaves behind a reasonably fresh partial log
    // instead of none at all.
    importLogFlushTimer = setInterval(persistImportLog, LOG_PERSIST_INTERVAL_MS);

    importChild = spawn(command, args, {
        cwd: path.resolve(__dirname, '..', '..'),
        env: process.env,
    });

    importChild.stdout?.on('data', (data) => appendImportLog(data.toString()));
    importChild.stderr?.on('data', (data) => appendImportLog(data.toString()));

    importChild.on('error', (err) => {
        importRunState.error = err.message;
        importRunState.running = false;
        importRunState.finishedAt = new Date().toISOString();

        if (importLogFlushTimer) clearInterval(importLogFlushTimer);
        if (importRunDbId !== null) {
            supabase
                .from('import_runs')
                .update({
                    status: 'error',
                    finished_at: importRunState.finishedAt,
                    error_message: err.message,
                    log: importRunState.logTail.join('\n'),
                })
                .eq('id', importRunDbId);
        }
    });

    importChild.on('close', (code) => {
        importRunState.running = false;
        importRunState.finishedAt = new Date().toISOString();
        importRunState.exitCode = code;
        importChild = null;

        if (importLogFlushTimer) clearInterval(importLogFlushTimer);
        if (importRunDbId !== null) {
            supabase
                .from('import_runs')
                .update({
                    status: code === 0 ? 'success' : 'error',
                    finished_at: importRunState.finishedAt,
                    exit_code: code,
                    log: importRunState.logTail.join('\n'),
                })
                .eq('id', importRunDbId);
        }
    });
}
