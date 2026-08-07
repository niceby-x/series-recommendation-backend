import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { Series, Rating, ApiResponse } from './types';

const app = express();
const PORT = 3001;

const allowedOrigins = [
  'http://localhost:3000',
  'https://series-recommendation-frontend.vercel.app',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

//Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_KEY as string
);

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
interface ImportRunState {
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

const importRunState: ImportRunState = {
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
async function reconcileOrphanedImportRun() {
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
async function startImportRun(limit: number) {
    const runningCompiled = __filename.endsWith('.js');
    const scriptPath = path.join(__dirname, runningCompiled ? 'discover-series-by-keyword.js' : 'discover-series-by-keyword.ts');
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
        cwd: path.resolve(__dirname, '..'),
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

//ROUTE 1 - Welcome route
app.get('/', (req: Request, res: Response) => {
    res.json({
        message: 'Welcome to the BL Series API!',
        author: 'Jimboy',
        version: '1.0.0'
    });
});

//Route 2 - Get ALL series
// series_tags -> tags joined in and flattened to a plain `tags` array per
// row (same flatten-the-join-table approach as the genre join below and
// the candidate tag_ids flattening) -- previously this route returned no
// mood/trope/etc. info at all, so the Moods and Tropes pages had nothing
// real to match series against and fell back to purely positional mock
// data. Purely additive: existing consumers that don't read `tags` are
// unaffected.
app.get('/series', async (req: Request, res: Response) => {
    const { data, error } = await supabase
    .from('series')
    .select('*, series_tags (tags (id, dimension, value_key, display_label, display_emoji))');

    if (error) {
        return res.status(500).json({ message: error.message});
    }

    const flattened = data.map((row: any) => {
        const { series_tags, ...rest } = row;
        const tags = (series_tags || []).map((t: any) => t.tags).filter(Boolean);
        return { ...rest, tags };
    });

    const response: ApiResponse<Series[]> = {
        message: 'List of BL Series',
        count: flattened.length,
        data: flattened
    };

    res.json(response);
});

//Route 3 - Get ONE series by id
app.get('/series/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);

    // Genres joined in and flattened to a plain genre_names array (same
    // flattening approach as GET /admin/candidates does for tag_ids) --
    // previously this route returned no genre info at all, so nothing
    // in the app (including this endpoint's own consumers) could show a
    // series' genres. Purely additive: existing consumers that don't
    // read genre_names are unaffected.
    //
    // series_tags -> tags is joined the same way, exposed both as the full
    // `tags` objects (dimension/value_key/display_label/display_emoji, for
    // rendering on the public detail page) and as a flat `tag_ids` array
    // (mirrors series_candidates' tag_ids shape) so SeriesEditModal's tag
    // picker can reuse the exact same selected-ids-as-a-Set pattern the
    // candidates Taxonomy modal already uses.
    const { data, error } = await supabase
        .from('series')
        .select('*, series_genres (genres (name)), series_tags (tags (id, dimension, value_key, display_label, display_emoji))')
        .eq('id', id)
        .single();

    if (error) {
        return res.status(404).json({
            message: "Series not found",
            error
        });
    }

    const { series_genres, series_tags, ...rest } = data as any;
    const genre_names = (series_genres || []).map((row: any) => row.genres?.name).filter(Boolean);
    const tags = (series_tags || []).map((row: any) => row.tags).filter(Boolean);
    const tag_ids = tags.map((t: any) => t.id);

    res.json({
        message: "Success",
        data: { ...rest, genre_names, tags, tag_ids }
    });
});

// Helper - Verify the Supabase Auth token and get-or-create the matching users row.
// Returns the integer user_id from the `users` table, or null if the token is invalid.
async function getOrCreateUserId(authHeader: string | undefined): Promise<number | null> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }

    const token = authHeader.replace('Bearer ', '');

    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !authUser) {
        return null;
    }

    // Check if a users row already exists for this auth account
    const { data: existing, error: existingError } = await supabase
        .from('users')
        .select('id, is_banned')
        .eq('auth_id', authUser.id)
        .maybeSingle();

    if (existingError) {
        console.error('Error checking existing user:', existingError.message);
        return null;
    }

    if (existing) {
        // Banned accounts can't rate or manage a watchlist -- both routes
        // that call this already treat a null return as "not
        // authenticated", so this reuses that same 401 path rather than
        // needing its own separate check in every caller.
        if (existing.is_banned) return null;
        return existing.id;
    }

    // No row yet — create one, linking it to this auth account
    const usernameFromEmail = authUser.email ? authUser.email.split('@')[0] : `user_${authUser.id.slice(0, 8)}`;

    const { data: created, error: createError } = await supabase
        .from('users')
        .insert([{
            auth_id: authUser.id,
            email: authUser.email,
            username: usernameFromEmail,
            password_hash: 'supabase_auth'
        }])
        .select('id')
        .single();

    if (createError) {
        console.error('Error creating user row:', createError.message);
        return null;
    }

    return created.id;
}

// Helper - Verify the request is from an admin. Two ways in:
// (1) ADMIN_EMAIL env var match -- the original single-account bootstrap,
//     kept permanently so whoever controls the deployment's env vars can
//     never lock themselves out, even if the users table gets into a bad
//     state.
// (2) users.is_admin = true -- real, independently-togglable admin state
//     (see PATCH /admin/users/:id/admin), so more than one person can be
//     an admin. If the ADMIN_EMAIL account's row hasn't been marked
//     is_admin yet (e.g. right after this column was added), this
//     self-heals it on first admin request rather than requiring a manual
//     SQL UPDATE, so it shows correctly as Admin in the Users list too.
// A banned account is never treated as admin, even if is_admin is true or
// it matches ADMIN_EMAIL -- banning is meant to fully lock someone out.
async function requireAdmin(req: Request, res: Response): Promise<boolean> {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ message: 'You must be signed in.' });
        return false;
    }

    const token = authHeader.replace('Bearer ', '');

    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !authUser) {
        res.status(401).json({ message: 'Your session is invalid or expired.' });
        return false;
    }

    const adminEmail = process.env.ADMIN_EMAIL;
    const isBootstrapAdmin = !!adminEmail && authUser.email === adminEmail;

    const { data: userRow } = await supabase
        .from('users')
        .select('id, is_admin, is_banned')
        .eq('auth_id', authUser.id)
        .maybeSingle();

    if (userRow?.is_banned) {
        res.status(403).json({ message: 'This account has been banned.' });
        return false;
    }

    if (!isBootstrapAdmin && !userRow?.is_admin) {
        res.status(403).json({ message: 'Admin access required.' });
        return false;
    }

    if (isBootstrapAdmin && userRow && !userRow.is_admin) {
        await supabase.from('users').update({ is_admin: true }).eq('id', userRow.id);
    }

    return true;
}

// Route 4 - Submit a rating
app.post('/ratings', async (req: Request, res: Response) => {
    const { series_id, score, review_text } = req.body;

    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to submit a rating'
        });
    }

    if (!series_id || !score) {
        return res.status(400).json({
            message: 'series_id and score are required'
        });
    }

    if (score < 1 || score > 10) {
        return res.status(400).json({
            message: 'Score must be between 1 and 10'
        });
    }

    const { data, error } = await supabase
        .from('ratings')
        .insert([{ user_id, series_id, score, review_text }])
        .select();

    if (error) {
        return res.status(500).json({ message: error.message});
    }

    const response: ApiResponse<Rating> = {
        message: 'Rating submitted successfully!',
        data: data[0]
    };

    res.status(201).json(response);
});

