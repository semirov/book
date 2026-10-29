/**
 * The write half of the extraction (BOOK-185, BOOK-DOC-77 §5), judged at its own seam.
 *
 * `persistExtraction` is handed an answer the validator already accepted; these tests ask what a
 * run does to the rows already there — an id that survives a re-run, a key that is retired instead
 * of deleted, a thread whose state is the replay of its events, a chapter whose text moved under
 * the answer. The orchestrator around it is `extract.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { closure } from '../../src/graph/closure.ts';
import { threadHintsOf } from '../../src/graph/extract.ts';
import { FrameChangedError, persistExtraction, type PersistResult } from '../../src/graph/persist.ts';
import { idOf } from '../../src/graph/text.ts';
import type { LooseAnswer } from '../../src/graph/schema.ts';
import {
  validateAnswer,
  type Block,
  type EstablishedFact,
  type ThreadHint,
  type ValidateResult,
} from '../../src/graph/validate.ts';
import { factAsOf } from '../../src/ledger/facts.ts';
import { findLiterals } from '../../src/ledger/mentions.ts';
import { ledgerFixture, seedChapter, type LedgerFixture, type SeededBlock } from '../ledger/helpers.ts';
import { ANSWER_CH1, ANSWER_CH2, ANSWER_CH2_NARROWED, AT, AT_LATER, CH1, CH2 } from './extractFixture.ts';

let fixture: LedgerFixture;

afterEach(() => {
  fixture.close();
});

function rows(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return fixture.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

/** `unknown` from a row, read as text, without a cast at every call site. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function count(table: string): number {
  return (fixture.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Two chapters, in reading order, with chapter 1's paper already in the ledger. */
function seed(): { ch1: SeededBlock[]; ch2: SeededBlock[] } {
  fixture = ledgerFixture();
  const ch1 = seedChapter(fixture.db, { chapter: 1, texts: CH1 });
  const ch2 = seedChapter(fixture.db, { chapter: 2, texts: CH2 });
  return { ch1, ch2 };
}

function blocksOf(seeded: SeededBlock[]): Block[] {
  return seeded.map((block) => ({ id: block.id, text: block.text }));
}

/** What `extract.ts` retrieves before the validator runs, without its relevance filter. */
function lists(db: LedgerFixture['db'], chapter: number): { established: EstablishedFact[]; threads: ThreadHint[] } {
  const established = db
    .prepare(
      `SELECT id, key, kind, chapter, term FROM facts
        WHERE chapter < ? AND invalidated_at IS NULL AND superseded_by_extraction IS NULL AND key <> ''
        ORDER BY chapter, key`,
    )
    .all(chapter) as EstablishedFact[];
  // The same hint the orchestrator gives the validator: the state as of chapter N-1.
  return { established, threads: threadHintsOf(db, chapter) };
}

function validated(db: LedgerFixture['db'], chapter: number, blocks: Block[], answer: unknown): ValidateResult {
  const { established, threads } = lists(db, chapter);
  return validateAnswer({ chapter, blocks, established, threads, answer: answer as LooseAnswer });
}

function persist(
  chapter: number,
  runId: string,
  blocks: Block[],
  answer: unknown,
  over: { at?: string; textSha?: string; rev?: number } = {},
): PersistResult {
  const row = fixture.db.prepare('SELECT rev, sha256 FROM chapters WHERE n = ?').get(chapter) as {
    rev: number;
    sha256: string;
  };
  // The run row exists before the rows that name it: `superseded_by_extraction` and
  // `retired_by_run` are foreign keys. `prompt_sha` is the run id, so a test can seed several
  // runs for one chapter without colliding with the question index.
  fixture.db
    .prepare(
      `INSERT INTO extraction_runs (id, chapter, rev, text_sha, prompt_sha, model, pass, at, status)
       VALUES (?, ?, ?, 'sha-text', ?, 'deepseek-flash', 'extract', ?, 'ok')`,
    )
    .run(runId, chapter, row.rev, runId, over.at ?? AT);
  const result = validated(fixture.db, chapter, blocks, answer);
  return persistExtraction(fixture.db, {
    chapter,
    rev: over.rev ?? row.rev,
    textSha: over.textSha ?? row.sha256,
    run: { id: runId, model: 'deepseek-flash', promptSha: 'sha-prompt', at: over.at ?? AT, pass: 'extract' },
    blocks,
    answer: result,
  });
}

