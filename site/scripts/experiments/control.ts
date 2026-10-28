/**
 * The control run: a promise that is actually kept somewhere else (`--control`).
 *
 * The three real filings return `local` — two of them cannot even seed, because the paragraph they
 * name holds no extracted fact. That is the honest state of the graph, and it proves nothing about
 * the ripple. So the experiment seeds the design's own unit-test fixture over the **real** chapters:
 *
 *   · the promise — ch05, «Это ещё тридцать рабочих дней.» (the deadline a clerk set);
 *   · the fulfilment — ch12, «Срок исполнения — 30 календарных дней» (a different unit, the same
 *     thirty days), reached by one `fulfils` edge on the `value` component;
 *   · the filing — the same promise moved to forty-five working days.
 *
 * A number change is a `value` move, so the node in ch12 is mandatory and the ripple has one
 * chapter to patch. Both texts are the manuscript's own, so the patcher reads what the writer
 * reads, and the run costs two patch calls plus two gate pairs.
 *
 * The wide fixture (`wideFixture`) is the same idea at the size a wide plan needs: six mandatory
 * nodes over six real chapters, with the money bound deliberately below the projection — the plan
 * says `wide` for the reason the design gives, and C prices it from one measured rewrite.
 */

import type { Db } from '../../server/src/db/db.ts';
import { assertDependency } from '../../server/src/ledger/graph/edges.ts';
import { chapterTextOf } from './ledger.ts';
import { parseChapter } from '../../server/src/ingest/parseChapter.ts';
import type { Filing } from './spec.ts';

const AT = '2026-10-28T12:00:00Z';

/**
 * The promise ch05 makes and the deadline ch12 restates — both real substrings of the manuscript.
 * The promise is a **date**, because a ripple is moved by a component and a spelled-out number is
 * not one: `movedComponents` compares digits, so «14.12.2065» → «21.12.2065» is a `value` move and
 * «тридцать» → «сорок пять» would be no move at all.
 */
const PROMISE = '14.12.2065';
const PROMISE_AFTER = '21.12.2065';
const DEADLINE = '30 календарных дней';

export type ControlFixture = {
  filing: Filing;
  promiseFact: string;
  deadlineFact: string;
  edgeId: string;
  /** The origin chapter and the chapter the ripple must reach. */
  chapters: number[];
  /** The promise as the manuscript states it, and as the filing moves it. */
  promise: string;
  promisedAfter: string;
  before: string;
  after: string;
};

function blockWith(bookRoot: string, chapter: number, needle: string): { id: string; text: string; start: number } {
  const parsed = parseChapter(chapter, chapterTextOf(bookRoot, chapter));
  for (const block of parsed.blocks) {
    const at = block.text.indexOf(needle);
    if (at !== -1) return { id: block.id, text: block.text, start: [...block.text.slice(0, at)].length };
  }
  throw new Error(`control: «${needle}» is not in chapter ${String(chapter)}`);
}

function insertFact(db: Db, input: { id: string; chapter: number; kind: string; statement: string; term: string }): void {
  db.prepare(
    `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, invalidated_at,
                        invalidated_by_change, created_at)
     VALUES (@id, @chapter, @kind, @statement, @term, @chapter, NULL, NULL, @at)`,
  ).run({ ...input, at: AT });
}

function insertMention(db: Db, input: { factId: string; blockId: string; chapter: number; start: number; end: number; witness: string }): void {
  db.prepare(
    `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, thread_id,
                           resolved_by_change, role, witness, edge_path)
     VALUES (@spanId, @blockId, @chapter, @start, @end, 'fact', @factId, NULL, NULL, 'assert', @witness, '[]')`,
  ).run({
    spanId: `${input.blockId}:1:0`,
    blockId: input.blockId,
    chapter: input.chapter,
    start: input.start,
    end: input.end,
    factId: input.factId,
    witness: input.witness,
  });
}

/**
 * The seeded fixture, once per ledger: the facts are keyed by id, so a second seed in the same
 * `main()` (ab, then cache) would be the same row twice.
 */
const seeded = new WeakMap<Db, ControlFixture>();

/**
 * Seed the promise/deadline pair over the real text. Nothing here is a model's reading: two
 * witnesses copied from the blocks, one edge with the component the target consumes, and one
 * filing whose intent is a number.
 */
