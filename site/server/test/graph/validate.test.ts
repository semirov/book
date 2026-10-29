/**
 * The form judge (BOOK-185, BOOK-DOC-77 §3).
 *
 * The prose lives in `validateFixture.ts` and is synthetic on purpose: the real chapters carry the
 * lesson (ch04's «кто подписал?», ch15's list of dates), and the fixture quotes those shapes
 * without needing the manuscript. Every case states which rule it proves and what a reader would
 * see if the rule were missing.
 */

import { describe, expect, it } from 'vitest';

import { dateKey, documentKey, keyOf } from '../../src/graph/keys.ts';
import type { Block } from '../../src/graph/validate.ts';
import { DECISION_FACT, DOC_FACT, NAME_FACT, run } from './validateFixture.ts';

describe('a quote is evidence only when the chapter contains it', () => {
  it('accepts a verbatim quote and stores code-point offsets and the witness', () => {
    const result = run({ facts: [{ ...DOC_FACT, sentence: 'Номер 65/11877/арх.' }] }, { established: [] });
    expect(result.rejects).toEqual([]);
    expect(result.facts).toHaveLength(1);
    const fact = result.facts[0];
    expect(fact?.blockId).toBe('b2');
    expect(fact?.start).toBe(42);
    expect(fact?.end).toBe(60);
    expect(fact?.witness).toBe('Номер 65/11877/арх');
    expect(fact?.sentence).toBe('Номер 65/11877/арх.');
    expect(fact?.role).toBe('assert');
    expect(fact?.chapter).toBe(5);
    expect(fact?.key).toBe('document:65-11877-арх');
  });

  it('derives the sentence from the block when the model did not supply one', () => {
    const result = run({ facts: [{ ...DOC_FACT }] }, { established: [] });
    expect(result.facts[0]?.sentence).toBe('Номер 65/11877/арх.');
  });

  it('keeps the model sentence only when it holds the quote', () => {
    const kept = run(
      { facts: [{ ...DOC_FACT, sentence: 'Сорокин Андрей Викторович подписал отказ. Номер 65/11877/арх.' }] },
      { established: [] },
    );
    expect(kept.facts[0]?.sentence).toBe('Сорокин Андрей Викторович подписал отказ. Номер 65/11877/арх.');
    const replaced = run({ facts: [{ ...DOC_FACT, sentence: 'Совсем другая фраза.' }] }, { established: [] });
    expect(replaced.facts[0]?.sentence).toBe('Номер 65/11877/арх.');
  });

  it('rejects a quote with one changed character', () => {
    const result = run({ facts: [{ ...DOC_FACT, quote: 'Номер 65/11877/арx' }] });
    expect(result.facts).toEqual([]);
    expect(result.rejects.map((reject) => reject.code)).toEqual(['QUOTE_NOT_FOUND']);
    expect(result.rejects[0]?.quote).toBe('Номер 65/11877/арx');
  });

  it('rejects a quote that spans two blocks', () => {
    // «…мой акт.» ends b1 and «Сорокин…» starts b2: no single block holds the joined string.
    const result = run({ facts: [{ ...DOC_FACT, quote: 'мой акт. Сорокин' }] });
    expect(result.rejects.map((reject) => reject.code)).toEqual(['QUOTE_NOT_FOUND']);
  });

  it('counts offsets in code points, not UTF-16 units', () => {
    const blocks: Block[] = [{ id: 'emoji', text: '🕯️ Номер 77/1/арх.' }];
    const result = run(
      { facts: [{ kind: 'document', value: '77/1/арх', quote: 'Номер 77/1/арх' }] },
      { blocks, established: [], threads: [] },
    );
    // The candle is two code points (surrogate pair + variation selector) and three UTF-16 units.
    expect(result.facts[0]?.start).toBe(3);
    expect(result.facts[0]?.end).toBe(17);
    expect(result.facts[0]?.witness).toBe('Номер 77/1/арх');
  });

  it('takes the first occurrence in reading order, deterministically', () => {
    const blocks: Block[] = [
      { id: 'first', text: 'Номер 65/11877/арх в первом блоке.' },
      { id: 'second', text: 'Номер 65/11877/арх во втором блоке.' },
    ];
    const result = run({ facts: [{ ...DOC_FACT }] }, { blocks, established: [], threads: [] });
    expect(result.facts[0]?.blockId).toBe('first');
    expect(result.facts[0]?.start).toBe(0);
  });
});

