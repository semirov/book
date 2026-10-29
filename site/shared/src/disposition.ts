/**
 * The disposition of a filing — how a reader's text was read instead of being thrown away
 * (BOOK-DOC-78, BOOK-174 comment #3888 §5–§6).
 *
 * A filing has four answers tried in order — `as_said` → `through_paper` →
 * `refused_in_world` → `inadmissible`. Nothing here refuses by exhaustion: `inadmissible` is
 * reachable only through one of the four locks, and everything else is placed by the ladder
 * itself, at the floor if nothing above it is licensed (BOOK-206, ADR-045 §5). There is no
 * fifth state and no author's door: a filing is never parked for a person.
 *
 * This file owns the **facts** of a reading: the four answers, the six carriers, the four
 * locks, and the stored chain. The **sentence** a reader sees is made in `stateWords.ts`
 * (`outcomeLine`) — one line per outcome, never a three-line report: a reader must not be
 * told two verdicts at once (owner, 2026-10-29).
 *
 * `outcomeOfChain` is the one place that turns a stored chain into that outcome: a lock
 * decides its own sentence, our failure carries no reading, and a reading is only ever an
 * accepted edit.
 */

import { outcomeLine, type Outcome } from './stateWords.ts';

/** The four answers, and no fifth: the ladder is total and nothing waits for a person. */
export type Disposition = 'as_said' | 'through_paper' | 'refused_in_world' | 'inadmissible';

/** The six carriers a `through_paper` reading lands behind (BOOK-174 §2, closed list). */
export type CarrierKind =
  | 'document'
  | 'speech'
  | 'registry_discrepancy'
  | 'numbered_object'
  | 'unheeded_joke'
  | 'obligatory_joke';

/** The four locks, and no others: the only way to `inadmissible`. */
export type DispositionLock = 'rights' | 'harm' | 'frame' | 'finale';

export const DISPOSITIONS: readonly Disposition[] = ['as_said', 'through_paper', 'refused_in_world', 'inadmissible'];

export const CARRIER_KINDS: readonly CarrierKind[] = [
  'document',
  'speech',
  'registry_discrepancy',
  'numbered_object',
  'unheeded_joke',
  'obligatory_joke',
];

export const DISPOSITION_LOCKS: readonly DispositionLock[] = ['rights', 'harm', 'frame', 'finale'];

/**
 * The one line a stored chain owes a reader. `inadmissible` names a lock; a chain without a
 * lock is a verdict this build cannot complete, and the honest answer is our failure — never an
 * invented refusal. Every accepted reading gets the reading's own line.
 */
export function outcomeOfChain(chain: Pick<DispositionChain, 'disposition' | 'lock' | 'carrierKind'>): Outcome {
  if (chain.disposition === 'inadmissible') {
    return chain.lock === null ? { kind: 'failure', failure: 'ourFailure' } : { kind: 'lock', lock: chain.lock };
  }
  return { kind: 'reading', reading: chain.disposition, carrierKind: chain.carrierKind };
}

/** The reader's sentence for a stored chain — exactly one line. */
export function chainLine(chain: Pick<DispositionChain, 'disposition' | 'lock' | 'carrierKind'>): string {
  return outcomeLine(outcomeOfChain(chain));
}

/** How long the refusing formula may be: the chooser licenses a stamp under this bound. */
export const STAMP_MAX_CHARS = 120;

/**
 * A stored chain: the five columns a filing keeps about how it was read. Old rows carry
 * `disposition: null` and have no chain at all — the absence is the fact.
 */
export type DispositionChain = {
  disposition: Disposition;
  lock: DispositionLock | null;
  carrierKind: CarrierKind | null;
  /** The verbatim fragment behind a document, or the refusing stamp of an in-world refusal. */
  quoteKept: string | null;
  /**
   * ADR-044 — the filing's own `comments.sentence_id` (`snt_…`), the one anchor a reading is
   * recorded against; null when the filing kept its block anchor.
   */
  sentenceId: string | null;
};

/** A closed word from storage, or null: a value this build does not know is dropped. */
function oneOf<T extends string>(value: string | null | undefined, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * A stored word, or null. BOOK-206 removed the ladder's old fifth state, so a row written
 * before it may still carry `disposition='escalated'`: that word is **not** a chain any more
 * (the boot migration re-opens every such row), and returning null is what keeps an old row a
 * page that renders — no chain, no sentence, no crash.
 */
export function normalizeDisposition(value: string | null | undefined): Disposition | null {
  return oneOf(value, DISPOSITIONS);
}

export function normalizeCarrierKind(value: string | null | undefined): CarrierKind | null {
  return oneOf(value, CARRIER_KINDS);
}

export function normalizeDispositionLock(value: string | null | undefined): DispositionLock | null {
  return oneOf(value, DISPOSITION_LOCKS);
}
