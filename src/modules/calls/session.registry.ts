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
  /**
   * Sessions idle for longer than `idleMs`. They stay registered: callsService.endSession removes a session only once
   * its end has committed, so one whose end fails is found again by the next sweep.
   */
  idle: (idleMs: number, now = Date.now()): ConversationSession[] => [...sessions.values()].filter((s) => now - s.lastActivityAt > idleMs),
};
