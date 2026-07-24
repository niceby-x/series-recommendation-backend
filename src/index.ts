import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { Series, Rating, ApiResponse } from './types';

const app = express();
const PORT = 3001;

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

//Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL as string,
    process.env.SUPABASE_KEY as string
);

//ROUTE 1 - Welcome route
app.get('/', (req: Request, res: Response) => {
    res.json({
        message: 'Welcome to the BL Series API!',
        author: 'Jimboy',
        version: '1.0.0'
    });
});

//Route 2 - Get ALL series
app.get('/series', async (req: Request, res: Response) => {
    const { data, error } = await supabase
    .from('series')
    .select('*');

    if (error) {
        return res.status(500).json({ message: error.message});
    }

    const response: ApiResponse<Series[]> = {
        message: 'List of BL Series',
        count: data.length,
        data: data
    };

    res.json(response);
});

//Route 3 - Get ONE series by id
app.get('/series/:id', async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string);

    const { data, error } = await supabase
        .from('series')
        .select('*')
        .eq('id', id)
        .single();

    console.log("id:", id);
    console.log("data:", data);
    console.log("error:", error);

    if (error) {
        return res.status(404).json({
            message: "Series not found",
            error
        });
    }

    res.json({
        message: "Success",
        data
    });
});

// Helper - Verify the Supabase Auth token and get-or-create the matching users row.
// Returns the integer user_id from the `users` table, or null if the token is invalid.
async function getOrCreateUserId(authHeader: string | undefined): Promise<number | null> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }

    const token = authHeader.replace('Bearer ', '');

    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !authUser) {
        return null;
    }

    // Check if a users row already exists for this auth account
    const { data: existing, error: existingError } = await supabase
        .from('users')
        .select('id')
        .eq('auth_id', authUser.id)
        .maybeSingle();

    if (existingError) {
        console.error('Error checking existing user:', existingError.message);
        return null;
    }

    if (existing) {
        return existing.id;
    }

    // No row yet — create one, linking it to this auth account
    const usernameFromEmail = authUser.email ? authUser.email.split('@')[0] : `user_${authUser.id.slice(0, 8)}`;

    const { data: created, error: createError } = await supabase
        .from('users')
        .insert([{
            auth_id: authUser.id,
            email: authUser.email,
            username: usernameFromEmail,
            password_hash: 'supabase_auth'
        }])
        .select('id')
        .single();

    if (createError) {
        console.error('Error creating user row:', createError.message);
        return null;
    }

    return created.id;
}

// Helper - Verify the request is from the signed-in admin account (checked against
// the ADMIN_EMAIL env var, never hardcoded). Sends the appropriate error response
// itself and returns false if the caller should stop; returns true if allowed to proceed.
async function requireAdmin(req: Request, res: Response): Promise<boolean> {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ message: 'You must be signed in.' });
        return false;
    }

    const token = authHeader.replace('Bearer ', '');

    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !authUser) {
        res.status(401).json({ message: 'Your session is invalid or expired.' });
        return false;
    }

    const adminEmail = process.env.ADMIN_EMAIL;

    if (!adminEmail || authUser.email !== adminEmail) {
        res.status(403).json({ message: 'Admin access required.' });
        return false;
    }

    return true;
}

// Route 4 - Submit a rating
app.post('/ratings', async (req: Request, res: Response) => {
    const { series_id, score, review_text } = req.body;

    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to submit a rating'
        });
    }

    if (!series_id || !score) {
        return res.status(400).json({
            message: 'series_id and score are required'
        });
    }

    if (score < 1 || score > 10) {
        return res.status(400).json({
            message: 'Score must be between 1 and 10'
        });
    }

    const { data, error } = await supabase
        .from('ratings')
        .insert([{ user_id, series_id, score, review_text }])
        .select();

    if (error) {
        return res.status(500).json({ message: error.message});
    }

    const response: ApiResponse<Rating> = {
        message: 'Rating submitted successfully!',
        data: data[0]
    };

    res.status(201).json(response);
});

// Route 5 - Add or update a watchlist entry (upsert)
app.post('/watchlist', async (req: Request, res: Response) => {
    const { series_id, status } = req.body;

    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to update your watchlist'
        });
    }

    const validStatuses = ['plan_to_watch', 'watching', 'completed'];

    if (!series_id || !status || !validStatuses.includes(status)) {
        return res.status(400).json({
            message: 'series_id and a valid status (' + validStatuses.join(', ') + ') are required'
        });
    }

    const { data, error } = await supabase
        .from('user_lists')
        .upsert(
            [{ user_id, series_id, status, updated_at: new Date().toISOString() }],
            { onConflict: 'user_id,series_id' }
        )
        .select();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(200).json({
        message: 'Watchlist updated',
        data: data[0]
    });
});

