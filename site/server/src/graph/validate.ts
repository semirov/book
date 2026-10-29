/**
 * The form judge (BOOK-185, BOOK-DOC-77 §3).
 *
 * The model reads; this file checks. It asks only questions code can answer with certainty: does
 * the quote occur verbatim in one block, is the kind one of the seven, does the value become its
 * key, is a `use` about a fact the book held **before** this chapter, is a cause stamped after its
 * effect, do both endpoints of an edge exist, is a thread move legal from the thread's state, and
 * is this the second time the answer says the same thing. It never judges meaning: a fact that is
 * true in the world but false in the book passes this file, and that is the quality gate's problem
 * (BOOK-DOC-77 §6), not the validator's.
 *
 * Two invariants decide most of the design:
 *
 *  · **A rejection is final.** A quote with one changed character is not repaired to the nearest
 *    substring and a value is not coerced; the item is dropped, counted, and quoted in the
 *    chapter's rejects. A repaired quote would make a model's paraphrase look like the chapter's
 *    words, which is the exact failure the quote rule exists to catch.
 *  · **Offsets are code points** (`quote.ts`), the unit the ledger stores, so a witness
 *    recomputed from `block.text` is the same string the mention will carry.
 *
 * The module is pure: no database, no clock, no id. The caller hands it the chapter's blocks, the
 * live earlier facts, the threads and the parsed answer; it hands back what a transaction may
 * write and what it must not.
 */

import { endpointOf, orderProblem } from './edgeOrder.ts';
import { keyOf } from './keys.ts';
import type {
  AcceptedEdge,
  AcceptedFact,
  AcceptedThread,
  AcceptedThreadEvent,
  AcceptedUse,
  Duplicates,
  EdgeEndpoint,
  Reject,
  RejectCode,
  ValidateResult,
} from './judged.ts';
import {
  evidenceOf,
  locate,
  restatementIndex,
  supportProblem,
  type Block,
  type Evidence,
} from './quote.ts';
import {
  isEdgeKind,
  isFactKind,
  isThreadEventKind,
  type FactKind,
  type LooseAnswer,
  type ThreadDirection,
  type ThreadEventKind,
} from './schema.ts';
import { normalise } from './text.ts';

export type { Block };

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

/** A fact the book already holds. `chapter` is the chapter that established it, never later. */
export type EstablishedFact = { id: string; key: string; kind: FactKind; chapter: number; term: string };

export type ThreadState = 'opened' | 'advanced' | 'complicated' | 'closed';

export type ThreadHint = { id: string; label: string; state: ThreadState };

export type ValidateInput = {
  /** The chapter under extraction: the only chapter stamp this file writes. */
  chapter: number;
  /** The chapter's blocks in reading order; a quote is searched in this order, first hit wins. */
  blocks: readonly Block[];
  established: readonly EstablishedFact[];
  threads: readonly ThreadHint[];
  /** A parsed answer, or any structurally similar object: a kind is checked here, not assumed. */
  answer: LooseAnswer;
};

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

export type {
  AcceptedEdge,
  AcceptedFact,
  AcceptedThread,
  AcceptedThreadEvent,
  AcceptedUse,
  Duplicates,
  EdgeEndpoint,
  Reject,
  RejectCode,
  ValidateResult,
} from './judged.ts';

// ---------------------------------------------------------------------------------------------
// The state machine, for replaying an answer's own events
// ---------------------------------------------------------------------------------------------

const ALLOWED: Record<ThreadState, readonly ThreadEventKind[]> = {
  opened: ['advanced', 'complicated', 'closed'],
  advanced: ['advanced', 'complicated', 'closed'],
  complicated: ['advanced', 'closed'],
  closed: [],
};

/** A stable label match: exact first, then case/ё/space-folded — a slip is not a second thread. */
function threadHintOf(label: string, threads: readonly ThreadHint[]): ThreadHint | undefined {
  const exact = threads.find((thread) => thread.label.trim() === label);
  if (exact !== undefined) return exact;
  const folded = normalise(label);
  return threads.find((thread) => normalise(thread.label) === folded);
}

// ---------------------------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------------------------

