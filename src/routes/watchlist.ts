// src/routes/watchlist.ts -- personal watchlist CRUD (auth required).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../services/supabase';
import { getOrCreateUserId } from '../middleware/auth';
import { validateBody } from '../middleware/validate';

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

    res.status(200).json({
        message: 'Watchlist updated',
        data: data[0]
    });
});
// Route 6 - Get the logged-in user's full watchlist, with series details joined in
router.get('/', async (req: Request, res: Response) => {
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