// Route 6 - Get the logged-in user's full watchlist, with series details joined in
app.get('/watchlist', async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to view your watchlist'
        });
    }

    const { data, error } = await supabase
        .from('user_lists')
        .select('id, status, updated_at, series (*)')
        .eq('user_id', user_id);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({
        message: 'Your watchlist',
        count: data.length,
        data
    });
});

// Route 7 - Get the logged-in user's status for one specific series (or null if not on their list)
app.get('/watchlist/:seriesId', async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to view watchlist status'
        });
    }

    const seriesId = parseInt(req.params.seriesId as string);

    const { data, error } = await supabase
        .from('user_lists')
        .select('status')
        .eq('user_id', user_id)
        .eq('series_id', seriesId)
        .maybeSingle();

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({
        message: 'Watchlist status',
        status: data ? data.status : null
    });
});

// Route 8 - Remove a series from the watchlist entirely
app.delete('/watchlist/:seriesId', async (req: Request, res: Response) => {
    const user_id = await getOrCreateUserId(req.headers.authorization);

    if (!user_id) {
        return res.status(401).json({
            message: 'You must be signed in to update your watchlist'
        });
    }

    const seriesId = parseInt(req.params.seriesId as string);

    const { error } = await supabase
        .from('user_lists')
        .delete()
        .eq('user_id', user_id)
        .eq('series_id', seriesId);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(200).json({ message: 'Removed from watchlist' });
});

// Route 9 - List TMDB import candidates by review status (admin only).
// Defaults to 'pending'; pass ?status=approved or ?status=rejected for the history views.
app.get('/admin/candidates', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const validStatuses = ['pending', 'approved', 'rejected'];
    const statusParam = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const status = validStatuses.includes(statusParam) ? statusParam : 'pending';

    // Pending candidates are shown oldest-first (a queue to work through);
    // approved/rejected history is shown most-recent-first (what you just did).
    const ascending = status === 'pending';

    const { data, error } = await supabase
        .from('series_candidates')
        .select('*')
        .eq('review_status', status)
        .order('created_at', { ascending });

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.json({
        message: status.charAt(0).toUpperCase() + status.slice(1) + ' candidates',
        count: data.length,
        data
    });
});

// Route 10 - Approve a candidate: copies it into `series`, marks it approved (admin only)
app.post('/admin/candidates/:id/approve', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { data: candidate, error: fetchError } = await supabase
        .from('series_candidates')
        .select('*')
        .eq('id', id)
        .single();

    if (fetchError || !candidate) {
        return res.status(404).json({ message: 'Candidate not found' });
    }

    const { error: insertError } = await supabase
        .from('series')
        .insert([{
            title: candidate.title,
            original_title: candidate.original_title,
            synopsis: candidate.synopsis,
            country: candidate.country,
            year: candidate.year,
            episode_count: candidate.episode_count,
            status: candidate.status,
            poster_url: candidate.poster_url,
            tmdb_id: candidate.tmdb_id,
        }]);

    if (insertError) {
        return res.status(500).json({ message: insertError.message });
    }

    const { error: updateError } = await supabase
        .from('series_candidates')
        .update({ review_status: 'approved' })
        .eq('id', id);

    if (updateError) {
        return res.status(500).json({ message: updateError.message });
    }

    res.status(200).json({ message: 'Approved and added to catalog' });
});

// Route 11 - Reject a candidate: just marks it rejected, never touches `series` (admin only)
app.post('/admin/candidates/:id/reject', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { error } = await supabase
        .from('series_candidates')
        .update({ review_status: 'rejected' })
        .eq('id', id);

    if (error) {
        return res.status(500).json({ message: error.message });
    }

    res.status(200).json({ message: 'Rejected' });
});

// Route 12 - Restore a candidate back to pending (admin only).
// If it was approved, this also removes the corresponding row from `series` first,
// so the catalog stays in sync with what's actually still approved.
app.post('/admin/candidates/:id/restore', async (req: Request, res: Response) => {
    const isAdmin = await requireAdmin(req, res);
    if (!isAdmin) return;

    const id = parseInt(req.params.id as string);

    const { data: candidate, error: fetchError } = await supabase
        .from('series_candidates')
        .select('*')
        .eq('id', id)
        .single();

    if (fetchError || !candidate) {
        return res.status(404).json({ message: 'Candidate not found' });
    }

    if (candidate.review_status === 'approved') {
        const { error: deleteError } = await supabase
            .from('series')
            .delete()
            .eq('tmdb_id', candidate.tmdb_id);

        if (deleteError) {
            return res.status(500).json({ message: deleteError.message });
        }
    }

    const { error: updateError } = await supabase
        .from('series_candidates')
        .update({ review_status: 'pending' })
        .eq('id', id);

    if (updateError) {
        return res.status(500).json({ message: updateError.message });
    }

    res.status(200).json({ message: 'Restored to pending' });
});

app.listen(PORT, () => {
    console.log(`BL Series API is running at http://localhost:${PORT}`);
});