// Route 5 - Add or update a watchlist entry (upsert)
app.post('/watchlist', async (req: Request, res: Response) => {
    const { series_id, status } = req.body;

    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to update your watchlist'
        });
    }

    const validStatuses = ['plan_to_watch', 'watching', 'completed'];

    if (!series_id || !status || !validStatuses.includes(status)) {
        return res.status(400).json({
            message: 'series_id and a valid status (' + validStatuses.join(', ') + ') are required'
        });
    }

    const { data, error } = await supabase
        .from('user_lists')
        .upsert(
            [{ user_id, series_id, status, updated_at: new Date().toISOString() }],
            { onConflict: 'user_id,series_id' }
        )
        .select();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(200).json({
        message: 'Watchlist updated',
        data: data[0]
    });
});

// Route 6 - Get the logged-in user's full watchlist, with series details joined in
app.get('/watchlist', async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to view your watchlist'
        });
    }

    const { data, error } = await supabase
        .from('user_lists')
        .select('id, status, updated_at, series (*)')
        .eq('user_id', user_id);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({
        message: 'Your watchlist',
        count: data.length,
        data
    });
});

// Route 7 - Get the logged-in user's status for one specific series (or null if not on their list)
app.get('/watchlist/:seriesId', async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to view watchlist status'
        });
    }

    const seriesId = parseInt(req.params.seriesId as string);

    const { data, error } = await supabase
        .from('user_lists')
        .select('status')
        .eq('user_id', user_id)
        .eq('series_id', seriesId)
        .maybeSingle();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({
        message: 'Watchlist status',
        status: data ? data.status : null
    });
});

// Route 8 - Remove a series from the watchlist entirely
app.delete('/watchlist/:seriesId', async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to update your watchlist'
        });
    }

    const seriesId = parseInt(req.params.seriesId as string);

    const { error } = await supabase
        .from('user_lists')
        .delete()
        .eq('user_id', user_id)
        .eq('series_id', seriesId);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(200).json({ message: 'Removed from watchlist' });
});

// Route 9 - List TMDB import candidates by review status (admin only).
// Defaults to 'pending'; pass ?status=approved or ?status=rejected for the history views.
app.get('/admin/candidates', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const validStatuses = ['pending', 'approved', 'rejected'];
    const statusParam = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const status = validStatuses.includes(statusParam) ? statusParam : 'pending';

    // Pending candidates are shown oldest-first (a queue to work through);
    // approved/rejected history is shown most-recent-first (what you just did).
    const ascending = status === 'pending';

    const { data, error } = await supabase
        .from('series_candidates')
        .select('*, series_candidate_tags (tag_id)')
        .eq('review_status', status)
        .order('created_at', { ascending });

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    // Flatten the joined tag rows into a plain tag_ids array — the nested
    // series_candidate_tags shape is a Supabase/Postgres join artifact,
    // not something the frontend should need to know about.
    const flattened = data.map((row: any) => {
        const { series_candidate_tags, ...rest } = row;
        return { ...rest, tag_ids: (series_candidate_tags || []).map((t: any) => t.tag_id) };
    });

    res.json({
        message: status.charAt(0).toUpperCase() + status.slice(1) + ' candidates',
        count: flattened.length,
        data: flattened
    });
});

// Route 9b - Lightweight counts for all three review statuses at once (admin only).
// Uses count-only queries (head: true) so this stays cheap even with a large queue.
app.get('/admin/candidates/counts', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const [pending, approved, rejected] = await Promise.all([
        supabase.from('series_candidates').select('*', { count: 'exact', head: true }).eq('review_status', 'pending'),
        supabase.from('series_candidates').select('*', { count: 'exact', head: true }).eq('review_status', 'approved'),
        supabase.from('series_candidates').select('*', { count: 'exact', head: true }).eq('review_status', 'rejected'),
    ]);

    if (pending.error || approved.error || rejected.error) {
        return res.status(500).json({
            message: pending.error?.message || approved.error?.message || rejected.error?.message
        });
    }

    res.json({
        message: 'Candidate counts',
        pending: pending.count || 0,
        approved: approved.count || 0,
        rejected: rejected.count || 0,
    });
});

// Route 9c - Get all active taxonomy tags, grouped by dimension (admin
// only). Fetched once by the admin page on load, not per candidate row.
// `?all=true` also includes inactive tags, for the Tags admin management
// page -- every other consumer (the candidates taxonomy editor) keeps
// getting active-only by not passing it, so this stays backward
// compatible.
app.get('/admin/tags', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const includeInactive = req.query.all === 'true';

    let query = supabase
        .from('tags')
        .select('id, dimension, value_key, display_label, display_emoji, sort_order, is_active')
        .order('dimension', { ascending: true })
        .order('sort_order', { ascending: true });

    if (!includeInactive) {
        query = query.eq('is_active', true);
    }

    const { data, error } = await query;

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    const grouped: Record<string, typeof data> = {};
    for (const tag of data) {
        if (!grouped[tag.dimension]) grouped[tag.dimension] = [];
        grouped[tag.dimension].push(tag);
    }

    res.json({ message: 'Tags by dimension', data: grouped });
});

const VALID_TAG_DIMENSIONS = ['mood', 'trope', 'relationship_dynamic', 'theme', 'content_warning'];

function slugifyTagKey(label: string): string {
    return label
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

// Route 9d - Create a new tag (admin only). value_key is auto-derived from
// display_label (Taxonomy v1's governed-vocabulary values are meant to be
// stable snake_case keys, not admin-typed strings that could drift in
// format) unless one is explicitly supplied. New tags are appended after
// the current highest sort_order within their dimension by default, so
// they show up last rather than jumping ahead of curated ordering.
app.post('/admin/tags', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { dimension, display_label, display_emoji, value_key, sort_order } = req.body || {};

    if (!VALID_TAG_DIMENSIONS.includes(dimension)) {
        return res.status(400).json({ message: 'dimension must be one of: ' + VALID_TAG_DIMENSIONS.join(', ') });
    }
    if (!display_label || typeof display_label !== 'string' || !display_label.trim()) {
        return res.status(400).json({ message: 'display_label is required.' });
    }

    const key = (value_key && String(value_key).trim()) || slugifyTagKey(display_label);
    if (!key) {
        return res.status(400).json({ message: 'Could not derive a value_key from display_label.' });
    }

    let nextSortOrder = sort_order;
    if (nextSortOrder === undefined || nextSortOrder === null) {
        const { data: existing } = await supabase
            .from('tags')
            .select('sort_order')
            .eq('dimension', dimension)
            .order('sort_order', { ascending: false })
            .limit(1);
        nextSortOrder = existing && existing.length > 0 ? existing[0].sort_order + 1 : 0;
    }

    const { data, error } = await supabase
        .from('tags')
        .insert({
            dimension,
            value_key: key,
            display_label: display_label.trim(),
            display_emoji: display_emoji || null,
            sort_order: nextSortOrder,
            is_active: true,
        })
        .select()
        .single();

    if (error) {
        // Postgres unique_violation -- most likely dimension+value_key already exists.
        if (error.code === '23505') {
            return res.status(409).json({ message: 'A tag with that key already exists in this dimension.' });
        }
        return res.status(500).json({ message: error.message });
    }

    res.status(201).json({ message: 'Tag created', data });
});

