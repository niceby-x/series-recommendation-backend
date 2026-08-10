// src/services/auditLog.ts
//
// A2-02: no audit trail existed for admin actions -- ban/unban,
// promote/demote, delete user, and approve/reject/restore candidate all
// changed state with nothing recording who did it or when. logAdminAction
// writes one row per call into admin_actions (see
// migrations/006_admin_actions_table.sql) for exactly those six actions,
// per this task's scope -- not every admin mutation route in the app.
//
// Deliberately fire-and-log rather than fire-and-fail: a logging failure
// (migration not yet run, transient DB error, etc.) is reported to the
// console but never blocks or rolls back the admin action it's attached
// to. An admin ban/delete/approve succeeding is more important than the
// audit row about it, and the caller already got a real response either
// way -- same reasoning DELETE /admin/users/:id already uses for its own
// non-blocking auth-account-deletion warning.

import { Request } from 'express';
import { supabase } from './supabase';

export async function logAdminAction(req: Request, action: string, target: string): Promise<void> {
    const actor = req.adminActor;

    const { error } = await supabase.from('admin_actions').insert({
        actor_user_id: actor?.id ?? null,
        actor_email: actor?.email ?? null,
        action,
        target,
    });

    if (error) {
        console.error('Failed to write admin_actions row for "' + action + '" on "' + target + '": ' + error.message);
    }
}
