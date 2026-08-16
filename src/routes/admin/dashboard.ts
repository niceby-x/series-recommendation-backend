// src/routes/admin/dashboard.ts -- real data for the two admin dashboard
// sidebar widgets that used to render fully static MOCK_ constants
// (components/admin/RecentActivityCard.tsx, TopMoodsCard.tsx). D2-01.

import { Router, Request, Response } from 'express';
import { supabase } from '../../services/supabase';
import { requireAdmin } from '../../middleware/auth';

const router = Router();

const DEFAULT_ACTIVITY_LIMIT = 5;
const MAX_ACTIVITY_LIMIT = 20;
const TOP_MOODS_LIMIT = 5;

// Route - Recent admin activity (admin only). Reads the admin_actions
// table A2-02's logAdminAction() already writes to (ban/unban, promote/
// demote, delete-user, approve/reject/restore-candidate, rank-snapshot
// run) -- there was no read route for it until now. `target` is stored as
// "type:id" (e.g. "candidate:12", "user:5") by logAdminAction, so this
// batch-resolves each referenced candidate/user's real title/email once
// (not one lookup per row) to turn that into something a human can read,
// rather than returning raw target strings for the frontend to guess at.
router.get('/activity', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const limit = Math.max(1, Math.min(MAX_ACTIVITY_LIMIT, parseInt(req.query.limit as string) || DEFAULT_ACTIVITY_LIMIT));

    const { data, error } = await supabase
        .from('admin_actions')
        .select('id, actor_email, action, target, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    const candidateIds = new Set<number>();
    const userIds = new Set<number>();
    for (const row of data) {
        const [type, idStr] = row.target.split(':');
        const id = parseInt(idStr, 10);
        if (Number.isNaN(id)) continue;
        if (type === 'candidate') candidateIds.add(id);
        else if (type === 'user') userIds.add(id);
    }

    const [candidatesRes, usersRes] = await Promise.all([
        candidateIds.size > 0
            ? supabase.from('series_candidates').select('id, title').in('id', [...candidateIds])
            : Promise.resolve({ data: [] as { id: number; title: string }[] }),
        userIds.size > 0
            ? supabase.from('users').select('id, email, username').in('id', [...userIds])
            : Promise.resolve({ data: [] as { id: number; email: string; username: string | null }[] }),
    ]);

    const candidateTitleById = new Map((candidatesRes.data || []).map((c) => [c.id, c.title]));
    const userLabelById = new Map((usersRes.data || []).map((u) => [u.id, u.username || u.email]));

    const shaped = data.map((row) => {
        const [type, idStr] = row.target.split(':');
        const id = parseInt(idStr, 10);

        let targetLabel = row.target;
        if (type === 'candidate') targetLabel = candidateTitleById.get(id) ?? 'a candidate';
        else if (type === 'user') targetLabel = userLabelById.get(id) ?? 'a user';
        else if (type === 'snapshot_date') targetLabel = idStr;

        return {
            id: row.id,
            action: row.action,
            target_type: type,
            target_label: targetLabel,
            actor_label: row.actor_email || 'System',
            created_at: row.created_at,
        };
    });

    res.json({ message: 'Recent admin activity', data: shaped });
});

// Route - Top moods by real tag usage (admin only). Aggregated fresh from
// series_tags/tags (dimension='mood') on every call rather than a stored
// column -- same join GET /series already flattens for its own
// tag_dimension/tag_key filtering (see G1-01), just counted per mood
// instead of matched per series. `pct` is each mood's share of total
// mood-taggings (not total series), since one series can carry more than
// one mood tag -- a straightforward "how often is each mood used" stat,
// not a claim about what fraction of the catalog has that mood.
router.get('/top-moods', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { data, error } = await supabase.from('series_tags').select('tags (value_key, display_label, dimension)');

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    const counts = new Map<string, { display_label: string; count: number }>();
    let totalMoodTaggings = 0;

    for (const row of data as any[]) {
        const tag = row.tags;
        if (!tag || tag.dimension !== 'mood') continue;

        totalMoodTaggings++;
        const existing = counts.get(tag.value_key);
        if (existing) existing.count++;
        else counts.set(tag.value_key, { display_label: tag.display_label, count: 1 });
    }

    const top = [...counts.entries()]
        .map(([value_key, v]) => ({
            value_key,
            display_label: v.display_label,
            count: v.count,
            pct: totalMoodTaggings > 0 ? Math.round((v.count / totalMoodTaggings) * 100) : 0,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_MOODS_LIMIT);

    res.json({ message: 'Top moods by real tag usage', data: top });
});

export default router;
