// src/routes/admin/tags.ts -- Discovery Tags taxonomy management: list/create/
// rename/toggle/merge/delete tags, plus per-tag series membership (admin only).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { supabase } from '../../services/supabase';
import { requireAdmin } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { mergeIdsSchema } from './schemas';

const router = Router();

// Route 9c - Get all active taxonomy tags, grouped by dimension (admin
// only). Fetched once by the admin page on load, not per candidate row.
// `?all=true` also includes inactive tags, for the Tags admin management
// page -- every other consumer (the candidates taxonomy editor) keeps
// getting active-only by not passing it, so this stays backward
// compatible.
router.get('/', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const includeInactive = req.query.all === 'true';

    let query = supabase
        .from('tags')
        .select('id, dimension, value_key, display_label, display_emoji, sort_order, is_active')
        .order('dimension', { ascending: true })
        .order('sort_order', { ascending: true });

    if (!includeInactive) {
        query = query.eq('is_active', true);
    }

    const { data, error } = await query;

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    const grouped: Record<string, typeof data> = {};
    for (const tag of data) {
        if (!grouped[tag.dimension]) grouped[tag.dimension] = [];
        grouped[tag.dimension].push(tag);
    }

    res.json({ message: 'Tags by dimension', data: grouped });
});
const VALID_TAG_DIMENSIONS = ['mood', 'trope', 'relationship_dynamic', 'theme', 'content_warning'];
function slugifyTagKey(label: string): string {
    return label
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}
// A2-01: same checks the old ad hoc if-checks did (dimension must be one of
// the governed values, display_label required), declared once via zod.
const createTagSchema = z
    .object({
        dimension: z.string().optional(),
        display_label: z.string().trim().optional(),
        display_emoji: z.string().nullable().optional(),
        value_key: z.string().optional(),
        sort_order: z.number().optional(),
    })
    .superRefine((val, ctx) => {
        if (!val.dimension || !VALID_TAG_DIMENSIONS.includes(val.dimension)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'dimension must be one of: ' + VALID_TAG_DIMENSIONS.join(', '),
            });
        }
        if (!val.display_label || !val.display_label.trim()) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'display_label is required.' });
        }
    });
const renameTagSchema = z
    .object({
        display_label: z.string().trim().optional(),
        display_emoji: z.string().nullable().optional(),
    })
    .superRefine((val, ctx) => {
        if (!val.display_label) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'display_label is required.' });
        }
    });
const addSeriesToTagSchema = z
    .object({
        series_id: z.union([z.number(), z.string()]).optional(),
    })
    .superRefine((val, ctx) => {
        if (!val.series_id) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'series_id is required.' });
        }
    });