// Route 9e - Toggle a tag's active state (admin only). Soft-delete rather
// than a hard DELETE -- series/series_candidates rows can already
// reference a tag by id, so removing the row outright would either fail
// on the foreign key or silently orphan references. Deactivating just
// drops it from the default GET /admin/tags (and therefore the tagging
// UI) without touching anything that already points at it.
app.patch('/admin/tags/:id/toggle', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { data: current, error: fetchError } = await supabase
        .from('tags')
        .select('is_active')
        .eq('id', id)
        .single();

    if (fetchError) {
        return res.status(404).json({ message: 'Tag not found.' });
    }

    const { data, error } = await supabase
        .from('tags')
        .update({ is_active: !current.is_active })
        .eq('id', id)
        .select()
        .single();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({ message: data.is_active ? 'Tag activated' : 'Tag deactivated', data });
});

// Route 9c-1 - Rename a tag (admin only). Only display_label/display_emoji
// change -- value_key stays put, since nothing outside this row references
// it by string (series_tags/series_candidate_tags point at the numeric
// id), so there's no reason to risk drifting it from what the tag was
// created with. Rejects a rename that would collide (case-insensitively)
// with another tag already in the same dimension -- that's a merge, not a
// rename, and silently combining them would lose one tag's history of
// which series it was actually on.
app.patch('/admin/tags/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { display_label, display_emoji } = req.body || {};

    if (!display_label || !String(display_label).trim()) {
        return res.status(400).json({ message: 'display_label is required.' });
    }

    const { data: existing, error: fetchError } = await supabase
        .from('tags')
        .select('id, dimension')
        .eq('id', id)
        .maybeSingle();

    if (fetchError) return res.status(500).json({ message: fetchError.message });
    if (!existing) return res.status(404).json({ message: 'Tag not found.' });

    const { data: siblings, error: siblingsError } = await supabase
        .from('tags')
        .select('id, display_label')
        .eq('dimension', existing.dimension)
        .neq('id', id);

    if (siblingsError) return res.status(500).json({ message: siblingsError.message });

    const collision = (siblings || []).find(
        (t) => t.display_label.trim().toLowerCase() === String(display_label).trim().toLowerCase()
    );
    if (collision) {
        return res.status(409).json({
            message: '"' + display_label + '" already exists in this dimension (id ' + collision.id + '). Merge into it instead of renaming.',
        });
    }

    const { data, error } = await supabase
        .from('tags')
        .update({ display_label, display_emoji: display_emoji || null })
        .eq('id', id)
        .select('id, dimension, value_key, display_label, display_emoji, sort_order, is_active')
        .single();

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: 'Tag renamed', data });
});

// Route 9c-2 - Merge one or more tags into another (admin only), fixing
// duplicates like "Enemies to Lovers" existing as two separate rows.
// Repoints every series_tags/series_candidate_tags row that pointed at a
// source tag onto the target instead (skipping any series/candidate that's
// already linked to the target, so merging can't create a duplicate link),
// then deletes the source tag rows. Body: { source_ids: number[], target_id }.
// All tags involved must share a dimension -- merging "Angsty" (mood) into
// "Slow Burn" (trope) would silently misclassify every series that carried
// the source tag, which is a bigger problem than the duplicate it fixes.
app.post('/admin/tags/merge', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const targetId = parseInt(req.body?.target_id);
    const sourceIds: number[] = (req.body?.source_ids || [])
        .map((id: unknown) => parseInt(String(id)))
        .filter((id: number) => !Number.isNaN(id) && id !== targetId);

    if (!targetId || sourceIds.length === 0) {
        return res.status(400).json({ message: 'target_id and at least one distinct source_id are required.' });
    }

    const { data: involved, error: involvedError } = await supabase
        .from('tags')
        .select('id, dimension')
        .in('id', [targetId, ...sourceIds]);

    if (involvedError) return res.status(500).json({ message: involvedError.message });
    if (!involved || involved.length !== sourceIds.length + 1) {
        return res.status(404).json({ message: 'One or more tags were not found.' });
    }
    if (new Set(involved.map((t) => t.dimension)).size > 1) {
        return res.status(400).json({ message: 'Can only merge tags within the same dimension.' });
    }

    // series_tags: repoint, skipping series already linked to the target.
    const { data: targetSeriesLinks } = await supabase.from('series_tags').select('series_id').eq('tag_id', targetId);
    const seriesAlreadyLinked = new Set((targetSeriesLinks || []).map((r) => r.series_id));

    const { data: sourceSeriesLinks, error: sourceSeriesLinksError } = await supabase
        .from('series_tags')
        .select('series_id')
        .in('tag_id', sourceIds);
    if (sourceSeriesLinksError) return res.status(500).json({ message: sourceSeriesLinksError.message });

    const seriesToRelink = [...new Set((sourceSeriesLinks || []).map((r) => r.series_id))].filter(
        (sid) => !seriesAlreadyLinked.has(sid)
    );
    if (seriesToRelink.length > 0) {
        const { error: insertError } = await supabase
            .from('series_tags')
            .insert(seriesToRelink.map((series_id) => ({ series_id, tag_id: targetId })));
        if (insertError) return res.status(500).json({ message: insertError.message });
    }

    const { error: deleteSeriesLinksError } = await supabase.from('series_tags').delete().in('tag_id', sourceIds);
    if (deleteSeriesLinksError) return res.status(500).json({ message: deleteSeriesLinksError.message });

    // series_candidate_tags: same repoint-then-delete pattern.
    const { data: targetCandidateLinks } = await supabase
        .from('series_candidate_tags')
        .select('candidate_id')
        .eq('tag_id', targetId);
    const candidatesAlreadyLinked = new Set((targetCandidateLinks || []).map((r) => r.candidate_id));

    const { data: sourceCandidateLinks, error: sourceCandidateLinksError } = await supabase
        .from('series_candidate_tags')
        .select('candidate_id')
        .in('tag_id', sourceIds);
    if (sourceCandidateLinksError) return res.status(500).json({ message: sourceCandidateLinksError.message });

    const candidatesToRelink = [...new Set((sourceCandidateLinks || []).map((r) => r.candidate_id))].filter(
        (cid) => !candidatesAlreadyLinked.has(cid)
    );
    if (candidatesToRelink.length > 0) {
        const { error: insertError } = await supabase
            .from('series_candidate_tags')
            .insert(candidatesToRelink.map((candidate_id) => ({ candidate_id, tag_id: targetId })));
        if (insertError) return res.status(500).json({ message: insertError.message });
    }

    const { error: deleteCandidateLinksError } = await supabase
        .from('series_candidate_tags')
        .delete()
        .in('tag_id', sourceIds);
    if (deleteCandidateLinksError) return res.status(500).json({ message: deleteCandidateLinksError.message });

    const { error: deleteTagsError } = await supabase.from('tags').delete().in('id', sourceIds);
    if (deleteTagsError) return res.status(500).json({ message: deleteTagsError.message });

    res.json({ message: 'Tags merged', data: { target_id: targetId, merged_ids: sourceIds } });
});

