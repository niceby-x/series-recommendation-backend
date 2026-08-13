// src/routes/watchlist.ts -- personal watchlist CRUD (auth required).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../services/supabase';
import { getOrCreateUserId } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { recordActivity } from '../services/gamification';

const router = Router();

const WATCHLIST_STATUSES = ['plan_to_watch', 'watching', 'completed'] as const;

// P2-03: same series_id/status-enum check the old ad hoc if-check did,
// same error message, just declared once as a schema.
const upsertWatchlistSchema = z.object({
    series_id: z.number({
        error: `series_id and a valid status (${WATCHLIST_STATUSES.join(', ')}) are required`,
    }),
    status: z.enum(WATCHLIST_STATUSES, {
        error: `series_id and a valid status (${WATCHLIST_STATUSES.join(', ')}) are required`,
    }),
});

// H2-02: current_episode is the only required field -- minutes_remaining
// is optional (see the migration's comment: there's no stored per-episode
// runtime to derive it from, so the frontend player supplies it if it
// has it, and omits it otherwise). 1-indexed and no upper bound enforced
// here against series.episode_count on purpose -- episode_count on a
// still-airing series changes over time (new episodes get added), and
// re-validating against it on every progress ping would mean this route
// starts failing for someone mid-episode the moment a series' episode
// count is edited in admin, which is a worse failure mode than trusting
// the player.
const updateProgressSchema = z.object({
    current_episode: z.number({ error: 'current_episode is required' }).int().positive(),
    minutes_remaining: z.number().int().nonnegative().nullable().optional(),
});

// Route 5 - Add or update a watchlist entry (upsert)
router.post('/', validateBody(upsertWatchlistSchema), async (req: Request, res: Response) => {
    const { series_id, status } = req.body;

    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to update your watchlist'
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

    // H2-03: same fire-and-forget reasoning as POST /ratings -- see that
    // route's comment.
    recordActivity(user_id, 'watchlist').catch((err) => {
        console.error('Failed to record gamification activity for watchlist update:', err instanceof Error ? err.message : err);
    });

    res.status(200).json({
        message: 'Watchlist updated',
        data: data[0]
    });
});
// Route 6 - Get the logged-in user's full watchlist, with series details
// and (H2-02) per-series episode progress joined in
router.get('/', async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to view your watchlist'
        });
    }

    // H2-02: user_episode_progress isn't FK-linked to user_lists (both
    // reference users/series independently, not each other -- see the
    // migration's comment on why progress is its own table), so it can't
    // be pulled in as a nested embed the way series_tags/series_genres
    // are elsewhere. Fetched separately and merged by series_id in JS
    // instead, same two-query-then-merge approach GET /activity uses.
    const [listResult, progressResult] = await Promise.all([
        supabase
            .from('user_lists')
            .select('id, status, updated_at, series (*)')
            .eq('user_id', user_id),
        supabase
            .from('user_episode_progress')
            .select('series_id, current_episode, minutes_remaining, updated_at')
            .eq('user_id', user_id),
    ]);

    if (listResult.error) {
        return res.status(500).json({ message: listResult.error.message });
    }
    if (progressResult.error) {
        return res.status(500).json({ message: progressResult.error.message });
    }

    const progressBySeriesId = new Map((progressResult.data || []).map((row: any) => [row.series_id, row]));

    const data = listResult.data.map((row: any) => {
        const progressRow = progressBySeriesId.get(row.series?.id);
        return {
            ...row,
            progress: progressRow
                ? {
                    current_episode: progressRow.current_episode,
                    total_episodes: row.series?.episode_count ?? null,
                    minutes_remaining: progressRow.minutes_remaining,
                    updated_at: progressRow.updated_at,
                }
                : null,
        };
    });

    res.json({
        message: 'Your watchlist',
        count: data.length,
        data
    });
});
// Route 7 - Get the logged-in user's status for one specific series (or null if not on their list)
router.get('/:seriesId', async (req: Request, res: Response) => {
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
// Route 7.5 - Update the logged-in user's episode progress for a series
// (H2-02). Upsert on (user_id, series_id) -- same reasoning as the
// watchlist upsert above: repeated pings from the player as someone
// watches should update the one row for this (user, series) pair, not
// create a new one each time.
router.put('/:seriesId/progress', validateBody(updateProgressSchema), async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to update your watch progress'
        });
    }

    const seriesId = parseInt(req.params.seriesId as string);
    const { current_episode, minutes_remaining } = req.body;

    const { data, error } = await supabase
        .from('user_episode_progress')
        .upsert(
            [{
                user_id,
                series_id: seriesId,
                current_episode,
                minutes_remaining: minutes_remaining ?? null,
                updated_at: new Date().toISOString(),
            }],
            { onConflict: 'user_id,series_id' }
        )
        .select();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(200).json({
        message: 'Progress updated',
        data: data[0]
    });
});
// Route 7.6 - Get the logged-in user's episode progress for one specific
// series (Q2-03). Previously the only way to read progress was the full
// GET / list (Route 6), which ProgressTracker.tsx used just to find the
// one row matching the current series -- an O(n) fetch against the whole
// watchlist to check a single series. This mirrors GET /:seriesId's
// shape (Route 7: signed-in-required, null when there's no row) but for
// user_episode_progress instead of user_lists.
router.get('/:seriesId/progress', async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to view your watch progress'
        });
    }

    const seriesId = parseInt(req.params.seriesId as string);

    const { data, error } = await supabase
        .from('user_episode_progress')
        .select('current_episode, minutes_remaining, updated_at')
        .eq('user_id', user_id)
        .eq('series_id', seriesId)
        .maybeSingle();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({
        message: 'Watch progress',
        progress: data
            ? {
                current_episode: data.current_episode,
                minutes_remaining: data.minutes_remaining,
                updated_at: data.updated_at,
            }
            : null,
    });
});
// Route 8 - Remove a series from the watchlist entirely
router.delete('/:seriesId', async (req: Request, res: Response) => {
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

export default router;
