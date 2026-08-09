// src/routes/curatorPicks.ts -- public curator picks for the homepage.

import { Router, Request, Response } from 'express';
import { fetchCuratorPicksJoined } from '../services/curatorPicks';

const router = Router();

// Route 20 - Public: today's curator picks (feature + list), for the
// homepage's Curator's Picks section. No auth required -- this is
// display data, same as GET /series. Replaces the old
// allSeries.slice(6, 10)-with-fake-tags placeholder in
// HomeLanding.tsx/HomeAuthed.tsx; falls back to their existing mock
// content on the frontend side if this list is empty (no picks curated
// yet), same real-first-then-mock convention as everywhere else.
router.get('/', async (req: Request, res: Response) => {
    const { error, data } = await fetchCuratorPicksJoined();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({ message: 'Curator picks', data });
});

export default router;