// Route 9c-3 - Permanently delete a tag (admin only). Unlike toggle (which
// just hides it from pickers), this removes every series_tags/
// series_candidate_tags row referencing it first, then the tag itself --
// same cleanup-children-before-parent pattern used throughout this file.
app.delete('/admin/tags/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { error: seriesLinksError } = await supabase.from('series_tags').delete().eq('tag_id', id);
    if (seriesLinksError) return res.status(500).json({ message: seriesLinksError.message });

    const { error: candidateLinksError } = await supabase.from('series_candidate_tags').delete().eq('tag_id', id);
    if (candidateLinksError) return res.status(500).json({ message: candidateLinksError.message });

    const { error } = await supabase.from('tags').delete().eq('id', id);
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: 'Tag deleted' });
});

// Route 9c-4 - List every genre with how many published series use it
// (admin only). Genres today only ever get created as a side effect of
// approving a candidate (find-or-create by name, see the approve route
// below) -- this is the first place they can be viewed, renamed, merged,
// or deleted directly.
app.get('/admin/genres', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const [genresRes, linksRes] = await Promise.all([
        supabase.from('genres').select('id, name').order('name', { ascending: true }),
        supabase.from('series_genres').select('genre_id'),
    ]);

    if (genresRes.error) return res.status(500).json({ message: genresRes.error.message });
    if (linksRes.error) return res.status(500).json({ message: linksRes.error.message });

    const countByGenre = new Map<number, number>();
    for (const row of linksRes.data) {
        countByGenre.set(row.genre_id, (countByGenre.get(row.genre_id) || 0) + 1);
    }

    const data = genresRes.data.map((g) => ({ ...g, series_count: countByGenre.get(g.id) || 0 }));

    res.json({ message: 'Genres', count: data.length, data });
});

// Route 9c-5 - Rename a genre (admin only). Same duplicate guard as tag
// rename -- e.g. "Romance" and "romance" existing as two separate rows is
// exactly the kind of thing this is for catching, not creating more of.
app.patch('/admin/genres/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { name } = req.body || {};

    if (!name || !String(name).trim()) {
        return res.status(400).json({ message: 'name is required.' });
    }

    const { data: existing, error: fetchError } = await supabase.from('genres').select('id').eq('id', id).maybeSingle();
    if (fetchError) return res.status(500).json({ message: fetchError.message });
    if (!existing) return res.status(404).json({ message: 'Genre not found.' });

    const { data: siblings, error: siblingsError } = await supabase.from('genres').select('id, name').neq('id', id);
    if (siblingsError) return res.status(500).json({ message: siblingsError.message });

    const collision = (siblings || []).find((g) => g.name.trim().toLowerCase() === String(name).trim().toLowerCase());
    if (collision) {
        return res.status(409).json({
            message: '"' + name + '" already exists (id ' + collision.id + '). Merge into it instead of renaming.',
        });
    }

    const { data, error } = await supabase
        .from('genres')
        .update({ name })
        .eq('id', id)
        .select('id, name')
        .single();

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: 'Genre renamed', data });
});

// Route 9c-6 - Merge one or more genres into another (admin only). Same
// repoint-skip-duplicates-then-delete pattern as tag merge. Body:
// { source_ids: number[], target_id }.
app.post('/admin/genres/merge', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const targetId = parseInt(req.body?.target_id);
    const sourceIds: number[] = (req.body?.source_ids || [])
        .map((id: unknown) => parseInt(String(id)))
        .filter((id: number) => !Number.isNaN(id) && id !== targetId);

    if (!targetId || sourceIds.length === 0) {
        return res.status(400).json({ message: 'target_id and at least one distinct source_id are required.' });
    }

    const { data: involved, error: involvedError } = await supabase
        .from('genres')
        .select('id')
        .in('id', [targetId, ...sourceIds]);

    if (involvedError) return res.status(500).json({ message: involvedError.message });
    if (!involved || involved.length !== sourceIds.length + 1) {
        return res.status(404).json({ message: 'One or more genres were not found.' });
    }

    const { data: targetLinks } = await supabase.from('series_genres').select('series_id').eq('genre_id', targetId);
    const seriesAlreadyLinked = new Set((targetLinks || []).map((r) => r.series_id));

    const { data: sourceLinks, error: sourceLinksError } = await supabase
        .from('series_genres')
        .select('series_id')
        .in('genre_id', sourceIds);
    if (sourceLinksError) return res.status(500).json({ message: sourceLinksError.message });

    const seriesToRelink = [...new Set((sourceLinks || []).map((r) => r.series_id))].filter(
        (sid) => !seriesAlreadyLinked.has(sid)
    );
    if (seriesToRelink.length > 0) {
        const { error: insertError } = await supabase
            .from('series_genres')
            .insert(seriesToRelink.map((series_id) => ({ series_id, genre_id: targetId })));
        if (insertError) return res.status(500).json({ message: insertError.message });
    }

    const { error: deleteLinksError } = await supabase.from('series_genres').delete().in('genre_id', sourceIds);
    if (deleteLinksError) return res.status(500).json({ message: deleteLinksError.message });

    const { error: deleteGenresError } = await supabase.from('genres').delete().in('id', sourceIds);
    if (deleteGenresError) return res.status(500).json({ message: deleteGenresError.message });

    res.json({ message: 'Genres merged', data: { target_id: targetId, merged_ids: sourceIds } });
});

// Route 9c-7 - Permanently delete a genre (admin only). Removes its
// series_genres links first, then the genre row -- doesn't touch the
// series themselves, just un-tags them from this genre.
app.delete('/admin/genres/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { error: linksError } = await supabase.from('series_genres').delete().eq('genre_id', id);
    if (linksError) return res.status(500).json({ message: linksError.message });

    const { error } = await supabase.from('genres').delete().eq('id', id);
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: 'Genre deleted' });
});

// Route 9f - Save a candidate's taxonomy (Curated Attributes + Discovery Tags) (admin only).
// Persists immediately, independent of approve/reject — this is what lets curation happen
// progressively across sessions, per BLumi Taxonomy v1. Body: { romance_pace?, emotional_intensity?,
// ending_type?, content_level?, tag_ids?: number[] }. tag_ids, if present, is the COMPLETE
// desired set of tag ids across all 5 Discovery Tag dimensions — this route diffs against
// what's currently linked rather than requiring the client to compute the diff.
app.patch('/admin/candidates/:id/taxonomy', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { romance_pace, emotional_intensity, ending_type, content_level, tag_ids } = req.body;

    const attributeUpdate: Record<string, unknown> = {};
    if (romance_pace !== undefined) attributeUpdate.romance_pace = romance_pace;
    if (emotional_intensity !== undefined) attributeUpdate.emotional_intensity = emotional_intensity;
    if (ending_type !== undefined) attributeUpdate.ending_type = ending_type;
    if (content_level !== undefined) attributeUpdate.content_level = content_level;
    // content_level intentionally has no default fallback — a client-sent `null` is a
    // deliberate "needs review" state (per Taxonomy v1 §2.4), not an error to correct.

    if (Object.keys(attributeUpdate).length > 0) {
        const { error: attrError } = await supabase
            .from('series_candidates')
            .update(attributeUpdate)
            .eq('id', id);

        if (attrError) {
            return res.status(500).json({ message: attrError.message });
        }
    }

    if (Array.isArray(tag_ids)) {
        const { data: existing, error: fetchError } = await supabase
            .from('series_candidate_tags')
            .select('tag_id')
            .eq('candidate_id', id);

        if (fetchError) {
            return res.status(500).json({ message: fetchError.message });
        }

        const existingIds = new Set((existing || []).map((row) => row.tag_id));
        const desiredIds = new Set(tag_ids as number[]);

        const toInsert = (tag_ids as number[]).filter((tagId) => !existingIds.has(tagId));
        const toDelete = [...existingIds].filter((tagId) => !desiredIds.has(tagId));

        if (toInsert.length > 0) {
            const { error: insertError } = await supabase
                .from('series_candidate_tags')
                .insert(toInsert.map((tagId) => ({ candidate_id: id, tag_id: tagId })));

            if (insertError) {
                return res.status(500).json({ message: insertError.message });
            }
        }

        if (toDelete.length > 0) {
            const { error: deleteError } = await supabase
                .from('series_candidate_tags')
                .delete()
                .eq('candidate_id', id)
                .in('tag_id', toDelete);

            if (deleteError) {
                return res.status(500).json({ message: deleteError.message });
            }
        }
    }

    res.status(200).json({ message: 'Taxonomy saved' });
});

