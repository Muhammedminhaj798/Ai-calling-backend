// JSON-lines logger on stdout/stderr. Keys that look like secrets are redacted.
// ponytail: shallow key redaction and no transports; switch to pino with redact paths when log volume grows.
import { env } from '../config/env.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Meta = Record<string, unknown>;

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|database_url|cookie/i;

function redact(meta: Meta): Meta {
  const out: Meta = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : value;
  }
  return out;
}

function write(level: Level, msg: string, meta?: Meta): void {
  if (ORDER[level] < ORDER[env.LOG_LEVEL]) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...(meta ? redact(meta) : {}) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const logger = {
  debug: (msg: string, meta?: Meta) => write('debug', msg, meta),
  info: (msg: string, meta?: Meta) => write('info', msg, meta),
  warn: (msg: string, meta?: Meta) => write('warn', msg, meta),
  error: (msg: string, meta?: Meta) => write('error', msg, meta),
};