export function validateAnswer(input: ValidateInput): ValidateResult {
  const chapter = input.chapter;
  const rejects: Reject[] = [];
  const duplicates: Duplicates = { facts: 0, uses: 0, edges: 0, total: 0 };
  const facts: AcceptedFact[] = [];
  const uses: AcceptedUse[] = [];
  const edges: AcceptedEdge[] = [];
  const threads: AcceptedThread[] = [];

  const established = new Map(input.established.map((fact) => [fact.key, fact]));
  /** Local refs (`f1`) → the fact or the earlier fact this answer names. First assignment wins. */
  const refs = new Map<string, EdgeEndpoint>();
  /** Keys this answer tells locally (asserted, or an earlier fact re-stated): not a `use`. */
  const localKeys = new Map<string, EdgeEndpoint>();
  const asserted = new Map<string, AcceptedFact>();
  /** The evidence of each local key, so a thread event without a quote still has a position. */
  const evidence = new Map<string, Evidence>();
  const seenEdges = new Set<string>();
  /**
   * The facts the answer has already told, indexed by what the **key cannot see**: the normalised
   * core value and the quote word for word. A restatement under a different key lands here and
   * becomes a mention of the first fact, never a second row (BOOK-185 defect 4).
   */
  const restatements = restatementIndex<EdgeEndpoint>();

  const reject = (code: RejectCode, path: string, item: unknown, quote: string, reason: string): void => {
    rejects.push({ code, path, item, quote, reason });
  };

  const bindRef = (ref: string | undefined, endpoint: EdgeEndpoint): void => {
    if (ref === undefined) return;
    if (!refs.has(ref)) refs.set(ref, endpoint);
  };

  const registerLocal = (key: string, endpoint: EdgeEndpoint, position: Evidence): void => {
    localKeys.set(key, endpoint);
    if (!evidence.has(key)) evidence.set(key, position);
  };

  // --- facts ---------------------------------------------------------------------------------
  for (const [index, fact] of input.answer.facts.entries()) {
    const path = `facts[${String(index)}]`;
    const quote = fact.quote ?? '';
    if (!isFactKind(fact.kind)) {
      reject('KIND_UNKNOWN', path, fact, quote, `"${fact.kind}" is not one of the seven carriers`);
      continue;
    }
    const parsed = keyOf(fact.kind, fact.value ?? '');
    if (!parsed.ok) {
      reject('VALUE_UNPARSEABLE', path, fact, quote, `"${fact.value}" is not a ${fact.kind} value`);
      continue;
    }
    const located = locate(quote, input.blocks);
    if (located === null) {
      reject('QUOTE_NOT_FOUND', path, fact, quote, 'the quote is not a verbatim substring of one block');
      continue;
    }
    const key = parsed.key;
    // A quote the chapter holds is not yet a quote that proves the value: `document:один-четыре`
    // with a ЖЭК sentence in its `quote` field proves nothing (BOOK-185 defect 2).
    const unsupported = supportProblem(fact.kind, key, quote);
    if (unsupported !== null) {
      reject('QUOTE_DOES_NOT_SUPPORT_VALUE', path, fact, quote, unsupported);
      continue;
    }
    const position = evidenceOf(located, fact.sentence);
    const term = fact.term ?? null;

    const assertedBefore = asserted.get(key);
    if (assertedBefore !== undefined) {
      // The same key twice in one answer: the first one is the fact, this is its mention.
      duplicates.facts += 1;
      duplicates.total += 1;
      facts.push({
        ...position,
        key,
        kind: fact.kind,
        value: fact.value,
        term,
        chapter,
        role: 'mention',
        factId: null,
        factChapter: null,
        ref: null,
      });
      bindRef(fact.ref, { key, kind: fact.kind, chapter, factId: null, source: 'local' });
      continue;
    }

    const live = established.get(key);
    if (live !== undefined && live.chapter < chapter) {
      // A re-assertion of an earlier fact is not a new fact: it is a use with the chapter's words.
      duplicates.facts += 1;
      duplicates.total += 1;
      const endpoint: EdgeEndpoint = { key, kind: fact.kind, chapter: live.chapter, factId: live.id, source: 'established' };
      registerLocal(key, endpoint, position);
      bindRef(fact.ref, endpoint);
      restatements.remember(endpoint, quote);
      uses.push({
        ...position,
        key,
        kind: fact.kind,
        value: fact.value,
        term,
        chapter,
        role: 'use',
        factId: live.id,
        factChapter: live.chapter,
      });
      continue;
    }

    const restatement = restatements.find(fact.kind, key, quote);
    if (restatement !== undefined) {
      // The same fact told again under another key or in another place: the row keeps the key that
      // came first, and this is a mention of it, never a second fact.
      duplicates.facts += 1;
      duplicates.total += 1;
      facts.push({
        ...position,
        key: restatement.key,
        kind: fact.kind,
        value: fact.value,
        term,
        chapter,
        role: 'mention',
        factId: restatement.factId,
        factChapter: restatement.source === 'established' ? restatement.chapter : null,
        ref: null,
      });
      registerLocal(restatement.key, restatement, position);
      bindRef(fact.ref, restatement);
      continue;
    }

    const endpoint: EdgeEndpoint = { key, kind: fact.kind, chapter, factId: null, source: 'local' };
    const accepted: AcceptedFact = {
      ...position,
      key,
      kind: fact.kind,
      value: fact.value,
      term,
      chapter,
      role: 'assert',
      factId: null,
      factChapter: null,
      ref: fact.ref ?? null,
    };
    asserted.set(key, accepted);
    registerLocal(key, endpoint, position);
    bindRef(fact.ref, endpoint);
    restatements.remember(endpoint, quote);
    facts.push(accepted);
  }

  // --- uses ----------------------------------------------------------------------------------
  for (const [index, use] of input.answer.uses.entries()) {
    const path = `uses[${String(index)}]`;
    const quote = use.quote ?? '';
    if (!isFactKind(use.kind)) {
      reject('KIND_UNKNOWN', path, use, quote, `"${use.kind}" is not one of the seven carriers`);
      continue;
    }
    const parsed = keyOf(use.kind, use.value ?? '');
    if (!parsed.ok) {
      reject('VALUE_UNPARSEABLE', path, use, quote, `"${use.value}" is not a ${use.kind} value`);
      continue;
    }
    const located = locate(quote, input.blocks);
    if (located === null) {
      reject('QUOTE_NOT_FOUND', path, use, quote, 'the quote is not a verbatim substring of one block');
      continue;
    }
    const key = parsed.key;
    const position = evidenceOf(located, use.sentence);

    const local = localKeys.get(key);
    if (local !== undefined) {
      // A key this chapter itself asserts is not a use: it is a mention of the local fact. It is
      // still a quote offered for a value, so it answers the same question every other item does.
      const unsupported = supportProblem(use.kind, key, quote);
      if (unsupported !== null) {
        reject('QUOTE_DOES_NOT_SUPPORT_VALUE', path, use, quote, unsupported);
        continue;
      }
      duplicates.uses += 1;
      duplicates.total += 1;
      uses.push({
        ...position,
        key,
        kind: use.kind,
        value: use.value,
        term: null,
        chapter,
        role: 'mention',
        factId: local.factId,
        factChapter: local.source === 'established' ? local.chapter : null,
      });
      continue;
    }

    const live = established.get(key);
    if (live === undefined || live.chapter >= chapter) {
      const reason =
        live === undefined
          ? 'no fact of the book holds this key'
          : `the fact is established in chapter ${String(live.chapter)}, not earlier than chapter ${String(chapter)}`;
      reject('FACT_NOT_ESTABLISHED', path, use, quote, reason);
      continue;
    }
    // A use carries a quote too, and the same question applies to it: the chapter's words must
    // mention the thing it claims to use.
    const unsupported = supportProblem(use.kind, key, quote);
    if (unsupported !== null) {
      reject('QUOTE_DOES_NOT_SUPPORT_VALUE', path, use, quote, unsupported);
      continue;
    }
    uses.push({
      ...position,
      key,
      kind: use.kind,
      value: use.value,
      term: null,
      chapter,
      role: 'use',
      factId: live.id,
      factChapter: live.chapter,
    });
  }

  // --- edges ---------------------------------------------------------------------------------
  for (const [index, edge] of input.answer.edges.entries()) {
    const path = `edges[${String(index)}]`;
    const quote = edge.quote ?? '';
    if (!isEdgeKind(edge.kind)) {
      reject('KIND_UNKNOWN', path, edge, quote, `"${edge.kind}" is not one of the five edges`);
      continue;
    }
    const located = locate(quote, input.blocks);
    if (located === null) {
      reject('QUOTE_NOT_FOUND', path, edge, quote, 'the quote is not a verbatim substring of one block');
      continue;
    }
    const from = endpointOf(edge.from, refs, established);
    if (from === null) {
      reject('EDGE_ENDPOINT_UNKNOWN', path, edge, quote, 'from names no fact of this answer and no established key');
      continue;
    }
    const to = endpointOf(edge.to, refs, established);
    if (to === null) {
      reject('EDGE_ENDPOINT_UNKNOWN', path, edge, quote, 'to names no fact of this answer and no established key');
      continue;
    }
    const problem = orderProblem(edge.kind, from, to);
    if (problem !== null) {
      reject('CAUSE_AFTER_EFFECT', path, edge, quote, problem);
      continue;
    }
    const key = `dep:${from.key}->${to.key}:${edge.kind}`;
    if (seenEdges.has(key)) {
      duplicates.edges += 1;
      duplicates.total += 1;
      continue;
    }
    seenEdges.add(key);
    edges.push({
      ...evidenceOf(located),
      key,
      from,
      to,
      kind: edge.kind,
      chapter,
      quote,
      statement: edge.statement ?? null,
      role: 'edge',
    });
  }

  // --- threads -------------------------------------------------------------------------------
  for (const [index, thread] of input.answer.threads.entries()) {
    const label = (thread.label ?? '').trim();
    const hint = threadHintOf(label, input.threads);
    const direction: ThreadDirection = thread.direction === 'backward' ? 'backward' : 'forward';
    let state: ThreadState = hint?.state ?? 'opened';
    const events: AcceptedThreadEvent[] = [];

    for (const [eventIndex, event] of (thread.events ?? []).entries()) {
      const path = `threads[${String(index)}].events[${String(eventIndex)}]`;
      const quote = event.quote ?? '';
      if (!isThreadEventKind(event.kind)) {
        reject('KIND_UNKNOWN', path, event, quote, `"${event.kind}" is not a thread move`);
        continue;
      }
      const endpoint = event.fact === undefined ? undefined : refs.get(event.fact);
      const factEvidence = endpoint === undefined ? undefined : evidence.get(endpoint.key);
      if (endpoint === undefined || factEvidence === undefined) {
        reject('THREAD_EVIDENCE_UNKNOWN', path, event, quote, 'the event names no fact this answer accepts');
        continue;
      }

      let position = factEvidence;
      if (quote.trim().length > 0) {
        const found = locate(quote, input.blocks);
        if (found === null) {
          reject('QUOTE_NOT_FOUND', path, event, quote, 'the quote is not a verbatim substring of one block');
          continue;
        }
        position = evidenceOf(found);
      }

      const isFirst = events.length === 0;
      if (hint === undefined) {
        if (isFirst && event.kind !== 'opened') {
          reject('THREAD_TRANSITION_ILLEGAL', path, event, quote, 'a new thread opens before it moves');
          continue;
        }
        if (!isFirst && event.kind === 'opened') {
          reject('THREAD_TRANSITION_ILLEGAL', path, event, quote, 'the thread was opened earlier in this answer');
          continue;
        }
        if (!isFirst && !ALLOWED[state].includes(event.kind)) {
          reject('THREAD_TRANSITION_ILLEGAL', path, event, quote, `${state} → ${event.kind} is not a transition`);
          continue;
        }
      } else {
        if (event.kind === 'opened') {
          reject('THREAD_TRANSITION_ILLEGAL', path, event, quote, 'the thread already exists: opened is not a move');
          continue;
        }
        if (!ALLOWED[state].includes(event.kind)) {
          reject('THREAD_TRANSITION_ILLEGAL', path, event, quote, `${state} → ${event.kind} is not a transition`);
          continue;
        }
      }

      state = event.kind === 'opened' ? 'opened' : event.kind;
      events.push({
        ...position,
        chapter,
        kind: event.kind,
        factKey: endpoint.key,
        factId: endpoint.factId,
        note: event.note ?? null,
      });
    }

    if (events.length > 0) {
      threads.push({
        key: `thread:${normalise(label)}`,
        label,
        threadId: hint?.id ?? null,
        direction,
        state,
        role: 'thread',
        events,
      });
    }
  }

  return { facts, uses, edges, threads, rejects, duplicates };
}
