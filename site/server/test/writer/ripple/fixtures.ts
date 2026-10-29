/**
 * The ripple's test graph, built over the writer harness (BOOK-173).
 *
 * The harness gives a real engine, a real database and a real manuscript; this file gives the
 * ledger part — facts, mentions and one edge each — on the blocks the ingest already wrote. The
 * graph is the design's own constructed fixture (§2.3) with the component a **patch** can move:
 * a document's status in ch05 («выдан» → «аннулирован»), whose consequence is restated in ch12 and
 * paid in ch19. A number cannot move here: the patch protocol refuses a changed digit, and a
 * rewrite is not a patch (BOOK-173 §2.6).
 */

import type { Db } from '../../../src/db/db.ts';
import { AT } from '../../ledger/helpers.ts';
import { createHarness, type Harness } from '../harness.ts';
import { inertParagraph } from '../inert.ts';

export type BlockRef = { id: string; text: string; hash: string; uid: string };

/** One block of a chapter as the ingest wrote it — the address a mention is bound to. */
export function blockOf(db: Db, chapter: number, idx = 0): BlockRef {
  const row = db
    .prepare('SELECT id, text, hash FROM blocks WHERE chapter = ? AND idx = ?')
    .get(chapter, idx) as { id: string; text: string; hash: string } | undefined;
  if (row === undefined) throw new Error(`no block ${String(idx)} in chapter ${String(chapter)}`);
  return { ...row, uid: `${row.id}:1` };
}

export type FactSeed = {
  id: string;
  chapter: number;
  kind?: 'document' | 'decision' | 'testimony' | 'erasure' | 'state';
  statement: string;
  term?: string;
  /** The block the claim is mentioned in; omitted = the chapter's first block. */
  block?: BlockRef;
  /**
   * The exact text the mention binds to, inside the block. Defaults to the whole block. A claim
   * that must survive a patch of its paragraph binds a *phrase* — that is what makes «still
   * asserted» a question about text rather than about a block id (BOOK-173 review, fix 4).
   */
  witness?: string;
};