describe('values become the keys of their kind', () => {
  it('builds all seven keys', () => {
    const facts = [
      { kind: 'date', value: '14.09.2065', quote: '14.09.2065' },
      { kind: 'document', value: '№ 65/11877/арх', quote: 'Номер 65/11877/арх' },
      { kind: 'name', value: 'Сорокин Андрей Викторович', quote: 'Сорокин Андрей Викторович' },
      { kind: 'term', value: 'Право   удержания', quote: 'правом удержания' },
      { kind: 'promise', value: 'вернуться@19.02', quote: 'вернусь до 19.02' },
      { kind: 'decision', value: 'подписать@отказ', quote: 'подписал отказ' },
      { kind: 'absence', value: 'сорокин@больше нет', quote: 'Сорокина больше нет' },
    ];
    const result = run({ facts }, { established: [] });
    expect(result.rejects).toEqual([]);
    expect(result.facts.map((fact) => fact.key)).toEqual([
      'date:2065-09-14',
      'document:65-11877-арх',
      'name:сорокин андрей викторович',
      'term:право удержания',
      'promise:вернуться@--02-19',
      'decision:подписать@отказ',
      'absence:сорокин@больше нет',
    ]);
    // The value is the model's, never rewritten: normalisation lives in the key alone.
    expect(result.facts[1]?.value).toBe('№ 65/11877/арх');
    expect(result.facts[3]?.value).toBe('Право   удержания');
  });

  it('writes a deadline in its date form, so two spellings are one promise', () => {
    expect(keyOf('promise', 'вернуться@19.02')).toEqual({ ok: true, key: 'promise:вернуться@--02-19' });
    expect(keyOf('decision', 'подписать@отказ')).toEqual({ ok: true, key: 'decision:подписать@отказ' });
  });

  it('refuses a value that is no date at all', () => {
    expect(dateKey('март')).toBeNull();
    expect(keyOf('date', 'вчера')).toEqual({ ok: false });
  });

  it('folds ё and keeps a yearless date', () => {
    expect(keyOf('name', 'Ковалёв Пётр')).toEqual({ ok: true, key: 'name:ковалев петр' });
    expect(dateKey('--02-19')).toBe('--02-19');
    expect(dateKey('19.02')).toBe('--02-19');
    expect(documentKey('65/11877/арх')).toBe('65-11877-арх');
  });

  it('rejects values that cannot become their key', () => {
    const facts = [
      { kind: 'date', value: '2065-13-40', quote: '14.09.2065' },
      { kind: 'date', value: '31.02', quote: '19.02' },
      { kind: 'document', value: '№', quote: 'Номер 65/11877/арх' },
      { kind: 'name', value: '«»', quote: 'Сорокин Андрей Викторович' },
      { kind: 'promise', value: 'вернусь', quote: 'вернусь до 19.02' },
      { kind: 'decision', value: '@отказ', quote: 'подписал отказ' },
      { kind: 'absence', value: 'сорокин@', quote: 'Сорокина больше нет' },
    ];
    const result = run({ facts });
    expect(result.facts).toEqual([]);
    expect(result.rejects.map((reject) => reject.code)).toEqual([
      'VALUE_UNPARSEABLE',
      'VALUE_UNPARSEABLE',
      'VALUE_UNPARSEABLE',
      'VALUE_UNPARSEABLE',
      'VALUE_UNPARSEABLE',
      'VALUE_UNPARSEABLE',
      'VALUE_UNPARSEABLE',
    ]);
  });

  it('rejects a kind that is not one of the seven', () => {
    const result = run({ facts: [{ kind: 'map', value: 'x', quote: 'Номер 65/11877/арх' }] });
    expect(result.rejects.map((reject) => reject.code)).toEqual(['KIND_UNKNOWN']);
  });
});

