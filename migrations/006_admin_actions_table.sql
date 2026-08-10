-- Run this once in the Supabase SQL editor before deploying the audit
-- logging added to the ban/unban, promote/demote, delete-user, and
-- approve/reject/restore-candidate admin routes (A2-02) -- those routes
-- call logAdminAction() (src/services/auditLog.ts), which inserts into this
-- table, and will fail every one of those calls until it exists (though
-- logAdminAction() swallows its own errors rather than blocking the
-- underlying admin action, so this wouldn't break those routes -- it would
-- just mean nothing gets logged).
--
-- actor_user_id is nullable and ON DELETE SET NULL rather than CASCADE --
-- if an admin account is later deleted, the historical record of what they
-- did should still exist (that's the whole point of an audit trail), just
-- no longer resolvable to a live user row. actor_email is stored
-- redundantly alongside it for the same reason: still readable after the
-- user row is gone.

create table if not exists admin_actions (
    id bigserial primary key,
    actor_user_id integer references users(id) on delete set null,
    actor_email text,
    action text not null,
    target text not null,
    created_at timestamptz not null default now()
);

create index if not exists admin_actions_created_at_idx on admin_actions (created_at desc);
