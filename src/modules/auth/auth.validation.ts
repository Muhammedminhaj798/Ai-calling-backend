import { z } from 'zod';

export const loginSchema = {
  body: z.object({
    email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
    password: z.string().min(8).max(200),
  }),
};
export type LoginInput = z.infer<typeof loginSchema.body>;
