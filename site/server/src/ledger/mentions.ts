/**
 * Mentions and literals (BOOK-176, BOOK-DOC-69).
 *
 * A **mention** is a stretch of block text that points at something: a fact the world holds, a
 * thread the story runs on, a document identifier or a date. It is written with its span, so
 * «where exactly was this said, and which edit said it» has one answer.
 *
 * A **literal** is the extracted value itself — the document number normalised to
 * `65-11877-арх`, a date to `2065-09-14` — indexed so the book can be asked «where is this
 * document mentioned» without re-parsing every paragraph. Extraction is deliberate and narrow:
 * a shape the ledger does not recognise is a shape it does not index, never a guess.
 *
 * Offsets are code points (see `spans.ts`); the recogniser itself lives in `factShaped.ts`, so the
 * guard that refuses an unbound date and the binder that records one always agree about what a
 * carrier is — one pattern, two readers.
 *
 * Mentions are **live-only** (ADR-043 D3): the applier deletes the rows of every block it edits
 * and binds them again from the new text, inside the same transaction. A mention is a statement
 * about the text that stands, never about a version that is gone.
 */

import type { Db } from '../db/db.ts';
import { findFactShaped } from './factShaped.ts';
import { factAsOf } from './facts.ts';
import { cpOffsetOf, sliceCp } from './spans.ts';

export type LiteralKind = 'document' | 'date';

export type LiteralMatch = {
  raw: string;
  /** Normalised value: `65-11877-арх` or `2065-09-14`. */
  literal: string;
  kind: LiteralKind;
  /** Code-point offsets in the text that was searched. */
  start: number;
  end: number;
};

/** `14.09.2065` → `2065-09-14`; a dotted or slashed date, or an ISO one left as it is. */
function normaliseDate(raw: string): string {
  const dotted = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/u.exec(raw);
  if (dotted === null) return raw;
  const [, day, month, year] = dotted;
  return `${year ?? ''}-${(month ?? '').padStart(2, '0')}-${(day ?? '').padStart(2, '0')}`;
}

/** `65/11877/арх` → `65-11877-арх`: the document number without its separators. */
function normaliseDocument(raw: string): string {
  const parts = raw.split('/').map((part) => part.trim());
  if (parts.length !== 3) return raw;
  const [a, b, suffix] = parts;
  return `${a ?? ''}-${b ?? ''}-${(suffix ?? '').toLowerCase()}`;
}

/**
 * The document numbers and dates of a text, normalised, in code-point offsets. A `№` reference is
 * fact-shaped but not a literal: this index is the document/date lookup, and the guard's wider
 * vocabulary belongs to `factShaped.ts`.
 */
export function findLiterals(text: string): LiteralMatch[] {
  if (text.trim() === '') return [];
  const literals: LiteralMatch[] = [];
  for (const token of findFactShaped(text)) {
    if (token.kind === 'reference') continue;
    literals.push({
      raw: token.raw,
      literal: token.kind === 'date' ? normaliseDate(token.raw) : normaliseDocument(token.raw),
      kind: token.kind,
      start: token.start,
      end: token.end,
    });
  }
  return literals;
}

/**
 * Every code-point offset at which `needle` occurs in `text`. A needle that does not occur is
 * an empty answer — never a throw: a fact that is not in this paragraph is normal.
 */
export function occurrences(text: string, needle: string): Array<{ start: number; end: number }> {
  if (needle === '') return [];
  const hits: Array<{ start: number; end: number }> = [];
  let from = text.indexOf(needle);
  while (from !== -1 && from <= text.length) {
    hits.push({ start: cpOffsetOf(text, from), end: cpOffsetOf(text, from + needle.length) });
    from = text.indexOf(needle, from + needle.length);
  }
  return hits;
}

/** One block as the binding pass sees it: the live text, and the span that last wrote it. */
export type BoundBlock = {
  spanId: string;
  blockId: string;
  /** The block's text after this edit — offsets below are 0-based in it. */
  text: string;
};

