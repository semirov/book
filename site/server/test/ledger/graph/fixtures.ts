/**
 * Fixtures for the ripple's graph (BOOK-173): chapters with real blocks, so a mention can bind to
 * text that stands, and facts that say what the prose says. `seedChapter` is the ledger's own
 * helper — the block ids a mention names are the ids the applier would write, not invented ones.
 *
 * The edges are BOOK-185's: rows of `fact_dependency`, written with the columns the extractor
 * writes, because the closure the plan reads is that table and no other.
 */

import type { Db } from '../../../src/db/db.ts';
import { AT, seedChapter, type SeededBlock } from '../helpers.ts';

/** ADR-040 §2.1: the five claims one fact can be the reason for another. */
export type DependencyKind = 'cause' | 'promise' | 'document' | 'absence' | 'decision';

export type DependencyRow = {
  id: string;
  from: string;
  to: string;
  chapter: number;
  kind: DependencyKind;
  statement: string;
  origin: 'registered' | 'inferred';
};

export type DependencyInput = {
  id?: string;
  from: string;
  to: string;
  chapter: number;
  kind?: DependencyKind;
  statement?: string;
  origin?: 'registered' | 'inferred';
  stepId?: string;
  rev?: number;
  at?: string;
};

export type GraphFixture = {
  db: Db;
  /** One chapter, one block per text; returns the blocks in order. */
  chapter: (n: number, texts: string[]) => SeededBlock[];
  /** A fact with its statement; `term` is what a mention binds to. */
  fact: (input: { id: string; chapter: number; statement: string; kind?: string; term?: string }) => string;
  /** A fact bound to a block: the witness is the block's text from `start` to `end`. */
  mention: (input: { factId: string; block: SeededBlock; chapter: number; start?: number; end?: number }) => void;
  edge: (input: DependencyInput) => DependencyRow;
};

const KINDS = new Set(['document', 'date', 'name', 'term', 'promise', 'decision', 'absence', 'testimony', 'erasure', 'state']);

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
    edge: (input) => {
      const id = input.id ?? `dep_${String(input.from)}_${String(input.to)}_${String(input.chapter)}`;
      db.prepare(
        `INSERT INTO fact_dependency
           (id, "from", "to", chapter, kind, stance, line, statement, origin, step_id, rev, at, extracted_by)
         VALUES (?, ?, ?, ?, ?, 'plain', NULL, ?, ?, ?, ?, ?, '')`,
      ).run(
        id,
        input.from,
        input.to,
        input.chapter,
        input.kind ?? 'cause',
        input.statement ?? 'служебная зависимость',
        input.origin ?? 'registered',
        input.stepId ?? 'stp_fixture',
        input.rev ?? 1,
        input.at ?? AT,
      );
      const row = db.prepare(`SELECT id, "from" AS "from", "to" AS "to", chapter, kind, statement, origin FROM fact_dependency WHERE id = ?`).get(id) as DependencyRow;
      return row;
    },
  };
}

/** The design's constructed fixture: a promise in ch05, its deadline restated in ch12. */
export function promiseFixture(db: Db): {
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
    id: 'dep_fixture_promise',
    from: promise,
    to: deadline,
    chapter: 12,
    kind: 'promise',
    statement: '«тридцать дней»: ch05 → ch12',
    at: AT,
  });
  return { fixture, promise, deadline, edgeId: edge.id };
}
