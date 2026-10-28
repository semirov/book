/**
 * Fixtures for the ripple's graph (BOOK-173): chapters with real blocks, so a mention can bind to
 * text that stands, and facts that say what the prose says. `seedChapter` is the ledger's own
 * helper — the block ids a mention names are the ids the applier would write, not invented ones.
 */

import type { Db } from '../../../src/db/db.ts';
import { assertDependency, type AssertDependencyInput, type EdgeRow } from '../../../src/ledger/graph/edges.ts';
import { AT, seedChapter, type SeededBlock } from '../helpers.ts';

export type GraphFixture = {
  db: Db;
  /** One chapter, one block per text; returns the blocks in order. */
  chapter: (n: number, texts: string[]) => SeededBlock[];
  /** A fact with its statement; `term` is what a mention binds to. */
  fact: (input: { id: string; chapter: number; statement: string; kind?: string; term?: string }) => string;
  /** A fact bound to a block: the witness is the block's text from `start` to `end`. */
  mention: (input: { factId: string; block: SeededBlock; chapter: number; start?: number; end?: number }) => void;
  edge: (input: AssertDependencyInput) => EdgeRow;
};

const KINDS = new Set(['document', 'decision', 'testimony', 'erasure', 'state']);

export function graphFixture(db: Db): GraphFixture {
  return {
    db,
    chapter: (n, texts) => seedChapter(db, { chapter: n, texts, at: AT }),
    fact: (input) => {
      const kind = input.kind ?? 'state';
      if (!KINDS.has(kind)) throw new Error(`unknown fact kind ${kind}`);
      db.prepare(
        `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, invalidated_at,
                            invalidated_by_change, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      ).run(input.id, input.chapter, kind, input.statement, input.term ?? null, input.chapter, AT);
      return input.id;
    },
    mention: (input) => {
      const text = input.block.text;
      const start = input.start ?? 0;
      const end = input.end ?? Array.from(text).length;
      db.prepare(
        `INSERT INTO mentions
           (span_id, block_id, chapter, start, end, kind, fact_id, thread_id, resolved_by_change,
            role, witness, edge_path)
         VALUES (?, ?, ?, ?, ?, 'fact', ?, NULL, NULL, 'assert', ?, '[]')`,
      ).run(`${input.block.uid}:1:0`, input.block.id, input.chapter, start, end, input.factId, Array.from(text).slice(start, end).join(''));
    },
    edge: (input) => assertDependency(db, input),
  };
}

/** The design's constructed fixture: a promise in ch05, its deadline restated in ch12. */
export function promiseFixture(db: Db, onComponent: 'value' | 'identity'): {
  fixture: GraphFixture;
  promise: string;
  deadline: string;
  edgeId: string;
} {
  const fixture = graphFixture(db);
  const ch05 = fixture.chapter(5, ['Я обещаю вернуть акт в тридцать дней.']);
  const ch12 = fixture.chapter(12, ['Долг в тридцать дней всё ещё висит над сменой.']);
  const promiseBlock = ch05[0];
  const deadlineBlock = ch12[0];
  if (promiseBlock === undefined || deadlineBlock === undefined) throw new Error('fixture did not seed a block');
  const promise = fixture.fact({
    id: 'f:p:обещание@ch05#aa',
    chapter: 5,
    kind: 'testimony',
    statement: 'Я обещаю вернуть акт в тридцать дней.',
    term: 'обещаю',
  });
  const deadline = fixture.fact({
    id: 'f:n:30@ch12#bb',
    chapter: 12,
    statement: 'Долг в тридцать дней всё ещё висит над сменой.',
    term: 'тридцать дней',
  });
  fixture.mention({ factId: promise, block: promiseBlock, chapter: 5 });
  fixture.mention({ factId: deadline, block: deadlineBlock, chapter: 12 });
  const edge = fixture.edge({
    from: promise,
    to: deadline,
    chapter: 12,
    kind: 'fulfils',
    onComponent,
    evidence: '«тридцать дней»: ch05 → ch12',
    origin: 'backfill',
    at: AT,
    id: 'edg_fixture_promise',
  });
  return { fixture, promise, deadline, edgeId: edge.id };
}
