// src/routes/me.ts -- the signed-in user's own profile (auth required).
//
// H4-02: the Home tab greeting derives its display name from the Supabase
// Auth email prefix (user.email.split('@')[0]) because there was no route
// for a signed-in user to fetch their own users.username -- that column
// already exists and is populated (see getOrCreateUserId in
// middleware/auth.ts, which sets it on first login), but was previously
// only ever selected from admin routes. This route exposes it to the
// account it actually belongs to.

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

export default router;