describe('a re-run is the same rows', () => {
  it('derives the ids from the evidence and keeps them across runs', () => {
    const { ch1, ch2 } = seed();
    persist(1, 'run_a', blocksOf(ch1), ANSWER_CH1);
    const first = persist(2, 'run_b', blocksOf(ch2), ANSWER_CH2);
    expect(first).toMatchObject({ facts: 2, uses: 1, mentions: 3, literals: 3, edges: 1, threads: 1 });

    const ids = rows('SELECT id, key FROM facts ORDER BY key');
    expect(ids.map((row) => row.id)).toEqual([
      idOf('fct', 'date:2065-09-14'),
      idOf('fct', 'document:65-11877-арх'),
      idOf('fct', 'document:77-1-арх'),
    ]);
    expect(rows('SELECT id FROM fact_dependency')).toEqual([
      { id: idOf('dep', `${idOf('fct', 'document:77-1-арх')}|${idOf('fct', 'document:65-11877-арх')}|document|2`) },
    ]);
    expect(rows('SELECT id FROM threads')).toEqual([{ id: idOf('thr', 'дело 65/11877/арх') }]);

    const before = rows('SELECT * FROM facts ORDER BY id').map((row) => row.id);
    persist(2, 'run_c', blocksOf(ch2), ANSWER_CH2);
    // The same chapter, the same answer, another run: no new fact, no doubled mention, no second
    // edge, and the thread's two events are replaced rather than appended.
    expect(rows('SELECT id FROM facts ORDER BY id').map((row) => row.id)).toEqual(before);
    expect(count('mentions')).toBe(4);
    expect(count('fact_dependency')).toBe(1);
    expect(count('threads')).toBe(1);
    expect(count('thread_events')).toBe(2);
    expect(count('literals')).toBe(4);
    // The newest run owns the rows it rewrote.
    expect(textOf((rows('SELECT extracted_by FROM facts ORDER BY id')[0] ?? {}).extracted_by)).toContain('run_c');
  });

  it('indexes every literal of the live text, once', () => {
    const { ch1, ch2 } = seed();
    persist(1, 'run_a', blocksOf(ch1), ANSWER_CH1);
    persist(2, 'run_b', blocksOf(ch2), ANSWER_CH2);
    const expected = blocksOf(ch2).flatMap((block) => findLiterals(block.text));
    expect(count('literals')).toBe(expected.length + findLiterals(CH1[0] ?? '').length);
  });
});

describe('supersede, never delete', () => {
  it('retires the fact and the edge a narrower answer drops, and the graph stops seeing them', () => {
    const { ch1, ch2 } = seed();
    persist(1, 'run_a', blocksOf(ch1), ANSWER_CH1);
    persist(2, 'run_b', blocksOf(ch2), ANSWER_CH2);
    const documentId = idOf('fct', 'document:77-1-арх');
    const dateId = idOf('fct', 'date:2065-09-14');
    expect(factAsOf(fixture.db, 3).map((fact) => fact.id)).toContain(documentId);

    const narrowed = persist(2, 'run_c', blocksOf(ch2), ANSWER_CH2_NARROWED, { at: AT_LATER });
    expect(narrowed.supersededFacts).toEqual([documentId]);
    expect(narrowed.retiredEdges).toEqual([rows('SELECT id FROM fact_dependency')[0]?.id]);

    // The row is history: still there, marked, and not the graph.
    expect(rows('SELECT invalidated_at, superseded_by_extraction FROM facts WHERE id = ?', documentId)).toEqual([
      { invalidated_at: AT_LATER, superseded_by_extraction: 'run_c' },
    ]);
    expect(factAsOf(fixture.db, 3).map((fact) => fact.key)).toEqual([
      'document:65-11877-арх',
      'date:2065-09-14',
    ]);
    expect(rows('SELECT retired_by_run FROM fact_dependency')[0]).toEqual({ retired_by_run: 'run_c' });
    expect(closure(fixture.db, [dateId]).edges).toEqual([]);
  });

  it('revives a key the answer states again, keeping its id', () => {
    const { ch1, ch2 } = seed();
    persist(1, 'run_a', blocksOf(ch1), ANSWER_CH1);
    persist(2, 'run_b', blocksOf(ch2), ANSWER_CH2);
    const documentId = idOf('fct', 'document:77-1-арх');
    persist(2, 'run_c', blocksOf(ch2), ANSWER_CH2_NARROWED, { at: AT_LATER });

    persist(2, 'run_d', blocksOf(ch2), ANSWER_CH2, { at: AT_LATER });
    expect(rows('SELECT id, invalidated_at, superseded_by_extraction FROM facts WHERE key = ?', 'document:77-1-арх')).toEqual([
      { id: documentId, invalidated_at: null, superseded_by_extraction: null },
    ]);
    expect(count('facts')).toBe(3);
  });
});

