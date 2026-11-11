// In-memory registry of live conversation sessions, keyed by call id. The database holds everything
// needed to rebuild a session (calls.service resumeSession), so losing this map only costs the model's
// short-term context, not the order.
// ponytail: single-process map; a shared store is needed only if more than one backend instance takes calls.
import type { ConversationSession } from '../ai/ai.types.ts';

const sessions = new Map<string, ConversationSession>();

export const sessionRegistry = {
  get: (callId: string) => sessions.get(callId),
  set: (session: ConversationSession) => sessions.set(session.callId, session),
  delete: (callId: string) => sessions.delete(callId),
  size: () => sessions.size,
  /** Sessions idle for longer than `idleMs`, removed from the registry and returned for closing. */
  takeIdle(idleMs: number, now = Date.now()): ConversationSession[] {
    const idle: ConversationSession[] = [];
    for (const [id, s] of sessions) {
      if (now - s.lastActivityAt > idleMs) {
        sessions.delete(id);
        idle.push(s);
      }
    }
    return idle;
  },
};
