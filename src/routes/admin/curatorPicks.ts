// src/routes/admin/curatorPicks.ts -- manage the homepage Curator's Picks
// (admin only). Shares fetchCuratorPicksJoined with the public route.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../../services/supabase';
import { requireAdmin } from '../../middleware/auth';
import { fetchCuratorPicksJoined } from '../../services/curatorPicks';
import { validateBody } from '../../middleware/validate';

const router = Router();

// A2-01: same required-field check the old ad hoc if-check did, declared
// once via zod.
const addCuratorPickSchema = z
    .object({
        series_id: z.union([z.number(), z.string()]).optional(),
        blurb: z.string().nullable().optional(),
        is_feature: z.boolean().optional(),
    })
    .superRefine((val, ctx) => {
        if (!val.series_id) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'series_id is required.' });
        }
    });

// Route 21 - Admin: same data as above, for the management screen
// (app/admin/curator-picks/page.tsx). No separate active/inactive
// distinction like tags/genres have -- a curator pick either exists (and
// shows on the homepage) or it's been removed, there's no soft-delete
// state for these.
router.get('/', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { error, data } = await fetchCuratorPicksJoined();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({ message: 'Curator picks', data });
});
// Route 22 - Add a series to Curator Picks (admin only). Body:
// { series_id, blurb?, is_feature? }. Only one pick can be the feature at
// a time -- see the invariant note on Route 23 -- so is_feature: true here
// unsets it on every other row first.
router.post('/', validateBody(addCuratorPickSchema), async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { series_id, blurb, is_feature } = req.body;

    if (is_feature) {
        await supabase.from('curator_picks').update({ is_feature: false }).eq('is_feature', true);
    }

    let nextSortOrder = 0;
    const { data: existing } = await supabase
        .from('curator_picks')
        .select('sort_order')
        .order('sort_order', { ascending: false })
        .limit(1);
    if (existing && existing.length > 0) nextSortOrder = existing[0].sort_order + 1;

    const { data, error } = await supabase
        .from('curator_picks')
        .insert({ series_id, blurb: blurb || null, is_feature: !!is_feature, sort_order: nextSortOrder })
        .select()
        .single();

    if (error) {
        if (error.code === '23505') {
            return res.status(409).json({ message: 'That series is already a curator pick.' });
        }
        return res.status(500).json({ message: error.message });
    }

    res.status(201).json({ message: 'Curator pick added', data });
});
// Route 23 - Edit a curator pick's blurb/feature state/order (admin only).
// Body: any of { blurb, is_feature, sort_order }. is_feature is a single-
// row invariant across the whole table (there's exactly one Feature card
// on the homepage) -- setting it true here unsets it everywhere else
// first, in the same request, so there's never a moment with two (or
// zero, if you just wanted to swap which one) featured rows from the
// caller's point of view.
router.patch('/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { blurb, is_feature, sort_order } = req.body || {};

    if (is_feature === true) {
        await supabase.from('curator_picks').update({ is_feature: false }).eq('is_feature', true).neq('id', id);
    }

    const updates: Record<string, unknown> = {};
    if (blurb !== undefined) updates.blurb = blurb;
    if (is_feature !== undefined) updates.is_feature = is_feature;
    if (sort_order !== undefined) updates.sort_order = sort_order;

    const { data, error } = await supabase
        .from('curator_picks')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({ message: 'Curator pick updated', data });
});
// Route 24 - Remove a series from Curator Picks (admin only). Does not
// touch the series itself -- this only un-features it.
router.delete('/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { error } = await supabase.from('curator_picks').delete().eq('id', id);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(200).json({ message: 'Curator pick removed' });
});

export default router;