// Route 10 - Approve a candidate: copies it into `series`, marks it approved (admin only).
// Accepts optional field overrides in the request body (title, original_title, country,
// year, episode_count, status, synopsis) so corrections made during review are saved —
// both on the series_candidates record itself and on the series row it creates.
app.post('/admin/candidates/:id/approve', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const overrides = req.body || {};

    const { data: candidate, error: fetchError } = await supabase
        .from('series_candidates')
        .select('*')
        .eq('id', id)
        .single();

    if (fetchError || !candidate) {
        return res.status(404).json({ message: 'Candidate not found' });
    }

    const finalValues = {
        title: overrides.title ?? candidate.title,
        original_title: overrides.original_title ?? candidate.original_title,
        synopsis: overrides.synopsis ?? candidate.synopsis,
        country: overrides.country ?? candidate.country,
        year: overrides.year ?? candidate.year,
        episode_count: overrides.episode_count ?? candidate.episode_count,
        status: overrides.status ?? candidate.status,
        romance_pace: overrides.romance_pace ?? candidate.romance_pace,
        emotional_intensity: overrides.emotional_intensity ?? candidate.emotional_intensity,
        ending_type: overrides.ending_type ?? candidate.ending_type,
        content_level: overrides.content_level ?? candidate.content_level,
    };

    // NOTE: Taxonomy v1 Level 1 fields (Romance Pace, Ending Type, Mood/Trope/
    // Relationship Dynamics tags) are NOT required to approve a candidate. A title
    // can go live with just its Core Metadata (title, genres, cast, synopsis) and
    // simply won't surface in mood/trope-based discovery until tagged — it stays
    // browsable by title/genre/country in the meantime. Curation Level exists as an
    // admin-visible signal of what's missing, not a publish gate. This was
    // deliberately relaxed from an earlier hard-block version once the pending
    // queue reached ~300 titles and manual per-title tagging became the bottleneck
    // for approving anything at all.

    const { data: newSeries, error: insertError } = await supabase
        .from('series')
        .insert([{
            title: finalValues.title,
            original_title: finalValues.original_title,
            synopsis: finalValues.synopsis,
            country: finalValues.country,
            year: finalValues.year,
            episode_count: finalValues.episode_count,
            status: finalValues.status,
            romance_pace: finalValues.romance_pace,
            emotional_intensity: finalValues.emotional_intensity,
            ending_type: finalValues.ending_type,
            content_level: finalValues.content_level,
            poster_url: candidate.poster_url,
            backdrop_url: candidate.backdrop_url,
            tmdb_id: candidate.tmdb_id,
            is_animated: candidate.is_animated,
            number_of_seasons: candidate.number_of_seasons,
            media_type: candidate.media_type,
        }])
        .select('id')
        .single();

    if (insertError || !newSeries) {
        return res.status(500).json({ message: insertError?.message || 'Failed to create series' });
    }

    // Link genres: find-or-create each by name, then link via series_genres.
    // Failures here are logged but don't block the approval — the series itself is already saved.
    for (const genreName of (candidate.genre_names || [])) {
        const { data: existingGenre } = await supabase
            .from('genres')
            .select('id')
            .eq('name', genreName)
            .maybeSingle();

        let genreId = existingGenre?.id;

        if (!genreId) {
            const { data: createdGenre, error: genreError } = await supabase
                .from('genres')
                .insert([{ name: genreName }])
                .select('id')
                .single();

            if (genreError || !createdGenre) {
                console.error('Failed to create genre "' + genreName + '": ' + genreError?.message);
                continue;
            }
            genreId = createdGenre.id;
        }

        const { error: linkError } = await supabase
            .from('series_genres')
            .insert([{ series_id: newSeries.id, genre_id: genreId }]);

        if (linkError) {
            console.error('Failed to link genre "' + genreName + '": ' + linkError.message);
        }
    }

    // Link cast: find-or-create each cast member by name, then link via series_cast.
    // First two cast entries (TMDB's own billing order) are marked as leads.
    const castList = (candidate.cast_json || []) as { name: string; character: string; photo_url: string | null }[];

    for (let i = 0; i < castList.length; i++) {
        const castEntry = castList[i];

        const { data: existingCast } = await supabase
            .from('cast_members')
            .select('id')
            .eq('name', castEntry.name)
            .maybeSingle();

        let castMemberId = existingCast?.id;

        if (!castMemberId) {
            const { data: createdCast, error: castError } = await supabase
                .from('cast_members')
                .insert([{ name: castEntry.name, photo_url: castEntry.photo_url, bio: null }])
                .select('id')
                .single();

            if (castError || !createdCast) {
                console.error('Failed to create cast member "' + castEntry.name + '": ' + castError?.message);
                continue;
            }
            castMemberId = createdCast.id;
        }

        const { error: castLinkError } = await supabase
            .from('series_cast')
            .insert([{
                series_id: newSeries.id,
                cast_member_id: castMemberId,
                role_name: castEntry.character || null,
                is_lead: i < 2,
            }]);

        if (castLinkError) {
            console.error('Failed to link cast member "' + castEntry.name + '": ' + castLinkError.message);
        }
    }

    // Copy taxonomy tags: unlike genres/cast, tag_ids already point into the shared
    // `tags` table, so this is a straight copy — no find-or-create needed.
    const { error: candidateTagsForCopyError, data: tagsToCopy } = await supabase
        .from('series_candidate_tags')
        .select('tag_id')
        .eq('candidate_id', id);

    if (candidateTagsForCopyError) {
        console.error('Failed to fetch candidate tags for copy: ' + candidateTagsForCopyError.message);
    } else if (tagsToCopy && tagsToCopy.length > 0) {
        const { error: tagCopyError } = await supabase
            .from('series_tags')
            .insert(tagsToCopy.map((row) => ({ series_id: newSeries.id, tag_id: row.tag_id })));

        if (tagCopyError) {
            console.error('Failed to copy tags to series ' + newSeries.id + ': ' + tagCopyError.message);
        }
    }

    const { error: updateError } = await supabase
        .from('series_candidates')
        .update({ ...finalValues, review_status: 'approved' })
        .eq('id', id);

    if (updateError) {
        return res.status(500).json({ message: updateError.message });
    }

    res.status(200).json({ message: 'Approved and added to catalog' });
});

// Route 11 - Reject a candidate: just marks it rejected, never touches `series` (admin only)
app.post('/admin/candidates/:id/reject', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { error } = await supabase
        .from('series_candidates')
        .update({ review_status: 'rejected' })
        .eq('id', id);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(200).json({ message: 'Rejected' });
});

