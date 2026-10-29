/**
 * The recall pass's arithmetic (BOOK-185, BOOK-DOC-77 §4).
 *
 * A second call asks the same chapter what the first list missed. Everything the model says is
 * **additive**: the recall can add a fact, an edge or a thread event, and it can never remove,
 * rewrite or re-chapter something the first pass produced. That is why this file merges rather
 * than revalidates the first answer:
 *
 *  · a recall fact whose key the first pass already asserted is a **mention** of it, not a second
 *    fact — the graph has one row per live key, and saying it twice is not saying two things;
 *  · a recall `use` of a key the first pass asserted is pre-converted to a fact of the same key
 *    before validation, so the validator sees a local mention instead of an `FACT_NOT_ESTABLISHED`
 *    (a use is only legal for a fact established **before** this chapter);
 *  · edges merge by `(from, to, kind, chapter)` and threads by normalised label, with the recall's
 *    events appended and an event the first pass already stated dropped.
 *
 * The merge also **stamps** what it added: every item carries `pass: 'recall'`, which is what
 * `persistFacts`/`persistEdges`/`persistThreads` write into `extracted_by.pass` — the pass that
 * first produced the row, not the pass that happened to write it last.
 *
 * The module is pure: no database, no clock, no id. The caller hands it two validated answers and
 * gets back the one a transaction may write, plus the count of what recall bought.
 */

import type {
  AcceptedEdge,
  AcceptedFact,
  AcceptedThread,
  AcceptedThreadEvent,
  AcceptedUse,
  Duplicates,
  ValidateResult,
} from './judged.ts';
import { keyOf } from './keys.ts';
import { buildRecallPrompt, type RecallFirst, type RecallPrompt } from './prompt.ts';
import { restatementIndex, supportCore } from './quote.ts';
import type { GraphAnswer } from './schema.ts';
import type { EstablishedFact, ThreadHint } from './validate.ts';
import { idOf, normalise } from './text.ts';

/** What the recall pass put into the graph that the first pass did not: the number to report. */
export type RecallAdded = { facts: number; edges: number; threads: number };

/** The zero of `RecallAdded`: a skipped or failed recall adds nothing and must not read as null. */
export const NOTHING_ADDED: RecallAdded = { facts: 0, edges: 0, threads: 0 };

/** The first pass as the recall prompt shows it: what it must not repeat. */
export function recallFirstOf(first: ValidateResult): RecallFirst {
  return {
    // A `mention` is the same key said twice inside the first answer; showing it again would ask
    // the recall to avoid a duplicate of a duplicate.
    facts: first.facts
      .filter((fact) => fact.role === 'assert')
      .map((fact) => ({ kind: fact.kind, value: fact.value, quote: fact.witness })),
    uses: first.uses.map((use) => ({ kind: use.kind, value: use.value, quote: use.witness })),
    edges: first.edges.map((edge) => ({
      kind: edge.kind,
      from: { key: edge.from.key },
      to: { key: edge.to.key },
      quote: edge.witness,
    })),
    threads: first.threads.map((thread) => ({
      label: thread.label,
      events: thread.events.map((event) => ({ kind: event.kind })),
    })),
  };
}

/** The recall prompt over one validated first answer; its sha is the recall question's identity. */
export function recallPromptOf(chapter: number, text: string, first: ValidateResult): RecallPrompt {
  return buildRecallPrompt({ chapter, text, first: recallFirstOf(first) });
}

/** The keys the first pass itself asserts: a recall item of one of them is a mention, not a fact. */
export function firstKeysOf(first: ValidateResult): Set<string> {
  return new Set(first.facts.filter((fact) => fact.role === 'assert').map((fact) => fact.key));
}

/**
 * A recall `use` whose key the first pass asserted becomes a fact of the same key: the validator
 * then reads it as a local mention, which is what it is. Every other use is left for the validator,
 * which binds it to the earlier fact or drops it.
 */
export function resolveRecallUses(answer: GraphAnswer, firstKeys: ReadonlySet<string>): GraphAnswer {
  const uses: GraphAnswer['uses'] = [];
  const facts: GraphAnswer['facts'] = [...answer.facts];
  for (const use of answer.uses) {
    const parsed = keyOf(use.kind, use.value);
    if (parsed.ok && firstKeys.has(parsed.key)) {
      facts.push({
        kind: use.kind,
        value: use.value,
        quote: use.quote,
        ...(use.sentence === undefined ? {} : { sentence: use.sentence }),
      });
    } else {
      uses.push(use);
    }
  }
  return { ...answer, facts, uses };
}

/**
 * The first pass's own facts and threads as the recall validator must see them: the facts as
 * same-chapter locals (a `{ "key": … }` endpoint resolves, an `opened` is not a new thread), and
 * the threads at the state the first pass left them.
 */
export function recallLocals(
  chapter: number,
  first: ValidateResult,
): { established: EstablishedFact[]; threads: ThreadHint[] } {
  return {
    established: first.facts
      .filter((fact) => fact.role === 'assert')
      .map((fact) => ({
        id: idOf('fct', fact.key),
        key: fact.key,
        kind: fact.kind,
        chapter,
        term: fact.term ?? '',
      })),
    threads: first.threads.map((thread) => ({
      id: thread.threadId ?? idOf('thr', normalise(thread.label)),
      label: thread.label,
      state: thread.state,
    })),
  };
}

export type MergeInput = {
  chapter: number;
  /** The first pass, validated against the book. */
  first: ValidateResult;
  /** The recall answer, validated against the book and the first pass. */
  recall: ValidateResult;
};

