/**
 * Writing one validated answer into the graph — the persistence half of BOOK-185 (BOOK-DOC-77 §5).
 *
 * One transaction, one order, and every step is idempotent in the rows it owns:
 *
 *   1. **facts** — upserted by a key-derived id, so a re-run is the same rows; a fact of this
 *      chapter the answer no longer states is superseded, never deleted (`persistFacts.ts`);
 *   2. **mentions** — the chapter's fact mentions are replaced and bound at the accepted offsets;
 *   3. **literals** — the date and document index of the chapter is rebuilt from its live text;
 *   4. **edges** — upserted by `dep_<sha1(from|to|kind|chapter)>`, retired when the answer drops
 *      them (`retired_by_run`), never deleted;
 *   5. **threads** — events replaced per chapter, state and `closed_at_chapter` replayed
 *      (`persistThreads.ts`);
 *   6. **gap** — `chapters.ledger_gap` recomputed from what is now bound;
 *   7. **form assertions, last** — `FACT_NOT_ESTABLISHED` and `FRAME_CHANGED`. Both are asked
 *      inside the transaction so the rows they condemn are still uncommitted: a rollback undoes
 *      the whole answer, and the caller records the run as refused instead of a half-written
 *      chapter.
 *
 * The edge ids are derived from the claim and not from the run for the same reason as the facts':
 * `fact_dependency` has `UNIQUE (from_fact, to_fact, kind, chapter)`, and a stable id means the
 * upsert keeps the row (and its history) instead of colliding with it.
 */

import type { Db } from '../db/db.ts';
import { getChapterRow } from '../db/repo/chapters.ts';
import { countUnboundFactShaped } from '../ledger/factShaped.ts';
import { parseSpans } from '../ledger/spans.ts';
import type { AcceptedEdge, EdgeEndpoint, ValidateResult } from './judged.ts';
import { assertFactsEstablished } from './integrity.ts';
import {
  factIdOf,
  persistFacts,
  persistLiterals,
  persistMentions,
  stampFor,
  type ExtractionStamp,
} from './persistFacts.ts';
import { persistThreads } from './persistThreads.ts';
import type { Block } from './quote.ts';
import { clip, idOf } from './text.ts';

export type { ExtractionStamp } from './persistFacts.ts';

/** `statement` is the one-line reading aid of an edge; the column's convention is ≤200 chars. */
const EDGE_STATEMENT_LIMIT = 200;

/**
 * The chapter changed between the read and the write. A run that answered one revision must not
 * be written into another: the block ids, the offsets and the sha would all be about text that
 * is gone.
 */
export class FrameChangedError extends Error {
  readonly code = 'FRAME_CHANGED';

  constructor(readonly chapter: number) {
    super(`FRAME_CHANGED: chapter ${String(chapter)} changed while it was being extracted`);
    this.name = 'FrameChangedError';
  }
}

/**
 * The span that last wrote each block: the last entry of its newest `block_versions.spans`, or
 * `ext:<run id>:<blockIdx>` when the block carries none (an imported chapter, whose versions are
 * checkpoints with `spans = '[]'`). The index is part of the fallback because `mentions_span` is
 * unique on `(span_id, start, end, kind)`: two blocks of one chapter would otherwise collide at
 * the same offsets. The run id makes the fallback stable across a re-run of the same question.
 */
export function spanIdsOf(
  db: Db,
  chapter: number,
  blocks: readonly Block[],
  runId: string,
): Map<string, string> {
  const rows = db
    .prepare(`SELECT block_id, spans FROM block_versions WHERE chapter = ? ORDER BY ver`)
    .all(chapter) as Array<{ block_id: string; spans: string | null }>;
  const known = new Map<string, string>();
  for (const row of rows) {
    const last = parseSpans(row.spans).at(-1);
    if (last !== undefined) known.set(row.block_id, last.span_id);
  }
  const ids = new Map<string, string>();
  blocks.forEach((block, index) => {
    ids.set(block.id, known.get(block.id) ?? `ext:${runId}:${String(index)}`);
  });
  return ids;
}

export type PersistInput = {
  chapter: number;
  /** The chapter's revision: the edge row's `rev`, and part of the edge's identity. */
  rev: number;
  /** The chapter's text sha the answer was produced from — the frame check compares it. */
  textSha: string;
  run: ExtractionStamp;
  /** The recall run, when the answer is a merge: an item it first produced carries its stamp. */
  recallRun?: ExtractionStamp;
  /** The chapter's blocks in reading order. */
  blocks: readonly Block[];
  answer: ValidateResult;
};

export type PersistResult = {
  /** Facts this chapter asserts (rows upserted, one per key). */
  facts: number;
  /** Mentions that consume a fact established in an earlier chapter. */
  uses: number;
  mentions: number;
  literals: number;
  edges: number;
  threads: number;
  gap: number;
  /** Facts this run retired (`invalidated_at` + `superseded_by_extraction`). */
  supersededFacts: string[];
  /** Edges this run retired (`retired_by_run`). */
  retiredEdges: string[];
};

/** `dep_<sha1(from|to|kind|chapter)[0..20]>`: an edge named by its claim and the chapter it is told. */
export function edgeIdOf(from: string, to: string, kind: string, chapter: number): string {
  return idOf('dep', `${from}|${to}|${kind}|${String(chapter)}`);
}

