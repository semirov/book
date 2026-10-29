/**
 * BOOK-202 — chapter 1 survives the launch reset (owner, 2026-10-29: «Мы сохраним первую главу»).
 *
 * The reset still empties the book's content and progress; the one exception is ch01: its
 * `chapters` row, its blocks, its revisions, its block versions and lineage, its live sentences
 * and its own corner of the graph are read before the wipe and left exactly as they were. Every
 * wipe predicate is therefore the **negation of a keep rule**, declared once in this module:
 * `counts.ts` counts with it and `book.ts` deletes with it, so the dry run cannot report one
 * thing and the wipe do another.
 *
 * Two things live here and nothing else:
 *
 *   * the SQL fragments (`*_WIPED`, `*_KEPT`) — pure strings, no caller ever supplies a table;
 *   * the digest and the snapshot: what the answer reports about ch01 (blocks, live sentences,
 *     characters, a sha256 of the assembled text) and what the wipe transaction asserts before
 *     it commits. The snapshot is never printed; a mismatch names counts and hashes only.
 *
 * The text comes from rows, never a file: the canonical assembly is the one `engine/text.ts`
 * hashes (`title`, blank line, paragraphs, trailing newline), so ch01's digest means the same
 * thing here as it means to a revision.
 */

import type { Db } from '../db/db.ts';
import { type BlockRow, type ChapterRow, getChapterRow, listBlocks } from '../db/repo/chapters.ts';
import { canonicalChapterRaw } from '../engine/text.ts';
import { sha256Hex } from '../util/hash.ts';

/** The one chapter a launch reset keeps (BOOK-202). */
export const KEPT_CHAPTER = 1;

const K = String(KEPT_CHAPTER);

/** Kept row sets, by their own identity — one definition per table, used by every rule below. */
const KEPT_FACTS = `SELECT id FROM facts WHERE chapter = ${K}`;
const KEPT_THREADS = `SELECT id FROM threads WHERE opened_at_chapter = ${K}`;
const KEPT_BLOCKS = `SELECT id FROM blocks WHERE chapter = ${K}`;

/**
 * An edge belongs to ch01's graph when it is told there **and** both ends are kept facts: an
 * edge is a claim about two facts, so a kept edge over a wiped fact would be a claim about
 * nothing.
 */
export const FACT_DEPENDENCY_KEPT =
  `chapter = ${K} AND "from" IN (${KEPT_FACTS}) AND "to" IN (${KEPT_FACTS})`;

const THREADS_KEPT = `opened_at_chapter = ${K}`;
export const THREAD_EVENTS_KEPT = `chapter = ${K} AND thread_id IN (${KEPT_THREADS})`;
export const MENTIONS_KEPT =
  `chapter = ${K} AND block_id IN (${KEPT_BLOCKS}) ` +
  `AND (fact_id IS NULL OR fact_id IN (${KEPT_FACTS})) ` +
  `AND (thread_id IS NULL OR thread_id IN (${KEPT_THREADS}))`;
export const LITERALS_KEPT = `chapter = ${K} AND block_id IN (${KEPT_BLOCKS})`;

/**
 * BOOK-DOC-77: an extraction run is audit, not a fact, so it is kept when ch01's own pass wrote
 * it **or** when a kept row still names it. Nulling a kept row's provenance to keep a run is the
 * wrong trade: the run is the cheaper row to keep.
 */
const KEPT_RUNS = [
  `SELECT id FROM extraction_runs WHERE chapter = ${K}`,
  `SELECT extracted_by FROM facts WHERE chapter = ${K} AND extracted_by <> ''`,
  `SELECT superseded_by_extraction FROM facts WHERE chapter = ${K} AND superseded_by_extraction IS NOT NULL`,
  `SELECT extracted_by FROM fact_dependency WHERE ${FACT_DEPENDENCY_KEPT} AND extracted_by <> ''`,
  `SELECT retired_by_run FROM fact_dependency WHERE ${FACT_DEPENDENCY_KEPT} AND retired_by_run IS NOT NULL`,
  `SELECT extracted_by FROM threads WHERE ${THREADS_KEPT} AND extracted_by <> ''`,
].join('\n  UNION ');

const EXTRACTION_RUNS_KEPT = `chapter = ${K} OR id IN (${KEPT_RUNS})`;

// ── what the wipe removes ────────────────────────────────────────────────────────────────────
//
// The content predicates keep the shape the counters always had (`basis = 0` for a written
// chapter) and add ch01 to the exclusion: ch01 is a chapter the book keeps now, not a slot the
// wipe re-seeds.
//
// The DELETE is wider than the counter in exactly the places it always was: `blocks` and
// `chapters` go by number, because the finale is re-seeded afterwards and a stale row must not
// survive under the new projection.

