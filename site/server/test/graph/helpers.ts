/**
 * Fixtures for the closure (BOOK-174). The graph is seeded row by row rather than extracted from
 * a chapter: the closure is a query over the ledger, and a test that had to build blocks and
 * mentions first would be testing the extractor a second time instead of the walk.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { databaseFile, openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import type { ClosureNode } from '../../src/graph/closure.ts';

export const AT = '2026-10-28T12:00:00Z';

export type GraphFixture = { db: Db; dataDir: string; close: () => void };

export function graphFixture(): GraphFixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'book-graph-closure-'));
  const db = openDatabase(databaseFile(dataDir));
  migrate(db);
  return {
    db,
    dataDir,
    close: () => {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function seedFact(
  db: Db,
  input: { id: string; chapter: number; kind?: string; key?: string; sentence?: string },
): string {
  const key = input.key ?? input.id;
  db.prepare(
    `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, created_at, key, sentence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.chapter,
    input.kind ?? 'term',
    input.sentence ?? `statement ${input.id}`,
    key,
    input.chapter,
    AT,
    key,
    input.sentence ?? `sentence ${input.id}`,
  );
  return input.id;
}

export function seedEdge(
  db: Db,
  input: {
    id: string;
    from: string;
    to: string;
    chapter: number;
    kind?: string;
    statement?: string;
    supersededBy?: string | null;
    /** BOOK-DOC-77: the extraction run that retired the whole pass this edge came from. */
    retiredByRun?: string | null;
  },
): string {
  db.prepare(
    `INSERT INTO fact_dependency
       (id, "from", "to", chapter, kind, stance, statement, origin, step_id, rev, superseded_by, at,
        retired_by_run)
     VALUES (?, ?, ?, ?, ?, 'plain', ?, 'inferred', 'test', 1, ?, ?, ?)`,
  ).run(
    input.id,
    input.from,
    input.to,
    input.chapter,
    input.kind ?? 'cause',
    input.statement ?? `${input.from} → ${input.to}`,
    input.supersededBy ?? null,
    AT,
    input.retiredByRun ?? null,
  );
  return input.id;
}

/** One extraction run, for the rows that name it (BOOK-DOC-77). */
export function seedRun(db: Db, input: { id: string; chapter?: number; pass?: 'extract' | 'recall' }): string {
  db.prepare(
    `INSERT INTO extraction_runs (id, chapter, rev, text_sha, prompt_sha, model, pass, at, status)
     VALUES (?, ?, 1, 'sha-text', 'sha-prompt', 'test-model', ?, ?, 'ok')`,
  ).run(input.id, input.chapter ?? 1, input.pass ?? 'extract', AT);
  return input.id;
}

export function seedMention(
  db: Db,
  input: { factId: string; chapter: number; witness: string; blockId?: string; start?: number },
): void {
  const blockId = input.blockId ?? `blk_${String(input.chapter)}_1`;
  const start = input.start ?? 0;
  db.prepare(
    `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, role, witness)
     VALUES (?, ?, ?, ?, ?, 'fact', ?, 'assert', ?)`,
  ).run(`spn_${input.factId}_${String(start)}`, blockId, input.chapter, start, start + input.witness.length, input.factId, input.witness);
}

/** A closure node with only the fields a test cares about set, the rest filled in plausibly. */
export function nodeOf(factId: string, chapter: number, over: Partial<ClosureNode> = {}): ClosureNode {
  return {
    factId,
    key: `term:${factId}`,
    kind: 'term',
    chapter,
    distance: 1,
    chapterDistance: 1,
    direction: 'descendant',
    via: `dep_${factId}`,
    ...over,
  };
}

/**
 * Converging support: `diamonds` diamonds in a chain, three facts each plus one root.
 *
 * Each diamond splits its base into two facts and joins them again, and the *join* is the next
 * diamond's base — so the last join is reachable by 2^22 simple paths while the graph holds 67
 * facts and 88 edges. That is what a walk enumerating paths multiplies (35 s measured on this
 * fixture) and what a node-deduped walk does not (2 ms).
 */
export function diamondChain(db: Db, diamonds = 22): { facts: number; edges: number } {
  seedFact(db, { id: 'fct_root', chapter: 1, key: 'term:root' });
  let base = 'fct_root';
  for (let index = 0; index < diamonds; index += 1) {
    const chapter = 1 + (index % 12);
    for (const side of ['a', 'b'] as const) {
      seedFact(db, { id: `fct_${side}${String(index)}`, chapter, key: `term:${side}${String(index)}` });
      seedEdge(db, { id: `dep_${side}${String(index)}`, from: base, to: `fct_${side}${String(index)}`, chapter });
    }
    seedFact(db, { id: `fct_c${String(index)}`, chapter, key: `term:c${String(index)}` });
    seedEdge(db, { id: `dep_ac${String(index)}`, from: `fct_a${String(index)}`, to: `fct_c${String(index)}`, chapter });
    seedEdge(db, { id: `dep_bc${String(index)}`, from: `fct_b${String(index)}`, to: `fct_c${String(index)}`, chapter });
    base = `fct_c${String(index)}`;
  }
  return { facts: 1 + diamonds * 3, edges: diamonds * 4 };
}