describe('a use is about a fact the book already held', () => {
  it('accepts a use of an earlier fact and binds it', () => {
    const result = run({ uses: [{ kind: 'document', value: '65-11877-арх', quote: 'Номер 65/11877/арх' }] });
    expect(result.rejects).toEqual([]);
    expect(result.uses).toHaveLength(1);
    expect(result.uses[0]?.role).toBe('use');
    expect(result.uses[0]?.factId).toBe('fact_doc');
    expect(result.uses[0]?.factChapter).toBe(3);
    expect(result.uses[0]?.chapter).toBe(5);
    expect(result.uses[0]?.witness).toBe('Номер 65/11877/арх');
  });

  it('rejects a use of a fact established later', () => {
    const result = run({ uses: [{ kind: 'document', value: '77/1/арх', quote: 'Документ 77/1/арх' }] });
    expect(result.uses).toEqual([]);
    expect(result.rejects.map((reject) => reject.code)).toEqual(['FACT_NOT_ESTABLISHED']);
    expect(result.rejects[0]?.reason).toContain('chapter 9');
  });

  it('matches an established promise whose deadline is written as the chapter writes it', () => {
    const result = run({ uses: [{ kind: 'promise', value: 'вернуться@19.02', quote: 'Я вернусь до 19.02' }] });
    expect(result.rejects).toEqual([]);
    expect(result.uses[0]?.factId).toBe('fact_promise');
    expect(result.uses[0]?.factChapter).toBe(4);
  });

  it('rejects a use whose kind is unknown', () => {
    const result = run({ uses: [{ kind: 'map', value: '65/11877/арх', quote: 'Номер 65/11877/арх' }] });
    expect(result.rejects.map((reject) => reject.code)).toEqual(['KIND_UNKNOWN']);
  });

  it('rejects a use whose value does not parse or whose quote is not in the chapter', () => {
    const badValue = run({ uses: [{ kind: 'document', value: '№', quote: 'Номер 65/11877/арх' }] });
    expect(badValue.rejects.map((reject) => reject.code)).toEqual(['VALUE_UNPARSEABLE']);

    const badQuote = run({ uses: [{ kind: 'document', value: '65-11877-арх', quote: 'Номер 65/11877/архы' }] });
    expect(badQuote.rejects.map((reject) => reject.code)).toEqual(['QUOTE_NOT_FOUND']);
  });

  it('rejects a use of a key no fact holds', () => {
    const result = run({ uses: [{ kind: 'document', value: '44/17', quote: 'Документ 77/1/арх' }] });
    expect(result.rejects.map((reject) => reject.code)).toEqual(['FACT_NOT_ESTABLISHED']);
  });

  it('reclassifies a use of a key asserted in the same answer as a mention', () => {
    const result = run({
      facts: [{ ...NAME_FACT }],
      uses: [{ kind: 'name', value: 'Сорокин Андрей Викторович', quote: 'Сорокин Андрей Викторович' }],
    });
    expect(result.rejects).toEqual([]);
    expect(result.uses).toHaveLength(1);
    expect(result.uses[0]?.role).toBe('mention');
    expect(result.uses[0]?.factId).toBeNull();
    expect(result.duplicates.uses).toBe(1);
    expect(result.duplicates.total).toBe(1);
  });

  it('turns a re-assertion of an established fact into a use, counted as a duplicate', () => {
    const result = run({ facts: [{ ...DOC_FACT }] });
    expect(result.rejects).toEqual([]);
    expect(result.facts).toEqual([]);
    expect(result.uses).toHaveLength(1);
    expect(result.uses[0]?.role).toBe('use');
    expect(result.uses[0]?.factId).toBe('fact_doc');
    expect(result.duplicates.facts).toBe(1);
  });
});