export const CHAPTERS_WIPED = `basis = 0 AND n <> ${K}`;
export const BLOCKS_WIPED = `chapter <> ${K}`;
export const CHAPTER_BLOCKS_WIPED = `c.basis = 0 AND c.n <> ${K}`;
export const SENTENCES_WIPED = `block_id NOT IN (${KEPT_BLOCKS})`;
export const REVISIONS_WIPED = `chapter <> ${K}`;

export const FACTS_WIPED = `chapter <> ${K}`;
export const FACT_DEPENDENCY_WIPED = `NOT (${FACT_DEPENDENCY_KEPT})`;
export const THREADS_WIPED = `opened_at_chapter <> ${K}`;
export const THREAD_EVENTS_WIPED = `NOT (${THREAD_EVENTS_KEPT})`;
export const MENTIONS_WIPED = `NOT (${MENTIONS_KEPT})`;
export const LITERALS_WIPED = `NOT (${LITERALS_KEPT})`;
export const EXTRACTION_RUNS_WIPED = `NOT (${EXTRACTION_RUNS_KEPT})`;
export const BLOCK_VERSIONS_WIPED = `chapter <> ${K}`;
export const BLOCK_LINEAGE_WIPED = `chapter <> ${K}`;

/**
 * BOOK-202 — the log's counter may not restart under ch01's kept pointers. Kept `revisions`,
 * `block_versions` and `block_lineage` rows carry `hseq` values into the log the wipe deletes; a
 * reset `sqlite_sequence` would hand the next event one of those numbers, and `history/asOf.ts`
 * would resolve ch01's provenance to an unrelated event. The counter is kept while any such row
 * exists, and restarted only when nothing kept addresses the old numbers.
 */
export function chapter1KeepsHseq(db: Db): boolean {
  const row = db
    .prepare(
      `SELECT (EXISTS (SELECT 1 FROM revisions WHERE chapter = ${K} AND hseq IS NOT NULL)
            OR EXISTS (SELECT 1 FROM block_versions WHERE chapter = ${K})
            OR EXISTS (SELECT 1 FROM block_lineage WHERE chapter = ${K})) AS kept`,
    )
    .get() as { kept: number };
  return row.kept === 1;
}

// ── the digest and the proof ─────────────────────────────────────────────────────────────────

/** What the answer says about ch01: counts, characters and two digests — never a text. */
export type KeptChapter = {
  chapter: 1;
  blocks: number;
  sentences: number;
  chars: number;
  /** sha256 of the assembled canonical text, read from rows before the wipe. */
  sha256Before: string;
  /** The same digest after the wipe. Equal to `sha256Before`, or the transaction rolls back. */
  sha256After: string;
};

type SentenceKey = { id: string; idx: number; start: number; end: number; text_hash: string };

/** ch01's kept graph, by id: the wipe may clear pointers, never drop one of these rows. */
type GraphIds = {
  facts: string[];
  factDependency: string[];
  threads: string[];
  threadEvents: string[];
  mentions: string[];
  literals: string[];
  extractionRuns: string[];
};

/**
 * The rows a reset must leave alone, as one comparable value: the chapter row, every block, the
 * live sentences, the **key sets** of the histories (a revision or a version may lose a pointer
 * into a wiped table, but no row of it may leave) and the **ids** of ch01's corner of the graph
 * (pointers on those rows are cleared on purpose, so ids are what the proof compares). Plain
 * JSON-able data, so the proof is a deep comparison and not a set of ad-hoc assertions.
 */
export type Chapter1Snapshot = {
  chapter: ChapterRow | null;
  blocks: BlockRow[];
  sentences: SentenceKey[];
  revisions: string[];
  blockVersions: string[];
  blockLineage: string[];
  graph: GraphIds;
};

function stateOf(db: Db): Chapter1Snapshot {
  const chapter = getChapterRow(db, KEPT_CHAPTER) ?? null;
  const blocks = chapter === null ? [] : listBlocks(db, KEPT_CHAPTER);
  const ids = blocks.map((block) => block.id);
  const sentences =
    ids.length === 0
      ? []
      : (db
          .prepare(
            `SELECT id, idx, start, end, text_hash FROM sentences
              WHERE erased_at IS NULL AND block_id IN (${ids.map(() => '?').join(', ')})
              ORDER BY block_id, idx`,
          )
          .all(...ids) as SentenceKey[]);
  const keys = (sql: string): string[] =>
    (db.prepare(sql).all(KEPT_CHAPTER) as Array<{ key: string }>).map((row) => row.key);
  const graphIds = (sql: string): string[] =>
    (db.prepare(sql).all() as Array<{ id: string | number }>).map((row) => String(row.id));
  return {
    chapter,
    blocks,
    sentences,
    revisions: keys(`SELECT chapter || ':' || rev AS key FROM revisions WHERE chapter = ? ORDER BY rev`),
    blockVersions: keys(
      `SELECT block_uid || ':' || ver AS key FROM block_versions WHERE chapter = ? ORDER BY block_uid, ver`,
    ),
    blockLineage: keys('SELECT block_id AS key FROM block_lineage WHERE chapter = ? ORDER BY block_id'),
    graph: {
      facts: graphIds(`SELECT id FROM facts WHERE chapter = ${K} ORDER BY id`),
      factDependency: graphIds(`SELECT id FROM fact_dependency WHERE ${FACT_DEPENDENCY_KEPT} ORDER BY id`),
      threads: graphIds(`SELECT id FROM threads WHERE ${THREADS_KEPT} ORDER BY id`),
      threadEvents: graphIds(`SELECT id FROM thread_events WHERE ${THREAD_EVENTS_KEPT} ORDER BY id`),
      mentions: graphIds(`SELECT id FROM mentions WHERE ${MENTIONS_KEPT} ORDER BY id`),
      literals: graphIds(`SELECT id FROM literals WHERE ${LITERALS_KEPT} ORDER BY id`),
      extractionRuns: graphIds(`SELECT id FROM extraction_runs WHERE ${EXTRACTION_RUNS_KEPT} ORDER BY id`),
    },
  };
}

