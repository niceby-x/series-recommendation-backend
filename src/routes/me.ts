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
// This merges the user's own real ratings and watchlist changes into one
// feed, newest first.
//
// 'progress' events (the mock's "You finished episode 7 of X") are
// deliberately NOT included here -- there's no per-episode progress data
// anywhere in the schema yet (that's H2-02, not started). Returning only
// the two kinds this app can actually back with real data beats
// fabricating a fake progress event just to fill out the shape the mock
// used.
//
// Each source table is queried and limited independently, then merged
// and re-sorted/re-limited in JS -- there's no single table or view to
// order across both at the database level without a raw SQL union,
// which the supabase-js client (no direct Postgres connection -- see
// migrations/README.md) can't express.
type RecentActivityKind = 'rating' | 'watchlist';

interface RecentActivityEntry {
    id: string;
    kind: RecentActivityKind;
    series_id: number;
    series_title: string;
    occurred_at: string;
    score?: number;
    status?: string;
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

    const [ratingsResult, watchlistResult] = await Promise.all([
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
    ]);

    if (ratingsResult.error) {
        return res.status(500).json({ message: ratingsResult.error.message });
    }
    if (watchlistResult.error) {
        return res.status(500).json({ message: watchlistResult.error.message });
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

    const merged = [...ratingEntries, ...watchlistEntries]
        .sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())
        .slice(0, RECENT_ACTIVITY_LIMIT);

    res.json({
        message: 'Your recent activity',
        data: merged,
    });
});

export default router;
