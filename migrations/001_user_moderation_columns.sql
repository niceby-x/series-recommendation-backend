-- Run this once in the Supabase SQL editor before deploying the
-- /admin/users/:id/admin and /admin/users/:id/ban routes -- they read and
-- write these columns and will error on every call until this exists.
--
-- is_admin: promoted admins beyond the permanent ADMIN_EMAIL account
--   (checked by requireAdmin() in src/index.ts alongside ADMIN_EMAIL).
-- is_banned: mirrors the real ban state that /admin/users/:id/ban sets via
--   Supabase Auth's ban_duration -- kept here too so the admin Users list
--   can show it without a second lookup.

alter table users add column if not exists is_admin boolean not null default false;
alter table users add column if not exists is_banned boolean not null default false;