describe('a thread is the replay of its events', () => {
  it('moves with a later chapter and falls back when that chapter no longer says it', () => {
    const { ch1, ch2 } = seed();
    persist(1, 'run_a', blocksOf(ch1), ANSWER_CH1);
    persist(2, 'run_b', blocksOf(ch2), ANSWER_CH2);
    expect(rows('SELECT state, opened_at_chapter, closed_at_chapter FROM threads')).toEqual([
      { state: 'advanced', opened_at_chapter: 2, closed_at_chapter: null },
    ]);

    // A second chapter whose answer does not name the thread: its events there go, the thread is
    // left with chapter 1's... which it never had, so the thread itself is gone.
    persist(2, 'run_c', blocksOf(ch2), ANSWER_CH2_NARROWED);
    expect(count('threads')).toBe(0);
  });

  it('recomputes a thread whose chapter stopped naming it, and keeps what other chapters said', () => {
    const { ch1, ch2 } = seed();
    persist(1, 'run_a', blocksOf(ch1), {
      ...ANSWER_CH1,
      threads: [{ label: 'дело 65/11877/арх', direction: 'forward', events: [{ kind: 'opened', fact: 'f1' }] }],
    });
    persist(2, 'run_b', blocksOf(ch2), ANSWER_CH2);
    expect(rows('SELECT state, opened_at_chapter FROM threads')).toEqual([{ state: 'advanced', opened_at_chapter: 1 }]);

    // The chapter 2 answer no longer names the thread: its move there goes, chapter 1 still stands.
    persist(2, 'run_c', blocksOf(ch2), ANSWER_CH2_NARROWED);
    expect(rows('SELECT state, opened_at_chapter, closed_at_chapter FROM threads')).toEqual([
      { state: 'opened', opened_at_chapter: 1, closed_at_chapter: null },
    ]);
    expect(rows('SELECT chapter, kind FROM thread_events')).toEqual([{ chapter: 1, kind: 'opened' }]);
  });

  it('replays a closed thread as closed and keeps the chapter that closed it', () => {
    fixture = ledgerFixture();
    const ch1 = seedChapter(fixture.db, { chapter: 1, texts: CH1 });
    const ch2 = seedChapter(fixture.db, { chapter: 2, texts: CH2 });
    const ch3 = seedChapter(fixture.db, { chapter: 3, texts: CH2 });
    persist(1, 'run_a', blocksOf(ch1), {
      ...ANSWER_CH1,
      threads: [{ label: 'дело 65/11877/арх', direction: 'forward', events: [{ kind: 'opened', fact: 'f1' }] }],
    });
    persist(2, 'run_b', blocksOf(ch2), {
      facts: [{ ref: 'f1', kind: 'date', value: '14.09.2065', term: '14.09.2065', quote: '14.09.2065' }],
      uses: [],
      edges: [],
      threads: [{ label: 'дело 65/11877/арх', direction: 'forward', events: [{ kind: 'closed', fact: 'f1' }] }],
    });
    expect(rows('SELECT state, opened_at_chapter, closed_at_chapter FROM threads')).toEqual([
      { state: 'closed', opened_at_chapter: 1, closed_at_chapter: 2 },
    ]);

    // A third chapter that says nothing about the thread leaves it exactly as it was.
    persist(3, 'run_c', blocksOf(ch3), { facts: [], uses: [], edges: [], threads: [] });
    expect(rows('SELECT state, closed_at_chapter FROM threads')).toEqual([{ state: 'closed', closed_at_chapter: 2 }]);
    expect(rows('SELECT thread_id, chapter, kind FROM thread_events ORDER BY chapter')).toEqual([
      { thread_id: idOf('thr', 'дело 65/11877/арх'), chapter: 1, kind: 'opened' },
      { thread_id: idOf('thr', 'дело 65/11877/арх'), chapter: 2, kind: 'closed' },
    ]);
  });
});

