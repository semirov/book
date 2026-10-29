/**
 * The recall merge as arithmetic (BOOK-185, BOOK-DOC-77 §4, defect 4).
 *
 * The merge is where two answers become one, so its corner cases are tested without a model, a
 * database or a clock: a restatement under another key, under another spelling of one value or
 * under the same quote is a mention of the first fact, never a second row. Grows here, out of
 * `recall.test.ts`, which drives the pass end to end and is near its size limit.
 */

import { describe, expect, it } from 'vitest';

import type { AcceptedEdge, AcceptedFact, AcceptedThread } from '../../src/graph/judged.ts';
import { mergeRecall, NOTHING_ADDED } from '../../src/graph/recall.ts';
import type { ValidateResult } from '../../src/graph/validate.ts';

// ---------------------------------------------------------------------------------------------
// The merge itself: arithmetic, no model, no database
// ---------------------------------------------------------------------------------------------

const evidence = (
  witness: string,
): Pick<AcceptedFact, 'blockId' | 'start' | 'end' | 'witness' | 'sentence' | 'statement'> => ({
  blockId: 'blk',
  start: 0,
  end: witness.length,
  witness,
  sentence: witness,
  statement: witness,
});

/** `document:4-у-арх` → `document`: the kind a fixture key names, so an edge and a key agree. */
function kindOf(key: string): AcceptedFact['kind'] {
  return key.slice(0, key.indexOf(':')) as AcceptedFact['kind'];
}

function factOf(key: string, role: 'assert' | 'mention' | 'use' = 'assert', witness?: string): AcceptedFact {
  return {
    ...evidence(witness ?? key),
    key,
    kind: kindOf(key),
    value: key.slice(key.indexOf(':') + 1),
    term: null,
    chapter: 2,
    role,
    factId: role === 'assert' ? null : 'fct_earlier',
    factChapter: role === 'assert' ? null : 1,
    ref: null,
  };
}

function edgeOf(from: string, to: string, kind: AcceptedEdge['kind'] = 'document'): AcceptedEdge {
  return {
    ...evidence(`${from}->${to}`),
    key: `dep:${from}->${to}:${kind}`,
    from: { key: from, kind: 'term', chapter: 2, factId: null, source: 'local' },
    to: { key: to, kind: 'term', chapter: 2, factId: null, source: 'local' },
    kind,
    chapter: 2,
    quote: `${from}->${to}`,
    statement: null,
    role: 'edge',
  };
}

function threadOf(label: string, kinds: Array<AcceptedThread['events'][number]['kind']>): AcceptedThread {
  return {
    key: `thread:${label}`,
    label,
    threadId: null,
    direction: 'forward',
    state: kinds.at(-1) ?? 'opened',
    role: 'thread',
    events: kinds.map((kind) => ({ ...evidence(`${label}:${kind}`), chapter: 2, kind, factKey: 'term:a', factId: null, note: null })),
  };
}

function answerOf(over: Partial<ValidateResult> = {}): ValidateResult {
  return {
    facts: [],
    uses: [],
    edges: [],
    threads: [],
    rejects: [],
    duplicates: { facts: 0, uses: 0, edges: 0, total: 0 },
    ...over,
  };
}

