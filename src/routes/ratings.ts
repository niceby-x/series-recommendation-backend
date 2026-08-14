// src/routes/ratings.ts -- submit/read ratings (auth required).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../services/supabase';
import { Rating, ApiResponse } from '../types';
import { getOrCreateUserId } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { recordActivity } from '../services/gamification';

const router = Router();

// P2-08: shared cap on review_text length, enforced here (server-side) and
// meant to be mirrored on the frontend's textarea maxLength so the two
// can't drift apart -- see the handoff note. 2000 chars is generous for a
// real review (roughly 300-400 words) while still keeping payloads and
// row sizes sane; there was no existing DB column limit or prior convention
// to inherit this from.
const REVIEW_TEXT_MAX_LENGTH = 2000;

// P2-03: same validation the old ad hoc if-checks did (series_id + score
// required, score 1-10, review_text capped), just declared once instead
// of three separate early-return blocks. Kept the exact same error
// messages so this is a behavior-preserving swap for any existing caller.
const submitRatingSchema = z
    .object({
        series_id: z.number().optional(),
        score: z.number().optional(),
        review_text: z
            .string()
            .max(REVIEW_TEXT_MAX_LENGTH, `review_text must be ${REVIEW_TEXT_MAX_LENGTH} characters or fewer`)
            .nullable()
            .optional(),
    })
    .superRefine((val, ctx) => {
        if (!val.series_id || !val.score) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'series_id and score are required' });
        } else if (!Number.isInteger(val.score) || val.score < 1 || val.score > 10) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Score must be an integer between 1 and 10' });
        }
    });

// Route 4 - Submit a rating (upsert -- resubmitting for a series you've
// already rated updates that row instead of creating a duplicate one).
router.post('/', validateBody(submitRatingSchema), async (req: Request, res: Response) => {
    const { series_id, score, review_text } = req.body;

    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to submit a rating'
        });
    }

    // Q3-03: recordActivity() should only fire for a user's first rating
    // of this series, not for score/review edits on an existing one --
    // otherwise updating a score from 7 to 9 pays out (or attempts to pay
    // out) gamification credit indistinguishable from a first-time
    // rating. The upsert below can't tell us after the fact whether it
    // inserted or updated, so check beforehand.
    const { data: existingRating, error: existingRatingError } = await supabase
        .from('ratings')
        .select('id')
        .eq('user_id', user_id)
        .eq('series_id', series_id)
        .maybeSingle();

    if (existingRatingError) {
        return res.status(500).json({ message: existingRatingError.message });
    }

    const isFirstTimeRating = !existingRating;

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

    // H2-03: fire-and-forget -- a rating that saved successfully should
    // never come back as a failure to the user just because the
    // gamification side-effect hiccuped. Logged so it's not silently
    // lost, but not awaited into the response.
    if (isFirstTimeRating) {
        recordActivity(user_id, 'rating').catch((err) => {
            console.error('Failed to record gamification activity for rating:', err instanceof Error ? err.message : err);
        });
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
