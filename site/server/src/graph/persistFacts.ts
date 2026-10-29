/**
 * The facts, their mentions and the literals of one validated answer (BOOK-185, BOOK-DOC-77 §5).
 *
 * **Why the ids are derived from the evidence.** `fct_` + `sha1(key)[0..20]` names a fact by what
 * it says, not by when it was written. A re-run of chapter 5 that answers the same document gets
 * the same row id, so the mentions of chapter 9 that point at it still point at it — and the
 * partial unique index `facts_key_live` (one live row per key) can be satisfied by an `ON CONFLICT
 * (id)` upsert instead of a delete-and-insert that would break every later chapter's edges. A row
 * that already carries the key keeps its own id (`fct_<ulid>` from the ledger, or a key the old
 * deterministic stage wrote): deriving a second id for a live key would collide with that index.
 *
 * **Supersede, never delete.** A fact of this chapter the new answer no longer states is
 * `invalidated_at = at` and `superseded_by_extraction = run`; the row stays, `factAsOf` and the
 * closure stop seeing it, and a reader can still ask what the book believed before this run. A
 * fact the answer states again after such a retirement is revived by the same upsert — a fact with
 * no `superseded_by_extraction` was never the extraction's to retire, so its invalidation by a
 * change is left alone.
 *
 * Mention rows are **live-only** (ADR-043 D3): the chapter's fact mentions are deleted and bound
 * again from this answer, so offsets always name the text that stands. Only `kind = 'fact'` rows
 * are replaced — a `document`/`date`/`thread` mention is the applier's record of an edit, and an
 * extraction that deleted it would erase another writer's history.
 */

import type { Db } from '../db/db.ts';
import { findLiterals } from '../ledger/mentions.ts';
import type { AcceptedFact, AcceptedUse } from './judged.ts';
import { SENTENCE_LIMIT, type Block } from './quote.ts';
import { clip, idOf } from './text.ts';

/** The provenance every row this pass writes carries (`extracted_by`, a JSON column). */
export type ExtractionStamp = {
  id: string;
  model: string;
  promptSha: string;
  at: string;
  pass: 'extract' | 'recall';
};

/** `{run, model, prompt, at, pass}` — the four names BOOK-DOC-77 §5 asks a row to remember. */
export function stampOf(run: ExtractionStamp): string {
  return JSON.stringify({ run: run.id, model: run.model, prompt: run.promptSha, at: run.at, pass: run.pass });
}

/**
 * The stamp one row carries: the recall run when the item says the second reader first produced
 * it, otherwise the run whose answer is being written. `extracted_by.pass` is therefore the pass
 * that first produced the row, not the pass that happened to write it last.
 */
export function stampFor(
  run: ExtractionStamp,
  recallRun: ExtractionStamp | undefined,
  pass: 'extract' | 'recall' | undefined,
): string {
  return stampOf(pass === 'recall' && recallRun !== undefined ? recallRun : run);
}

/** `fct_<sha1(key)[0..20]>`: a fact's identity is its key, so a re-run writes the same row. */
export function factIdOf(key: string): string {
  return idOf('fct', key);
}

export type PersistFactsInput = {
  chapter: number;
  at: string;
  run: ExtractionStamp;
  /** The recall run, when the answer is a merge: an item tagged `recall` carries its stamp. */
  recallRun?: ExtractionStamp;
  /** The validator's accepted facts: `assert` writes a row, `mention` is a repeat inside the answer. */
  facts: readonly AcceptedFact[];
};

export type PersistedFacts = {
  /** key → row id for every fact this chapter asserts (a legacy row keeps its own id). */
  ids: Map<string, string>;
  /** key → the chapter of the row the key was bound to, so a mention's role follows the row. */
  bound: Map<string, number>;
  /** The live rows of this chapter the answer no longer states. */
  superseded: string[];
};

/**
 * A fact this answer states whose key is already live in a **later** chapter. The run cannot
 * write it: binding it to that row would make this chapter's mention a `use` of a fact that did
 * not exist yet, and re-chaptering the row would rewrite a later chapter's fact from an earlier
 * run. Nothing is written — the whole answer rolls back (`FACT_NOT_ESTABLISHED` class), because
 * an item-level skip would be a silent no-op.
 */
export class FactChapterAheadError extends Error {
  readonly code = 'FACT_NOT_ESTABLISHED';

