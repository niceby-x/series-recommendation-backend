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
    // IMP1-04: false only when the initial import_runs insert in
    // startImportRun failed (any error other than the 23505
    // unique_violation, which is handled separately as a conflict and
    // never reaches this point) -- the run still proceeds untracked in
    // that case (see the comment at that insert), but with no DB row to
    // update, a crash mid-run leaves nothing for
    // reconcileOrphanedImportRun() to find on the next boot. True is the
    // default/reset value so the frontend only warns about an actual
    // persistence failure, never a run that just hasn't started yet.
    persisted: boolean;
    // IMP2-01: true only when the current/most-recent run was ended via
    // stopImportRun() (an admin action) rather than finishing on its own
    // or dying with an error -- lets the close handler below record
    // status: 'cancelled' in import_runs instead of misreporting a
    // deliberate stop as 'error' (there's no controlled way to make a
    // killed child process exit with code 0, so 'success' isn't right
    // either). Reset to false at the start of every run.
    cancelled: boolean;
    // IMP2-03: mirrors the --dry-run flag passed to
    // discover-series-by-keyword.ts for this run -- the script skips its
    // actual candidate insert in that mode, just logs what it would have
    // queued, so this is what lets the admin UI (and, later, IMP3-03's
    // run history) tell a dry run apart from a real one that happened to
    // queue nothing. Reset to false at the start of every run.
    dryRun: boolean;
    // IMP3-01: parsed from the script's __IMPORT_SUMMARY__ stdout line
    // (see appendImportLog) once it prints one -- null until then, so the
    // frontend can tell "no summary yet" (still running, or a run that
    // errored/was stopped before it got that far) apart from "summary
    // says zero of everything". Same countryTally/mediaTypeTally shape
    // the script already computed for its own human-readable log; this is
    // just the structured version of the same numbers.
    summary: ImportRunSummary | null;
    // IMP3-02: the effective (post-trim/default/clamp) keyword this run
    // was/is searching TMDB for -- previously always the hardcoded
    // "boys' love (bl)" default, now whatever startImportRun resolved
    // (see DEFAULT_KEYWORD/MAX_KEYWORD_LENGTH below), forwarded to the
    // script as --keyword=. null only before this process has ever seen a
    // run start.
    keyword: string | null;
}

export interface ImportRunSummary {
    added: number;
    mediaTypeTally: Record<string, number>;
    countryTally: Record<string, number>;
}

const MAX_IMPORT_LOG_LINES = 300;
const LOG_PERSIST_INTERVAL_MS = 5000;

// IMP1-03: the "limit per media type" input (POST /admin/import/run's
// `limit` body param) was previously only validated as positive/non-NaN,
// with no upper bound -- nothing stopped an admin entering an extreme
// value and running the importer against TMDB for far longer than
// intended. 500 is well under the script's own hard ceiling (MAX_PAGES=50
// pages x 20 results/page = 1000 raw results per media type in
// discover-series-by-keyword.ts, so nothing above 1000 could ever do
// anything different anyway) while still comfortably covering a
// deliberately large catalog-seeding run -- each accepted candidate costs
// an extra TMDB details call on top of the page-listing calls, so the
// cap is meant to bound worst-case run time/API usage, not just echo the
// script's own limit. Exported so the route can clamp against the same
// number it reports back to the frontend for the input's max attribute.
export const DEFAULT_IMPORT_LIMIT = 150;
export const MAX_IMPORT_LIMIT = 500;

// IMP3-02: mirrors discover-series-by-keyword.ts's own DEFAULT_KEYWORD
// constant -- kept as a separate copy rather than imported, the same way
// DEFAULT_IMPORT_LIMIT above duplicates the script's DEFAULT_LIMIT rather
// than sharing it, since the script runs as its own spawned process
// (see startImportRun below), not as an imported module. If the script's
// default ever changes, this needs updating to match.
export const DEFAULT_KEYWORD = "boys' love (bl)";
// Sanity cap on the keyword input's length -- an admin-controlled text
// field with no upper bound is the same class of problem IMP1-03 fixed
// for the limit input, just for a string instead of a number. 100 is
// generous for any real TMDB keyword/genre phrase while still ruling out
// someone pasting in something absurd.
export const MAX_KEYWORD_LENGTH = 100;

export const importRunState: ImportRunState = {
    running: false,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    limit: null,
    logTail: [],
    error: null,
    persisted: true,
    cancelled: false,
    dryRun: false,
    summary: null,
    keyword: null,
};

let importChild: ChildProcess | null = null;
let importRunDbId: number | null = null;
let importLogFlushTimer: ReturnType<typeof setInterval> | null = null;