/** The canonical text of ch01 from its rows — the same assembly `engine/text.ts` hashes. */
function shaOf(chapter: ChapterRow | null, blocks: readonly { text: string }[]): string {
  if (chapter === null) return sha256Hex('');
  return sha256Hex(canonicalChapterRaw(chapter.title, blocks));
}

/** ch01 as the answer reports it; `sha256After` is the same digest until a wipe says otherwise. */
export function readChapter1(db: Db): { report: KeptChapter; snapshot: Chapter1Snapshot } {
  const snapshot = stateOf(db);
  const sha = shaOf(snapshot.chapter, snapshot.blocks);
  const aggregate = db
    .prepare('SELECT COALESCE(SUM(LENGTH(text)), 0) AS chars FROM blocks WHERE chapter = ?')
    .get(KEPT_CHAPTER) as { chars: number };
  return {
    snapshot,
    report: {
      chapter: 1,
      blocks: snapshot.blocks.length,
      sentences: snapshot.sentences.length,
      chars: aggregate.chars,
      sha256Before: sha,
      sha256After: sha,
    },
  };
}

function moved(before: Chapter1Snapshot, after: Chapter1Snapshot): string | null {
  const pairs: Array<[string, unknown, unknown]> = [
    ['the chapter row', before.chapter, after.chapter],
    ['its blocks', before.blocks, after.blocks],
    ['its live sentences', before.sentences, after.sentences],
    ['its revision keys', before.revisions, after.revisions],
    ['its block version keys', before.blockVersions, after.blockVersions],
    ['its block lineage keys', before.blockLineage, after.blockLineage],
    ['its graph facts', before.graph.facts, after.graph.facts],
    ['its graph edges', before.graph.factDependency, after.graph.factDependency],
    ['its graph threads', before.graph.threads, after.graph.threads],
    ['its graph thread events', before.graph.threadEvents, after.graph.threadEvents],
    ['its graph mentions', before.graph.mentions, after.graph.mentions],
    ['its graph literals', before.graph.literals, after.graph.literals],
    ['its graph extraction runs', before.graph.extractionRuns, after.graph.extractionRuns],
  ];
  for (const [what, left, right] of pairs) {
    if (JSON.stringify(left) !== JSON.stringify(right)) return what;
  }
  return null;
}

/**
 * The proof that ch01 survived, run **inside** the wipe transaction: the rows are identical to
 * the snapshot taken before the wipe and the digest still hashes to the same value. A mismatch
 * throws, so the transaction rolls back rather than publishing a book with a rewritten ch01.
 *
 * A volume whose ch01 had no row is the other case: the slot was seeded from `book_frame`, and
 * the only thing this run may have written there is that basis row.
 *
 * Returns the digest after the wipe, which is what the answer carries. Nothing here prints a
 * text or a row: a failure names the part that moved, the counts and the hashes.
 */
export function assertChapter1Kept(db: Db, before: Chapter1Snapshot): string {
  const after = stateOf(db);
  const sha = shaOf(after.chapter, after.blocks);
  if (before.chapter === null) {
    if (after.chapter === null || after.chapter.basis !== 1) {
      throw new Error('reset: chapter 1 was not seeded from the frame');
    }
    return sha;
  }
  const part = moved(before, after);
  if (part !== null) {
    throw new Error(
      `reset: chapter 1 changed during the wipe (${part}: ` +
        `${String(before.blocks.length)}/${String(after.blocks.length)} blocks, ` +
        `${String(before.sentences.length)}/${String(after.sentences.length)} sentences)`,
    );
  }
  const was = shaOf(before.chapter, before.blocks);
  if (sha !== was) throw new Error('reset: chapter 1 hashes differently after the wipe');
  return sha;
}
