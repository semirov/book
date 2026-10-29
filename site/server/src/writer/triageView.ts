/**
 * BOOK-206 (ADR-045 §3, AC5) — one filing's read, from the writer's side of the wire.
 *
 * These are shapes only: the engine writes every value, and the lane reads them without a
 * database handle of its own. They live apart from `client.ts`, which is at its `arch` bound, and
 * are re-exported there so a caller still imports one module.
 */

/**
 * BOOK-206 (ADR-045 §3): one filing claimed for a read — the envelope as the server wrote it, and
 * gate C's stored answer when there is one, so only the missing half is asked.
 */
export type TriageAskView = {
  commentId: string;
  attempt: number;
  chapter: number;
  kind: string | null;
  envelope: Record<string, unknown>;
  world: string | null;
  recordedVerdict: 'FITS' | 'OFF' | null;
  /** §10.8: the widening this attempt runs under (`as-document` after the third failure). */
  widened?: string | null;
};

/** `assignment: null` with `reason: 'budget'` is the engine's own stop for a paused day. */
export type TriageNextView = { assignment: TriageAskView | null; reason: 'budget' | null };

/** What `verdict` sends: the answer and its money — `estimated` when the counts were read off the text, not measured (BOOK-219). */
export type TriageVerdictInput = {
  commentId: string;
  n: number;
  verdict: unknown;
  spend: { model: string; tokensIn: number; tokensOut: number; usd: number; estimated?: boolean };
};

export type TriageVerdictView = { stored: boolean; already?: true };

/** A failed call: a code the engine records, never the reader's text. */
/**
 * BOOK-206 (AC5): a failed call is still money. `spend` is present when the provider answered
 * with usage, absent for a transport failure that never reported any.
 */
export type TriageFailInput = {
  commentId: string;
  n: number;
  code: string;
  detail?: string;
  spend?: TriageVerdictInput['spend'];
};

export type TriageFailView = { tries: number; nextAt: string | null; cap: boolean; desperate?: true };