export type MergedAnswer = {
  /** The one answer a transaction writes: the first pass with the recall's additions. */
  answer: ValidateResult;
  added: RecallAdded;
};

function edgeSlot(edge: AcceptedEdge): string {
  return `${edge.from.key}|${edge.to.key}|${edge.kind}`;
}

/** The key's value with nothing between the characters: `document:4-у-арх` → `4уарх`. */
function coreOf(key: string): string {
  return supportCore(key.slice(key.indexOf(':') + 1));
}

/**
 * An edge as a **different spelling** cannot hide it: `(from core, to core, kind)`. The key-based
 * slot above catches the same keys; this one catches `document:4-у-арх` and `document:4-у арх`
 * naming one paper on one end of one dependency (BOOK-185 defect 4).
 */
function edgeCore(edge: AcceptedEdge): string {
  return `${coreOf(edge.from.key)}|${coreOf(edge.to.key)}|${edge.kind}`;
}

function eventSlot(event: AcceptedThreadEvent): string {
  return `${event.kind}|${event.factKey}`;
}

function sumDuplicates(left: Duplicates, right: Duplicates): Duplicates {
  return {
    facts: left.facts + right.facts,
    uses: left.uses + right.uses,
    edges: left.edges + right.edges,
    total: left.total + right.total,
  };
}

/**
 * The first answer with the recall's additions, in the order the writer of the graph expects:
 * facts first (an `assert` always precedes the mentions that bind to it), then uses, edges and
 * threads. Nothing of the first pass is dropped, reordered or restamped.
 */
export function mergeRecall(input: MergeInput): MergedAnswer {
  const { first, recall } = input;
  const duplicates = sumDuplicates(first.duplicates, recall.duplicates);
  const added: RecallAdded = { ...NOTHING_ADDED };

  const facts: AcceptedFact[] = [...first.facts];
  const firstByKey = new Map(first.facts.filter((fact) => fact.role === 'assert').map((fact) => [fact.key, fact]));
  /**
   * What the first pass already tells, indexed by what a **different key** cannot hide: the
   * normalised core value (`document:заявление о прекращении` vs `document:заявлениеопрекращении`)
   * and the quote word for word. The recall's restatement of either is a mention of the first
   * fact, never a second row (BOOK-185 defect 4).
   */
  const firstTold = restatementIndex<AcceptedFact>();
  for (const fact of first.facts) {
    if (fact.role === 'assert') firstTold.remember(fact, fact.witness);
  }

  for (const fact of recall.facts) {
    // A `use` is bound to an earlier chapter by the validator; only a fact the recall tells of
    // **this** chapter can restate one of the first pass's.
    const existing =
      fact.role === 'use' ? undefined : (firstByKey.get(fact.key) ?? firstTold.find(fact.kind, fact.key, fact.witness));
    if (existing !== undefined) {
      // One row, said twice: a mention at its own span, under the key the first pass wrote — the
      // mention binds to the live row, never to the spelling the recall happened to choose.
      facts.push({ ...fact, key: existing.key, role: 'mention', factId: null, factChapter: null, pass: 'recall' });
      // The recall's own restatements were charged by its validator; a restatement of the first
      // pass is charged here, because the recall prompt counts one as a duplicate, not as recall.
      if (fact.role === 'assert') {
        duplicates.facts += 1;
        duplicates.total += 1;
      }
      continue;
    }
    facts.push({ ...fact, pass: 'recall' });
    if (fact.role === 'assert') added.facts += 1;
  }

  const uses: AcceptedUse[] = [...first.uses, ...recall.uses];

  const edges: AcceptedEdge[] = [...first.edges];
  const seenEdges = new Set(first.edges.map(edgeSlot));
  const seenCores = new Set(first.edges.map(edgeCore));
  for (const edge of recall.edges) {
    const slot = edgeSlot(edge);
    if (seenEdges.has(slot)) continue;
    if (seenCores.has(edgeCore(edge))) {
      // The same dependency under another spelling of an endpoint: one edge, not two.
      seenEdges.add(slot);
      duplicates.edges += 1;
      duplicates.total += 1;
      continue;
    }
    seenEdges.add(slot);
    seenCores.add(edgeCore(edge));
    edges.push({ ...edge, pass: 'recall' });
    added.edges += 1;
  }

  const threads: AcceptedThread[] = first.threads.map((thread) => ({ ...thread, events: [...thread.events] }));
  const byLabel = new Map(threads.map((thread) => [normalise(thread.label), thread]));
  for (const thread of recall.threads) {
    const label = normalise(thread.label);
    const existing = byLabel.get(label);
    if (existing === undefined) {
      threads.push({ ...thread, events: [...thread.events], pass: 'recall' });
      added.threads += 1;
      continue;
    }
    const seenEvents = new Set(existing.events.map(eventSlot));
    for (const event of thread.events) {
      const slot = eventSlot(event);
      if (seenEvents.has(slot)) continue;
      seenEvents.add(slot);
      existing.events.push(event);
    }
    // The state is the replay of every event this chapter now tells; `persistThreads` replays the
    // database rows anyway, and a dry run has only this field to show.
    const last = existing.events.at(-1);
    if (last !== undefined) existing.state = last.kind;
  }

  return {
    answer: {
      facts,
      uses,
      edges,
      threads,
      // A cross-pass repeat costs a duplicate too: the recall prompt calls a restatement a
      // duplicate, and the merge charges it instead of pretending the model was silent.
      rejects: [...first.rejects, ...recall.rejects],
      duplicates,
    },
    added,
  };
}