describe('an edge may not be stamped into the past', () => {
  it('rejects a cause whose from and to are the same chapter', () => {
    const result = run({
      facts: [{ ...NAME_FACT }, { ...DECISION_FACT }],
      edges: [{ from: 'f2', to: 'f3', kind: 'cause', quote: 'подписал отказ' }],
    });
    expect(result.edges).toEqual([]);
    expect(result.rejects.map((reject) => reject.code)).toEqual(['CAUSE_AFTER_EFFECT']);
  });

  it('accepts a document edge from a fact of a later chapter', () => {
    const result = run({
      facts: [{ ...NAME_FACT }],
      edges: [{ from: { key: 'document:77-1-арх' }, to: 'f2', kind: 'document', quote: 'Документ 77/1/арх' }],
    });
    expect(result.rejects).toEqual([]);
    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0];
    expect(edge?.from.chapter).toBe(9);
    expect(edge?.from.source).toBe('established');
    expect(edge?.to.chapter).toBe(5);
    expect(edge?.key).toBe('dep:document:77-1-арх->name:сорокин андрей викторович:document');
    expect(edge?.role).toBe('edge');
  });

  it('lets an absence edge start in the same chapter', () => {
    const result = run({
      facts: [{ ...NAME_FACT }, { ref: 'f4', kind: 'absence', value: 'сорокин@больше нет', quote: 'Сорокина больше нет' }],
      edges: [{ from: 'f2', to: 'f4', kind: 'absence', quote: 'Сорокина больше нет' }],
    });
    expect(result.rejects).toEqual([]);
    expect(result.edges).toHaveLength(1);
  });

  it('rejects an absence edge that starts in a later chapter', () => {
    const result = run({
      facts: [{ ...NAME_FACT }],
      edges: [{ from: { key: 'document:77-1-арх' }, to: 'f2', kind: 'absence', quote: 'Документ 77/1/арх' }],
    });
    expect(result.rejects.map((reject) => reject.code)).toEqual(['CAUSE_AFTER_EFFECT']);
    expect(result.rejects[0]?.reason).toContain('never later');
  });

  it('rejects an edge whose to names nothing', () => {
    const result = run({
      facts: [{ ...NAME_FACT }],
      edges: [{ from: 'f2', to: { key: 'document:nope' }, kind: 'document', quote: 'Номер 65/11877/арх' }],
    });
    expect(result.rejects.map((reject) => reject.code)).toEqual(['EDGE_ENDPOINT_UNKNOWN']);
    expect(result.rejects[0]?.reason).toContain('to');
  });

  it('rejects an edge whose quote is not in the chapter', () => {
    const result = run({
      facts: [{ ...NAME_FACT }],
      edges: [{ from: 'f2', to: 'f2', kind: 'document', quote: 'Номер 65/11877/арх и ещё' }],
    });
    expect(result.rejects.map((reject) => reject.code)).toEqual(['QUOTE_NOT_FOUND']);
  });

  it('rejects an edge whose endpoint names nothing', () => {
    const result = run({
      facts: [{ ...NAME_FACT }],
      edges: [
        { from: 'f9', to: 'f2', kind: 'document', quote: 'Номер 65/11877/арх' },
        { from: { key: 'document:nope' }, to: 'f2', kind: 'document', quote: 'Номер 65/11877/арх' },
      ],
    });
    expect(result.edges).toEqual([]);
    expect(result.rejects.map((reject) => reject.code)).toEqual(['EDGE_ENDPOINT_UNKNOWN', 'EDGE_ENDPOINT_UNKNOWN']);
    expect(result.rejects[0]?.reason).toContain('from');
  });

  it('rejects an edge kind that is not one of the five', () => {
    const result = run({
      facts: [{ ...NAME_FACT }],
      edges: [{ from: 'f2', to: 'f2', kind: 'theme', quote: 'Сорокин Андрей Викторович' }],
    });
    expect(result.rejects.map((reject) => reject.code)).toEqual(['KIND_UNKNOWN']);
  });
});

