// src/middleware/validate.ts
//
// P2-03: one place to turn a zod schema into an Express middleware, so a
// route declares its body shape once instead of a stack of ad hoc
// `if (!field) return 400` checks that a new route can just as easily
// forget to copy. validateBody replaces req.body with the *parsed*
// result (so defaults/coercions from the schema are what the route
// handler actually sees), and returns 400 with a single readable message
// on failure -- same shape every existing ad hoc check already returned
// ({ message: string }), so this is a drop-in swap, not a response-shape
// change callers need to handle differently.

import { Request, Response, NextFunction } from 'express';
import { ZodTypeAny } from 'zod';

export function validateBody(schema: ZodTypeAny) {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = schema.safeParse(req.body);

        if (!result.success) {
            const messages = [...new Set(result.error.issues.map((issue) => issue.message))];
            const message = messages.join('; ');
            return res.status(400).json({ message });
        }

        req.body = result.data;
        next();
    };
}