  constructor(readonly keys: ReadonlyArray<{ key: string; chapter: number; factChapter: number }>) {
    // The reason is a key and two chapter numbers — the same shape the reject carries, never a row.
    // The array is never empty: the error exists because at least one item was refused.
    const first = keys[0] as { key: string; chapter: number; factChapter: number };
    super(
      `FACT_NOT_ESTABLISHED: ${String(keys.length)} fact(s) name a key a later chapter already holds` +
        ` (first: "${first.key}" is chapter ${String(first.factChapter)}, not chapter ${String(first.chapter)})`,
    );
    this.name = 'FactChapterAheadError';
  }
}

const UPSERT_FACT = `
INSERT INTO facts
  (id, chapter, kind, statement, term, valid_from_chapter, invalidated_at, invalidated_by_change,
   created_at, key, sentence, extracted_by, superseded_by_extraction)
VALUES (@id, @chapter, @kind, @statement, @term, @chapter, NULL, NULL, @at, @key, @sentence,
        @extractedBy, NULL)
ON CONFLICT(id) DO UPDATE SET
  statement = excluded.statement,
  sentence = excluded.sentence,
  term = excluded.term,
  extracted_by = excluded.extracted_by,
  valid_from_chapter = MIN(valid_from_chapter, excluded.valid_from_chapter),
  -- A row an earlier run retired is revived; a row a change invalidated keeps its history.
  invalidated_at = CASE WHEN superseded_by_extraction IS NULL THEN invalidated_at ELSE NULL END,
  invalidated_by_change =
    CASE WHEN superseded_by_extraction IS NULL THEN invalidated_by_change ELSE NULL END,
  superseded_by_extraction = NULL`;

/** `statement` is one line, not a paragraph: the reading aid of a row, not its sentence. */
export const STATEMENT_LIMIT = 200;

/**
 * Write the chapter's facts and retire the ones it stopped stating. Returns the ids so the
 * mentions, edges and thread events of the same transaction bind to the rows it just wrote.
 */
export function persistFacts(db: Db, input: PersistFactsInput): PersistedFacts {
  const upsert = db.prepare(UPSERT_FACT);
  /**
   * The live row of this key a chapter may bind to: the latest one **not after** this chapter. A
   * row of a later chapter is not this pass's to update — an out-of-order run must not re-chapter
   * a fact that chapter 3 already established (BOOK-185 defect 6).
   */
  const live = db.prepare(
    `SELECT id, chapter FROM facts
      WHERE key = ? AND invalidated_at IS NULL AND key <> '' AND chapter <= ?
      ORDER BY chapter DESC, id LIMIT 1`,
  );
  const ahead = db.prepare(
    `SELECT chapter FROM facts
      WHERE key = ? AND invalidated_at IS NULL AND key <> '' AND chapter > ?
      ORDER BY chapter, id LIMIT 1`,
  );
  const ids = new Map<string, string>();
  const bound = new Map<string, number>();
  const accepted = new Set<string>();
  const later: Array<{ key: string; chapter: number; factChapter: number }> = [];

  for (const fact of input.facts) {
    // A `mention` is the same key said twice in one answer: the row already exists (the validator
    // ordered the assertion first), and a second upsert would only rewrite what stands.
    if (fact.role !== 'assert') continue;
    if (accepted.has(fact.key)) continue;
    accepted.add(fact.key);
    const known = live.get(fact.key, input.chapter) as { id: string; chapter: number } | undefined;
    if (known === undefined) {
      const laterRow = ahead.get(fact.key, input.chapter) as { chapter: number } | undefined;
      if (laterRow !== undefined) {
        later.push({ key: fact.key, chapter: input.chapter, factChapter: laterRow.chapter });
        continue;
      }
    }
    const id = known?.id ?? factIdOf(fact.key);
    ids.set(fact.key, id);
    if (known !== undefined) bound.set(fact.key, known.chapter);
    upsert.run({
      id,
      chapter: input.chapter,
      kind: fact.kind,
      statement: clip(fact.statement, STATEMENT_LIMIT),
      term: fact.term,
      at: input.at,
      key: fact.key,
      sentence: clip(fact.sentence, SENTENCE_LIMIT),
      extractedBy: stampFor(input.run, input.recallRun, fact.pass),
    });
  }

  // A key a later chapter already holds is refused whole: the transaction rolls the rest back.
  if (later.length > 0) throw new FactChapterAheadError(later);

  // Supersede, never delete: what this chapter said and the answer no longer says is history.
  // A row with an empty key was written by a stage that knew no keys, so it is not this pass's
  // to replace.
  const rows = db
    .prepare(
      `SELECT id, key FROM facts
        WHERE chapter = ? AND invalidated_at IS NULL AND superseded_by_extraction IS NULL
          AND key <> ''
        ORDER BY id`,
    )
    .all(input.chapter) as Array<{ id: string; key: string }>;
  const retire = db.prepare(`UPDATE facts SET invalidated_at = ?, superseded_by_extraction = ? WHERE id = ?`);
  const superseded: string[] = [];
  for (const row of rows) {
    if (accepted.has(row.key)) continue;
    retire.run(input.at, input.run.id, row.id);
    superseded.push(row.id);
  }

  return { ids, bound, superseded };
}

