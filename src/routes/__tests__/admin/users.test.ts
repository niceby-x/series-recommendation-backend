// src/routes/__tests__/admin/users.test.ts
//
// A3-01: covers user management -- especially A2-03 (pagination and
// scoping the ratings/user_lists count queries to just the returned page's
// user ids), A2-01's zod validation on the boolean-flag routes, the
// ADMIN_EMAIL bootstrap-account guard on promote/demote/ban/delete, and
// A2-02's audit logging on all three mutation routes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockSupabase, allowAdmin, rejectAdmin } from './testUtils';

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
const { logAdminActionMock } = vi.hoisted(() => ({ logAdminActionMock: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../../../middleware/auth', () => ({ requireAdmin: requireAdminMock }));
vi.mock('../../../services/auditLog', () => ({ logAdminAction: logAdminActionMock }));

const { supabase, queue } = mockSupabase();
vi.mock('../../../services/supabase', () => ({ get supabase() { return supabase; } }));

import usersRouter from '../../admin/users';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/admin/users', usersRouter);
    return app;
}

beforeEach(() => {
    vi.clearAllMocks();
    logAdminActionMock.mockResolvedValue(undefined);
    requireAdminMock.mockImplementation(allowAdmin());
    delete process.env.ADMIN_EMAIL;
});

describe('GET /admin/users', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).get('/admin/users');

        expect(res.status).toBe(403);
    });

    it('scopes the ratings/user_lists queries to only the returned users\' ids (A2-03)', async () => {
        queue('users', {
            data: [{ id: 1, email: 'a@a.com', is_admin: false, is_banned: false }, { id: 2, email: 'b@b.com', is_admin: false, is_banned: false }],
            error: null,
        });
        queue('ratings', { data: [{ user_id: 1 }, { user_id: 1 }], error: null });
        queue('user_lists', { data: [{ user_id: 2 }], error: null });

        const res = await request(buildApp()).get('/admin/users');

        expect(res.status).toBe(200);
        expect(res.body.data.find((u: any) => u.id === 1).ratings_count).toBe(2);
        expect(res.body.data.find((u: any) => u.id === 1).watchlist_count).toBe(0);
        expect(res.body.data.find((u: any) => u.id === 2).watchlist_count).toBe(1);
        expect(res.body.pagination).toBeUndefined();
    });

    it('skips the ratings/user_lists queries entirely when there are no users (empty page)', async () => {
        queue('users', { data: [], error: null, count: 0 });

        const res = await request(buildApp()).get('/admin/users?page=5&limit=20');

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
        expect(res.body.pagination).toEqual({ page: 5, limit: 20, total: 0, has_more: false });
    });

    it('marks the ADMIN_EMAIL account as is_admin and is_root even if its row is not yet flagged', async () => {
        process.env.ADMIN_EMAIL = 'owner@blumi.app';
        queue('users', { data: [{ id: 1, email: 'owner@blumi.app', is_admin: false, is_banned: false }], error: null });
        queue('ratings', { data: [], error: null });
        queue('user_lists', { data: [], error: null });

        const res = await request(buildApp()).get('/admin/users');

        expect(res.body.data[0].is_admin).toBe(true);
        expect(res.body.data[0].is_root).toBe(true);
    });
});

describe('PATCH /admin/users/:id/admin', () => {
    it('rejects a non-boolean is_admin with 400', async () => {
        const res = await request(buildApp()).patch('/admin/users/1/admin').send({ is_admin: 'yes' });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/is_admin must be a boolean/);
    });

    it('returns 404 when the target user does not exist', async () => {
        queue('users', { data: null, error: { message: 'not found' } });

        const res = await request(buildApp()).patch('/admin/users/999/admin').send({ is_admin: true });

        expect(res.status).toBe(404);
    });

    it("refuses to remove admin from the ADMIN_EMAIL account", async () => {
        process.env.ADMIN_EMAIL = 'owner@blumi.app';
        queue('users', { data: { email: 'owner@blumi.app' }, error: null });

        const res = await request(buildApp()).patch('/admin/users/1/admin').send({ is_admin: false });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/ADMIN_EMAIL/);
    });

    it('promotes a user and logs the action (A2-02)', async () => {
        queue('users', { data: { email: 'member@example.com' }, error: null });
        queue('users', { data: { id: 5, email: 'member@example.com', is_admin: true, is_banned: false }, error: null });

        const res = await request(buildApp()).patch('/admin/users/5/admin').send({ is_admin: true });

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('User promoted to admin');
        expect(logAdminActionMock).toHaveBeenCalledWith(expect.anything(), 'user.promote', 'user:5');
    });

    it('demotes a user and logs the action (A2-02)', async () => {
        queue('users', { data: { email: 'member@example.com' }, error: null });
        queue('users', { data: { id: 5, email: 'member@example.com', is_admin: false, is_banned: false }, error: null });

        const res = await request(buildApp()).patch('/admin/users/5/admin').send({ is_admin: false });

        expect(res.status).toBe(200);
        expect(logAdminActionMock).toHaveBeenCalledWith(expect.anything(), 'user.demote', 'user:5');
    });
});