export type InsertMentionsInput = {
  chapter: number;
  blocks: ReadonlyArray<BoundBlock>;
  /** The change or pass that produced the spans; null for an operator's own act. */
  resolvedBy: string | null;
};

export type InsertedMentions = { mentions: number; literals: number };

/**
 * Bind the facts, threads and literals of each edited block's **live text**. Written inside the
 * applier's transaction: a mention that survived a rolled-back edit would point at text that never
 * landed.
 *
 * Binding the whole block, not only the inserted stretch, is deliberate (ADR-043 D3): mentions are
 * live-only, so an edit re-binds what the block says now and the ones it deletes are not a silent
 * loss of coverage. `span_id` names the edit that last re-bound the row; the offsets and the
 * witness name the text.
 *
 * The one-mention-per-interval rule (`mentions_span`) is enforced here in JavaScript rather than
 * by ignoring the insert's error, so a real constraint bug still fails loudly: two facts that
 * share a surface form are one mention at that place, the earlier fact wins.
 */
export function insertSpanMentions(db: Db, input: InsertMentionsInput): InsertedMentions {
  const facts = factAsOf(db, input.chapter).filter((fact) => fact.term !== null && fact.term !== '');
  const threads = db.prepare(`SELECT id, label FROM threads WHERE label != ''`).all() as Array<{
    id: string;
    label: string;
  }>;
  const mention = db.prepare(
    `INSERT INTO mentions
       (span_id, block_id, chapter, start, end, kind, fact_id, thread_id, resolved_by_change,
        role, witness, edge_path)
     VALUES (@spanId, @blockId, @chapter, @start, @end, @kind, @factId, @threadId, @resolvedBy,
             @role, @witness, @edgePath)`,
  );
  const literal = db.prepare(
    `INSERT INTO literals (literal, raw, block_id, span_id, chapter, mention_kind, start, end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const seen = new Set<string>();
  let mentions = 0;
  let literals = 0;

  /** One mention row. `witness` is the text the offsets point at, copied at write time. */
  const bind = (input0: {
    block: BoundBlock;
    start: number;
    end: number;
    kind: 'fact' | 'thread' | 'document' | 'date';
    factId: string | null;
    threadId: string | null;
    /** ADR-043 D3: only a fact span carries a role; stage 2 adds 'use'. */
    role: 'assert' | null;
  }): void => {
    mention.run({
      spanId: input0.block.spanId,
      blockId: input0.block.blockId,
      chapter: input.chapter,
      start: input0.start,
      end: input0.end,
      kind: input0.kind,
      factId: input0.factId,
      threadId: input0.threadId,
      resolvedBy: input.resolvedBy,
      role: input0.role,
      witness: sliceCp(input0.block.text, input0.start, input0.end),
      edgePath: '[]',
    });
    mentions += 1;
  };

  for (const block of input.blocks) {
    for (const fact of facts) {
      for (const hit of occurrences(block.text, fact.term ?? '')) {
        const key = `${block.spanId}|${String(hit.start)}|${String(hit.end)}|fact`;
        if (seen.has(key)) continue;
        seen.add(key);
        bind({ block, start: hit.start, end: hit.end, kind: 'fact', factId: fact.id, threadId: null, role: 'assert' });
      }
    }
    for (const thread of threads) {
      for (const hit of occurrences(block.text, thread.label)) {
        const key = `${block.spanId}|${String(hit.start)}|${String(hit.end)}|thread`;
        if (seen.has(key)) continue;
        seen.add(key);
        bind({ block, start: hit.start, end: hit.end, kind: 'thread', factId: null, threadId: thread.id, role: null });
      }
    }
    for (const found of findLiterals(block.text)) {
      const key = `${block.spanId}|${String(found.start)}|${String(found.end)}|${found.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bind({ block, start: found.start, end: found.end, kind: found.kind, factId: null, threadId: null, role: null });
      literal.run(found.literal, found.raw, block.blockId, block.spanId, input.chapter, found.kind, found.start, found.end);
      literals += 1;
    }
  }

  return { mentions, literals };
}
