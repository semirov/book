/**
 * The ripple's verification after a chapter lands (BOOK-173, BOOK-DOC-75 §5) — code, and only code.
 *
 * Five questions, all of them `SELECT`s, all of them ≤ a few milliseconds on the real graph:
 *
 *   1. **the ledger is closed** — every `edges` endpoint is a live fact (`FACT_DANGLING`), and no
 *      fact is used before the chapter that established it (`CAUSE_UNSUPPORTED`);
 *   2. **the frames hold** — `frameIntact` for every chapter the ripple changed (`FRAME_CHANGED`);
 *   3. **the chapter is irreversible** — every changed chapter has ≥1 live fact of kind
 *      `decision` / `document` / `erasure` asserted there (`IRREVERSIBLE_LOST`). This reads the
 *      ledger's own rows, never a regex over prose: «irreversible» is a claim about the world;
 *   4. **the plan still describes the book** — the recomputed closure is a subset of the planned
 *      nodes plus the ones that became mandatory while we worked (`CLOSURE_DRIFT`);
 *   5. nothing here judges prose: the gates do that, and this module does not repeat them.
 *
 * The rows are read through `readLedgerFacts`, which the engine (or a co-located CLI, like
 * `--revert`) can call on the engine's own database; the frame probe is injected so a test needs no
 * book on disk. No model, no network, no write.
 */

import type { Db } from '../../db/db.ts';
import { factAsOf } from '../../ledger/facts.ts';
import type { RipplePlan } from '../../ledger/graph/plan.ts';

export type LiveFact = { chapter: number; validFrom: number; kind: string };

/** The snapshot the checks read: live facts, every edge, every `use`-mention. */
export type LedgerFacts = {
  live: ReadonlyMap<string, LiveFact>;
  edges: ReadonlyArray<{ id: string; from: string; to: string }>;
  uses: ReadonlyArray<{ factId: string; chapter: number }>;
};

export type VerifyCode =
  | 'FACT_DANGLING'
  | 'CAUSE_UNSUPPORTED'
  | 'FRAME_CHANGED'
  | 'IRREVERSIBLE_LOST'
  | 'CLOSURE_DRIFT';

export type VerifyFailure = { code: VerifyCode; detail: string };
export type VerifyResult = { ok: boolean; failures: VerifyFailure[] };

/** The irreversible kinds: a chapter that holds one of these has closed a door (BOOK-DOC-75 §5). */
export const IRREVERSIBLE_KINDS = ['decision', 'document', 'erasure'] as const;

export type VerifyInput = {
  plan: RipplePlan;
  /** The plan recomputed against the book as it stands now (the closure, narrowed). */
  recomputed: RipplePlan;
  /** Every chapter the ripple wrote, the origin included. */
  changedChapters: readonly number[];
  facts: LedgerFacts;
  /** `frameIntact` for one chapter — injected, so the check needs no manuscript in a test. */
  frameOk: (chapter: number) => boolean;
  /** The nodes the change executed: a node executed and still mandatory is drift, not work. */
  executed?: readonly string[];
};

/**
 * Read the snapshot. `asOf` is the chapter the ledger is read at: 42 — «what stands in the whole
 * book now» — because a dangling endpoint or an early use is a fact about the book, not about one
 * chapter of it.
 */
export function readLedgerFacts(db: Db, asOf = 42): LedgerFacts {
  const live = new Map<string, LiveFact>();
  for (const fact of factAsOf(db, asOf)) {
    live.set(fact.id, { chapter: fact.chapter, validFrom: fact.valid_from_chapter, kind: fact.kind });
  }
  const edges = db.prepare('SELECT id, from_fact AS "from", to_fact AS "to" FROM edges ORDER BY id').all() as Array<{
    id: string;
    from: string;
    to: string;
  }>;
  const uses = db
    .prepare(
      `SELECT fact_id AS factId, chapter FROM mentions
        WHERE role = 'use' AND kind = 'fact' AND fact_id IS NOT NULL
        ORDER BY chapter, fact_id`,
    )
    .all() as Array<{ factId: string; chapter: number }>;
  return { live, edges, uses };
}

function ledgerClosed(facts: LedgerFacts): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  for (const edge of facts.edges) {
    if (!facts.live.has(edge.from)) {
      failures.push({ code: 'FACT_DANGLING', detail: `${edge.id}: from ${edge.from} is not a live fact` });
    }
    if (!facts.live.has(edge.to)) {
      failures.push({ code: 'FACT_DANGLING', detail: `${edge.id}: to ${edge.to} is not a live fact` });
    }
  }
  for (const use of facts.uses) {
    const fact = facts.live.get(use.factId);
    if (fact === undefined) continue; // a retired fact is the dangling question, not this one
    if (fact.validFrom > use.chapter) {
      failures.push({
        code: 'CAUSE_UNSUPPORTED',
        detail: `${use.factId} is used in chapter ${String(use.chapter)} but established in ${String(fact.validFrom)}`,
      });
    }
  }
  return failures;
}

function irreversible(facts: LedgerFacts, chapters: readonly number[]): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  const kinds = new Set<string>(IRREVERSIBLE_KINDS);
  for (const chapter of chapters) {
    const holds = [...facts.live.values()].some((fact) => fact.chapter === chapter && kinds.has(fact.kind));
    if (!holds) {
      failures.push({
        code: 'IRREVERSIBLE_LOST',
        detail: `глава ${String(chapter)} changed but holds no live decision, document or erasure`,
      });
    }
  }
  return failures;
}

function planEquality(plan: RipplePlan, recomputed: RipplePlan, executed: readonly string[]): VerifyFailure[] {
  const planned = new Set([...plan.nodes.map((node) => node.factId), ...executed]);
  const mandatory = new Set(recomputed.nodes.filter((node) => node.mandatory).map((node) => node.factId));
  const failures: VerifyFailure[] = [];
  for (const node of recomputed.nodes) {
    if (planned.has(node.factId) || mandatory.has(node.factId)) continue;
    failures.push({
      code: 'CLOSURE_DRIFT',
      detail: `${node.factId} (глава ${String(node.chapter)}) is in the closure now and was neither planned nor mandatory`,
    });
  }
  return failures;
}

/** All five checks, in the design's order. The first failure is not the only one reported. */
export function verifyRipple(input: VerifyInput): VerifyResult {
  const chapters = [...new Set(input.changedChapters)].sort((left, right) => left - right);
  const failures: VerifyFailure[] = [...ledgerClosed(input.facts)];
  for (const chapter of chapters) {
    if (!input.frameOk(chapter)) {
      failures.push({ code: 'FRAME_CHANGED', detail: `рамка главы ${String(chapter)} не та, что в каноне` });
    }
  }
  failures.push(...irreversible(input.facts, chapters));
  failures.push(...planEquality(input.plan, input.recomputed, input.executed ?? []));
  return { ok: failures.length === 0, failures };
}
