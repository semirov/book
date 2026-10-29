/**
 * The ledger's side of a landing (BOOK-173, BOOK-DOC-75 §1.3, §2).
 *
 * A patch writes prose — `blocks`, `block_versions`, a revision — and the ledger does not follow by
 * itself: a mention keeps the block id it was bound to, and a block id is content-derived, so a
 * rewritten paragraph leaves every mention of it pointing at a row that no longer exists. These
 * three functions are what `engine/ripple.ts` runs inside the landing's own transaction to keep
 * the two in step, and they are **not** the graph: the dependency graph the ripple walks is
 * BOOK-185's `fact_dependency`, read by `graph/closure.ts` and written by `bin/graph.mjs`.
 *
 * The question all three ask is the same one, measured against **text, not block identity**: «is
 * this claim still asserted in the chapter as it stands?» Reading it through the block id made a
 * patched node look unasserted, which turned a mandatory node optional and made `CLOSURE_UNSTABLE`
 * unreachable — the exact bug the review of BOOK-173 found.
 */

import type { Db } from '../../db/db.ts';
import { resolveSentenceCovering } from '../../sentences/store.ts';
import { invalidateFact } from '../facts.ts';

/**
 * The facts whose claim is still asserted, measured against **text, not block identity**:
 *
 *   1. fast path — the mention is still bound to a live block and that block still holds the
 *      witness (`land` re-binds the survivors, so this is the normal case);
 *   2. survivor path — the block is gone: the witness must occur in a paragraph the chapter holds
 *      now, in paragraph order. `land` re-binds by the same rule (`rebindMentions`), so this is
 *      the fallback for rows written before a re-bind or for a mention whose block was replaced
 *      by a later watcher pass rather than by a landing;
 *   3. otherwise the claim was edited away and the fact is *not* asserted — which is what makes
 *      «its claim is still asserted» a query and not a memory of the extractor.
 */
export function assertedFacts(db: Db): Set<string> {
  const live = liveBlocksByChapter(db);
  const liveIds = new Set<string>();
  const textById = new Map<string, string>();
  for (const blocks of live.values()) {
    for (const block of blocks) {
      liveIds.add(block.id);
      textById.set(block.id, block.text);
    }
  }
  const rows = db
    .prepare(
      `SELECT m.fact_id AS factId, m.block_id AS blockId, m.chapter AS chapter, m.witness AS witness
         FROM mentions m
        WHERE m.kind = 'fact' AND m.fact_id IS NOT NULL AND m.witness != ''`,
    )
    .all() as Array<{ factId: string; blockId: string; chapter: number; witness: string }>;
  const asserted = new Set<string>();
  for (const row of rows) {
    if (asserted.has(row.factId)) continue;
    const own = liveIds.has(row.blockId) ? textById.get(row.blockId) : undefined;
    if (own !== undefined && own.includes(row.witness)) {
      asserted.add(row.factId);
      continue;
    }
    const survivors = live.get(row.chapter) ?? [];
    if (survivors.some((block) => block.text.includes(row.witness))) asserted.add(row.factId);
  }
  return asserted;
}

/** A live block of one chapter, in paragraph order — the address a mention is re-bound to. */
function liveBlocksByChapter(db: Db): Map<number, Array<{ id: string; text: string }>> {
  const rows = db.prepare('SELECT id, chapter, text FROM blocks ORDER BY chapter, idx').all() as Array<{
    id: string;
    chapter: number;
    text: string;
  }>;
  const map = new Map<number, Array<{ id: string; text: string }>>();
  for (const row of rows) {
    const list = map.get(row.chapter) ?? [];
    list.push({ id: row.id, text: row.text });
    map.set(row.chapter, list);
  }
  return map;
}