const SUMMARY_LOG_PREFIX = '__IMPORT_SUMMARY__';

function appendImportLog(chunk: string) {
    const lines = chunk.toString().split('\n').filter((l) => l.trim().length > 0);

    for (const line of lines) {
        // IMP3-01: the script emits one line prefixed with
        // __IMPORT_SUMMARY__ containing the same countryTally/
        // mediaTypeTally numbers as its human-readable summary, just as
        // parseable JSON. Pull it out here rather than letting it reach
        // the visible logTail -- it's meant for the admin UI's stat
        // breakdown, not to be read as a log line, and would just look
        // like a stray blob of JSON if left in the log panel. A malformed
        // or unexpected line (e.g. truncated by a mid-write chunk split)
        // is skipped rather than surfaced as an error -- the human log
        // already has the same numbers, so a parse miss here only means
        // the stat breakdown falls back to whatever import_runs already
        // had, not a run that silently lost information.
        if (line.startsWith(SUMMARY_LOG_PREFIX)) {
            try {
                importRunState.summary = JSON.parse(line.slice(SUMMARY_LOG_PREFIX.length));
            } catch {
                // Malformed/partial line -- leave importRunState.summary
                // as it was rather than throwing out of a stdout handler.
            }
            continue;
        }
        importRunState.logTail.push(line);
    }

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
// Return value tells the route handler whether a run actually started
// and, since IMP1-03, the effective (post-clamp) limit -- so the route
// can echo back what actually happened rather than re-deriving it.
// `conflict: true` means another run was already in progress -- either
// caught here by the in-memory check (same process, e.g. a double-click)
// or by the import_runs_one_running_idx partial unique index on the
// insert below (a different process/instance, or a restart that cleared
// this process's in-memory state without clearing the DB row). Either
// way, no child process gets spawned on top of one that's already going.
//
// IMP2-03: dryRun is forwarded straight through to the script as
// --dry-run (see its DRY_RUN = process.argv.includes('--dry-run') check)
// -- the script itself already knows how to skip its candidate insert in
// that mode; this just plumbs a way to ask for it through here instead
// of only from the command line.
//
// IMP3-02: keyword is trimmed/defaulted/length-clamped here -- same
// "single source of truth for every caller" reasoning as IMP1-03's limit
// clamp above -- then forwarded to the script as --keyword=, which the
// script's own parseKeywordArg reads the same way it already reads
// --limit=.
export async function startImportRun(
    limit: number,
    dryRun: boolean = false,
    keyword?: string
): Promise<{ started: boolean; conflict?: boolean; limit?: number; dryRun?: boolean; keyword?: string }> {
    // First line of defense: cheap, no DB round trip, and closes the
    // specific TOCTOU window IMP1-01 was filed for -- the route handler's
    // own `if (importRunState.running)` check happens right after
    // `await requireAdmin(...)`, a yield point where a second
    // near-simultaneous request could otherwise slip through before this
    // process had set running to true. This check-and-set runs fully
    // synchronously (no `await` until the insert below), so once one
    // request's continuation reaches here, JS's run-to-completion
    // semantics mean nothing else in this process can interleave before
    // `running` flips to true. It is NOT sufficient on its own across
    // processes/instances -- see the insert's conflict handling below for
    // the authoritative, DB-level guard.
    if (importRunState.running) {
        return { started: false, conflict: true };
    }

    // IMP1-03: clamp here rather than only in the route, so this is the
    // single source of truth for every caller -- including a future
    // scheduler (IMP4-01) that might call startImportRun directly without
    // going through the route's own request-parsing. Lower-bounded too,
    // defensively, in case a future caller passes something <= 0.
    const clampedLimit = Math.max(1, Math.min(limit, MAX_IMPORT_LIMIT));

    // IMP3-02: same reasoning as clampedLimit above -- trim, fall back to
    // DEFAULT_KEYWORD on empty/whitespace-only input, and cap length so an
    // admin can't paste in something absurd. Always resolves to a
    // non-empty string, so the script never gets an empty --keyword= that
    // would send a blank query to TMDB.
    const trimmedKeyword = keyword?.trim();
    const effectiveKeyword = trimmedKeyword && trimmedKeyword.length > 0
        ? trimmedKeyword.slice(0, MAX_KEYWORD_LENGTH)
        : DEFAULT_KEYWORD;

    const runningCompiled = __filename.endsWith('.js');
    const scriptPath = path.join(
        __dirname,
        '..',
        'scripts',
        runningCompiled ? 'discover-series-by-keyword.js' : 'discover-series-by-keyword.ts'
    );
    const command = process.platform === 'win32' ? 'node.exe' : 'node';
    const scriptArgs = ['--limit=' + clampedLimit, '--keyword=' + effectiveKeyword, ...(dryRun ? ['--dry-run'] : [])];
    const args = runningCompiled ? [scriptPath, ...scriptArgs] : ['--import', 'tsx', scriptPath, ...scriptArgs];

    importRunState.running = true;
    importRunState.startedAt = new Date().toISOString();
    importRunState.finishedAt = null;
    importRunState.exitCode = null;
    importRunState.limit = clampedLimit;
    importRunState.logTail = [];
    importRunState.error = null;
    importRunState.persisted = true;
    importRunState.cancelled = false;
    importRunState.dryRun = dryRun;
    importRunState.summary = null;
    importRunState.keyword = effectiveKeyword;

    const { data: runRow, error: insertError } = await supabase
        .from('import_runs')
        .insert({
            status: 'running',
            limit_per_type: clampedLimit,
            started_at: importRunState.startedAt,
            dry_run: dryRun,
            keyword: effectiveKeyword,
        })
        .select('id')
        .single();

    // 23505 = unique_violation -- import_runs_one_running_idx
    // (migrations/013_import_runs_running_unique.sql) rejected this insert
    // because another row already has status = 'running'. This is the
    // authoritative guard the in-memory check above can't fully provide:
    // it also catches a second server instance, or a restart that cleared
    // this process's in-memory state without clearing the DB row. Reset
    // our own state and bail out WITHOUT spawning a child process -- two
    // discovery scripts hitting TMDB and the candidates table at once is
    // exactly what this is meant to prevent.
    if (insertError?.code === '23505') {
        importRunState.running = false;
        importRunState.startedAt = null;
        importRunState.limit = null;
        return { started: false, conflict: true };
    }

    // IMP1-04: any other insert failure means this run proceeds
    // untracked -- importRunDbId stays null, so persistImportLog() and
    // the close/error handlers below skip their .update() calls, and a
    // crash mid-run leaves no row for reconcileOrphanedImportRun() to
    // find on the next boot. The run itself is still allowed to
    // continue (a transient DB hiccup shouldn't block an otherwise-fine
    // import), but importRunState.persisted flips to false so the route
    // can surface it and the admin isn't left thinking the run's outcome
    // is being recorded when it isn't.
    importRunDbId = insertError ? null : runRow.id;
    importRunState.persisted = importRunDbId !== null;

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
                    // IMP2-01: a run stopped via stopImportRun() exits
                    // with a signal, not a normal exit code -- `code` is
                    // null in that case (Node reports the death via the
                    // separate `signal` param this handler doesn't take),
                    // which would otherwise fall into the 'error' bucket
                    // and misreport a deliberate admin action as a
                    // failure. importRunState.cancelled disambiguates it.
                    status: importRunState.cancelled ? 'cancelled' : code === 0 ? 'success' : 'error',
                    finished_at: importRunState.finishedAt,
                    exit_code: code,
                    log: importRunState.logTail.join('\n'),
                    // IMP3-01: importRunState.summary is only ever set by
                    // the script's final __IMPORT_SUMMARY__ stdout line,
                    // which (barring a truncated chunk -- see
                    // appendImportLog) has already landed by the time
                    // 'close' fires, since Node only emits 'close' once
                    // the child's stdio streams are fully drained. Stays
                    // null here for a run that errored, was stopped, or
                    // got interrupted before reaching that line -- same
                    // as it already is in memory, nothing to invent.
                    summary: importRunState.summary,
                })
                .eq('id', importRunDbId);
        }
    });

    return { started: true, limit: clampedLimit, dryRun, keyword: effectiveKeyword };
}

// IMP2-01: importChild was already tracked module-scope for the
// stdout/stderr/close wiring above -- it just wasn't exposed to admins
// as a way to actually stop a run short of restarting the whole server.
// SIGTERM (not SIGKILL) so the child gets Node's normal unhandled-signal
// exit path rather than being killed with no chance to flush anything;
// discover-series-by-keyword.ts doesn't register its own SIGTERM handler,
// so this reliably ends the process. The existing 'close' handler above
// still fires as usual once it does, and (via importRunState.cancelled,
// set here first) records status: 'cancelled' instead of 'error'.
export function stopImportRun(): { stopped: boolean; reason?: 'not_running' } {
    if (!importRunState.running || !importChild) {
        return { stopped: false, reason: 'not_running' };
    }

    importRunState.cancelled = true;
    importChild.kill('SIGTERM');

    return { stopped: true };
}
