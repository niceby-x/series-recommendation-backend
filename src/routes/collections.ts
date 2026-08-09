// src/routes/collections.ts -- public + personal collections (browse curated,
// manage your own; admin-curated management lives in routes/admin/collections.ts).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../services/supabase';
import { getOrCreateUserId } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { fetchCollectionsJoined, loadEditableCollection } from '../services/collections';

const router = Router();

// P2-03: schemas for this router's three body-carrying routes, replacing
// the ad hoc if-checks each one had. Kept the same error messages and the
// same "trim, empty string counts as missing" behavior POST / already had.
const createCollectionSchema = z.object({
    title: z
        .string({ error: 'title is required.' })
        .trim()
        .min(1, 'title is required.'),
    description: z.string().nullable().optional(),
});

// PATCH allows a partial update (title/description each optional), but if
// title is provided it can't be blank -- same as create.
const updateCollectionSchema = z.object({
    title: z.string().trim().min(1, 'title is required.').optional(),
    description: z.string().nullable().optional(),
});

const addSeriesToCollectionSchema = z.object({
    series_id: z.number({ error: 'series_id is required.' }),
});

// Route 25 - Public: browse collections. ?mine=true (auth required) returns
// only the caller's own personal collections; otherwise returns every
// admin-curated collection (public, no auth needed) -- matches the "All
// Collections" / "My Collections" filter chips on the Collections page,
// which fetches each separately rather than one mixed list.
router.get('/', async (req: Request, res: Response) => {
    const requestingUserId = await getOrCreateUserId(req.headers.authorization);

    if (req.query.mine === 'true') {
        if (requestingUserId === null) {
            return res.status(401).json({ message: 'You must be signed in to view your collections.' });
        }
        const { error, data } = await fetchCollectionsJoined({ is_curated: false, owner_user_id: requestingUserId }, requestingUserId);
        if (error) return res.status(500).json({ message: error.message });
        return res.json({ message: 'Your collections', count: data.length, data });
    }

    const { error, data } = await fetchCollectionsJoined({ is_curated: true }, requestingUserId);
    if (error) return res.status(500).json({ message: error.message });
    res.json({ message: 'Curated collections', count: data.length, data });
});
// Route 26 - Public: one collection's detail, with its series joined in
// (same shape as GET /series' cards, so SeriesCard/CollectionsAuthed can
// reuse existing rendering). A personal collection is only visible to its
// owner; a curated one is visible to everyone.
router.get('/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const requestingUserId = await getOrCreateUserId(req.headers.authorization);

    const { data: collection, error: collectionError } = await supabase
        .from('collections')
        .select('id, title, description, is_curated, owner_user_id, created_at, updated_at')
        .eq('id', id)
        .maybeSingle();

    if (collectionError || !collection) {
        return res.status(404).json({ message: 'Collection not found' });
    }

    if (!collection.is_curated && collection.owner_user_id !== requestingUserId) {
        return res.status(403).json({ message: "You don't have access to this collection." });
    }

    const { data: memberRows, error: memberError } = await supabase
        .from('collection_series')
        .select('sort_order, series (*)')
        .eq('collection_id', id)
        .order('sort_order', { ascending: true });

    if (memberError) {
        return res.status(500).json({ message: memberError.message });
    }

    res.json({
        message: 'Collection',
        data: {
            id: collection.id,
            title: collection.title,
            description: collection.description,
            is_curated: collection.is_curated,
            is_mine: requestingUserId !== null && collection.owner_user_id === requestingUserId,
            series: (memberRows || []).map((row: any) => row.series).filter(Boolean),
        },
    });
});
// Route 27 - Create a personal collection (auth required). Always
// is_curated: false, owner_user_id: the caller -- curated collections are
// only created through POST /admin/collections below.
router.post('/', validateBody(createCollectionSchema), async (req: Request, res: Response) => {
    const userId = await getOrCreateUserId(req.headers.authorization);
    if (userId === null) {
        return res.status(401).json({ message: 'You must be signed in to create a collection.' });
    }

    const { title, description } = req.body;

    const { data, error } = await supabase
        .from('collections')
        .insert({ title, description: description || null, is_curated: false, owner_user_id: userId })
        .select()
        .single();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(201).json({ message: 'Collection created', data });
});
// Route 28 - Rename/redescribe a personal collection (owner only).
router.patch('/:id', validateBody(updateCollectionSchema), async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const collection = await loadEditableCollection(req, res, id, { allowCurated: false });
    if (!collection) return;

    const { title, description } = req.body;
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;

    const { data, error } = await supabase.from('collections').update(update).eq('id', id).select().single();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({ message: 'Collection updated', data });
});
// Route 29 - Delete a personal collection (owner only). Only removes the
// collection itself and its collection_series membership rows -- never
// touches the series or the owner's ratings/watchlist.
router.delete('/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const collection = await loadEditableCollection(req, res, id, { allowCurated: false });
    if (!collection) return;

    const { error: memberError } = await supabase.from('collection_series').delete().eq('collection_id', id);
    if (memberError) return res.status(500).json({ message: memberError.message });

    const { error } = await supabase.from('collections').delete().eq('id', id);
    if (error) return res.status(500).json({ message: error.message });

    res.status(200).json({ message: 'Collection deleted' });
});
// Route 30 - Add a series to a personal collection (owner only). Body:
// { series_id }.
router.post('/:id/series', validateBody(addSeriesToCollectionSchema), async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const collection = await loadEditableCollection(req, res, id, { allowCurated: false });
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
// Route 31 - Remove a series from a personal collection (owner only).
router.delete('/:id/series/:seriesId', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);
    const collection = await loadEditableCollection(req, res, id, { allowCurated: false });
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