// Route 9d - Create a new tag (admin only). value_key is auto-derived from
// display_label (Taxonomy v1's governed-vocabulary values are meant to be
// stable snake_case keys, not admin-typed strings that could drift in
// format) unless one is explicitly supplied. New tags are appended after
// the current highest sort_order within their dimension by default, so
// they show up last rather than jumping ahead of curated ordering.
router.post('/', validateBody(createTagSchema), async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { dimension, display_label, display_emoji, value_key, sort_order } = req.body;

    const key = (value_key && String(value_key).trim()) || slugifyTagKey(display_label);
    if (!key) {
        return res.status(400).json({ message: 'Could not derive a value_key from display_label.' });
    }

    let nextSortOrder = sort_order;
    if (nextSortOrder === undefined || nextSortOrder === null) {
        const { data: existing } = await supabase
            .from('tags')
            .select('sort_order')
            .eq('dimension', dimension)
            .order('sort_order', { ascending: false })
            .limit(1);
        nextSortOrder = existing && existing.length > 0 ? existing[0].sort_order + 1 : 0;
    }

    const { data, error } = await supabase
        .from('tags')
        .insert({
            dimension,
            value_key: key,
            display_label: display_label.trim(),
            display_emoji: display_emoji || null,
            sort_order: nextSortOrder,
            is_active: true,
        })
        .select()
        .single();

    if (error) {
        // Postgres unique_violation -- most likely dimension+value_key already exists.
        if (error.code === '23505') {
            return res.status(409).json({ message: 'A tag with that key already exists in this dimension.' });
        }
        return res.status(500).json({ message: error.message });
    }

    res.status(201).json({ message: 'Tag created', data });
});
// Route 9e - Toggle a tag's active state (admin only). Soft-delete rather
// than a hard DELETE -- series/series_candidates rows can already
// reference a tag by id, so removing the row outright would either fail
// on the foreign key or silently orphan references. Deactivating just
// drops it from the default GET /admin/tags (and therefore the tagging
// UI) without touching anything that already points at it.
router.patch('/:id/toggle', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { data: current, error: fetchError } = await supabase
        .from('tags')
        .select('is_active')
        .eq('id', id)
        .single();

    if (fetchError) {
        return res.status(404).json({ message: 'Tag not found.' });
    }

    const { data, error } = await supabase
        .from('tags')
        .update({ is_active: !current.is_active })
        .eq('id', id)
        .select()
        .single();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({ message: data.is_active ? 'Tag activated' : 'Tag deactivated', data });
});
// Route 9c-1 - Rename a tag (admin only). Only display_label/display_emoji
// change -- value_key stays put, since nothing outside this row references
// it by string (series_tags/series_candidate_tags point at the numeric
// id), so there's no reason to risk drifting it from what the tag was
// created with. Rejects a rename that would collide (case-insensitively)
// with another tag already in the same dimension -- that's a merge, not a
// rename, and silently combining them would lose one tag's history of
// which series it was actually on.
router.patch('/:id', validateBody(renameTagSchema), async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { display_label, display_emoji } = req.body;

    const { data: existing, error: fetchError } = await supabase
        .from('tags')
        .select('id, dimension')
        .eq('id', id)
        .maybeSingle();

    if (fetchError) return res.status(500).json({ message: fetchError.message });
    if (!existing) return res.status(404).json({ message: 'Tag not found.' });

    const { data: siblings, error: siblingsError } = await supabase
        .from('tags')
        .select('id, display_label')
        .eq('dimension', existing.dimension)
        .neq('id', id);

    if (siblingsError) return res.status(500).json({ message: siblingsError.message });

    const collision = (siblings || []).find(
        (t) => t.display_label.trim().toLowerCase() === String(display_label).trim().toLowerCase()
    );
    if (collision) {
        return res.status(409).json({
            message: '"' + display_label + '" already exists in this dimension (id ' + collision.id + '). Merge into it instead of renaming.',
        });
    }

    const { data, error } = await supabase
        .from('tags')
        .update({ display_label, display_emoji: display_emoji || null })
        .eq('id', id)
        .select('id, dimension, value_key, display_label, display_emoji, sort_order, is_active')
        .single();

    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: 'Tag renamed', data });
});
// Route 9c-2 - Merge one or more tags into another (admin only), fixing
// duplicates like "Enemies to Lovers" existing as two separate rows.
// Repoints every series_tags/series_candidate_tags row that pointed at a
// source tag onto the target instead (skipping any series/candidate that's
// already linked to the target, so merging can't create a duplicate link),
// then deletes the source tag rows. Body: { source_ids: number[], target_id }.
// All tags involved must share a dimension -- merging "Angsty" (mood) into
// "Slow Burn" (trope) would silently misclassify every series that carried
// the source tag, which is a bigger problem than the duplicate it fixes.
router.post('/merge', validateBody(mergeIdsSchema), async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const { targetId, sourceIds } = req.body;

    const { data: involved, error: involvedError } = await supabase
        .from('tags')
        .select('id, dimension')
        .in('id', [targetId, ...sourceIds]);

    if (involvedError) return res.status(500).json({ message: involvedError.message });
    if (!involved || involved.length !== sourceIds.length + 1) {
        return res.status(404).json({ message: 'One or more tags were not found.' });
    }
    if (new Set(involved.map((t) => t.dimension)).size > 1) {
        return res.status(400).json({ message: 'Can only merge tags within the same dimension.' });
    }

    // series_tags: repoint, skipping series already linked to the target.
    const { data: targetSeriesLinks } = await supabase.from('series_tags').select('series_id').eq('tag_id', targetId);
    const seriesAlreadyLinked = new Set((targetSeriesLinks || []).map((r) => r.series_id));

    const { data: sourceSeriesLinks, error: sourceSeriesLinksError } = await supabase
        .from('series_tags')
        .select('series_id')
        .in('tag_id', sourceIds);
    if (sourceSeriesLinksError) return res.status(500).json({ message: sourceSeriesLinksError.message });

    const seriesToRelink = [...new Set((sourceSeriesLinks || []).map((r) => r.series_id))].filter(
        (sid) => !seriesAlreadyLinked.has(sid)
    );
    if (seriesToRelink.length > 0) {
        const { error: insertError } = await supabase
            .from('series_tags')
            .insert(seriesToRelink.map((series_id) => ({ series_id, tag_id: targetId })));
        if (insertError) return res.status(500).json({ message: insertError.message });
    }

    const { error: deleteSeriesLinksError } = await supabase.from('series_tags').delete().in('tag_id', sourceIds);
    if (deleteSeriesLinksError) return res.status(500).json({ message: deleteSeriesLinksError.message });

    // series_candidate_tags: same repoint-then-delete pattern.
    const { data: targetCandidateLinks } = await supabase
        .from('series_candidate_tags')
        .select('candidate_id')
        .eq('tag_id', targetId);
    const candidatesAlreadyLinked = new Set((targetCandidateLinks || []).map((r) => r.candidate_id));

    const { data: sourceCandidateLinks, error: sourceCandidateLinksError } = await supabase
        .from('series_candidate_tags')
        .select('candidate_id')
        .in('tag_id', sourceIds);
    if (sourceCandidateLinksError) return res.status(500).json({ message: sourceCandidateLinksError.message });

    const candidatesToRelink = [...new Set((sourceCandidateLinks || []).map((r) => r.candidate_id))].filter(
        (cid) => !candidatesAlreadyLinked.has(cid)
    );
    if (candidatesToRelink.length > 0) {
        const { error: insertError } = await supabase
            .from('series_candidate_tags')
            .insert(candidatesToRelink.map((candidate_id) => ({ candidate_id, tag_id: targetId })));
        if (insertError) return res.status(500).json({ message: insertError.message });
    }

    const { error: deleteCandidateLinksError } = await supabase
        .from('series_candidate_tags')
        .delete()
        .in('tag_id', sourceIds);
    if (deleteCandidateLinksError) return res.status(500).json({ message: deleteCandidateLinksError.message });

    const { error: deleteTagsError } = await supabase.from('tags').delete().in('id', sourceIds);
    if (deleteTagsError) return res.status(500).json({ message: deleteTagsError.message });

    res.json({ message: 'Tags merged', data: { target_id: targetId, merged_ids: sourceIds } });
});
// Route 9c-3 - Permanently delete a tag (admin only). Unlike toggle (which
// just hides it from pickers), this removes every series_tags/
// series_candidate_tags row referencing it first, then the tag itself --
// same cleanup-children-before-parent pattern used throughout this file.
router.delete('/:id', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { error: seriesLinksError } = await supabase.from('series_tags').delete().eq('tag_id', id);
    if (seriesLinksError) return res.status(500).json({ message: seriesLinksError.message });

    const { error: candidateLinksError } = await supabase.from('series_candidate_tags').delete().eq('tag_id', id);
    if (candidateLinksError) return res.status(500).json({ message: candidateLinksError.message });

    const { error } = await supabase.from('tags').delete().eq('id', id);
    if (error) return res.status(500).json({ message: error.message });

    res.json({ message: 'Tag deleted' });
});
// Route 9c-2b - List every series currently carrying a given tag (admin
// only). Powers the new Moods/Tropes admin browsing screens
// (app/admin/moods/page.tsx, app/admin/tropes/page.tsx) -- the reverse
// direction from PATCH /admin/series/:id's tag_ids (which sets a series's
// complete tag set); this instead starts from one tag and shows which
// series have it, for browsing/curating a whole mood or trope at once
// instead of hunting through individual series edits.
router.get('/:id/series', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { data, error } = await supabase
        .from('series_tags')
        .select('series (id, title, country, year, poster_url, backdrop_url)')
        .eq('tag_id', id);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    const series = (data || []).map((row: any) => row.series).filter(Boolean);

    res.json({ message: 'Series with this tag', count: series.length, data: series });
});
// Route 9c-2c - Add one series to a tag (admin only). Body: { series_id }.
// A single, targeted series_tags insert -- unlike PATCH /admin/series/:id's
// tag_ids, which replaces a series's whole tag set, this only touches the
// one tag/series pair, since the Moods/Tropes screens add series one at a
// time from the tag's side.
router.post('/:id/series', validateBody(addSeriesToTagSchema), async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const { series_id } = req.body;

    const { error } = await supabase.from('series_tags').insert({ tag_id: id, series_id });

    if (error) {
        if (error.code === '23505') {
            return res.status(409).json({ message: 'That series already has this tag.' });
        }
        return res.status(500).json({ message: error.message });
    }

    res.status(201).json({ message: 'Series tagged' });
});
// Route 9c-2d - Remove one series from a tag (admin only).
router.delete('/:id/series/:seriesId', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);
    const seriesId = parseInt(req.params.seriesId as string);

    const { error } = await supabase.from('series_tags').delete().eq('tag_id', id).eq('series_id', seriesId);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(200).json({ message: 'Series untagged' });
});

export default router;