/**
 * Re-bind a chapter's mentions to its live blocks (BOOK-173 review, fix 4).
 *
 * A patch replaces the `blocks` rows of the chapter, so a mention of a rewritten paragraph keeps a
 * `block_id` that no longer exists. Re-binding is the cheap half of the fix — one indexed read of
 * the chapter's blocks and one scan of its fact mentions — and it is done **inside the landing's
 * transaction** (the ingest's own, see `engine/ripple.ts`), because «the mention follows the text
 * the same write produced» is the invariant, not a later repair. The witness is the address: the
 * mention's code-point span is recomputed where the witness now sits, in paragraph order.
 *
 * A witness the landing removed is not re-bound and not deleted: the fact row keeps its history,
 * the stale mention keeps pointing where it pointed, and `assertedFacts` reads the claim as gone.
 * Returns how many mentions moved, which is what a test and the log line need.
 */
export function rebindMentions(db: Db, chapter: number): number {
  const live = liveBlocksByChapter(db).get(chapter) ?? [];
  if (live.length === 0) return 0;
  const rows = db
    .prepare(
      `SELECT id, block_id AS blockId, witness FROM mentions
        WHERE chapter = ? AND kind = 'fact' AND witness != ''`,
    )
    .all(chapter) as Array<{ id: number; blockId: string; witness: string }>;
  const liveIds = new Set(live.map((block) => block.id));
  const update = db.prepare('UPDATE mentions SET block_id = ?, start = ?, end = ?, sentence_id = ? WHERE id = ?');
  let moved = 0;
  for (const row of rows) {
    if (liveIds.has(row.blockId)) continue;
    for (const block of live) {
      const at = block.text.indexOf(row.witness);
      if (at < 0) continue;
      const start = Array.from(block.text.slice(0, at)).length;
      const end = start + Array.from(row.witness).length;
      // ADR-044 §4 / BOOK-173 §2.4: the mention follows the **sentence** to the row the patch
      // re-attached, with the new offsets. No live sentence covers the span (it straddles a split,
      // or its row was erased) → no id: the mention keeps its block anchor, which is the legacy
      // fallback. An id is never invented and never kept past its row.
      const sentence = resolveSentenceCovering(db, { blockId: block.id, start, end });
      update.run(block.id, start, end, sentence === null ? null : sentence.id, row.id);
      moved += 1;
      break;
    }
  }
  return moved;
}

/**
 * Retire the claims a landing overran (BOOK-173 review round 3, fix 3; BOOK-DOC-75 §1.3, §2 —
 * «facts of the patched blocks are retired, their incident edges retired»).
 *
 * The question is `assertedFacts`' own, asked after the landing wrote its blocks: a fact whose
 * witness no longer occurs in the chapter's text is a claim the book stopped making, so its row is
 * **invalidated, never deleted**, with the change that dropped it. The graph follows without a
 * second step: BOOK-185's closure only walks live facts and live edges whose two ends are live, so
 * a retired fact is off the graph by the predicate, and its `fact_dependency` rows stay as the
 * history of a claim the book no longer makes.
 *
 * Two guards keep the retirement honest:
 *   · a candidate is a mention whose block **this landing replaced** — a fact whose carrier is
 *     still live is not a fact this patch overran;
 *   · a fact that is still asserted anywhere is never invalidated, and neither is one the caller
 *     names in `keep` — the landing's seeds, whose edges the plan it just froze walks over.
 *
 * `changeId` is what `factAsOf` reads to ask «false from when», so it is required: an invalidation
 * with no change would take the facts off the graph and record no reason.
 */
export function retireUnassertedFacts(
  db: Db,
  input: { chapter: number; changeId: string; keep: readonly string[]; at?: string },
): string[] {
  const candidates = db
    .prepare(
      `SELECT DISTINCT m.fact_id AS factId
         FROM mentions m JOIN facts f ON f.id = m.fact_id
        WHERE m.chapter = ? AND m.kind = 'fact' AND m.fact_id IS NOT NULL AND m.witness != ''
          AND f.invalidated_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.id = m.block_id)
        ORDER BY m.fact_id`,
    )
    .all(input.chapter) as Array<{ factId: string }>;
  if (candidates.length === 0) return [];
  const keep = new Set(input.keep);
  const asserted = assertedFacts(db);
  const retired: string[] = [];
  for (const row of candidates) {
    if (keep.has(row.factId)) continue;
    if (asserted.has(row.factId)) continue;
    invalidateFact(db, { id: row.factId, changeId: input.changeId, at: input.at });
    retired.push(row.factId);
  }
  return retired;
}
