/**
 * The backfill that makes the graph real (BOOK-173, BOOK-DOC-75 §1.3, §5).
 *
 * The ledger v22 holds facts a change asserted; it has never held the *prose's* facts, so a ripple
 * over a real filing reached plenty of text and could not name a single line (BOOK-173 #3867:
 * 0 mandatory on all three filings). This module reads the written chapters once, deterministically,
 * and writes what the research measured:
 *
 *   · `facts` — document instances (noun + number), numbers and dates, promises, irreversible acts,
 *     decisions, each with the quote that states it (`proseFacts.ts` holds the closed lists);
 *   · `mentions` — one per fact, with the block, the code-point span and the witness, so «is this
 *     claim still asserted?» is a query and not a memory of this run;
 *   · `edges` — the four measured chain rules (document, number identity, entity continuity,
 *     causal connective) plus promise → candidate, each with the component the target consumes.
 *
 * **Idempotent by construction.** A fact whose id exists is not inserted; an edge whose key exists
 * is not asserted (which would rewrite its row); a mention that already covers its span is left
 * alone. Every chapter is still read, so a chapter written today chains to the ones backfilled
 * yesterday — the `rev` marker reports what was already measured, it never hides the text. A
 * second run writes zero rows and says so.
 *
 * **Bounded, and honest about it.** At most `MAX_BACKFILL_FACTS` facts for the whole book: beyond
 * that the extractor is wrong, not the book. A chapter that cannot be read is skipped and named —
 * one unparseable chapter must not cost the other fifteen their graph.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chapterLabel } from '@book/shared';

import type { Db } from '../../db/db.ts';
import { getMeta, setMeta } from '../../db/repo/meta.ts';
import { extractChapter } from '../../index/extract.ts';
import { parseChapter } from '../../ingest/parseChapter.ts';
import { sha256Hex } from '../../util/hash.ts';
import { toIso } from '../../util/time.ts';
import { parseSpans } from '../spans.ts';
import type { Component } from './components.ts';
import { assertDependency, type EdgeKind, type EdgeRow } from './edges.ts';
import { chapterFacts, type FactCandidate } from './proseFacts.ts';

/** The whole book, bounded: more facts than this is an extractor defect, not prose. */
export const MAX_BACKFILL_FACTS = 5_000;
/** Where the per-chapter `rev` this backfill already read is remembered. */
export const BACKFILL_META_KEY = 'ledger.backfill';

/** Explicit causal connectives — the design's closed list. */
const CONNECTIVES = [
  'потому что',
  'поэтому',
  'вследствие',
  'из-за',
  'благодаря',
  'так что',
  'отсюда',
  'на основании',
  'во исполнение',
  'в связи с',
] as const;

export type BackfillInput = {
  bookRoot: string;
  at?: string;
  /** Test seam for the valve: a book this size would take an hour to write in a fixture. */
  maxFacts?: number;
};

export type BackfillResult = {
  /** Chapters read in this run. */
  chapters: number[];
  /** Rows written in this run — a second run reports zeros. */
  facts: number;
  mentions: number;
  edges: number;
  /** Chapters already at the marker's rev, or a basis slot (the frame is not prose). */
  skipped: number[];
  /** Chapters that could not be read; the run continued without them. */
  failed: number[];
  /** The fact valve tripped: the run stopped inserting and says so. */
  truncated: boolean;
};

type Built = { fact: FactCandidate; chapter: number; blockId: string; pos: number };

type EdgeDraft = {
  from: string;
  to: string;
  chapter: number;
  kind: EdgeKind;
  onComponent: Component;
  evidence: string;
};

type ChapterRow = { n: number; rev: number; basis: number; sha256: string };

type LiveBlock = { id: string; text: string };

/** A chapter's blocks: the projection when it has one, the file when it does not. */
function blocksOf(db: Db, bookRoot: string, n: number): LiveBlock[] {
  const rows = db.prepare('SELECT id, text FROM blocks WHERE chapter = ? ORDER BY idx').all(n) as LiveBlock[];
  if (rows.length > 0) return rows;
  const file = join(bookRoot, 'manuscript', `ch${chapterLabel(n)}.md`);
  if (!existsSync(file)) return [];
  const parsed = parseChapter(n, readFileSync(file, 'utf8'));
  return parsed.blocks.map((block) => ({ id: block.id, text: block.text }));
}

