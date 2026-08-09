// src/routes/admin/genres.ts -- genre management: list/rename/merge/delete (admin only).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../../services/supabase';
import { requireAdmin } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { mergeIdsSchema } from './schemas';

const router = Router();

// A2-01: same required-field check the old ad hoc if-check did ("name is
// required."), just declared once via zod instead of an early-return block.
const renameGenreSchema = z
    .object({
        name: z.string().trim().optional(),
    })
    .superRefine((val, ctx) => {
        if (!val.name) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'name is required.' });
        }
    });

// Route 9c-4 - List every genre with how many published series use it
// (admin only). Genres today only ever get created as a side effect of
// approving a candidate (find-or-create by name, see the approve route
// below) -- this is the first place they can be viewed, renamed, merged,
// or deleted directly.
router.get('/', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const [genresRes, linksRes] = await Promise.all([
        supabase.from('genres').select('id, name').order('name', { ascending: true }),
        supabase.from('series_genres').select('genre_id'),
    ]);

    if (genresRes.error) return res.status(500).json({ message: genresRes.error.message });
    if (linksRes.error) return res.status(500).json({ message: linksRes.error.message });

    const countByGenre = new Map<number, number>();
    for (const row of linksRes.data) {
        countByGenre.set(row.genre_id, (countByGenre.get(row.genre_id) || 0) + 1);
    }

    const data = genresRes.data.map((g) => ({ ...g, series_count: countByGenre.get(g.id) || 0 }));

    res.json({ message: 'Genres', count: data.length, data });
});
// Route 9c-5 - Rename a genre (admin only). Same duplicate guard as tag
// rename -- e.g. "Romance" and "romance" existing as two separate rows is
// exactly the kind of thing this is for catching, not creating more of.
router.patch('/:id', validateBody(renameGenreSchema), async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { name } = req.body;

    const { data: existing, error: fetchError } = await supabase.from('genres').select('id').eq('id', id).maybeSingle();
    if (fetchError) return res.status(500).json({ message: fetchError.message });
    if (!existing) return res.status(404).json({ message: 'Genre not found.' });

    const { data: siblings, error: siblingsError } = await supabase.from('genres').select('id, name').neq('id', id);
    if (siblingsError) return res.status(500).json({ message: siblingsError.message });

    const collision = (siblings || []).find((g) => g.name.trim().toLowerCase() === String(name).trim().toLowerCase());
    if (collision) {
        return res.status(409).json({
            message: '"' + name + '" already exists (id ' + collision.id + '). Merge into it instead of renaming.',
        });
    }

    const { data, error } = await supabase
        .from('genres')
        .update({ name })
        .eq('id', id)
        .select('id, name')
        .single();

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: 'Genre renamed', data });
});
// Route 9c-6 - Merge one or more genres into another (admin only). Same
// repoint-skip-duplicates-then-delete pattern as tag merge. Body:
// { source_ids: number[], target_id }.
router.post('/merge', validateBody(mergeIdsSchema), async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { targetId, sourceIds } = req.body;

    const { data: involved, error: involvedError } = await supabase
        .from('genres')
        .select('id')
        .in('id', [targetId, ...sourceIds]);

    if (involvedError) return res.status(500).json({ message: involvedError.message });
    if (!involved || involved.length !== sourceIds.length + 1) {
        return res.status(404).json({ message: 'One or more genres were not found.' });
    }

    const { data: targetLinks } = await supabase.from('series_genres').select('series_id').eq('genre_id', targetId);
    const seriesAlreadyLinked = new Set((targetLinks || []).map((r) => r.series_id));

    const { data: sourceLinks, error: sourceLinksError } = await supabase
        .from('series_genres')
        .select('series_id')
        .in('genre_id', sourceIds);
    if (sourceLinksError) return res.status(500).json({ message: sourceLinksError.message });

    const seriesToRelink = [...new Set((sourceLinks || []).map((r) => r.series_id))].filter(
        (sid) => !seriesAlreadyLinked.has(sid)
    );
    if (seriesToRelink.length > 0) {
        const { error: insertError } = await supabase
            .from('series_genres')
            .insert(seriesToRelink.map((series_id) => ({ series_id, genre_id: targetId })));
        if (insertError) return res.status(500).json({ message: insertError.message });
    }

    const { error: deleteLinksError } = await supabase.from('series_genres').delete().in('genre_id', sourceIds);
    if (deleteLinksError) return res.status(500).json({ message: deleteLinksError.message });

    const { error: deleteGenresError } = await supabase.from('genres').delete().in('id', sourceIds);
    if (deleteGenresError) return res.status(500).json({ message: deleteGenresError.message });

    res.json({ message: 'Genres merged', data: { target_id: targetId, merged_ids: sourceIds } });
});
// Route 9c-7 - Permanently delete a genre (admin only). Removes its
// series_genres links first, then the genre row -- doesn't touch the
// series themselves, just un-tags them from this genre.
router.delete('/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { error: linksError } = await supabase.from('series_genres').delete().eq('genre_id', id);
    if (linksError) return res.status(500).json({ message: linksError.message });

    const { error } = await supabase.from('genres').delete().eq('id', id);
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: 'Genre deleted' });
});

export default router;
