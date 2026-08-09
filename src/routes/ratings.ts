// src/routes/ratings.ts -- submit/read ratings (auth required).

import { Router, Request, Response } from 'express';
import { supabase } from '../services/supabase';
import { Rating, ApiResponse } from '../types';
import { getOrCreateUserId } from '../middleware/auth';

const router = Router();

// Route 4 - Submit a rating (upsert -- resubmitting for a series you've
// already rated updates that row instead of creating a duplicate one).
router.post('/', async (req: Request, res: Response) => {
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
        .upsert(
            [{ user_id, series_id, score, review_text }],
            { onConflict: 'user_id,series_id' }
        )
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
// Route 4b - Get the logged-in user's own rating for one series, so
// RatingForm can prefill instead of showing blank for someone who's
// already rated (paired with the upsert above -- without this lookup,
// resubmitting silently overwrote a prior review with no warning at all).
// Mirrors GET /watchlist/:seriesId's per-user/per-series shape.
router.get('/mine/:seriesId', async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to view your rating'
        });
    }

    const seriesId = parseInt(req.params.seriesId as string);

    const { data, error } = await supabase
        .from('ratings')
        .select('score, review_text')
        .eq('user_id', user_id)
        .eq('series_id', seriesId)
        .maybeSingle();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({
        message: 'Your rating',
        data: data ?? null
    });
});

export default router;