export type PersistMentionsInput = {
  chapter: number;
  facts: readonly AcceptedFact[];
  uses: readonly AcceptedUse[];
  /** key → id of the facts this chapter asserts. */
  ids: ReadonlyMap<string, string>;
  /** key → the chapter of the row the key was bound to (absent when this pass wrote the row). */
  bound: ReadonlyMap<string, number>;
  /** block id → the span the mention names (`spanIdsOf`). */
  spanIds: ReadonlyMap<string, string>;
};

export type PersistedMentions = { mentions: number; uses: number };

/**
 * The role a mention carries, read from the row it is actually bound to: a row of an earlier
 * chapter is used, a row of this chapter — or one this pass writes — is asserted. The item's own
 * `factChapter` is the validator's view of the book before the write; the bound row is the one the
 * mention points at, and the two can differ on an out-of-order run.
 */
function roleOf(
  entry: { key: string; factChapter: number | null },
  chapter: number,
  bound: ReadonlyMap<string, number>,
): 'assert' | 'use' {
  // A key with no bound row was written by this pass, so the row it names is this chapter's.
  const boundChapter = bound.get(entry.key) ?? entry.factChapter ?? chapter;
  return boundChapter < chapter ? 'use' : 'assert';
}

/**
 * Re-bind the chapter's fact mentions from the answer. `mentions_span` is unique on
 * `(span_id, start, end, kind)`, so two facts read off the same stretch of text collapse into the
 * first one — the same rule the applier uses, applied here in JavaScript so a real constraint bug
 * still throws instead of being swallowed by `INSERT OR IGNORE`.
 */
export function persistMentions(db: Db, input: PersistMentionsInput): PersistedMentions {
  db.prepare(`DELETE FROM mentions WHERE chapter = ? AND kind = 'fact'`).run(input.chapter);
  const insert = db.prepare(
    `INSERT INTO mentions
       (span_id, block_id, chapter, start, end, kind, fact_id, thread_id, resolved_by_change,
        role, witness, edge_path)
     VALUES (@spanId, @blockId, @chapter, @start, @end, 'fact', @factId, NULL, NULL,
             @role, @witness, '[]')`,
  );
  const seen = new Set<string>();
  let mentions = 0;
  let uses = 0;

  const bind = (entry: {
    key: string;
    factId: string | null;
    factChapter: number | null;
    blockId: string;
    start: number;
    end: number;
    witness: string;
  }): void => {
    const spanId = input.spanIds.get(entry.blockId);
    if (spanId === undefined) return;
    const slot = `${spanId}|${String(entry.start)}|${String(entry.end)}`;
    if (seen.has(slot)) return;
    seen.add(slot);
    const role = roleOf(entry, input.chapter, input.bound);
    insert.run({
      spanId,
      blockId: entry.blockId,
      chapter: input.chapter,
      start: entry.start,
      end: entry.end,
      factId: entry.factId ?? input.ids.get(entry.key) ?? factIdOf(entry.key),
      role,
      witness: entry.witness,
    });
    mentions += 1;
    if (role === 'use') uses += 1;
  };

  for (const fact of input.facts) bind(fact);
  for (const use of input.uses) bind(use);

  return { mentions, uses };
}

export type PersistLiteralsInput = {
  chapter: number;
  blocks: readonly Block[];
  spanIds: ReadonlyMap<string, string>;
};

/**
 * Re-index the chapter's literals: every date and document number of the live text, bound or not.
 * A literal is a lookup index over the words, not a claim about the world, so code owns it — the
 * extractor's silence about a date does not make the date unfindable.
 */
export function persistLiterals(db: Db, input: PersistLiteralsInput): number {
  db.prepare('DELETE FROM literals WHERE chapter = ?').run(input.chapter);
  const insert = db.prepare(
    `INSERT INTO literals (literal, raw, block_id, span_id, chapter, mention_kind, start, end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let literals = 0;
  for (const block of input.blocks) {
    const spanId = input.spanIds.get(block.id) ?? '';
    for (const found of findLiterals(block.text)) {
      insert.run(found.literal, found.raw, block.id, spanId, input.chapter, found.kind, found.start, found.end);
      literals += 1;
    }
  }
  return literals;
}