// Route 12 - Restore a candidate back to pending (admin only).
// If it was approved, this also removes the corresponding row from `series` first,
// so the catalog stays in sync with what's actually still approved.
app.post('/admin/candidates/:id/restore', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { data: candidate, error: fetchError } = await supabase
        .from('series_candidates')
        .select('*')
        .eq('id', id)
        .single();

    if (fetchError || !candidate) {
        return res.status(404).json({ message: 'Candidate not found' });
    }

    if (candidate.review_status === 'approved') {
        const { data: seriesRow } = await supabase
            .from('series')
            .select('id')
            .eq('tmdb_id', candidate.tmdb_id)
            .maybeSingle();

        if (seriesRow) {
            // Clean up link table rows explicitly first — don't rely on ON DELETE CASCADE
            // being configured, since we can't be sure it is.
            const { error: genreLinkDeleteError } = await supabase
                .from('series_genres')
                .delete()
                .eq('series_id', seriesRow.id);

            if (genreLinkDeleteError) {
                return res.status(500).json({ message: genreLinkDeleteError.message });
            }

            const { error: castLinkDeleteError } = await supabase
                .from('series_cast')
                .delete()
                .eq('series_id', seriesRow.id);

            if (castLinkDeleteError) {
                return res.status(500).json({ message: castLinkDeleteError.message });
            }

            const { error: tagLinkDeleteError } = await supabase
                .from('series_tags')
                .delete()
                .eq('series_id', seriesRow.id);

            if (tagLinkDeleteError) {
                return res.status(500).json({ message: tagLinkDeleteError.message });
            }
        }

        const { error: deleteError } = await supabase
            .from('series')
            .delete()
            .eq('tmdb_id', candidate.tmdb_id);

        if (deleteError) {
            return res.status(500).json({ message: deleteError.message });
        }
    }

    const { error: updateError } = await supabase
        .from('series_candidates')
        .update({ review_status: 'pending' })
        .eq('id', id);

    if (updateError) {
        return res.status(500).json({ message: updateError.message });
    }

    res.status(200).json({ message: 'Restored to pending' });
});

// Route 13 - List registered users with their activity counts (admin only).
// Ratings/watchlist counts are computed in-memory from the raw user_id
// columns rather than a Postgres GROUP BY -- simplest thing that works
// correctly at this app's current scale, no RPC/view needed. If the users
// table grows large enough for this to matter, switch to a `.rpc()` call
// against a SQL aggregate instead of adding pagination band-aids here.
app.get('/admin/users', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const [usersRes, ratingsRes, listsRes] = await Promise.all([
        supabase.from('users').select('id, email, username, created_at, is_admin, is_banned').order('created_at', { ascending: false }),
        supabase.from('ratings').select('user_id'),
        supabase.from('user_lists').select('user_id'),
    ]);

    if (usersRes.error) return res.status(500).json({ message: usersRes.error.message });
    if (ratingsRes.error) return res.status(500).json({ message: ratingsRes.error.message });
    if (listsRes.error) return res.status(500).json({ message: listsRes.error.message });

    const ratingsCountByUser = new Map<number, number>();
    for (const row of ratingsRes.data) {
        ratingsCountByUser.set(row.user_id, (ratingsCountByUser.get(row.user_id) || 0) + 1);
    }

    const watchlistCountByUser = new Map<number, number>();
    for (const row of listsRes.data) {
        watchlistCountByUser.set(row.user_id, (watchlistCountByUser.get(row.user_id) || 0) + 1);
    }

    const adminEmail = process.env.ADMIN_EMAIL;

    // is_admin here is the real column now, OR'd with the ADMIN_EMAIL
    // bootstrap match -- so the owner's account always shows correctly as
    // Admin even in the moment before requireAdmin's self-heal has run.
    const data = usersRes.data.map((u) => ({
        ...u,
        ratings_count: ratingsCountByUser.get(u.id) || 0,
        watchlist_count: watchlistCountByUser.get(u.id) || 0,
        is_admin: u.is_admin || (!!adminEmail && u.email === adminEmail),
        // The frontend uses this to disable promote/ban/delete on the
        // bootstrap account -- those routes already reject those actions
        // server-side too (see the ADMIN_EMAIL checks in each), but
        // without this the buttons would look clickable, submit, and only
        // then silently fail.
        is_root: !!adminEmail && u.email === adminEmail,
    }));

    res.json({
        message: 'Users',
        count: data.length,
        data
    });
});

// Route 13b - Promote/demote a user's admin status (admin only). Body:
// { is_admin: boolean }. The ADMIN_EMAIL account can't be demoted through
// this route -- that account's access comes from the env var regardless of
// this column (see requireAdmin), so demoting it here would just be
// confusing (the Users list would show them as Member, but they'd still
// have full access) rather than actually removing anything.
app.patch('/admin/users/:id/admin', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { is_admin } = req.body || {};

    if (typeof is_admin !== 'boolean') {
        return res.status(400).json({ message: 'is_admin must be a boolean.' });
    }

    const { data: target, error: targetError } = await supabase
        .from('users')
        .select('email')
        .eq('id', id)
        .single();

    if (targetError) {
        return res.status(404).json({ message: 'User not found.' });
    }

    const adminEmail = process.env.ADMIN_EMAIL;
    if (!is_admin && adminEmail && target.email === adminEmail) {
        return res.status(400).json({ message: "Can't remove admin from the account tied to ADMIN_EMAIL." });
    }

    const { data, error } = await supabase
        .from('users')
        .update({ is_admin })
        .eq('id', id)
        .select('id, email, username, created_at, is_admin, is_banned')
        .single();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({ message: is_admin ? 'User promoted to admin' : 'Admin access removed', data });
});

// Route 13c - Ban/unban a user (admin only). Body: { is_banned: boolean }.
// A banned account is rejected by requireAdmin (can't use admin routes)
// and by getOrCreateUserId (can't rate or manage a watchlist) -- see both
// for exactly what banning currently blocks. It does not sign them out of
// an already-open session or block plain browsing/reading, since there's
// no session-revocation hook wired up for that yet. The ADMIN_EMAIL
// account can't be banned through this route, for the same reason it
// can't be demoted above.
app.patch('/admin/users/:id/ban', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { is_banned } = req.body || {};

    if (typeof is_banned !== 'boolean') {
        return res.status(400).json({ message: 'is_banned must be a boolean.' });
    }

    const { data: target, error: targetError } = await supabase
        .from('users')
        .select('email')
        .eq('id', id)
        .single();

    if (targetError) {
        return res.status(404).json({ message: 'User not found.' });
    }

    const adminEmail = process.env.ADMIN_EMAIL;
    if (is_banned && adminEmail && target.email === adminEmail) {
        return res.status(400).json({ message: "Can't ban the account tied to ADMIN_EMAIL." });
    }

    const { data, error } = await supabase
        .from('users')
        .update({ is_banned })
        .eq('id', id)
        .select('id, email, username, created_at, is_admin, is_banned')
        .single();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({ message: is_banned ? 'User banned' : 'User unbanned', data });
});

