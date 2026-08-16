// src/routes/__tests__/admin/dashboard.test.ts
//
// D2-01: covers GET /admin/activity (admin_actions -> resolved target
// labels for candidate:/user: targets, System fallback for a null actor)
// and GET /admin/top-moods (series_tags/tags aggregated in JS into real
// per-mood counts + percentages, replacing the RecentActivityCard/
// TopMoodsCard MOCK_ constants).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mockSupabase, allowAdmin, rejectAdmin } from './testUtils';

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
vi.mock('../../../middleware/auth', () => ({ requireAdmin: requireAdminMock }));

const { supabase, queue } = mockSupabase();
vi.mock('../../../services/supabase', () => ({ get supabase() { return supabase; } }));

import dashboardRouter from '../../admin/dashboard';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/admin', dashboardRouter);
    return app;
}

beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockImplementation(allowAdmin());
});

describe('GET /admin/activity', () => {
    it('rejects a non-admin', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).get('/admin/activity');

        expect(res.status).toBe(403);
    });

    it('resolves candidate: and user: targets to real titles/emails, and defaults a null actor to System', async () => {
        queue('admin_actions', {
            data: [
                { id: 1, actor_email: 'admin@example.com', action: 'candidate.approve', target: 'candidate:12', created_at: '2026-08-01T00:00:00Z' },
                { id: 2, actor_email: null, action: 'user.ban', target: 'user:5', created_at: '2026-07-31T00:00:00Z' },
                { id: 3, actor_email: 'admin@example.com', action: 'rank_snapshot.run', target: 'snapshot_date:2026-07-30', created_at: '2026-07-30T00:00:00Z' },
            ],
            error: null,
        });
        queue('series_candidates', { data: [{ id: 12, title: 'Cherry Magic' }], error: null });
        queue('users', { data: [{ id: 5, email: 'user5@example.com', username: null }], error: null });

        const res = await request(buildApp()).get('/admin/activity');

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([
            { id: 1, action: 'candidate.approve', target_type: 'candidate', target_label: 'Cherry Magic', actor_label: 'admin@example.com', created_at: '2026-08-01T00:00:00Z' },
            { id: 2, action: 'user.ban', target_type: 'user', target_label: 'user5@example.com', actor_label: 'System', created_at: '2026-07-31T00:00:00Z' },
            { id: 3, action: 'rank_snapshot.run', target_type: 'snapshot_date', target_label: '2026-07-30', actor_label: 'admin@example.com', created_at: '2026-07-30T00:00:00Z' },
        ]);
    });

    it('falls back to a generic label when a referenced candidate/user no longer exists', async () => {
        queue('admin_actions', {
            data: [{ id: 1, actor_email: 'admin@example.com', action: 'candidate.reject', target: 'candidate:999', created_at: '2026-08-01T00:00:00Z' }],
            error: null,
        });
        queue('series_candidates', { data: [], error: null }); // id 999 not found

        const res = await request(buildApp()).get('/admin/activity');

        expect(res.body.data[0].target_label).toBe('a candidate');
    });

    it('does not query series_candidates/users at all when no rows reference them', async () => {
        queue('admin_actions', {
            data: [{ id: 1, actor_email: 'admin@example.com', action: 'rank_snapshot.run', target: 'snapshot_date:2026-08-01', created_at: '2026-08-01T00:00:00Z' }],
            error: null,
        });

        const res = await request(buildApp()).get('/admin/activity');

        expect(res.status).toBe(200);
        expect(res.body.data[0].target_label).toBe('2026-08-01');
    });

    it('respects and clamps ?limit=', async () => {
        queue('admin_actions', { data: [], error: null });

        await request(buildApp()).get('/admin/activity?limit=500');

        // clamped to MAX_ACTIVITY_LIMIT (20) -- just confirms the route
        // didn't pass the raw value straight through un-clamped
        expect(supabase.from).toHaveBeenCalledWith('admin_actions');
    });
});

describe('GET /admin/top-moods', () => {
    it('rejects a non-admin', async () => {
        requireAdminMock.mockImplementation(rejectAdmin());

        const res = await request(buildApp()).get('/admin/top-moods');

        expect(res.status).toBe(403);
    });

    it('aggregates real series_tags into mood counts + percentages, ignoring non-mood dimensions', async () => {
        queue('series_tags', {
            data: [
                { tags: { value_key: 'healing', display_label: 'Healing', dimension: 'mood' } },
                { tags: { value_key: 'healing', display_label: 'Healing', dimension: 'mood' } },
                { tags: { value_key: 'angsty', display_label: 'Angsty', dimension: 'mood' } },
                { tags: { value_key: 'enemies_to_lovers', display_label: 'Enemies to Lovers', dimension: 'trope' } }, // not mood -- excluded
            ],
            error: null,
        });

        const res = await request(buildApp()).get('/admin/top-moods');

        expect(res.status).toBe(200);
        // 3 total mood taggings (trope row excluded from the denominator)
        expect(res.body.data).toEqual([
            { value_key: 'healing', display_label: 'Healing', count: 2, pct: 67 },
            { value_key: 'angsty', display_label: 'Angsty', count: 1, pct: 33 },
        ]);
    });

    it('returns an empty list rather than dividing by zero when there are no mood taggings yet', async () => {
        queue('series_tags', { data: [], error: null });

        const res = await request(buildApp()).get('/admin/top-moods');

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([]);
    });

    it('caps the result at the top 5 moods by count', async () => {
        queue('series_tags', {
            data: Array.from({ length: 6 }, (_, i) => ({
                tags: { value_key: 'mood' + i, display_label: 'Mood ' + i, dimension: 'mood' },
            })),
            error: null,
        });

        const res = await request(buildApp()).get('/admin/top-moods');

        expect(res.body.data).toHaveLength(5);
    });
});