describe('duplicates collapse', () => {
  it('keeps the first fact of a key and turns the repeat into a mention', () => {
    const result = run({ facts: [{ ...NAME_FACT }, { ...NAME_FACT, ref: 'f9' }] });
    expect(result.rejects).toEqual([]);
    expect(result.facts).toHaveLength(2);
    expect(result.facts.map((fact) => fact.role)).toEqual(['assert', 'mention']);
    expect(result.duplicates.facts).toBe(1);
    expect(result.duplicates.total).toBe(1);
  });

  it('keeps one edge of a triple', () => {
    const edge = { from: 'f2', to: 'f4', kind: 'absence' as const, quote: 'Сорокина больше нет' };
    const result = run({
      facts: [{ ...NAME_FACT }, { ref: 'f4', kind: 'absence', value: 'сорокин@больше нет', quote: 'Сорокина больше нет' }],
      edges: [edge, edge],
    });
    expect(result.edges).toHaveLength(1);
    expect(result.duplicates.edges).toBe(1);
  });
});

describe('threads move by the state machine', () => {
  const facts = [{ ...DOC_FACT }];

  it('advances an existing thread and stamps the chapter under extraction', () => {
    const result = run({
      facts,
      threads: [
        {
          label: 'дело 65/11877/арх',
          direction: 'forward',
          events: [{ chapter: 99, kind: 'advanced', fact: 'f1', quote: 'Номер 65/11877/арх', note: 'акт найден' }],
        },
      ],
    });
    expect(result.rejects).toEqual([]);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.threadId).toBe('thr_deal');
    expect(result.threads[0]?.state).toBe('advanced');
    expect(result.threads[0]?.events[0]?.chapter).toBe(5);
    expect(result.threads[0]?.events[0]?.factKey).toBe('document:65-11877-арх');
    expect(result.threads[0]?.events[0]?.note).toBe('акт найден');
  });

  it('refuses to move a closed thread', () => {
    const result = run({
      facts,
      threads: [{ label: 'закрытая линия', events: [{ kind: 'advanced', fact: 'f1', quote: 'Номер 65/11877/арх' }] }],
    });
    expect(result.threads).toEqual([]);
    expect(result.rejects.map((reject) => reject.code)).toEqual(['THREAD_TRANSITION_ILLEGAL']);
    expect(result.rejects[0]?.reason).toContain('closed');
  });

  it('refuses to open a thread that already exists', () => {
    const result = run({
      facts,
      threads: [{ label: 'дело 65/11877/арх', events: [{ kind: 'opened', fact: 'f1', quote: 'Номер 65/11877/арх' }] }],
    });
    expect(result.rejects.map((reject) => reject.code)).toEqual(['THREAD_TRANSITION_ILLEGAL']);
  });

  it('opens a new thread and reports it without an id', () => {
    const result = run({
      facts,
      threads: [{ label: 'живая линия', direction: 'backward', events: [{ kind: 'opened', fact: 'f1', quote: 'Номер 65/11877/арх' }] }],
    });
    expect(result.rejects).toEqual([]);
    expect(result.threads[0]).toMatchObject({ threadId: null, state: 'opened', direction: 'backward', role: 'thread' });
    expect(result.threads[0]?.key).toBe('thread:живая линия');
  });

  it('requires a new thread to open before it moves', () => {
    const result = run({
      facts,
      threads: [{ label: 'живая линия', events: [{ kind: 'advanced', fact: 'f1', quote: 'Номер 65/11877/арх' }] }],
    });
    expect(result.rejects.map((reject) => reject.code)).toEqual(['THREAD_TRANSITION_ILLEGAL']);
    expect(result.rejects[0]?.reason).toContain('opens');
  });

  it('rejects a thread event that is not a move', () => {
    const result = run({
      facts,
      threads: [{ label: 'живая линия', events: [{ kind: 'paused', fact: 'f1', quote: 'Номер 65/11877/арх' }] }],
    });
    expect(result.rejects.map((reject) => reject.code)).toEqual(['KIND_UNKNOWN']);
  });

  it('refuses a second opening and a move out of closed, inside one answer', () => {
    const twice = run({
      facts,
      threads: [
        {
          label: 'живая линия',
          events: [
            { kind: 'opened', fact: 'f1', quote: 'Номер 65/11877/арх' },
            { kind: 'opened', fact: 'f1', quote: 'Номер 65/11877/арх' },
          ],
        },
      ],
    });
    expect(twice.rejects.map((reject) => reject.code)).toEqual(['THREAD_TRANSITION_ILLEGAL']);
    expect(twice.rejects[0]?.reason).toContain('opened earlier');

    const reopened = run({
      facts,
      threads: [
        {
          label: 'живая линия',
          events: [
            { kind: 'opened', fact: 'f1', quote: 'Номер 65/11877/арх' },
            { kind: 'closed', fact: 'f1', quote: 'Номер 65/11877/арх' },
            { kind: 'advanced', fact: 'f1', quote: 'Номер 65/11877/арх' },
          ],
        },
      ],
    });
    expect(reopened.threads[0]?.state).toBe('closed');
    expect(reopened.rejects.map((reject) => reject.code)).toEqual(['THREAD_TRANSITION_ILLEGAL']);
  });

  it('rejects an event with no resolvable fact', () => {
    const result = run({
      facts,
      threads: [
        {
          label: 'живая линия',
          events: [
            { kind: 'opened', fact: 'f9', quote: 'Номер 65/11877/арх' },
            { kind: 'opened', note: 'ни на чём' },
          ],
        },
      ],
    });
    expect(result.rejects.map((reject) => reject.code)).toEqual([
      'THREAD_EVIDENCE_UNKNOWN',
      'THREAD_EVIDENCE_UNKNOWN',
    ]);
  });

  it('rejects an event whose quote is not in the chapter', () => {
    const result = run({
      facts,
      threads: [{ label: 'живая линия', events: [{ kind: 'opened', fact: 'f1', quote: 'Номер 65/11877/арх!' }] }],
    });
    expect(result.rejects.map((reject) => reject.code)).toEqual(['QUOTE_NOT_FOUND']);
  });
});