function endpointId(endpoint: EdgeEndpoint, ids: ReadonlyMap<string, string>): string {
  return ids.get(endpoint.key) ?? endpoint.factId ?? factIdOf(endpoint.key);
}

const UPSERT_EDGE = `
INSERT INTO fact_dependency
  (id, from_fact, to_fact, chapter, kind, stance, line, statement, origin, step_id, rev,
   superseded_by, at, extracted_by, retired_by_run)
VALUES (@id, @fromFact, @toFact, @chapter, @kind, 'plain', NULL, @statement, 'inferred', @stepId,
        @rev, NULL, @at, @extractedBy, NULL)
ON CONFLICT DO UPDATE SET
  stance = 'plain',
  statement = excluded.statement,
  origin = 'inferred',
  step_id = excluded.step_id,
  rev = excluded.rev,
  at = excluded.at,
  extracted_by = excluded.extracted_by,
  superseded_by = NULL,
  retired_by_run = NULL`;

type PersistEdgesInput = {
  chapter: number;
  rev: number;
  at: string;
  run: ExtractionStamp;
  edges: readonly AcceptedEdge[];
  factIds: ReadonlyMap<string, string>;
  recallRun?: ExtractionStamp;
};

/** Write this chapter's edges and retire the ones the answer no longer tells. */
function persistEdges(db: Db, input: PersistEdgesInput): { written: number; retired: string[] } {
  const upsert = db.prepare(UPSERT_EDGE);
  const written = new Set<string>();
  for (const edge of input.edges) {
    const from = endpointId(edge.from, input.factIds);
    const to = endpointId(edge.to, input.factIds);
    const id = edgeIdOf(from, to, edge.kind, input.chapter);
    upsert.run({
      id,
      fromFact: from,
      toFact: to,
      chapter: input.chapter,
      kind: edge.kind,
      statement: clip(edge.statement ?? `${edge.from.key} → ${edge.to.key}`, EDGE_STATEMENT_LIMIT),
      stepId: input.run.id,
      rev: input.rev,
      at: input.at,
      extractedBy: stampFor(input.run, input.recallRun, edge.pass),
    });
    written.add(`${from}|${to}|${edge.kind}`);
  }

  // Edges of this chapter that no longer stand: retired by this run, never deleted. The tuple is
  // compared, not the id, because a row written before the ids were derived keeps its own id.
  const rows = db
    .prepare(
      `SELECT id, from_fact AS fromFact, to_fact AS toFact, kind FROM fact_dependency
        WHERE chapter = ? AND superseded_by IS NULL AND retired_by_run IS NULL
        ORDER BY id`,
    )
    .all(input.chapter) as Array<{ id: string; fromFact: string; toFact: string; kind: string }>;
  const retire = db.prepare(`UPDATE fact_dependency SET retired_by_run = ? WHERE id = ?`);
  const retired: string[] = [];
  for (const row of rows) {
    if (written.has(`${row.fromFact}|${row.toFact}|${row.kind}`)) continue;
    retire.run(input.run.id, row.id);
    retired.push(row.id);
  }
  return { written: written.size, retired };
}

/**
 * Write one validated answer. The caller has already asked the validator; this function only
 * decides what the transaction does, and refuses the whole answer when the graph or the frame
 * says no.
 */
export function persistExtraction(db: Db, input: PersistInput): PersistResult {
  return db.transaction((): PersistResult => {
    const answer = input.answer;
    const spanIds = spanIdsOf(db, input.chapter, input.blocks, input.run.id);

    const facts = persistFacts(db, {
      chapter: input.chapter,
      at: input.run.at,
      run: input.run,
      ...(input.recallRun === undefined ? {} : { recallRun: input.recallRun }),
      facts: answer.facts,
    });
    const mentions = persistMentions(db, {
      chapter: input.chapter,
      facts: answer.facts,
      uses: answer.uses,
      ids: facts.ids,
      bound: facts.bound,
      spanIds,
    });
    const literals = persistLiterals(db, { chapter: input.chapter, blocks: input.blocks, spanIds });
    const edges = persistEdges(db, {
      chapter: input.chapter,
      rev: input.rev,
      at: input.run.at,
      run: input.run,
      ...(input.recallRun === undefined ? {} : { recallRun: input.recallRun }),
      edges: answer.edges,
      factIds: facts.ids,
    });
    const threads = persistThreads(db, {
      chapter: input.chapter,
      at: input.run.at,
      run: input.run,
      ...(input.recallRun === undefined ? {} : { recallRun: input.recallRun }),
      threads: answer.threads,
      factIds: facts.ids,
    });

    const gap = countUnboundFactShaped(db, input.chapter);
    db.prepare('UPDATE chapters SET ledger_gap = ? WHERE n = ?').run(gap, input.chapter);

    // The form assertions come last, and both of them ask about the rows above.
    assertFactsEstablished(db);
    const row = getChapterRow(db, input.chapter);
    if (row === undefined || row.sha256 !== input.textSha) throw new FrameChangedError(input.chapter);

    return {
      facts: facts.ids.size,
      uses: mentions.uses,
      mentions: mentions.mentions,
      literals,
      edges: edges.written,
      threads,
      gap,
      supersededFacts: facts.superseded,
      retiredEdges: edges.retired,
    };
  })();
}
