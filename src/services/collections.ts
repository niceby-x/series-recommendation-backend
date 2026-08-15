// src/services/collections.ts
//
// Shared shape-builders for collections -- fetchCollectionsJoined backs both
// the public and admin "list collections" routes, and loadEditableCollection
// backs every route that mutates a specific collection (owner-only for
// personal collections, admin-only for curated ones) across both the public
// and admin collections routers. Moved out of index.ts as part of the P4-04
// split.

import { Request, Response } from 'express';
import { supabase } from './supabase';
import { requireAdmin, getOrCreateUserId } from '../middleware/auth';

// Shared shape-builder for a list of collections (personal or curated),
// with series_count and, for personal ones when requestingUserId is the
// owner, a real progress_pct computed from that user's own user_lists
// status -- not meaningful for a curated collection (it isn't "your"
// watchlist), so progress_pct is always null there.
//
// G1-02: `pagination`, when given, pushes page/limit into the initial
// `collections` query itself (a real .range() + count: 'exact', same as
// GET /series' own baseline fast path) rather than fetching every
// matching collection and slicing in JS. Safe to do at the SQL level
// here -- unlike GET /series' genre/rating_min filters, is_curated/
// owner_user_id are plain column equality the DB can already filter on,
// and series_count/progress_pct are computed per-collection from its own
// collection_series join, not aggregated across collections -- so
// fetching only one page's worth up front doesn't corrupt anything the
// way a partial catalog fetch would for Moods/Tropes (see G1-01).
// Omitted (the admin router's own call, and any caller not ready to
// paginate) keeps fetching every matching collection, exactly as before.
export async function fetchCollectionsJoined(
    filter: { is_curated: boolean; owner_user_id?: number },
    requestingUserId: number | null,
    pagination?: { page: number; limit: number }
) {
    let query = supabase
        .from('collections')
        .select(
            'id, title, description, is_curated, owner_user_id, created_at, updated_at, collection_series (series_id)',
            pagination ? { count: 'exact' } : undefined
        )
        .eq('is_curated', filter.is_curated)
        .order('updated_at', { ascending: false });

    if (filter.owner_user_id !== undefined) {
        query = query.eq('owner_user_id', filter.owner_user_id);
    }

    if (pagination) {
        const from = (pagination.page - 1) * pagination.limit;
        const to = from + pagination.limit - 1;
        query = query.range(from, to);
    }

    const { data, error, count } = await query;
    if (error || !data) return { error, data: [] as any[], total: 0 };

    const allSeriesIds = [...new Set(data.flatMap((c: any) => (c.collection_series || []).map((cs: any) => cs.series_id)))];

    let watchStatusById = new Map<number, string>();
    if (requestingUserId !== null && allSeriesIds.length > 0) {
        const { data: statusRows } = await supabase
            .from('user_lists')
            .select('series_id, status')
            .eq('user_id', requestingUserId)
            .in('series_id', allSeriesIds);
        for (const row of statusRows || []) {
            watchStatusById.set(row.series_id, row.status);
        }
    }

    const shaped = data.map((c: any) => {
        const seriesIds: number[] = (c.collection_series || []).map((cs: any) => cs.series_id);
        const isMine = requestingUserId !== null && c.owner_user_id === requestingUserId;

        let progressPct: number | null = null;
        if (isMine && !c.is_curated && seriesIds.length > 0) {
            const completedCount = seriesIds.filter((id) => watchStatusById.get(id) === 'completed').length;
            progressPct = Math.round((completedCount / seriesIds.length) * 100);
        }

        return {
            id: c.id,
            title: c.title,
            description: c.description,
            is_curated: c.is_curated,
            is_mine: isMine,
            series_count: seriesIds.length,
            progress_pct: progressPct,
            updated_at: c.updated_at,
            created_at: c.created_at,
        };
    });

    return { error: null, data: shaped, total: pagination ? (count ?? shaped.length) : shaped.length };
}
// Helper - Load a collection and confirm the caller may modify it: the
// owner of a personal collection, or an admin for a curated one. Sends the
// appropriate error response itself and returns null if the caller should
// stop.
export async function loadEditableCollection(
    req: Request,
    res: Response,
    id: number,
    opts: { allowCurated: boolean }
): Promise<{ id: number; is_curated: boolean; owner_user_id: number | null } | null> {
    const { data: collection, error } = await supabase
        .from('collections')
        .select('id, is_curated, owner_user_id')
        .eq('id', id)
        .maybeSingle();

    if (error || !collection) {
        res.status(404).json({ message: 'Collection not found' });
        return null;
    }

    if (collection.is_curated) {
        if (!opts.allowCurated) {
            res.status(400).json({ message: 'This is a curated collection -- manage it from the admin Collections page.' });
            return null;
        }
        const isAdmin = await requireAdmin(req, res);
        if (!isAdmin) return null;
        return collection;
    }

    const userId = await getOrCreateUserId(req.headers.authorization);
    if (userId === null) {
        res.status(401).json({ message: 'You must be signed in.' });
        return null;
    }
    if (collection.owner_user_id !== userId) {
        res.status(403).json({ message: "You don't own this collection." });
        return null;
    }
    return collection;
}
