// src/routes/admin/users.ts -- user management: list, promote/demote,
// ban/unban, delete (admin only).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../../services/supabase';
import { requireAdmin } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { logAdminAction } from '../../services/auditLog';

const router = Router();

// A2-01: same type check the old ad hoc if-checks did, declared once via zod.
const adminFlagSchema = z.object({
    is_admin: z.boolean({ message: 'is_admin must be a boolean.' }),
});
const banFlagSchema = z.object({
    is_banned: z.boolean({ message: 'is_banned must be a boolean.' }),
});

// Route 13 - List registered users with their activity counts (admin only).
// Ratings/watchlist counts are computed in-memory from the raw user_id
// columns rather than a Postgres GROUP BY -- simplest thing that works
// correctly at this app's current scale, no RPC/view needed. If the users
// table grows large enough for this to matter, switch to a `.rpc()` call
// against a SQL aggregate instead of adding pagination band-aids here.
// A2-03: pagination is opt-in via page/limit, same convention P2-04 used for
// GET /series -- omitting them preserves today's full-list behavior exactly.
// Independent of whether pagination is requested, the ratings/user_lists
// count queries are now scoped to just the user ids actually being
// returned (`.in('user_id', userIds)`) instead of pulling every row in
// both tables regardless of how many users are on the page -- that's the
// bigger of the two problems this task called out, and fixing it doesn't
// depend on the caller having adopted the new paginated response shape.
router.get('/', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const hasPagination = req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 20));

    let usersQuery = supabase
        .from('users')
        .select('id, email, username, created_at, is_admin, is_banned', hasPagination ? { count: 'exact' } : {})
        .order('created_at', { ascending: false });

    if (hasPagination) {
        const from = (page - 1) * limit;
        const to = from + limit - 1;
        usersQuery = usersQuery.range(from, to);
    }

    const { data: users, error: usersError, count } = await usersQuery;
    if (usersError) return res.status(500).json({ message: usersError.message });

    const userIds = users.map((u) => u.id);

    const [ratingsRes, listsRes] = userIds.length > 0
        ? await Promise.all([
            supabase.from('ratings').select('user_id').in('user_id', userIds),
            supabase.from('user_lists').select('user_id').in('user_id', userIds),
        ])
        : [{ data: [], error: null }, { data: [], error: null }];

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

    // is_admin here is the real column now, OR'd with the ADMIN_EMAIL
    // bootstrap match -- so the owner's account always shows correctly as
    // Admin even in the moment before requireAdmin's self-heal has run.
    const data = users.map((u) => ({
        ...u,
        ratings_count: ratingsCountByUser.get(u.id) || 0,
        watchlist_count: watchlistCountByUser.get(u.id) || 0,
        is_admin: u.is_admin || (!!adminEmail && u.email === adminEmail),
        // The frontend uses this to disable promote/ban/delete on the
        // bootstrap account -- those routes already reject those actions
        // server-side too (see the ADMIN_EMAIL checks in each), but
        // without this the buttons would look clickable, submit, and only
        // then silently fail.
        is_root: !!adminEmail && u.email === adminEmail,
    }));

    res.json({
        message: 'Users',
        count: data.length,
        data,
        ...(hasPagination && {
            pagination: {
                page,
                limit,
                total: count ?? data.length,
                has_more: page * limit < (count ?? 0),
            },
        }),
    });
});
// Route 13b - Promote/demote a user's admin status (admin only). Body:
// { is_admin: boolean }. The ADMIN_EMAIL account can't be demoted through
// this route -- that account's access comes from the env var regardless of
// this column (see requireAdmin), so demoting it here would just be
// confusing (the Users list would show them as Member, but they'd still
// have full access) rather than actually removing anything.
router.patch('/:id/admin', validateBody(adminFlagSchema), async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { is_admin } = req.body;

    const { data: target, error: targetError } = await supabase
        .from('users')
        .select('email')
        .eq('id', id)
        .single();

    if (targetError) {
        return res.status(404).json({ message: 'User not found.' });
    }

    const adminEmail = process.env.ADMIN_EMAIL;
    if (!is_admin && adminEmail && target.email === adminEmail) {
        return res.status(400).json({ message: "Can't remove admin from the account tied to ADMIN_EMAIL." });
    }

    const { data, error } = await supabase
        .from('users')
        .update({ is_admin })
        .eq('id', id)
        .select('id, email, username, created_at, is_admin, is_banned')
        .single();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    await logAdminAction(req, is_admin ? 'user.promote' : 'user.demote', 'user:' + id);

    res.json({ message: is_admin ? 'User promoted to admin' : 'Admin access removed', data });
});
// Route 13c - Ban/unban a user (admin only). Body: { is_banned: boolean }.
// A banned account is rejected by requireAdmin (can't use admin routes)
// and by getOrCreateUserId (can't rate or manage a watchlist) -- see both
// for exactly what banning currently blocks. It does not sign them out of
// an already-open session or block plain browsing/reading, since there's
// no session-revocation hook wired up for that yet. The ADMIN_EMAIL
// account can't be banned through this route, for the same reason it
// can't be demoted above.
router.patch('/:id/ban', validateBody(banFlagSchema), async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { is_banned } = req.body;

    const { data: target, error: targetError } = await supabase
        .from('users')
        .select('email')
        .eq('id', id)
        .single();

    if (targetError) {
        return res.status(404).json({ message: 'User not found.' });
    }

    const adminEmail = process.env.ADMIN_EMAIL;
    if (is_banned && adminEmail && target.email === adminEmail) {
        return res.status(400).json({ message: "Can't ban the account tied to ADMIN_EMAIL." });
    }

    const { data, error } = await supabase
        .from('users')
        .update({ is_banned })
        .eq('id', id)
        .select('id, email, username, created_at, is_admin, is_banned')
        .single();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    await logAdminAction(req, is_banned ? 'user.ban' : 'user.unban', 'user:' + id);

    res.json({ message: is_banned ? 'User banned' : 'User unbanned', data });
});
// Route 13d - Permanently delete a user (admin only). Removes their
// ratings and watchlist entries first, then the users row, then their
// Supabase Auth account -- in that order so a failure partway through
// never leaves an orphaned auth account that can still sign in after
// their profile's gone. The auth deletion needs the service-role key (the
// same key this whole backend already runs on); if it fails for some
// reason the app data is still fully removed, so this logs a warning
// rather than rolling back or blocking the response on it. The
// ADMIN_EMAIL account can't be deleted through this route.
router.delete('/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { data: target, error: targetError } = await supabase
        .from('users')
        .select('email, auth_id')
        .eq('id', id)
        .single();

    if (targetError) {
        return res.status(404).json({ message: 'User not found.' });
    }

    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail && target.email === adminEmail) {
        return res.status(400).json({ message: "Can't delete the account tied to ADMIN_EMAIL." });
    }

    const { error: ratingsError } = await supabase.from('ratings').delete().eq('user_id', id);
    if (ratingsError) return res.status(500).json({ message: ratingsError.message });

    const { error: listsError } = await supabase.from('user_lists').delete().eq('user_id', id);
    if (listsError) return res.status(500).json({ message: listsError.message });

    // H2-03: same explicit-cleanup-before-delete convention as
    // ratings/user_lists above -- these three all cascade on user_id too
    // (see migrations/008_gamification_tables.sql), but this codebase
    // deletes FK dependents explicitly rather than relying on that.
    for (const table of ['user_xp_events', 'user_activity_days', 'user_stats']) {
        const { error: gamificationError } = await supabase.from(table).delete().eq('user_id', id);
        if (gamificationError) return res.status(500).json({ message: gamificationError.message });
    }

    const { error: userError } = await supabase.from('users').delete().eq('id', id);
    if (userError) return res.status(500).json({ message: userError.message });

    if (target.auth_id) {
        const { error: authDeleteError } = await supabase.auth.admin.deleteUser(target.auth_id);
        if (authDeleteError) {
            console.error('Deleted users row for id ' + id + ' but failed to delete its auth account:', authDeleteError.message);
        }
    }

    await logAdminAction(req, 'user.delete', 'user:' + id);

    res.status(200).json({ message: 'User deleted' });
});

export default router;