describe('mentions', () => {
  it('binds the span of the block_versions chain when there is one', () => {
    const { ch1, ch2 } = seed();
    persist(1, 'run_a', blocksOf(ch1), ANSWER_CH1);
    const block = ch2[0] as SeededBlock;
    fixture.db
      .prepare(`UPDATE block_versions SET spans = ? WHERE block_id = ?`)
      .run(JSON.stringify([{ span_id: 'spn_real' }]), block.id);
    persist(2, 'run_b', blocksOf(ch2), ANSWER_CH2);
    const mentions = rows('SELECT block_id, span_id FROM mentions WHERE chapter = 2 ORDER BY start');
    expect(mentions.filter((row) => row.block_id === block.id).map((row) => row.span_id)).toEqual(['spn_real']);
    // The blocks without a span still name the run and their index.
    expect(mentions.some((row) => String(row.span_id).startsWith('ext:run_b:'))).toBe(true);
  });

  it('keeps one mention per stretch of text and leaves another writer\'s rows alone', () => {
    const { ch1, ch2 } = seed();
    persist(1, 'run_a', blocksOf(ch1), ANSWER_CH1);
    const block = ch2[0] as SeededBlock;
    fixture.db
      .prepare(
        `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, resolved_by_change, role, witness, edge_path)
         VALUES ('patch:1', ?, 2, 0, 3, 'date', NULL, NULL, NULL, 'Акт', '[]')`,
      )
      .run(block.id);

    // A date and a document read off the same stretch of text: one mention, two facts.
    const result = persist(2, 'run_b', blocksOf(ch2), {
      facts: [
        { ref: 'f1', kind: 'date', value: '14.09.2065', term: '14.09.2065', quote: '14.09.2065' },
        { ref: 'f2', kind: 'document', value: '14.09.2065', term: '14.09.2065', quote: '14.09.2065' },
      ],
      uses: [],
      edges: [],
      threads: [],
    });
    expect(result.facts).toBe(2);
    // Chapter 1's mention, the author's date mention, and one fact mention for the two facts that
    // were read off the same stretch of text.
    expect(rows('SELECT kind, chapter FROM mentions ORDER BY id')).toEqual([
      { kind: 'fact', chapter: 1 },
      { kind: 'date', chapter: 2 },
      { kind: 'fact', chapter: 2 },
    ]);
  });
});

describe('the role of a mention follows the row it is bound to', () => {
  it('calls an assertion of an earlier chapter a use, whatever the validator thought', () => {
    const { ch1, ch2 } = seed();
    persist(1, 'run_a', blocksOf(ch1), ANSWER_CH1);
    const row = fixture.db.prepare('SELECT rev, sha256 FROM chapters WHERE n = 2').get() as {
      rev: number;
      sha256: string;
    };
    fixture.db
      .prepare(
        `INSERT INTO extraction_runs (id, chapter, rev, text_sha, prompt_sha, model, pass, at, status)
         VALUES ('run_blind', 2, ?, 'sha-text', 'run_blind', 'deepseek-flash', 'extract', ?, 'ok')`,
      )
      .run(row.rev, AT);
    // A validator that never saw chapter 1's row calls the same key an assert: the write is the
    // place that knows the row exists, and the mention must not claim this chapter established it.
    const blind: ValidateResult = {
      facts: [
        {
          blockId: ch2[2]?.id ?? '',
          start: 0,
          end: 18,
          witness: 'Дело 65/11877/арх',
          sentence: 'Дело 65/11877/арх ведёт Сорокин.',
          statement: 'Дело 65/11877/арх ведёт Сорокин.',
          key: 'document:65-11877-арх',
          kind: 'document',
          value: '65/11877/арх',
          term: null,
          chapter: 2,
          role: 'assert',
          factId: null,
          factChapter: null,
          ref: null,
        },
      ],
      uses: [],
      edges: [],
      threads: [],
      rejects: [],
      duplicates: { facts: 0, uses: 0, edges: 0, total: 0 },
    };
    const result = persistExtraction(fixture.db, {
      chapter: 2,
      rev: row.rev,
      textSha: row.sha256,
      run: { id: 'run_blind', model: 'deepseek-flash', promptSha: 'sha-prompt', at: AT, pass: 'extract' },
      blocks: blocksOf(ch2),
      answer: blind,
    });
    expect(result.uses).toBe(1);
    expect(rows(`SELECT chapter FROM facts WHERE key = 'document:65-11877-арх'`)).toEqual([{ chapter: 1 }]);
    expect(rows(`SELECT role FROM mentions WHERE chapter = 2 AND kind = 'fact'`)).toEqual([{ role: 'use' }]);
  });
});

describe('FRAME_CHANGED', () => {
  it('refuses the whole answer when the chapter is not the one that was read', () => {
    const { ch1, ch2 } = seed();
    persist(1, 'run_a', blocksOf(ch1), ANSWER_CH1);
    const before = count('facts');
    expect(() => persist(2, 'run_b', blocksOf(ch2), ANSWER_CH2, { textSha: 'sha-of-another-revision' })).toThrow(
      FrameChangedError,
    );
    expect(count('facts')).toBe(before);
    expect(count('mentions')).toBe(1);
    expect(count('literals')).toBe(1);
    expect(count('fact_dependency')).toBe(0);
  });
});

