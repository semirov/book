/**
 * BOOK-206 (ADR-045 §3) on the wire: the three doors a triage tick needs — the filing the engine
 * claimed for a read, the answer, and the report of a broken call.
 *
 * They live apart from `client.ts` because that file was at the file-size wall, and because the
 * shapes are a contract with the engine's own routes (`engine/filingTriage.ts`) rather than with
 * the writer's logic: `client.ts` re-exports every one of them, so its public surface did not
 * move. Nothing here decides anything — a view is what a route answered, narrowed to the fields
 * the lane reads.
 */

/**
 * One filing the engine claims for a read. The envelope is the filing as the server wrote it (the
 * four untrusted values plus the world); `recordedVerdict` is gate C's stored answer, when there
 * is one — then only the missing half is asked.
 */
export type TriageAskView = {
  commentId: string;
  attempt: number;
  chapter: number;
  kind: string | null;
  envelope: Record<string, unknown>;
  world: string | null;
  recordedVerdict: 'FITS' | 'OFF' | null;
};

/** `assignment: null` with `reason: 'budget'` is the engine's own stop for a paused day. */
export type TriageNextView = { assignment: TriageAskView | null; reason: 'budget' | null };

/** What `verdict` sends: the model's answer and the money it cost. */
export type TriageVerdictInput = {
  commentId: string;
  n: number;
  verdict: unknown;
  spend: { model: string; tokensIn: number; tokensOut: number; usd: number };
};

export type TriageVerdictView = { stored: boolean; already?: true };

/**
 * BOOK-206 (AC5): a failed call is still money. `spend` is present when the provider answered
 * with usage (a shape failure, a recorded-verdict conflict, an engine refusal of the answer) and
 * absent for a transport failure that never reported any.
 */
export type TriageFailInput = {
  commentId: string;
  n: number;
  code: string;
  detail?: string;
  spend?: TriageVerdictInput['spend'];
};

export type TriageFailView = { tries: number; nextAt: string | null; cap: boolean };
