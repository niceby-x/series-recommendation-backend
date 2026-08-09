// src/routes/admin/collections.ts -- manage curated collections (admin only).
// Shares fetchCollectionsJoined/loadEditableCollection with the public router.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../../services/supabase';
import { requireAdmin, getOrCreateUserId } from '../../middleware/auth';
import { fetchCollectionsJoined, loadEditableCollection } from '../../services/collections';
import { validateBody } from '../../middleware/validate';

const router = Router();

// A2-01: same required-field checks the old ad hoc if-checks did, declared
// once via zod.
const createCollectionSchema = z
    .object({
        title: z.string().trim().optional(),
        description: z.string().nullable().optional(),
    })
    .superRefine((val, ctx) => {
        if (!val.title) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'title is required.' });
        }
    });
const addSeriesToCollectionSchema = z
    .object({
        series_id: z.union([z.number(), z.string()]).optional(),
    })
    .superRefine((val, ctx) => {
        if (!val.series_id) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'series_id is required.' });
        }
    });

// Route 32 - Admin: list every curated collection (for app/admin/collections).
router.get('/', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { error, data } = await fetchCollectionsJoined({ is_curated: true }, null);
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: 'Curated collections', count: data.length, data });
});
// Route 33 - Admin: create a curated collection. owner_user_id is set to
// whichever admin created it (audit only -- ownership doesn't gate access
// the way it does for personal collections; any admin can edit any curated
// collection, see loadEditableCollection).
router.post('/', validateBody(createCollectionSchema), async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { title, description } = req.body;

    const authHeader = req.headers.authorization;
    const creatorUserId = await getOrCreateUserId(authHeader);

    const { data, error } = await supabase
        .from('collections')
        .insert({ title: title.trim(), description: description || null, is_curated: true, owner_user_id: creatorUserId })
        .select()
        .single();

    if (error) return res.status(500).json({ message: error.message });

    res.status(201).json({ message: 'Curated collection created', data });
});
// Route 34 - Admin: rename/redescribe a curated collection.
router.patch('/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const collection = await loadEditableCollection(req, res, id, { allowCurated: true });
    if (!collection) return;

    const { title, description } = req.body || {};
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;

    const { data, error } = await supabase.from('collections').update(update).eq('id', id).select().single();
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: 'Collection updated', data });
});
// Route 35 - Admin: delete a curated collection.
router.delete('/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const collection = await loadEditableCollection(req, res, id, { allowCurated: true });
    if (!collection) return;

    const { error: memberError } = await supabase.from('collection_series').delete().eq('collection_id', id);
    if (memberError) return res.status(500).json({ message: memberError.message });

    const { error } = await supabase.from('collections').delete().eq('id', id);
    if (error) return res.status(500).json({ message: error.message });

    res.status(200).json({ message: 'Collection deleted' });
});
// Route 36 - Admin: add a series to a curated collection. Body: { series_id }.
router.post('/:id/series', validateBody(addSeriesToCollectionSchema), async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const collection = await loadEditableCollection(req, res, id, { allowCurated: true });
    if (!collection) return;

    const { series_id } = req.body;

    let nextSortOrder = 0;
    const { data: existing } = await supabase
        .from('collection_series')
        .select('sort_order')
        .eq('collection_id', id)
        .order('sort_order', { ascending: false })
        .limit(1);
    if (existing && existing.length > 0) nextSortOrder = existing[0].sort_order + 1;

    const { error } = await supabase
        .from('collection_series')
        .insert({ collection_id: id, series_id, sort_order: nextSortOrder });

    if (error) {
        if (error.code === '23505') {
            return res.status(409).json({ message: 'That series is already in this collection.' });
        }
        return res.status(500).json({ message: error.message });
    }

    await supabase.from('collections').update({ updated_at: new Date().toISOString() }).eq('id', id);

    res.status(201).json({ message: 'Added to collection' });
});
// Route 37 - Admin: remove a series from a curated collection.
router.delete('/:id/series/:seriesId', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const collection = await loadEditableCollection(req, res, id, { allowCurated: true });
    if (!collection) return;

    const seriesId = parseInt(req.params.seriesId as string);

    const { error } = await supabase
        .from('collection_series')
        .delete()
        .eq('collection_id', id)
        .eq('series_id', seriesId);

    if (error) return res.status(500).json({ message: error.message });

    await supabase.from('collections').update({ updated_at: new Date().toISOString() }).eq('id', id);

    res.status(200).json({ message: 'Removed from collection' });
});

export default router;