describe('mergeRecall', () => {
  it('turns a recalled key into a mention instead of a second fact', () => {
    const merged = mergeRecall({
      chapter: 2,
      first: answerOf({ facts: [factOf('term:a')] }),
      recall: answerOf({ facts: [factOf('term:a')] }),
    });
    expect(merged.added).toEqual(NOTHING_ADDED);
    expect(merged.answer.facts.map((fact) => fact.role)).toEqual(['assert', 'mention']);
    expect(merged.answer.facts[1]?.pass).toBe('recall');
  });

  it('collapses a recall restatement by core and by quote into mentions of one fact', () => {
    // Defect 4: `document:4-у-арх` and `document:4-у арх` are one paper, and the same sentence
    // quoted again is the same fact, not a second one. Two mentions, one fact.
    const first = answerOf({ facts: [factOf('document:4-у-арх', 'assert', 'форма 4-У/арх')] });
    const recall = answerOf({
      facts: [
        factOf('term:правоудержания', 'assert', 'права удержания'), // the core, another spelling
        factOf('term:право', 'assert', 'право удержания'), // the quote, another key
      ],
    });
    const restated = mergeRecall({
      chapter: 2,
      first: answerOf({ facts: [factOf('term:право удержания', 'assert', 'право удержания')] }),
      recall,
    });
    expect(restated.added.facts).toBe(0);
    expect(restated.answer.facts.map((fact) => [fact.key, fact.role])).toEqual([
      ['term:право удержания', 'assert'],
      ['term:право удержания', 'mention'],
      ['term:право удержания', 'mention'],
    ]);
    expect(restated.answer.duplicates.facts).toBe(2);

    const document = mergeRecall({
      chapter: 2,
      first,
      recall: answerOf({ facts: [factOf('document:4-у', 'assert', 'форма 4-У/арх')] }),
    });
    expect(document.added.facts).toBe(0);
    expect(document.answer.facts.map((fact) => [fact.key, fact.role])).toEqual([
      ['document:4-у-арх', 'assert'],
      ['document:4-у-арх', 'mention'],
    ]);
  });

  it('keeps one edge when the recall respells an endpoint of the same dependency', () => {
    const merged = mergeRecall({
      chapter: 2,
      first: answerOf({ edges: [edgeOf('term:право удержания', 'name:сорокин')] }),
      recall: answerOf({ edges: [edgeOf('term:правоудержания', 'name:сорокин')] }),
    });
    expect(merged.added.edges).toBe(0);
    expect(merged.answer.edges).toHaveLength(1);
    expect(merged.answer.duplicates.edges).toBe(1);
  });

  it('never folds a recall use into a first-pass fact: a use binds to an earlier chapter', () => {
    const merged = mergeRecall({
      chapter: 2,
      first: answerOf({ facts: [factOf('document:65-11877-арх', 'assert', 'заявление 65/11877/арх')] }),
      recall: answerOf({ facts: [factOf('document:65-11877-арх', 'use', 'заявление 65/11877/арх')] }),
    });
    expect(merged.answer.facts.map((fact) => fact.role)).toEqual(['assert', 'use']);
  });

  it('drops an edge and a thread event the first pass already told', () => {
    const merged = mergeRecall({
      chapter: 2,
      first: answerOf({ edges: [edgeOf('term:a', 'term:b')], threads: [threadOf('дело', ['opened'])] }),
      recall: answerOf({ edges: [edgeOf('term:a', 'term:b')], threads: [threadOf('дело', ['opened'])] }),
    });
    expect(merged.added).toEqual(NOTHING_ADDED);
    expect(merged.answer.edges).toHaveLength(1);
    expect(merged.answer.threads[0]?.events).toHaveLength(1);
  });

  it('appends a new move to an existing thread and counts a new thread', () => {
    const merged = mergeRecall({
      chapter: 2,
      first: answerOf({ threads: [threadOf('дело', ['opened'])] }),
      recall: answerOf({ threads: [threadOf('дело', ['advanced']), threadOf('второе', ['opened'])] }),
    });
    expect(merged.added.threads).toBe(1);
    expect(merged.answer.threads.map((thread) => thread.label)).toEqual(['дело', 'второе']);
    expect(merged.answer.threads[0]?.events.map((event) => event.kind)).toEqual(['opened', 'advanced']);
    expect(merged.answer.threads[0]?.state).toBe('advanced');
    expect(merged.answer.threads[0]?.pass).toBeUndefined();
    expect(merged.answer.threads[1]?.pass).toBe('recall');
  });

  it('sums the two passes’ rejects and duplicates and keeps the first pass order', () => {
    const merged = mergeRecall({
      chapter: 2,
      first: answerOf({
        facts: [factOf('term:a'), factOf('term:b')],
        duplicates: { facts: 1, uses: 0, edges: 0, total: 1 },
      }),
      recall: answerOf({
        facts: [factOf('term:c')],
        rejects: [{ code: 'QUOTE_NOT_FOUND', path: 'facts[0]', item: {}, quote: '', reason: '' }],
        duplicates: { facts: 0, uses: 1, edges: 0, total: 1 },
      }),
    });
    expect(merged.added).toEqual({ facts: 1, edges: 0, threads: 0 });
    expect(merged.answer.facts.map((fact) => fact.key)).toEqual(['term:a', 'term:b', 'term:c']);
    expect(merged.answer.rejects).toHaveLength(1);
    expect(merged.answer.duplicates).toEqual({ facts: 1, uses: 1, edges: 0, total: 2 });
  });
});
