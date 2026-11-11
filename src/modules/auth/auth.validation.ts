import { z } from 'zod';

export const loginSchema = {
  body: z.object({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
    password: z.string().min(8).max(200),
  }),
};
export type LoginInput = z.infer<typeof loginSchema.body>;

/** Refresh/logout accept the token from the HTTP-only cookie or, for non-browser clients, the JSON body. */
export const refreshSchema = {
  body: z.object({ refreshToken: z.string().min(20).max(500).optional() }).optional(),
};
