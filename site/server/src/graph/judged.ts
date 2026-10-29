/**
 * What the judge accepted, and what it refused (BOOK-185, BOOK-DOC-77 §3).
 *
 * These types are the validator's answer to a transaction: each accepted item already carries the
 * block, the code-point offsets, the witness and the sentence a mention needs, plus the key, the
 * chapter and the role (`assert`, `use`, `mention`) the ledger writes. Nothing here is assigned by
 * the caller — an id, an edge id and a thread id are the database's to give.
 *
 * They live beside `validate.ts` because the file reached 500 lines, not because a reader should
 * import them from anywhere else: `validate.ts` re-exports every name below.
 */

import type { EdgeKind, FactKind, ThreadEventKind } from './schema.ts';
import type { Evidence } from './quote.ts';

export type RejectCode =
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_DOES_NOT_SUPPORT_VALUE'
  | 'KIND_UNKNOWN'
  | 'VALUE_UNPARSEABLE'
  | 'FACT_NOT_ESTABLISHED'
  | 'CAUSE_AFTER_EFFECT'
  | 'EDGE_ENDPOINT_UNKNOWN'
  | 'THREAD_TRANSITION_ILLEGAL'
  | 'THREAD_EVIDENCE_UNKNOWN';

export type Reject = {
  code: RejectCode;
  /** Where in the answer: `facts[0]`, `edges[2]`, `threads[0].events[1]`. */
  path: string;
  /** The offending item as the model wrote it — untouched, so a transcript can show it. */
  item: unknown;
  /** The item's own quote when it has one, `''` otherwise. */
  quote: string;
  reason: string;
};

/**
 * Provenance of a merged item: the pass that **first** produced it. `undefined` is the first pass
 * (the one whose run wrote it unless a recall addition says otherwise), `'recall'` is an item the
 * second reader added. `persist*` turns it into `extracted_by.pass`.
 */
export type PassTag = { pass?: 'extract' | 'recall' };

export type AcceptedFact = Evidence & PassTag & {
  key: string;
  kind: FactKind;
  /** The model's own value, never normalised: normalisation lives in `key`. */
  value: string;
  term: string | null;
  /** The chapter this item is registered in — always the chapter under extraction. */
  chapter: number;
  /**
   * `assert` — this chapter establishes the fact; `mention` — a repeat inside this answer;
   * `use` — the fact already exists in an earlier chapter and this answer re-stated it.
   */
  role: 'assert' | 'mention' | 'use';
  /** The established fact this binds to (`use`), null when this answer establishes it. */
  factId: string | null;
  /** The established fact's own chapter (`use`); null otherwise. */
  factChapter: number | null;
  ref: string | null;
};

export type AcceptedUse = Evidence & {
  key: string;
  kind: FactKind;
  value: string;
  term: string | null;
  chapter: number;
  /** `use` — bound to an earlier fact; `mention` — bound to a fact this same answer asserts. */
  role: 'use' | 'mention';
  factId: string | null;
  factChapter: number | null;
};

/** One end of an edge: a fact of this answer, or a fact the book already holds. */
export type EdgeEndpoint = {
  key: string;
  kind: FactKind;
  chapter: number;
  factId: string | null;
  source: 'local' | 'established';
};

export type AcceptedEdge = Omit<Evidence, 'statement'> & PassTag & {
  /** `dep:<from.key>-><to.key>:<kind>` — the edge's identity, derived from its evidence. */
  key: string;
  from: EdgeEndpoint;
  to: EdgeEndpoint;
  kind: EdgeKind;
  chapter: number;
  quote: string;
  statement: string | null;
  role: 'edge';
};

export type AcceptedThreadEvent = Omit<Evidence, 'statement'> & {
  chapter: number;
  kind: ThreadEventKind;
  factKey: string;
  factId: string | null;
  note: string | null;
};

export type AcceptedThread = PassTag & {
  key: string;
  label: string;
  /** Null for a thread this answer opens: the id is the database's to assign. */
  threadId: string | null;
  direction: 'forward' | 'backward';
  /** The thread's state after replaying the accepted events. */
  state: 'opened' | 'advanced' | 'complicated' | 'closed';
  role: 'thread';
  events: AcceptedThreadEvent[];
};

/** Same key twice, same edge twice: collapsed, and the count says how much the prompt repeated. */
export type Duplicates = { facts: number; uses: number; edges: number; total: number };

export type ValidateResult = {
  facts: AcceptedFact[];
  uses: AcceptedUse[];
  edges: AcceptedEdge[];
  threads: AcceptedThread[];
  rejects: Reject[];
  duplicates: Duplicates;
};