/** The span an edit last wrote the block at — the mention's `span_id`, live only. */
function spanOfBlock(db: Db, blockId: string): string {
  const row = db
    .prepare(
      `SELECT block_uid, ver, spans FROM block_versions
        WHERE block_id = ? AND op != 'erased'
        ORDER BY ver DESC LIMIT 1`,
    )
    .get(blockId) as { block_uid: string; ver: number; spans: string } | undefined;
  if (row === undefined) return `legacy:${blockId}`;
  const spans = parseSpans(row.spans);
  return spans[0]?.span_id ?? `${row.block_uid}:${String(row.ver)}:0`;
}

function markers(db: Db): Record<string, number> {
  const raw = getMeta(db, BACKFILL_META_KEY);
  if (raw === null || raw === '') return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** One deterministic identity per dependency: a rerun produces the same row ids, not new ones. */
function edgeId(draft: EdgeDraft): string {
  return `edg_bf_${sha256Hex(`${draft.from}>${draft.to}>${draft.kind}>${String(draft.chapter)}`).slice(0, 24)}`;
}

/**
 * The measured chain rules, in reading order. Every rule is a key the prose shares between two
 * facts, and the component the later fact consumes of the earlier one — nothing is inferred beyond
 * the closed lists.
 */
export function draftEdges(built: readonly Built[]): EdgeDraft[] {
  const drafts: EdgeDraft[] = [];
  const seen = new Set<string>();
  const add = (draft: EdgeDraft): void => {
    if (draft.from === draft.to) return;
    const key = `${draft.from}>${draft.to}>${draft.kind}>${String(draft.chapter)}`;
    if (seen.has(key)) return;
    seen.add(key);
    drafts.push(draft);
  };

  // 1. document instance: the same paper across chapters, in reading order.
  const byDoc = new Map<string, Built[]>();
  for (const entry of built) {
    if (entry.fact.docKey === undefined) continue;
    byDoc.set(entry.fact.docKey, [...(byDoc.get(entry.fact.docKey) ?? []), entry]);
  }
  for (const [key, list] of [...byDoc.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1))) {
    for (let i = 1; i < list.length; i += 1) {
      const previous = list[i - 1];
      const current = list[i];
      if (previous === undefined || current === undefined || previous.chapter === current.chapter) continue;
      add({
        from: previous.fact.factId,
        to: current.fact.factId,
        chapter: current.chapter,
        kind: 'follows',
        onComponent: 'status',
        evidence: `«${key}»: ${previous.fact.status ?? 'stated'} (ch${String(previous.chapter)}) → ${current.fact.status ?? 'stated'} (ch${String(current.chapter)})`,
      });
    }
  }

  // 2. number identity: the same literal in two chapters, consecutive pairs.
  const byNumber = new Map<string, Built[]>();
  for (const entry of built) {
    for (const number of entry.fact.numbers) {
      if (number.length < 2) continue;
      byNumber.set(number, [...(byNumber.get(number) ?? []), entry]);
    }
  }
  for (const [number, list] of [...byNumber.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1))) {
    if (new Set(list.map((entry) => entry.chapter)).size < 2) continue;
    for (let i = 1; i < list.length; i += 1) {
      const previous = list[i - 1];
      const current = list[i];
      if (previous === undefined || current === undefined || previous.chapter === current.chapter) continue;
      add({
        from: previous.fact.factId,
        to: current.fact.factId,
        chapter: current.chapter,
        kind: 'follows',
        onComponent: 'value',
        evidence: `«${number}»: ch${String(previous.chapter)} → ch${String(current.chapter)}`,
      });
    }
  }

  // 3. entity continuity: an irreversible act reaches the next facts about the same entity.
  const byEntity = new Map<string, Built[]>();
  for (const entry of built) {
    for (const entity of entry.fact.entities) {
      byEntity.set(entity, [...(byEntity.get(entity) ?? []), entry]);
    }
  }
  for (const [entity, list] of [...byEntity.entries()].sort((left, right) => (left[0] < right[0] ? -1 : 1))) {
    for (let i = 0; i < list.length; i += 1) {
      const act = list[i];
      if (act === undefined || (act.fact.kind !== 'state' && act.fact.kind !== 'erasure')) continue;
      let taken = 0;
      for (let j = i + 1; j < list.length && taken < 3; j += 1) {
        const next = list[j];
        if (next === undefined || next.chapter < act.chapter) continue;
        add({
          from: act.fact.factId,
          to: next.fact.factId,
          chapter: next.chapter,
          kind: 'references',
          onComponent: 'identity',
          evidence: `«${entity}» after «${act.fact.statement.slice(0, 60)}…»`,
        });
        taken += 1;
      }
    }
  }

  // 4. causal connective: the nearest preceding fact in the block, within three sentences.
  const byBlock = new Map<string, Built[]>();
  for (const entry of built) {
    const key = `${String(entry.chapter)}|${entry.blockId}`;
    byBlock.set(key, [...(byBlock.get(key) ?? []), entry]);
  }
  for (const list of byBlock.values()) {
    for (const entry of list) {
      const connective = CONNECTIVES.find((text) => entry.fact.statement.toLowerCase().includes(text));
      if (connective === undefined) continue;
      const cause = list.find(
        (other) =>
          other.pos < entry.pos &&
          other.fact.si < entry.fact.si &&
          entry.fact.si - other.fact.si <= 3,
      );
      if (cause === undefined) continue;
      add({
        from: cause.fact.factId,
        to: entry.fact.factId,
        chapter: entry.chapter,
        kind: 'follows',
        onComponent: 'value',
        evidence: `${connective}: «${cause.fact.statement.slice(0, 50)}…» → «${entry.fact.statement.slice(0, 50)}…»`,
      });
    }
  }

  // 5. promise → candidate: a later fact sharing the paper, a number or an entity.
  for (const promise of built) {
    if (promise.fact.marker === undefined) continue;
    const keys = new Set<string>([
      ...(promise.fact.docKey === undefined ? [] : [promise.fact.docKey]),
      ...promise.fact.numbers,
      ...promise.fact.entities,
    ]);
    if (keys.size === 0) continue;
    let taken = 0;
    for (let i = promise.pos + 1; i < built.length && taken < 5; i += 1) {
      const candidate = built[i];
      if (candidate === undefined) continue;
      const shared = [
        ...(candidate.fact.docKey !== undefined && keys.has(candidate.fact.docKey) ? [candidate.fact.docKey] : []),
        ...candidate.fact.numbers.filter((number) => keys.has(number)),
        ...candidate.fact.entities.filter((entity) => keys.has(entity)),
      ];
      if (shared.length === 0) continue;
      add({
        from: promise.fact.factId,
        to: candidate.fact.factId,
        chapter: candidate.chapter,
        kind: 'fulfils',
        onComponent: 'value',
        evidence: `shared: ${shared.slice(0, 2).join(', ')}`,
      });
      taken += 1;
    }
  }

  return drafts;
}

