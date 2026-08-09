// src/routes/admin/reviews.ts -- moderate ratings/reviews (admin only).

import { Router, Request, Response } from 'express';
import { supabase } from '../../services/supabase';
import { requireAdmin } from '../../middleware/auth';

const router = Router();

// Route 14 - List every rating/review across all series (admin only).
// Reviews aren't shown anywhere on the public site yet (no display feature
// built), but people can already submit review_text via POST /ratings --
// this gives admins visibility into what's been written, and a way to
// remove anything inappropriate, before public display ever ships.
// Ordered by id descending (a safe recency proxy regardless of whether
// this table happens to have a created_at column).
router.get('/', async (req: Request, res: Response) => {
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
router.delete('/:id', async (req: Request, res: Response) => {
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

export default router;
