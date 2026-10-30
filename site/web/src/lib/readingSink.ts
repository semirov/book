/**
 * BOOK-DOC-84 §10.8 — where the ladder's sink is: the **desperate sixth**, never the fifth.
 *
 * A failed fifth has its last rung still coming (the deterministic sixth), so it reads as a wait;
 * only the sixth's own frame — `desperate: true`, 6 of 6 — is the end. The predicate lives in one
 * place so the head's line and the record's «повторить» cannot disagree about the same frame.
 */

export type LadderFrame = {
  phase: string;
  attempt: number;
  maxAttempts: number;
  desperate: boolean;
};

/** Is this reading frame the ladder's end? The fifth failure is not. */
export function readingSunk(reading: LadderFrame): boolean {
  return reading.phase === 'failed' && reading.desperate && reading.attempt >= reading.maxAttempts;
}
