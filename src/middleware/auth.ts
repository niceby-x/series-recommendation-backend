// src/middleware/auth.ts
//
// Shared auth helpers used across nearly every router (P4-04 split of the
// old monolithic src/index.ts). getOrCreateUserId backs any route that
// needs "who is this user" (ratings, watchlist, collections); requireAdmin
// backs every /admin/* route.

import { Request, Response } from 'express';
import { supabase } from '../services/supabase';

// Helper - Verify the Supabase Auth token and get-or-create the matching users row.
// Returns the integer user_id from the `users` table, or null if the token is invalid.
export async function getOrCreateUserId(authHeader: string | undefined): Promise<number | null> {
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
export async function requireAdmin(req: Request, res: Response): Promise<boolean> {
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
