// src/routes/me.ts -- the signed-in user's own profile and activity
// (auth required).
//
// H4-02: the Home tab greeting derives its display name from the Supabase
// Auth email prefix (user.email.split('@')[0]) because there was no route
// for a signed-in user to fetch their own users.username -- that column
// already exists and is populated (see getOrCreateUserId in
// middleware/auth.ts, which sets it on first login), but was previously
// only ever selected from admin routes. This route exposes it to the
// account it actually belongs to.
//
// H2-04: GET /activity below adds the same "signed-in user's own data"
// shape for Recent Activity -- see its own comment further down.

import { Router, Request, Response } from 'express';
import { supabase } from '../services/supabase';
import { getOrCreateUserId } from '../middleware/auth';
import { getGamificationSummary } from '../services/gamification';
import { getRecommendationsForUser } from '../services/recommendations';

const router = Router();

// Route - Get the logged-in user's own profile row
router.get('/', async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to view your profile'
        });
    }

    const { data, error } = await supabase
        .from('users')
        .select('id, email, username, created_at, is_admin')
        .eq('id', user_id)
        .single();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({
        message: 'Your profile',
        data
    });
});

// H2-04: Recent Activity on Home was 100% MOCK_RECENT_ACTIVITY -- every
// signed-in user saw the same fake watchlist/rating/progress events.
// This merges the user's own real ratings, watchlist changes, and (since
// H2-02 shipped) episode progress updates into one feed, newest first.
//
// Each source table is queried and limited independently, then merged
// and re-sorted/re-limited in JS -- there's no single table or view to
// order across all three at the database level without a raw SQL union,
// which the supabase-js client (no direct Postgres connection -- see
// migrations/README.md) can't express.
type RecentActivityKind = 'rating' | 'watchlist' | 'progress';

interface RecentActivityEntry {
    id: string;
    kind: RecentActivityKind;
    series_id: number;
    series_title: string;
    occurred_at: string;
    score?: number;
    status?: string;
    current_episode?: number;
    total_episodes?: number | null;
}

const RECENT_ACTIVITY_LIMIT = 10;

// Route - Get the logged-in user's recent activity (ratings + watchlist
// changes, newest first).
router.get('/activity', async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to view your activity'
        });
    }

    const [ratingsResult, watchlistResult, progressResult] = await Promise.all([
        supabase
            .from('ratings')
            .select('id, series_id, score, created_at, series (title)')
            .eq('user_id', user_id)
            .order('created_at', { ascending: false })
            .limit(RECENT_ACTIVITY_LIMIT),
        supabase
            .from('user_lists')
            .select('id, series_id, status, updated_at, series (title)')
            .eq('user_id', user_id)
            .order('updated_at', { ascending: false })
            .limit(RECENT_ACTIVITY_LIMIT),
        supabase
            .from('user_episode_progress')
            .select('id, series_id, current_episode, updated_at, series (title, episode_count)')
            .eq('user_id', user_id)
            .order('updated_at', { ascending: false })
            .limit(RECENT_ACTIVITY_LIMIT),
    ]);

    if (ratingsResult.error) {
        return res.status(500).json({ message: ratingsResult.error.message });
    }
    if (watchlistResult.error) {
        return res.status(500).json({ message: watchlistResult.error.message });
    }
    if (progressResult.error) {
        return res.status(500).json({ message: progressResult.error.message });
    }

    const ratingEntries: RecentActivityEntry[] = (ratingsResult.data || []).map((row: any) => ({
        id: 'rating:' + row.id,
        kind: 'rating',
        series_id: row.series_id,
        series_title: row.series?.title ?? 'Unknown series',
        occurred_at: row.created_at,
        score: row.score,
    }));

    // updated_at doubles as "added" and "status changed" -- this table
    // has no separate created_at column (see watchlist.ts's upsert,
    // which only ever sets updated_at), so a status transition (e.g.
    // plan_to_watch -> watching -> completed) surfaces as fresh activity
    // the same way a first-time add does. That's the right behavior for
    // an activity feed either way -- "you started watching X" and "you
    // finished X" are both real, recent things the user did.
    const watchlistEntries: RecentActivityEntry[] = (watchlistResult.data || []).map((row: any) => ({
        id: 'watchlist:' + row.id,
        kind: 'watchlist',
        series_id: row.series_id,
        series_title: row.series?.title ?? 'Unknown series',
        occurred_at: row.updated_at,
        status: row.status,
    }));

    // H2-02: real per-episode progress now exists, so this is an actual
    // "you got to episode 7" event, not a fabricated one -- see this
    // route's header comment for why this couldn't be included before.
    const progressEntries: RecentActivityEntry[] = (progressResult.data || []).map((row: any) => ({
        id: 'progress:' + row.id,
        kind: 'progress',
        series_id: row.series_id,
        series_title: row.series?.title ?? 'Unknown series',
        occurred_at: row.updated_at,
        current_episode: row.current_episode,
        total_episodes: row.series?.episode_count ?? null,
    }));

    const merged = [...ratingEntries, ...watchlistEntries, ...progressEntries]
        .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())
        .slice(0, RECENT_ACTIVITY_LIMIT);

    res.json({
        message: 'Your recent activity',
        data: merged,
    });
});

// H2-03: Bloom Journey (level/XP) and This Week's Journey (discovery
// streak) were both 100% MOCK_BLOOM_JOURNEY / MOCK_WEEKLY_JOURNEY --
// every signed-in user saw the identical level, XP, and streak. This one
// route serves both cards (they're both "this user's current gamification
// snapshot," no reason to make the frontend fire two fetches for it) --
// all the actual logic lives in services/gamification.ts and is unit
// tested there; this route is a thin pass-through, same shape as
// GET /activity above.
router.get('/gamification', async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to view your gamification stats'
        });
    }

    try {
        const data = await getGamificationSummary(user_id);
        res.json({
            message: 'Your gamification stats',
            data,
        });
    } catch (err) {
        res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to load gamification stats' });
    }
});

// H3-01: "Made For You" -- all the real matching logic lives in
// services/recommendations.ts (unit tested there); this route is the
// same thin auth-gate-then-pass-through shape as GET /gamification
// above. has_enough_signal tells the frontend whether to render the
// section at all vs. a "rate a few shows" prompt -- see the service's
// header comment for why an empty list here is the honest answer for a
// brand new user, not a fallback to generic popular titles.
router.get('/recommendations', async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to view your recommendations'
        });
    }

    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit as string) || 10));

    try {
        const { has_enough_signal, data } = await getRecommendationsForUser(user_id, limit);
        res.json({
            message: has_enough_signal ? 'Made for you' : 'Not enough signal yet',
            has_enough_signal,
            count: data.length,
            data,
        });
    } catch (err) {
        res.status(500).json({ message: err instanceof Error ? err.message : 'Failed to load recommendations' });
    }
});

export default router;