/**
 * Read the written chapters into the graph. Safe to call on every boot: every insert is guarded by
 * its own identity, and every chapter is read so a new chapter's facts chain to the old ones — the
 * `rev` marker reports what was already backfilled, it never stops the reading.
 */
export function backfillLedger(db: Db, input: BackfillInput): BackfillResult {
  const at = input.at ?? toIso(Date.now());
  const maxFacts = input.maxFacts ?? MAX_BACKFILL_FACTS;
  const done = markers(db);
  const known = new Set(
    (db.prepare('SELECT id FROM facts').all() as Array<{ id: string }>).map((row) => row.id),
  );
  const knownMentions = new Set(
    (db.prepare(`SELECT block_id, start, end FROM mentions WHERE kind = 'fact'`).all() as Array<{
      block_id: string;
      start: number;
      end: number;
    }>).map((row) => `${row.block_id}|${String(row.start)}|${String(row.end)}`),
  );
  const knownEdges = new Set(
    (db.prepare('SELECT from_fact, to_fact, kind, chapter FROM edges').all() as EdgeRow[]).map(
      (row) => `${row.from_fact}>${row.to_fact}>${row.kind}>${String(row.chapter)}`,
    ),
  );
  // A retired claim is not part of today's graph: its edges were deleted with the invalidation
  // (`facts_retire_edges`), and a re-run must not bring them back.
  const invalidated = new Set(
    (db.prepare('SELECT id FROM facts WHERE invalidated_at IS NOT NULL').all() as Array<{ id: string }>).map(
      (row) => row.id,
    ),
  );

  const result: BackfillResult = {
    chapters: [],
    facts: 0,
    mentions: 0,
    edges: 0,
    skipped: [],
    failed: [],
    truncated: false,
  };
  const built: Built[] = [];
  const insertFact = db.prepare(
    `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, invalidated_at,
                        invalidated_by_change, created_at)
     VALUES (@id, @chapter, @kind, @statement, @term, @chapter, NULL, NULL, @at)`,
  );
  const insertMention = db.prepare(
    `INSERT OR IGNORE INTO mentions
       (span_id, block_id, chapter, start, end, kind, fact_id, thread_id, resolved_by_change, role,
        witness, edge_path)
     VALUES (@spanId, @blockId, @chapter, @start, @end, 'fact', @factId, NULL, NULL, 'assert', @witness, '[]')`,
  );

  const chapters = db.prepare('SELECT n, rev, basis, sha256 FROM chapters ORDER BY n').all() as ChapterRow[];

  /**
   * One chapter, one transaction (BOOK-173 review, fix 2). A live book keeps serving while an
   * operator runs this: the whole-book transaction that was here first held the write lock for the
   * length of the run (590 ms on the real book, and beta readers write while the writer works), and
   * a chapter that fails half-way left the run with counters it could not honour. A chapter either
   * commits its facts, mentions and marker together, or contributes nothing.
   */
  const writeChapter = db.transaction(
    (chapter: ChapterRow): { read: boolean; already: boolean; facts: number; mentions: number; built: Built[] } => {
    // `already` is read before the marker moves: it is «this rev was measured by an earlier run».
    const written = { read: true, already: done[String(chapter.n)] === chapter.rev, facts: 0, mentions: 0, built: [] as Built[] };
    const blocks = blocksOf(db, input.bookRoot, chapter.n);
    if (blocks.length === 0) return { ...written, read: false };
    const facts = chapterFacts({
      blocks,
      index: extractChapter({
        n: chapter.n,
        written: true,
        sha256: chapter.sha256,
        paragraphs: blocks.map((block) => block.text),
      }),
    });
    const blockById = new Map(blocks.map((block) => [block.id, block]));
    for (const fact of facts) {
      if (invalidated.has(fact.factId)) continue;
      // `pos` is the entry's index in the whole-book reading order: the chapters already committed
      // plus the ones this transaction has read so far (the chain rules compare positions).
      const entry: Built = { fact, chapter: chapter.n, blockId: fact.blockId, pos: built.length + written.built.length };
      written.built.push(entry);
      if (known.has(fact.factId)) continue;
      if (known.size >= maxFacts) {
        result.truncated = true;
        break;
      }
      const block = blockById.get(fact.blockId);
      if (block === undefined) continue;
      insertFact.run({
        id: fact.factId,
        chapter: chapter.n,
        kind: fact.kind,
        statement: fact.statement,
        term: fact.term,
        at,
      });
      known.add(fact.factId);
      written.facts += 1;
      const mentionKey = `${block.id}|${String(fact.start)}|${String(fact.end)}`;
      if (knownMentions.has(mentionKey)) continue;
      const inserted = insertMention.run({
        spanId: spanOfBlock(db, block.id),
        blockId: block.id,
        chapter: chapter.n,
        start: fact.start,
        end: fact.end,
        factId: fact.factId,
        witness: Array.from(block.text).slice(fact.start, fact.end).join(''),
      });
      knownMentions.add(mentionKey);
      if (inserted.changes > 0) written.mentions += 1;
    }
    if (!result.truncated) {
      done[String(chapter.n)] = chapter.rev;
      setMeta(db, BACKFILL_META_KEY, JSON.stringify(done));
    }
    return written;
  });

  for (const chapter of chapters) {
    if (result.truncated) break;
    if (chapter.basis === 1) {
      result.skipped.push(chapter.n);
      continue;
    }
    let written: { read: boolean; already: boolean; facts: number; mentions: number; built: Built[] };
    try {
      written = writeChapter(chapter);
    } catch {
      // One unreadable or unwritable chapter must not cost the other fifteen their graph: its
      // transaction rolled back, it is named, and the run continues.
      result.failed.push(chapter.n);
      continue;
    }
    if (!written.read) {
      result.failed.push(chapter.n);
      continue;
    }
    result.chapters.push(chapter.n);
    result.facts += written.facts;
    result.mentions += written.mentions;
    built.push(...written.built);
    if (written.already) result.skipped.push(chapter.n);
  }

  // The chain rules read the whole book at once: one transaction, after every chapter committed.
  const writeEdges = db.transaction(() => {
    for (const draft of draftEdges(built)) {
      const key = `${draft.from}>${draft.to}>${draft.kind}>${String(draft.chapter)}`;
      if (knownEdges.has(key)) continue;
      if (!known.has(draft.from) || !known.has(draft.to)) continue;
      assertDependency(db, {
        from: draft.from,
        to: draft.to,
        chapter: draft.chapter,
        kind: draft.kind,
        onComponent: draft.onComponent,
        evidence: draft.evidence,
        origin: 'backfill',
        at,
        id: edgeId(draft),
      });
      knownEdges.add(key);
      result.edges += 1;
    }
  });
  writeEdges();
  return result;
}