// Route 13d - Permanently delete a user (admin only). Removes their
// ratings and watchlist entries first, then the users row, then their
// Supabase Auth account -- in that order so a failure partway through
// never leaves an orphaned auth account that can still sign in after
// their profile's gone. The auth deletion needs the service-role key (the
// same key this whole backend already runs on); if it fails for some
// reason the app data is still fully removed, so this logs a warning
// rather than rolling back or blocking the response on it. The
// ADMIN_EMAIL account can't be deleted through this route.
app.delete('/admin/users/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { data: target, error: targetError } = await supabase
        .from('users')
        .select('email, auth_id')
        .eq('id', id)
        .single();

    if (targetError) {
        return res.status(404).json({ message: 'User not found.' });
    }

    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail && target.email === adminEmail) {
        return res.status(400).json({ message: "Can't delete the account tied to ADMIN_EMAIL." });
    }

    const { error: ratingsError } = await supabase.from('ratings').delete().eq('user_id', id);
    if (ratingsError) return res.status(500).json({ message: ratingsError.message });

    const { error: listsError } = await supabase.from('user_lists').delete().eq('user_id', id);
    if (listsError) return res.status(500).json({ message: listsError.message });

    const { error: userError } = await supabase.from('users').delete().eq('id', id);
    if (userError) return res.status(500).json({ message: userError.message });

    if (target.auth_id) {
        const { error: authDeleteError } = await supabase.auth.admin.deleteUser(target.auth_id);
        if (authDeleteError) {
            console.error('Deleted users row for id ' + id + ' but failed to delete its auth account:', authDeleteError.message);
        }
    }

    res.status(200).json({ message: 'User deleted' });
});

// Route 14 - List every rating/review across all series (admin only).
// Reviews aren't shown anywhere on the public site yet (no display feature
// built), but people can already submit review_text via POST /ratings --
// this gives admins visibility into what's been written, and a way to
// remove anything inappropriate, before public display ever ships.
// Ordered by id descending (a safe recency proxy regardless of whether
// this table happens to have a created_at column).
app.get('/admin/reviews', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { data, error } = await supabase
        .from('ratings')
        .select('*, users (username, email), series (id, title, poster_url)')
        .order('id', { ascending: false });

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({
        message: 'Reviews',
        count: data.length,
        data
    });
});

// Route 15 - Remove a rating/review (admin only). Deletes the whole row --
// score included -- rather than just blanking review_text, so a removed
// review doesn't leave a scoreless rating with no explanation behind it.
app.delete('/admin/reviews/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { error } = await supabase
        .from('ratings')
        .delete()
        .eq('id', id);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(200).json({ message: 'Review removed' });
});

