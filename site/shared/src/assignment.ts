/**
 * What a writer session receives (§6B.2, BOOK-7) — structure only: no names, no titles, no plot.
 *
 * These two shapes live apart from `change.ts` because that file is at the file-size wall, and
 * because they are the *lane's* contract rather than the change's own vocabulary: the engine
 * derives them from a step (`engine/trace.ts` `writerAssignment`), the writer reads them, and
 * `change.ts` re-exports them, so `@book/shared` still answers one name per shape.
 */

import type { Finding, Relevance, SeamRef, ScopeHint, StepPass } from './change.ts';
import type { InterventionKind } from './intervention.ts';
import type { WidenedNote } from './stage.ts';

/**
 * BOOK-44 — a reader-written value travels marked. The mark sits *inside* the value, so a nested
 * read cannot lose it and a model sees `"untrusted": true` next to the words. A copy that is not
 * evidence for a model (a stage line, a summary) is unwrapped with `.value` at its call site.
 */
export type Untrusted<T> = { value: T; untrusted: true };

/**
 * BOOK-7 — a chapter's premise: a reader's intervention on a slot with no text yet. It is not
 * prose and not a rewrite of a paragraph but one goal for the first edition. `intent` is the
 * change's validated public sentence (no author label, no comment body), marked so a nested
 * read cannot lose the mark; `kind` is the world-fact the reader brought, when they named one.
 */
export type PremiseAssignment = {
  intent: Untrusted<string>;
  kind: InterventionKind | null;
};

/** What a writer session receives (§6B.2): structure only — no names, no titles, no plot. */
export type WriterAssignment = {
  stepId: string;
  leaseId: string;
  pass: StepPass;
  chapter: number | 'front';
  neighbours: { before: number | null; after: number | null };
  expectation: null | { chars: { min: number; max: number } };
  /**
   * BOOK-44 — the reader's own goal sentence, marked `untrusted` where it travels: it is data
   * for the writer, never an instruction. Null when the step has no change behind it.
   */
  intent: Untrusted<string> | null;
  /** BOOK-16 — which of the four world-facts the intervention brought; null when unknown. */
  interventionKind: InterventionKind | null;
  /** BOOK-173 — `change.scope_hint`; `null` only when the step has no change at all. */
  scopeHint: ScopeHint | null;
  /** BOOK-173 §3: the anchor names a sentence row that is still live, so the pass may patch it. */
  sentenceAnchor: boolean;
  /**
   * BOOK-206 — the filing's own read, from its newest attempt: gate C's `verdict`, and
   * `awaitingRead` while that attempt is `submitted` and unanswered. The patch path runs only
   * over a read filing: the writer holds the key, so an unread change has no reading to patch.
   */
  triage: { verdict: 'FITS' | 'OFF' | null; awaitingRead: boolean };
  /**
   * BOOK-7 — set on the first pass of a chapter that carries a reader's premise: the writer
   * takes it or refuses it with one plain reason, never silently ignores it. Null otherwise.
   */
  premise: PremiseAssignment | null;
  seamsIn: SeamRef[];
  cycle: number;
  findings: Finding[] | null;
  relevance: Relevance | null;
  /** The file this step must revise is already landed (a resumed step or a gate phase). */
  landed: boolean;
  verdicts: { editor: boolean; consultant: boolean; rights?: boolean };
  budget: null | {
    wave: number;
    maxWave: number;
    steps: number;
    maxSteps: number;
    deadline: string;
  };
  changeId: string | null;
  cascadeId: string | null;
  // ── BOOK-DOC-84 §10.8 — the ladder's fields on the assignment ──────────────
  /** The step's lease count (1..6); the engine counts, the writer obeys. */
  attempt: number;
  maxAttempts: number;
  /**
   * The widening this attempt runs under, `null` before the third failure. A widened attempt is
   * a rewrite: BOOK-173's mode table (`writer/mode.ts`) is what the widened pass runs through.
   */
  widened: WidenedNote | null;
  /** 1..6: the sixth is the desperate one — one call, cheap, deterministic. */
  desperate: boolean;
  /** The attempt's own bound in ms: the step's wall, or 180 s on the desperate attempt. */
  deadlineAt: number;
  /** On a re-issue: when this attempt was picked up again; `null` on a first claim. */
  retryAt: number | null;
};