export function controlFixture(db: Db, bookRoot: string): ControlFixture {
  const known = seeded.get(db);
  if (known !== undefined) return known;
  const promiseBlock = blockWith(bookRoot, 5, PROMISE);
  const deadlineBlock = blockWith(bookRoot, 12, DEADLINE);
  const promiseFact = `f:c:promise@${promiseBlock.id}`;
  const deadlineFact = `f:c:30@${deadlineBlock.id}`;

  insertFact(db, {
    id: promiseFact,
    chapter: 5,
    kind: 'testimony',
    statement: `Обжалование — до ${PROMISE} включительно.`,
    term: PROMISE,
  });
  insertMention(db, {
    factId: promiseFact,
    blockId: promiseBlock.id,
    chapter: 5,
    start: promiseBlock.start,
    end: promiseBlock.start + PROMISE.length,
    witness: PROMISE,
  });
  insertFact(db, { id: deadlineFact, chapter: 12, kind: 'state', statement: `Срок исполнения — ${DEADLINE}.`, term: DEADLINE });
  insertMention(db, {
    factId: deadlineFact,
    blockId: deadlineBlock.id,
    chapter: 12,
    start: deadlineBlock.start,
    end: deadlineBlock.start + DEADLINE.length,
    witness: DEADLINE,
  });
  const edge = assertDependency(db, {
    from: promiseFact,
    to: deadlineFact,
    chapter: 12,
    kind: 'fulfils',
    onComponent: 'value',
    evidence: `«${PROMISE}» ch05 → «${DEADLINE}» ch12`,
    origin: 'owner',
    at: AT,
    id: 'edg_ctl_promise_deadline',
  });

  const before = chapterTextOf(bookRoot, 5);
  const built: ControlFixture = {
    filing: {
      label: 'ctl05',
      chapter: 5,
      id: 'ctl_promise',
      kind: 'operator',
      scopeHint: 'phrase',
      intent: `Обжалование — до ${PROMISE_AFTER} включительно: обещанный срок сдвинут.`,
      proposedText: null,
      anchor: { blockIds: [promiseBlock.id], quote: PROMISE },
    },
    promiseFact,
    deadlineFact,
    edgeId: edge.id,
    chapters: [5, 12],
    promise: PROMISE,
    promisedAfter: PROMISE_AFTER,
    before,
    after: before.replace(PROMISE, PROMISE_AFTER),
  };
  seeded.set(db, built);
  return built;
}

export type WideFixture = {
  filing: Filing;
  promiseFact: string;
  chapters: number[];
  before: string;
  after: string;
  bounds: { usd: number; estimatedUsd: number };
};

/** Six real chapters, six mandatory nodes, and a money bound the plan cannot satisfy. */
const WIDE_CHAPTERS = [7, 8, 10, 11, 13, 14] as const;

export function wideFixture(db: Db, bookRoot: string, seeded?: ControlFixture): WideFixture {
  // The fixture is seeded once: the facts are keyed by id, and a second seed is the same row.
  const control = seeded ?? controlFixture(db, bookRoot);
  const chapters: number[] = [5];
  WIDE_CHAPTERS.forEach((chapter, index) => {
    const parsed = parseChapter(chapter, chapterTextOf(bookRoot, chapter));
    const block = parsed.blocks.find((entry) => entry.text.trim().length > 60) ?? parsed.blocks[0];
    if (block === undefined) return;
    const witness = block.text.trim().slice(0, 40);
    const start = [...block.text.slice(0, block.text.indexOf(witness))].length;
    const factId = `f:c:wide${String(index)}@${block.id}`;
    insertFact(db, { id: factId, chapter, kind: 'state', statement: witness, term: witness.slice(0, 20) });
    insertMention(db, {
      factId,
      blockId: block.id,
      chapter,
      start,
      end: start + witness.length,
      witness,
    });
    assertDependency(db, {
      from: control.promiseFact,
      to: factId,
      chapter,
      kind: 'follows',
      onComponent: 'value',
      evidence: `control: «${witness.slice(0, 30)}…»`,
      origin: 'owner',
      at: AT,
      id: `edg_ctl_wide${String(index)}`,
    });
    chapters.push(chapter);
  });
  return {
    filing: control.filing,
    promiseFact: control.promiseFact,
    chapters,
    before: control.before,
    after: control.after,
    // The projection the harness prints is above the design's own money bound (0.6): `wide`.
    bounds: { usd: 0.5, estimatedUsd: 5.6 },
  };
}