// Route 16 - Trigger a new TMDB discovery run (admin only). Only one run
// at a time -- concurrent runs would double-queue candidates and fight
// over TMDB's rate limit -- so this 409s if one's already in progress
// instead of silently starting a second. Returns immediately; poll
// GET /admin/import/status for progress and the tail of its log output.
app.post('/admin/import/run', async (req: Request, res: Response) => {
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
app.get('/admin/import/status', async (req: Request, res: Response) => {
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

// Route 18 - Edit a published series (admin only). Unlike candidate
// approval's `overrides`, this mutates a LIVE row directly -- there was
// previously no way to fix a typo, swap a wrong poster, or correct a
// field on anything already published. Every field is optional (only
// what's sent gets updated); genre_names, if present, is the COMPLETE
// desired genre list and gets diffed against what's currently linked
// (find-or-create each, same pattern as the approve route), not appended.
app.patch('/admin/series/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const body = req.body || {};

    const editableFields = [
        'title', 'original_title', 'synopsis', 'country', 'year', 'episode_count', 'status',
        'poster_url', 'backdrop_url', 'romance_pace', 'emotional_intensity', 'ending_type', 'content_level',
    ] as const;

    const update: Record<string, unknown> = {};
    for (const field of editableFields) {
        if (body[field] !== undefined) update[field] = body[field];
    }

    if (Object.keys(update).length > 0) {
        const { error: updateError } = await supabase
            .from('series')
            .update(update)
            .eq('id', id);

        if (updateError) {
            return res.status(500).json({ message: updateError.message });
        }
    }

    // Tag reassignment (mood/trope/relationship_dynamic/theme/content_warning):
    // unlike genres this points straight into the shared `tags` table by id,
    // so it's a diff-and-repoint rather than a find-or-create -- identical
    // logic to PATCH /admin/candidates/:id/taxonomy's tag_ids handling, just
    // against series_tags instead of series_candidate_tags. tag_ids, if
    // present, is the COMPLETE desired set across all dimensions.
    if (Array.isArray(body.tag_ids)) {
        const { data: existingTagLinks, error: fetchTagsError } = await supabase
            .from('series_tags')
            .select('tag_id')
            .eq('series_id', id);

        if (fetchTagsError) {
            return res.status(500).json({ message: fetchTagsError.message });
        }

        const existingTagIds = new Set((existingTagLinks || []).map((row) => row.tag_id));
        const desiredTagIds = new Set(body.tag_ids as number[]);

        const tagsToInsert = (body.tag_ids as number[]).filter((tagId) => !existingTagIds.has(tagId));
        const tagsToDelete = [...existingTagIds].filter((tagId) => !desiredTagIds.has(tagId));

        if (tagsToInsert.length > 0) {
            const { error: insertTagsError } = await supabase
                .from('series_tags')
                .insert(tagsToInsert.map((tagId) => ({ series_id: id, tag_id: tagId })));

            if (insertTagsError) {
                return res.status(500).json({ message: insertTagsError.message });
            }
        }

        if (tagsToDelete.length > 0) {
            const { error: deleteTagsError } = await supabase
                .from('series_tags')
                .delete()
                .eq('series_id', id)
                .in('tag_id', tagsToDelete);

            if (deleteTagsError) {
                return res.status(500).json({ message: deleteTagsError.message });
            }
        }
    }

    // Genre reassignment: find-or-create each named genre, then diff against
    // what's currently linked so this can both add and remove genres from an
    // existing series (not just append).
    if (Array.isArray(body.genre_names)) {
        const { data: existingLinks, error: existingLinksError } = await supabase
            .from('series_genres')
            .select('genre_id, genres (name)')
            .eq('series_id', id);

        if (existingLinksError) {
            return res.status(500).json({ message: existingLinksError.message });
        }

        const currentNames = new Set(
            (existingLinks || []).map((row: any) => row.genres?.name).filter(Boolean)
        );
        const desiredNames = new Set((body.genre_names as string[]).filter(Boolean));

        const namesToAdd = [...desiredNames].filter((name) => !currentNames.has(name));
        const linksToRemove = (existingLinks || []).filter(
            (row: any) => row.genres?.name && !desiredNames.has(row.genres.name)
        );

        for (const genreName of namesToAdd) {
            const { data: existingGenre } = await supabase
                .from('genres')
                .select('id')
                .eq('name', genreName)
                .maybeSingle();

            let genreId = existingGenre?.id;

            if (!genreId) {
                const { data: createdGenre, error: genreError } = await supabase
                    .from('genres')
                    .insert([{ name: genreName }])
                    .select('id')
                    .single();

                if (genreError || !createdGenre) {
                    console.error('Failed to create genre "' + genreName + '": ' + genreError?.message);
                    continue;
                }
                genreId = createdGenre.id;
            }

            const { error: linkError } = await supabase
                .from('series_genres')
                .insert([{ series_id: id, genre_id: genreId }]);

            if (linkError) {
                console.error('Failed to link genre "' + genreName + '": ' + linkError.message);
            }
        }

        for (const row of linksToRemove as any[]) {
            const { error: unlinkError } = await supabase
                .from('series_genres')
                .delete()
                .eq('series_id', id)
                .eq('genre_id', row.genre_id);

            if (unlinkError) {
                console.error('Failed to unlink genre id ' + row.genre_id + ': ' + unlinkError.message);
            }
        }
    }

    res.status(200).json({ message: 'Series updated' });
});

// Route 19 - Permanently remove a published series (admin only). Cleans up
// every table that references series_id first -- link tables plus
// ratings/watchlist entries real users may have created -- rather than
// relying on ON DELETE CASCADE being configured (same caution as the
// candidate restore route above), so this can't fail partway with orphaned
// rows left behind or a foreign-key error on the final delete.
app.delete('/admin/series/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const cleanupTables = ['series_genres', 'series_cast', 'series_tags', 'ratings', 'user_lists', 'curator_picks'];

    for (const table of cleanupTables) {
        const { error } = await supabase.from(table).delete().eq('series_id', id);
        if (error) {
            return res.status(500).json({ message: 'Failed to clean up ' + table + ': ' + error.message });
        }
    }

    const { error: deleteError } = await supabase.from('series').delete().eq('id', id);

    if (deleteError) {
        return res.status(500).json({ message: deleteError.message });
    }

    res.status(200).json({ message: 'Series deleted' });
});

// Shared shape-builder for curator picks -- both the public and admin
// routes below join the same series/genre/tags data, so this keeps that
// one join/flatten in one place instead of duplicated inline twice.
async function fetchCuratorPicksJoined() {
    const { data, error } = await supabase
        .from('curator_picks')
        .select(
            'id, blurb, is_feature, sort_order, series (id, title, country, year, poster_url, backdrop_url, ' +
            'series_genres (genres (name)), series_tags (tags (display_label)))'
        )
        .order('is_feature', { ascending: false })
        .order('sort_order', { ascending: true });

    if (error || !data) return { error, data: [] as any[] };

    const seriesIds = data.map((p: any) => p.series?.id).filter(Boolean);

    // Real average rating per picked series, computed from actual
    // `ratings` rows -- these are meant to be genuinely featured titles
    // now, so this uses the real number instead of the deterministic mock
    // rating helper the rest of the catalog UI falls back to.
    const ratingsBySeries = new Map<number, number[]>();
    if (seriesIds.length > 0) {
        const { data: ratingsRows } = await supabase.from('ratings').select('series_id, score').in('series_id', seriesIds);
        for (const row of ratingsRows || []) {
            const list = ratingsBySeries.get(row.series_id) || [];
            list.push(row.score);
            ratingsBySeries.set(row.series_id, list);
        }
    }

    const shaped = data
        .filter((p: any) => p.series)
        .map((p: any) => {
            const scores = ratingsBySeries.get(p.series.id) || [];
            const avgRating = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
            // Real mood/trope tags if the series has any (series_tags),
            // otherwise fall back to genre names -- better than an empty
            // chip row for a series that's been genre-tagged but not yet
            // run through the newer tags picker in SeriesEditModal.
            const realTags = (p.series.series_tags || []).map((row: any) => row.tags?.display_label).filter(Boolean);
            const genreNames = (p.series.series_genres || []).map((row: any) => row.genres?.name).filter(Boolean);
            return {
                id: p.series.id,
                pick_id: p.id,
                title: p.series.title,
                country: p.series.country,
                mediaType: 'Series',
                year: p.series.year,
                rating: avgRating,
                tags: realTags.length > 0 ? realTags : genreNames,
                imageUrl: p.series.backdrop_url ?? p.series.poster_url,
                isFeature: p.is_feature,
                blurb: p.blurb,
            };
        });

    return { error: null, data: shaped };
}

// Route 20 - Public: today's curator picks (feature + list), for the
// homepage's Curator's Picks section. No auth required -- this is
// display data, same as GET /series. Replaces the old
// allSeries.slice(6, 10)-with-fake-tags placeholder in
// HomeLanding.tsx/HomeAuthed.tsx; falls back to their existing mock
// content on the frontend side if this list is empty (no picks curated
// yet), same real-first-then-mock convention as everywhere else.
app.get('/curator-picks', async (req: Request, res: Response) => {
    const { error, data } = await fetchCuratorPicksJoined();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({ message: 'Curator picks', data });
});

// Route 21 - Admin: same data as above, for the management screen
// (app/admin/curator-picks/page.tsx). No separate active/inactive
// distinction like tags/genres have -- a curator pick either exists (and
// shows on the homepage) or it's been removed, there's no soft-delete
// state for these.
app.get('/admin/curator-picks', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { error, data } = await fetchCuratorPicksJoined();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({ message: 'Curator picks', data });
});

// Route 22 - Add a series to Curator Picks (admin only). Body:
// { series_id, blurb?, is_feature? }. Only one pick can be the feature at
// a time -- see the invariant note on Route 23 -- so is_feature: true here
// unsets it on every other row first.
app.post('/admin/curator-picks', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { series_id, blurb, is_feature } = req.body || {};

    if (!series_id) {
        return res.status(400).json({ message: 'series_id is required.' });
    }

    if (is_feature) {
        await supabase.from('curator_picks').update({ is_feature: false }).eq('is_feature', true);
    }

    let nextSortOrder = 0;
    const { data: existing } = await supabase
        .from('curator_picks')
        .select('sort_order')
        .order('sort_order', { ascending: false })
        .limit(1);
    if (existing && existing.length > 0) nextSortOrder = existing[0].sort_order + 1;

    const { data, error } = await supabase
        .from('curator_picks')
        .insert({ series_id, blurb: blurb || null, is_feature: !!is_feature, sort_order: nextSortOrder })
        .select()
        .single();

    if (error) {
        if (error.code === '23505') {
            return res.status(409).json({ message: 'That series is already a curator pick.' });
        }
        return res.status(500).json({ message: error.message });
    }

    res.status(201).json({ message: 'Curator pick added', data });
});

// Route 23 - Edit a curator pick's blurb/feature state/order (admin only).
// Body: any of { blurb, is_feature, sort_order }. is_feature is a single-
// row invariant across the whole table (there's exactly one Feature card
// on the homepage) -- setting it true here unsets it everywhere else
// first, in the same request, so there's never a moment with two (or
// zero, if you just wanted to swap which one) featured rows from the
// caller's point of view.
app.patch('/admin/curator-picks/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { blurb, is_feature, sort_order } = req.body || {};

    if (is_feature === true) {
        await supabase.from('curator_picks').update({ is_feature: false }).eq('is_feature', true).neq('id', id);
    }

    const updates: Record<string, unknown> = {};
    if (blurb !== undefined) updates.blurb = blurb;
    if (is_feature !== undefined) updates.is_feature = is_feature;
    if (sort_order !== undefined) updates.sort_order = sort_order;

    const { data, error } = await supabase
        .from('curator_picks')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({ message: 'Curator pick updated', data });
});

// Route 24 - Remove a series from Curator Picks (admin only). Does not
// touch the series itself -- this only un-features it.
app.delete('/admin/curator-picks/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { error } = await supabase.from('curator_picks').delete().eq('id', id);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(200).json({ message: 'Curator pick removed' });
});

app.listen(PORT, () => {
    console.log(`BL Series API is running at http://localhost:${PORT}`);
    reconcileOrphanedImportRun();
});