describe('PATCH /admin/users/:id/ban', () => {
    it('rejects a non-boolean is_banned with 400', async () => {
        const res = await request(buildApp()).patch('/admin/users/1/ban').send({});

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/is_banned must be a boolean/);
    });

    it("refuses to ban the ADMIN_EMAIL account", async () => {
        process.env.ADMIN_EMAIL = 'owner@blumi.app';
        queue('users', { data: { email: 'owner@blumi.app' }, error: null });

        const res = await request(buildApp()).patch('/admin/users/1/ban').send({ is_banned: true });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/ADMIN_EMAIL/);
    });

    it('bans a user and logs the action (A2-02)', async () => {
        queue('users', { data: { email: 'member@example.com' }, error: null });
        queue('users', { data: { id: 5, email: 'member@example.com', is_admin: false, is_banned: true }, error: null });

        const res = await request(buildApp()).patch('/admin/users/5/ban').send({ is_banned: true });

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('User banned');
        expect(logAdminActionMock).toHaveBeenCalledWith(expect.anything(), 'user.ban', 'user:5');
    });
});

describe('DELETE /admin/users/:id', () => {
    it('rejects a non-admin with 403', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).delete('/admin/users/1');

        expect(res.status).toBe(403);
    });

    it('returns 404 when the target user does not exist', async () => {
        queue('users', { data: null, error: { message: 'not found' } });

        const res = await request(buildApp()).delete('/admin/users/999');

        expect(res.status).toBe(404);
    });

    it("refuses to delete the ADMIN_EMAIL account", async () => {
        process.env.ADMIN_EMAIL = 'owner@blumi.app';
        queue('users', { data: { email: 'owner@blumi.app', auth_id: 'auth-1' }, error: null });

        const res = await request(buildApp()).delete('/admin/users/1');

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/ADMIN_EMAIL/);
    });

    it('deletes ratings, watchlist, the user row, then the auth account, in that order, and logs the action', async () => {
        queue('users', { data: { email: 'member@example.com', auth_id: 'auth-5' }, error: null });
        queue('ratings', { data: null, error: null });
        queue('user_lists', { data: null, error: null });
        queue('users', { data: null, error: null });
        vi.mocked(supabase.auth.admin.deleteUser).mockResolvedValue({ error: null } as any);

        const res = await request(buildApp()).delete('/admin/users/5');

        expect(res.status).toBe(200);
        expect(supabase.auth.admin.deleteUser).toHaveBeenCalledWith('auth-5');
        expect(logAdminActionMock).toHaveBeenCalledWith(expect.anything(), 'user.delete', 'user:5');
    });

    it('still deletes app data and logs even if the auth-account deletion fails', async () => {
        queue('users', { data: { email: 'member@example.com', auth_id: 'auth-5' }, error: null });
        queue('ratings', { data: null, error: null });
        queue('user_lists', { data: null, error: null });
        queue('users', { data: null, error: null });
        vi.mocked(supabase.auth.admin.deleteUser).mockResolvedValue({ error: { message: 'auth service down' } } as any);

        const res = await request(buildApp()).delete('/admin/users/5');

        expect(res.status).toBe(200);
        expect(logAdminActionMock).toHaveBeenCalledWith(expect.anything(), 'user.delete', 'user:5');
    });
});