export function seedFact(db: Db, input: FactSeed): string {
  const block = input.block ?? blockOf(db, input.chapter);
  const witness = input.witness ?? block.text;
  const at = Array.from(block.text.slice(0, block.text.indexOf(witness))).length;
  db.prepare(
    `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, invalidated_at,
                        invalidated_by_change, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(input.id, input.chapter, input.kind ?? 'state', input.statement, input.term ?? null, input.chapter, AT);
  db.prepare(
    `INSERT INTO mentions
       (span_id, block_id, chapter, start, end, kind, fact_id, thread_id, resolved_by_change,
        role, witness, edge_path)
     VALUES (?, ?, ?, ?, ?, 'fact', ?, NULL, NULL, 'assert', ?, '[]')`,
  ).run(
    `${block.uid}:${input.id}`,
    block.id,
    input.chapter,
    at,
    at + Array.from(witness).length,
    input.id,
    witness,
  );
  return input.id;
}

/** One dependency row of BOOK-185's graph — the table the closure walks. */
export function seedEdge(
  db: Db,
  input: { id: string; from: string; to: string; chapter: number; kind?: string },
): void {
  db.prepare(
    `INSERT INTO fact_dependency
       (id, "from", "to", chapter, kind, stance, statement, origin, step_id, rev, at)
     VALUES (?, ?, ?, ?, ?, 'plain', ?, 'registered', 'stp_fixture', 1, ?)`,
  ).run(
    input.id,
    input.from,
    input.to,
    input.chapter,
    input.kind ?? 'cause',
    `«выдан»: ch05 → ch${String(input.chapter)}`,
    AT,
  );
}

export type RippleGraph = {
  seed: string;
  deadline: string;
  payment: string;
  /** Extra consequences, each in its own chapter: how a test walks the character bound. */
  extra: string[];
};

/**
 * The graph a status patch in ch05 walks: the document's state (ch05), its restatement (ch12) and
 * its payment (ch19), each on a `status` hop, plus a live irreversible fact in every consequence
 * chapter — the S6 marker the verification reads (§5).
 */
export function rippleGraph(
  harness: Harness,
  extra: Array<{ id: string; chapter: number; statement: string }> = [],
): RippleGraph {
  const db = harness.fixture.db;
  // The origin's own irreversible fact, in a block the patch never touches: a chapter that
  // changed and holds no decision is a chapter the book can no longer point at (§5).
  seedFact(db, { id: 'f:d:решение@ch05', chapter: 5, kind: 'decision', statement: 'Решено: смена идёт.', block: blockOf(db, 5, 3) });
  const seed = seedFact(db, {
    id: 'f:d:допуск@ch05#status',
    chapter: 5,
    kind: 'document',
    statement: 'Допуск выдан Ковалёву на руки.',
    term: 'допуск',
    block: blockOf(db, 5, 1),
  });
  const deadline = seedFact(db, {
    id: 'f:d:допуск@ch12#status',
    chapter: 12,
    kind: 'document',
    statement: 'Допуск всё ещё выдан, и смена стоит.',
    term: 'допуск',
    block: blockOf(db, 12, 0),
    // A phrase, not the whole paragraph: a patch of this block that keeps the claim must not
    // unassert the fact (BOOK-173 review, fix 4 — the mention follows the text, not the id).
    witness: 'Допуск всё ещё выдан',
  });
  const payment = seedFact(db, {
    id: 'f:d:допуск@ch19#status',
    chapter: 19,
    kind: 'document',
    statement: 'По выданному допуску платят в конце смены.',
    block: blockOf(db, 19, 0),
  });
  seedEdge(db, { id: 'edg_doc_12', from: seed, to: deadline, chapter: 12 });
  seedEdge(db, { id: 'edg_doc_19', from: seed, to: payment, chapter: 19 });
  seedFact(db, { id: 'f:d:акт@ch12', chapter: 12, kind: 'document', statement: 'Акт подписан.', block: blockOf(db, 12, 2) });
  seedFact(db, { id: 'f:d:акт@ch19', chapter: 19, kind: 'document', statement: 'Акт изъят из дела.', block: blockOf(db, 19, 2) });
  const extras: string[] = [];
  for (const one of extra) {
    extras.push(
      seedFact(db, { id: one.id, chapter: one.chapter, statement: one.statement, block: blockOf(db, one.chapter, 1) }),
    );
    seedEdge(db, { id: `edg_extra_${one.id}`, from: seed, to: one.id, chapter: one.chapter });
  }
  return { seed, deadline, payment, extra: extras };
}

/**
 * Retire a repaired fact the way a real repair does: the claim leaves the book. The dependency rows
 * stay as history (BOOK-185 retires, never deletes) — the closure drops them because one of their
 * ends is no longer a live fact.
 */
export function retire(db: Db, factIds: readonly string[], changeId: string): void {
  const at = new Date().toISOString();
  for (const factId of factIds) {
    db.prepare('DELETE FROM mentions WHERE fact_id = ?').run(factId);
    db.prepare('UPDATE facts SET invalidated_at = ?, invalidated_by_change = ? WHERE id = ?').run(at, changeId, factId);
  }
}

function para(marker: string, chars = 600): string {
  return inertParagraph(marker, chars);
}

/** A chapter's file: a title line, then the paragraphs. */
export function chapterOf(title: string, blocks: string[]): string {
  return `${title}\n\n${blocks.join('\n\n')}\n`;
}

/** ch05 carries the status the patch moves; ch12 and ch19 restate and pay it. */
export const ORIGIN = 5;
export const CONSEQUENCES = [12, 19] as const;

export function chaptersFixture(extra: number[] = []): Record<number, string> {
  const chapters: Record<number, string> = {
    [ORIGIN]: chapterOf('Глава пятая', [
      para('Первый абзац пятой главы.'),
      para('Допуск выдан Ковалёву на руки.'),
      para('Третий абзац пятой главы.'),
      para('Четвёртый абзац пятой главы.'),
    ]),
    12: chapterOf('Глава двенадцатая', [
      para('Допуск всё ещё выдан, и смена стоит.'),
      para('Второй абзац двенадцатой главы.'),
      para('Акт подписан вчера.'),
      para('Четвёртый абзац двенадцатой главы.'),
    ]),
    19: chapterOf('Глава девятнадцатая', [
      para('По выданному допуску платят в конце смены.'),
      para('Второй абзац девятнадцатой главы.'),
      para('Акт изъят из дела.'),
      para('Четвёртый абзац девятнадцатой главы.'),
    ]),
  };
  for (const chapter of extra) {
    chapters[chapter] = chapterOf(`Глава ${String(chapter)}`, [
      para('Первый абзац.'),
      para('Второй абзац, он стоит на допуске.'),
      para('Третий абзац.'),
      para('Четвёртый абзац.'),
    ]);
  }
  return chapters;
}

/** A harness with the three chapters written and published, plus a phrase-scope filing on ch05. */
export async function rippleHarness(extra: number[] = []): Promise<Harness> {
  const harness = await createHarness({ chapters: chaptersFixture(extra) });
  for (const chapter of [ORIGIN, ...CONSEQUENCES, ...extra]) harness.ingest(chapter);
  harness.fixture.engine.enqueue({
    kind: 'operator',
    chapter: ORIGIN,
    intent: 'в главе 5 допуск отзывают',
    scopeHint: 'phrase',
  });
  return harness;
}

/** The patch the scripted model returns for ch05: one word, the document's state. */
export function statusPatch(harness: Harness): string {
  const block = blockOf(harness.fixture.db, ORIGIN, 1);
  return JSON.stringify({
    mode: 'patch',
    edits: [{ blockId: block.id, oldText: 'выдан', newText: 'аннулирован' }],
    facts: [],
    note: 'status moved',
  });
}
