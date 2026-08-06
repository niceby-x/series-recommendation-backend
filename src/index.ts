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
app.get('/series', async (req: Request, res: Response) => {
    const { data, error } = await supabase
    .from('series')
    .select('*');

    if (error) {
        return res.status(500).json({ message: error.message});
    }

    const response: ApiResponse<Series[]> = {
        message: 'List of BL Series',
        count: data.length,
        data: data
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
    const { data, error } = await supabase
        .from('series')
        .select('*, series_genres (genres (name))')
        .eq('id', id)
        .single();

    if (error) {
        return res.status(404).json({
            message: "Series not found",
            error
        });
    }

    const { series_genres, ...rest } = data as any;
    const genre_names = (series_genres || []).map((row: any) => row.genres?.name).filter(Boolean);

    res.json({
        message: "Success",
        data: { ...rest, genre_names }
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
        .select('id')
        .eq('auth_id', authUser.id)
        .maybeSingle();

    if (existingError) {
        console.error('Error checking existing user:', existingError.message);
        return null;
    }

    if (existing) {
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

// Helper - Verify the request is from the signed-in admin account (checked against
// the ADMIN_EMAIL env var, never hardcoded). Sends the appropriate error response
// itself and returns false if the caller should stop; returns true if allowed to proceed.
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

    if (!adminEmail || authUser.email !== adminEmail) {
        res.status(403).json({ message: 'Admin access required.' });
        return false;
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

// Route 9c - Get all active taxonomy tags, grouped by dimension (admin only).
// Fetched once by the admin page on load, not per candidate row.
app.get('/admin/tags', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { data, error } = await supabase
        .from('tags')
        .select('id, dimension, value_key, display_label, display_emoji, sort_order')
        .eq('is_active', true)
        .order('dimension', { ascending: true })
        .order('sort_order', { ascending: true });

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

// Route 9d - Save a candidate's taxonomy (Curated Attributes + Discovery Tags) (admin only).
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
        supabase.from('users').select('id, email, username, created_at').order('created_at', { ascending: false }),
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

    const data = usersRes.data.map((u) => ({
        ...u,
        ratings_count: ratingsCountByUser.get(u.id) || 0,
        watchlist_count: watchlistCountByUser.get(u.id) || 0,
        is_admin: !!adminEmail && u.email === adminEmail,
    }));

    res.json({
        message: 'Users',
        count: data.length,
        data
    });
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

    const cleanupTables = ['series_genres', 'series_cast', 'series_tags', 'ratings', 'user_lists'];

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

app.listen(PORT, () => {
    console.log(`BL Series API is running at http://localhost:${PORT}`);
    reconcileOrphanedImportRun();
});