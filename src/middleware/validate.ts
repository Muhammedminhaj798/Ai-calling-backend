// Request validation at the controller boundary with zod.
// Parsed values replace req.body and are also exposed as res.locals.input.{params,query,body}
// (Express 5 exposes req.query as a read-only getter, so it cannot be reassigned).
// A failed parse throws ZodError, which errorHandler turns into a 400 VALIDATION_ERROR.
import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

export interface RequestSchemas {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, res, next) => {
    const input: Record<string, unknown> = {};
    for (const key of ['params', 'query', 'body'] as const) {
      const schema = schemas[key];
      if (schema) input[key] = schema.parse(req[key]);
    }
    if ('body' in input) req.body = input['body'];
    res.locals['input'] = input;
    next();
  };
}