describe('a rejection is a record, not a shrug', () => {
  it('carries the item, the quote and the path for every reject', () => {
    const result = run({
      facts: [{ kind: 'date', value: '2065-13-40', quote: '14.09.2065' }],
      uses: [{ kind: 'document', value: '44/17', quote: 'Документ 77/1/арх' }],
      edges: [{ from: 'f9', to: 'f9', kind: 'document', quote: 'Номер 65/11877/арх' }],
      threads: [{ label: 'живая линия', events: [{ kind: 'opened', fact: 'f9' }] }],
    });
    expect(result.rejects).toHaveLength(4);
    for (const reject of result.rejects) {
      expect(typeof reject.item).toBe('object');
      expect(reject.item).not.toBeNull();
      expect(typeof reject.quote).toBe('string');
      expect(reject.reason.length).toBeGreaterThan(0);
      expect(reject.path).toMatch(/^(facts|uses|edges|threads)\[/u);
    }
    expect(result.rejects.map((reject) => reject.path)).toEqual([
      'facts[0]',
      'uses[0]',
      'edges[0]',
      'threads[0].events[0]',
    ]);
  });

  it('accepts an empty answer without a reject', () => {
    const result = run({});
    expect(result).toEqual({
      facts: [],
      uses: [],
      edges: [],
      threads: [],
      rejects: [],
      duplicates: { facts: 0, uses: 0, edges: 0, total: 0 },
    });
  });
});
