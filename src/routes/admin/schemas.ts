// src/routes/admin/schemas.ts
//
// A2-01: shared zod schemas for admin routes, following the same pattern
// P2-03 established in middleware/validate.ts -- declare the shape once
// instead of ad hoc if-checks a new route could forget to copy.
//
// mergeIdsSchema in particular replaces IDENTICAL ad hoc logic that used
// to be duplicated between genres.ts's POST /merge and tags.ts's
// POST /merge (parse target_id, parse+filter source_ids, then require at
// least one distinct one) -- defined once here so the two can't drift.

import { z } from 'zod';

export const mergeIdsSchema = z
    .object({
        target_id: z.union([z.number(), z.string()]).optional(),
        source_ids: z.array(z.union([z.number(), z.string()])).optional(),
    })
    .transform((val) => {
        const targetId = parseInt(String(val.target_id));
        const sourceIds = (val.source_ids || [])
            .map((id) => parseInt(String(id)))
            .filter((id) => !Number.isNaN(id) && id !== targetId);

        return { targetId, sourceIds };
    })
    .superRefine((val, ctx) => {
        if (!val.targetId || val.sourceIds.length === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'target_id and at least one distinct source_id are required.',
            });
        }
    });
