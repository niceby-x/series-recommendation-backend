import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { reconcileOrphanedImportRun } from './services/importRuns';

import seriesRouter from './routes/series';
import ratingsRouter from './routes/ratings';
import watchlistRouter from './routes/watchlist';
import curatorPicksRouter from './routes/curatorPicks';
import collectionsRouter from './routes/collections';
import meRouter from './routes/me';

import adminCandidatesRouter from './routes/admin/candidates';
import adminTagsRouter from './routes/admin/tags';
import adminGenresRouter from './routes/admin/genres';
import adminUsersRouter from './routes/admin/users';
import adminReviewsRouter from './routes/admin/reviews';
import adminImportRunsRouter from './routes/admin/importRuns';
import adminSeriesRouter from './routes/admin/series';
import adminCuratorPicksRouter from './routes/admin/curatorPicks';
import adminCollectionsRouter from './routes/admin/collections';
import adminRankSnapshotsRouter from './routes/admin/rankSnapshots';

const app = express();
const PORT = 3001;

// Sets the usual security headers (X-Content-Type-Options, X-Frame-Options,
// Strict-Transport-Security, etc.) that a public API had none of before.
// contentSecurityPolicy is off: CSP is a browser-facing, HTML-response
// concern, and this is a JSON API with no HTML views to protect -- an
// overly strict default CSP here would just add noise with nothing to
// actually secure.
app.use(helmet({ contentSecurityPolicy: false }));

const allowedOrigins = [
  'http://localhost:3000',
  'https://series-recommendation-frontend.vercel.app',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// Rate limit writes only (GET /series is public, unauthenticated, and
// meant to be hit on every page load -- limiting it would break normal
// browsing). Applied as blanket middleware keyed on req.method rather than
// attached route-by-route, so every current POST/PATCH/DELETE (there are
// ~35 of them, admin routes included) is covered by one place, and any
// route added later -- including every router split out below by P4-04 --
// is covered automatically instead of needing the limiter re-added by
// hand. Mounted before the routers, so it still runs first for all of
// them.
const writeRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests. Please try again later.' },
});

app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET') return next();
    return writeRateLimiter(req, res, next);
});

//ROUTE 1 - Welcome route
app.get('/', (req: Request, res: Response) => {
    res.json({
        message: 'Welcome to the BL Series API!',
        author: 'Jimboy',
        version: '1.0.0'
    });
});

// Public / user-facing routers (P4-04: split out of this file, which had
// grown to ~2,800 lines covering every route inline -- see
// docs/AGENTS.md for the resulting route map).
app.use('/series', seriesRouter);
app.use('/ratings', ratingsRouter);
app.use('/watchlist', watchlistRouter);
app.use('/curator-picks', curatorPicksRouter);
app.use('/collections', collectionsRouter);
app.use('/me', meRouter);

// Admin routers (all gated by requireAdmin inside each route -- see
// middleware/auth.ts).
app.use('/admin/candidates', adminCandidatesRouter);
app.use('/admin/tags', adminTagsRouter);
app.use('/admin/genres', adminGenresRouter);
app.use('/admin/users', adminUsersRouter);
app.use('/admin/reviews', adminReviewsRouter);
app.use('/admin/import', adminImportRunsRouter);
app.use('/admin/series', adminSeriesRouter);
app.use('/admin/curator-picks', adminCuratorPicksRouter);
app.use('/admin/collections', adminCollectionsRouter);
app.use('/admin/rank-snapshots', adminRankSnapshotsRouter);

app.listen(PORT, () => {
    console.log(`BL Series API is running at http://localhost:${PORT}`);
    reconcileOrphanedImportRun();
});
