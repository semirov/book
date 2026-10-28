/**
 * The drainer (BOOK-173, BOOK-DOC-75 §4, §6, §8) — the only writer component allowed to touch a
 * chapter other than the one the change landed on.
 *
 * It is not a second pipeline. One call of `drainRipple` is **one chapter**, and one chapter is one
 * process iteration: the step is opened by the engine's ripple door (`pass: 'cascade'`), the pass
 * patches that chapter exactly as it patches an origin chapter, the gates run, the step closes. The
 * loop is a sequence of such calls — the journal in `change_plans.iterations` is the state that
 * carries between processes, so a long ripple is a sequence of normal passes and a restart never
 * starts the budget over (`drainAll` is the same sequence in one process, for an operator run).
 * What this module owns is the loop's arithmetic, which is money and doubt:
 *
 *   · **4 iterations** — the bound is money and doubt, not depth (the measured longest path is 13);
 *   · **4 000 changed characters, cumulative** — enforced here, before each chapter, against the
 *     sum of what the iterations already spent plus this chapter's estimate;
 *   · **$0.60, cumulative** — the same shape, priced at the design's measured per-chapter cost;
 *   · **the node valve** — already applied by the plan; a truncated closure is `wide`, not a walk
 *     that stopped looking.
 *
 * Every iteration is appended to `change_plans.iterations`, so a re-run of the process reads the
 * journal rather than starting the budget over — a fixpoint cannot sneak past a cap one node at a
 * time. `CLOSURE_UNSTABLE` is the refusal the loop itself can produce: a node mandatory again after
 * its own patch, a node flipping mandatory↔optional between iterations, or a closure that does not
 * shrink while unexecuted mandatory nodes remain. It parks and does not retry.
 *
 * After the last chapter lands, and only then, `verify.ts` reads the ledger (`done` or a failure),
 * and the causality judge is the pass's own call on the chapter that landed — not a second bill
 * here.
 *
 * TODO(BOOK-173 follow-up, not implemented here): the drift read — every 10 accepted changes a
 * whole-book `sweep` pass in the writer lane, one call, «это всё ещё та же книга?»; two consecutive
 * GAPs pause the queue. Design: BOOK-DOC-75 §6; filed with the ripple, out of scope of this file.
 */

import type { WriterConfig } from '../config.ts';
import type { Db } from '../../db/db.ts';
import {
  buildPlan,
  changedChars,
  parkPlan,
  RIPPLE_MAX_CHANGED_CHARS,
  RIPPLE_MAX_ITERATIONS,
  type PlanNode,
  type RipplePlan,
} from '../../ledger/graph/plan.ts';
import { frameIntact } from '../../ingest/frameGuard.ts';
import { toIso } from '../../util/time.ts';
import { readChapter } from '../../engine/text.ts';
import { readSnapshot } from '../../versions/snapshots.ts';
import type { EngineClient } from '../client.ts';
import type { PassResult } from '../passLane.ts';
import type { ProviderCall } from '../passLane.ts';
import { readerReason } from '../reasons.ts';
import { RIPPLE_CHAPTER_USD } from './planAfterPatch.ts';
import { readLedgerFacts, verifyRipple, type VerifyResult } from './verify.ts';

/** One executed — or refused — chapter, as the journal records it. Never a plan edit. */
export type RippleIteration = {
  chapter: number;
  nodes: string[];
  changedChars: number;
  costUsd: number;
  /** `false` for an attempt the book refused: it is still a row, and it is still money. */
  landed: boolean;
  at: string;
  /**
   * The closed code of a refusal (`LANE_LOST`, `CHAPTER_REFUSED`, the engine's own code). It lives
   * in the journal and in the log — never in `park_reason`, which is the author's sentence.
   */
  code?: string;
};

/** What one chapter's pass reported. The drainer does not read prose to learn this. */
export type ChapterRun = {
  landed: boolean;
  changedChars: number;
  costUsd: number;
  reason?: string;
  /** The closed code behind the refusal, when the pass has one. */
  code?: string;
};

/**
 * How many refusals of one node park the plan (BOOK-173 review, fix 5). Two: one refusal is a
 * chapter that did not take, two is the book saying no — and a retrying driver must not pay for
 * the same refusal a third time.
 */
export const RIPPLE_MAX_REFUSALS = 2;

export type DrainInput = {
  db: Db;
  planRowId: string;
  plan: RipplePlan;
  runChapter: (chapter: number, nodes: PlanNode[]) => Promise<ChapterRun>;
  frameOk: (chapter: number) => boolean;
  now?: () => number;
};

export type DrainStatus =
  | 'continued'
  | 'done'
  | 'wide'
  | 'unstable'
  | 'verify_failed'
  | 'chapter_refused'
  | 'parked';

export type DrainOutcome = {
  status: DrainStatus;
  reason: string;
  iterations: RippleIteration[];
  plan: RipplePlan;
  verification: VerifyResult | null;
};

/** The chapter's own estimate: two copies of the claim it must repair, and never less than a line. */
const MIN_NODE_CHARS = 60;

/** Read the journal a previous process iteration wrote. */
export function readIterations(db: Db, planRowId: string): RippleIteration[] {
  const row = db.prepare('SELECT iterations FROM change_plans WHERE id = ?').get(planRowId) as
    | { iterations: string }
    | undefined;
  if (row === undefined) return [];
  try {
    const parsed = JSON.parse(row.iterations) as RippleIteration[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Append one iteration. The journal is the only column of a frozen plan that ever moves. */
export function appendIteration(db: Db, planRowId: string, iteration: RippleIteration): void {
  const journal = [...readIterations(db, planRowId), iteration];
  db.prepare('UPDATE change_plans SET iterations = ? WHERE id = ?').run(JSON.stringify(journal), planRowId);
}

/** How many times each node's chapter was refused — the count that parks a plan. */
export function refusalsPerNode(journal: readonly RippleIteration[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of journal) {
    if (entry.landed) continue;
    for (const node of entry.nodes) counts.set(node, (counts.get(node) ?? 0) + 1);
  }
  return counts;
}

/**
 * Stop the plan for good, in the book's own words (BOOK-173 review, fixes 5 and 8c).
 *
 * A park is persisted (`parked_at`/`park_reason`) and `drainablePlans` excludes it, so no driver —
 * this process, the next one, or an operator typing `--ripple` — can re-run a plan the book
 * already decided about. The reason is a sentence for the author; the code stays in the log and
 * in the journal entry that produced it. The daily money caps remain the outer bound.
 */
function park(input: DrainInput, at: number, code: string, detail: string): string {
  const sentence = readerReason(code, detail);
  parkPlan(input.db, input.planRowId, sentence, toIso(at));
  return sentence;
}

/**
 * Recompute the closure against the book as it stands. The seeds keep the components the original
 * plan measured; **the executed set is the journal's** (round 3, fix 2) — a node the change already
 * patched, this iteration or an earlier one, is not mandatory again, so a repair that keeps the
 * claim's wording leaves the mandatory set instead of parking `CLOSURE_UNSTABLE`.
 */
export function recomputePlan(db: Db, plan: RipplePlan, executedIds: readonly string[] = []): RipplePlan {
  return buildPlan({
    db,
    changeId: plan.changeId,
    chapter: plan.chapter,
    seeds: plan.seeds.map((seed) => ({ factId: seed.factId, changed: seed.changed })),
    before: '',
    after: '',
    executed: executedIds,
  });
}

function mandatoryOf(plan: RipplePlan): PlanNode[] {
  return plan.nodes.filter((node) => node.mandatory);
}

/** One table cell: one line, and never longer than a column needs. */
function clip(value: string): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`;
}

function estimateChars(node: PlanNode): number {
  return Math.max(MIN_NODE_CHARS, node.quote.length * 2);
}

/** The lowest chapter still owed work, and the nodes it owes. The origin is never touched again. */
function nextChapter(plan: RipplePlan): { chapter: number; nodes: PlanNode[] } | null {
  const pending = mandatoryOf(plan).filter((node) => node.chapter !== plan.chapter);
  if (pending.length === 0) return null;
  const chapter = Math.min(...pending.map((node) => node.chapter));
  return { chapter, nodes: pending.filter((node) => node.chapter === chapter) };
}

/**
 * The instability rule of §4: (a) a node returns to the mandatory set, (b) a node flipping
 * mandatory↔optional between two iterations, (c) a closure that did not shrink while unexecuted
 * mandatory work remains. Any of them is `CLOSURE_UNSTABLE` — park, no retry.
 *
 * **(a) reads the path, not the flag** (round 3, fix 2): an executed node is optional by
 * construction, so the doubt is a node the plan already owed coming back by a **different edge** —
 * the ripple's own edits moved its cause, and membership alone cannot tell that from a repair.
 */
function unstable(before: RipplePlan, after: RipplePlan, executed: readonly string[]): string | null {
  const executedSet = new Set(executed);
  const beforeById = new Map(before.nodes.map((node) => [node.factId, node]));
  for (const node of after.nodes) {
    if (!node.mandatory) continue;
    const prior = beforeById.get(node.factId);
    if (prior === undefined || !prior.mandatory) continue;
    if (prior.reason !== node.reason) return `${node.factId} вернулся другим ребром: ${node.reason}`;
  }
  for (const node of after.nodes) {
    const prior = beforeById.get(node.factId);
    if (prior !== undefined && prior.mandatory !== node.mandatory && !executedSet.has(node.factId)) {
      return `${node.factId} переключился ${prior.mandatory ? 'обязательный → отсрочиваемый' : 'отсрочиваемый → обязательный'}`;
    }
  }
  const left = after.nodes.filter((node) => node.mandatory && node.chapter !== after.chapter && !executedSet.has(node.factId));
  if (left.length > 0 && left.length >= before.nodes.filter((node) => node.mandatory).length) {
    return `замыкание не сузилось: ${String(left.length)} обязательных узлов осталось`;
  }
  return null;
}

/**
 * Run **one** chapter — the unit of a process iteration — and say what the book owes next.
 *
 * `continued` means the chapter landed and the closure still owes work: the next call (the next
 * process iteration) reads the journal and takes the next chapter. `done` is the fixpoint, checked
 * by `verify.ts`; `wide`, `unstable`, `verify_failed`, `parked` and `chapter_refused` are the five
 * ways it stops without one. Every stop but `chapter_refused` is written to `change_plans.parked_at`
 * — `chapter_refused` is a chapter that did not take, and the same node refusing twice becomes
 * `RIPPLE_REFUSED` (fix 5), so nothing is retried past the second answer.
 */
export async function drainRipple(input: DrainInput): Promise<DrainOutcome> {
  const at = input.now ?? Date.now;
  const journal = readIterations(input.db, input.planRowId);
  const plan = input.plan;
  const spentChars = journal.reduce((sum, entry) => sum + entry.changedChars, 0);
  const spentUsd = journal.reduce((sum, entry) => sum + entry.costUsd, 0);

  const next = nextChapter(plan);
  if (next === null) return verified(input, plan, journal, spentChars, spentUsd);

  if (journal.length >= RIPPLE_MAX_ITERATIONS) {
    const reason = park(
      input,
      at(),
      'CLOSURE_UNSTABLE',
      `${String(RIPPLE_MAX_ITERATIONS)} итерации исчерпаны, обязательные узлы остались`,
    );
    return { status: 'unstable', reason, iterations: journal, plan, verification: null };
  }

  const estimate = next.nodes.reduce((sum, node) => sum + estimateChars(node), 0);
  if (spentChars + estimate > RIPPLE_MAX_CHANGED_CHARS) {
    const reason = park(
      input,
      at(),
      'CLOSURE_BOUND',
      `глава ${String(next.chapter)} требует ~${String(estimate)} знаков, остаток ${String(RIPPLE_MAX_CHANGED_CHARS - spentChars)}`,
    );
    return { status: 'wide', reason, iterations: journal, plan, verification: null };
  }
  if (spentUsd + RIPPLE_CHAPTER_USD > plan.bounds.usd) {
    const reason = park(
      input,
      at(),
      'CLOSURE_BOUND',
      `глава ${String(next.chapter)} выводит сумму за $${plan.bounds.usd.toFixed(2)}`,
    );
    return { status: 'wide', reason, iterations: journal, plan, verification: null };
  }

  const run = await input.runChapter(next.chapter, next.nodes);
  const executed = next.nodes.map((node) => node.factId);
  if (!run.landed) {
    // BOOK-173 review, fix 5: a refusal is an attempt, and an attempt is a journal row — the code,
    // the money it burnt and the moment. Without this the plan stayed drainable and a retrying
    // driver paid for the same refusal forever.
    const attempt: RippleIteration = {
      chapter: next.chapter,
      nodes: executed,
      changedChars: run.changedChars,
      costUsd: run.costUsd,
      landed: false,
      at: toIso(at()),
      code: run.code ?? 'CHAPTER_REFUSED',
    };
    journal.push(attempt);
    appendIteration(input.db, input.planRowId, attempt);
    const refusals = refusalsPerNode(journal);
    const twice = next.nodes.find((node) => (refusals.get(node.factId) ?? 0) >= RIPPLE_MAX_REFUSALS);
    const detail = `глава ${String(next.chapter)} не легла: ${run.reason ?? 'правка не принята'}`;
    if (twice !== undefined) {
      const reason = park(input, at(), 'RIPPLE_REFUSED', detail);
      return { status: 'parked', reason, iterations: journal, plan, verification: null };
    }
    return { status: 'chapter_refused', reason: detail.slice(0, 300), iterations: journal, plan, verification: null };
  }
  const iteration: RippleIteration = {
    chapter: next.chapter,
    nodes: executed,
    changedChars: run.changedChars,
    costUsd: run.costUsd,
    landed: true,
    at: toIso(at()),
  };
  journal.push(iteration);
  appendIteration(input.db, input.planRowId, iteration);

  // The journal's landed work is the executed set (fix 2): the node just patched is not mandatory again.
  const done = journal.filter((entry) => entry.landed).flatMap((entry) => entry.nodes);
  const recomputed = recomputePlan(input.db, plan, done);
  const why = unstable(plan, recomputed, done);
  if (why !== null) {
    const reason = park(input, at(), 'CLOSURE_UNSTABLE', `${why}`);
    return { status: 'unstable', reason, iterations: journal, plan: recomputed, verification: null };
  }
  if (nextChapter(recomputed) === null) {
    return verified(input, recomputed, journal, spentChars + run.changedChars, spentUsd + run.costUsd);
  }
  return {
    status: 'continued',
    reason: `глава ${String(next.chapter)} легла; замыкание продолжается`,
    iterations: journal,
    plan: recomputed,
    verification: null,
  };
}

/** The same sequence in one process: what `--ripple` runs, and what a test drives in a loop. */
export async function drainAll(input: DrainInput): Promise<DrainOutcome> {
  let outcome = await drainRipple(input);
  while (outcome.status === 'continued') {
    outcome = await drainRipple({ ...input, plan: outcome.plan });
  }
  return outcome;
}

/** The fixpoint check: nothing mandatory is left, so the ledger answers for the whole ripple. */
function verified(
  input: DrainInput,
  plan: RipplePlan,
  journal: RippleIteration[],
  spentChars: number,
  spentUsd: number,
): DrainOutcome {
  const changedChapters = [plan.chapter, ...journal.filter((entry) => entry.landed).map((entry) => entry.chapter)];
  const verification = verifyRipple({
    plan: input.plan,
    recomputed: plan,
    changedChapters,
    facts: readLedgerFacts(input.db),
    frameOk: input.frameOk,
    executed: journal.flatMap((entry) => entry.nodes),
  });
  if (!verification.ok) {
    const first = verification.failures[0];
    const reason = park(input, (input.now ?? Date.now)(), first?.code ?? 'CLOSURE_DRIFT', first?.detail ?? '');
    return { status: 'verify_failed', reason, iterations: journal, plan, verification };
  }
  return {
    status: 'done',
    reason: `замыкание пройдено: ${String(journal.length)} глав, ${String(spentChars)} знаков, $${spentUsd.toFixed(2)}`,
    iterations: journal,
    plan,
    verification,
  };
}

type BlockDiff = { before: string; after: string };

/**
 * The readable before/after of one block, from `block_versions` by `blockId` (§6): the current
 * version's text is the `after`, and the version it superseded is the `before` when that row is a
 * checkpoint. The diff is never stored in the plan — the text keeps one home — and a version chain
 * that kept no text prints «—» instead of inventing one.
 */
function blockDiffOf(db: Db, blockId: string): BlockDiff | null {
  const current = db
    .prepare('SELECT block_uid AS uid, ver, text, prev_ver AS prev FROM block_versions WHERE block_id = ? ORDER BY ver DESC LIMIT 1')
    .get(blockId) as { uid: string; ver: number; text: string; prev: number | null } | undefined;
  const live = db.prepare('SELECT text FROM blocks WHERE id = ?').get(blockId) as { text: string } | undefined;
  if (current === undefined) return live === undefined ? null : { before: '', after: live.text };
  const previous =
    current.prev === null
      ? undefined
      : (db.prepare('SELECT text AS text FROM block_versions WHERE block_uid = ? AND ver = ?').get(current.uid, current.prev) as
          | { text: string }
          | undefined);
  return {
    before: previous?.text ?? '',
    after: current.text.length > 0 ? current.text : (live?.text ?? ''),
  };
}

/**
 * The reviewable table (§6): per chapter and block, the block's readable before → after, the claim
 * the plan puts there, why, whether it is mandatory, and its price.
 */
export function planTable(db: Db, plan: RipplePlan): string[] {
  const rows: string[] = [
    `план ${plan.changeId}: ${plan.outcome}${plan.proven ? '' : ' · не доказан'}, ` +
      `${String(plan.closureSize.nodes)} узлов / ${String(plan.closureSize.edges)} связей / ${String(plan.chaptersTouched.length)} глав`,
  ];
  for (const node of plan.nodes) {
    const diff = node.blockId === null ? null : blockDiffOf(db, node.blockId);
    const quote = node.quote.length > 0 ? node.quote : '(без цитаты)';
    const before = diff === null || diff.before.length === 0 ? '—' : `«${clip(diff.before)}»`;
    const text = diff === null ? '—' : `${before} → «${clip(diff.after)}»`;
    rows.push(
      [
        `гл. ${String(node.chapter)}`,
        node.blockId ?? '—',
        text,
        `«${clip(quote)}»`,
        node.reason,
        node.mandatory ? 'обязательный' : 'отсрочиваемый',
        node.mandatory ? `$${RIPPLE_CHAPTER_USD.toFixed(2)}` : '—',
      ].join(' · '),
    );
  }
  return rows;
}

/** The chapter's changed characters between its last two revisions — the drainer's own measure. */
export function chapterChangedChars(db: Db, dataDir: string, chapter: number): number {
  const rows = db
    .prepare('SELECT snapshot FROM revisions WHERE chapter = ? ORDER BY rev DESC LIMIT 2')
    .all(chapter) as Array<{ snapshot: string }>;
  const after = rows[0] === undefined ? null : readSnapshot(dataDir, rows[0].snapshot);
  const before = rows[1] === undefined ? null : readSnapshot(dataDir, rows[1].snapshot);
  if (after === null) return 0;
  return changedChars(before ?? '', after);
}

/**
 * The frame probe the verification uses: the chapter as it stands on disk against the frozen
 * frame. A missing file is not a changed frame — it is a chapter the ripple never wrote.
 */
export function frameProbe(bookRoot: string): (chapter: number) => boolean {
  return (chapter) => {
    const own = readChapter(bookRoot, chapter);
    if (!own.exists) return true;
    try {
      return frameIntact(chapter, own.raw);
    } catch {
      return false;
    }
  };
}

/** The one-chapter runner `main.ts --ripple` hands the loop: a normal pass through the ripple door. */
export type DrainPassInput = {
  db: Db;
  config: WriterConfig;
  bookRoot: string;
  dataDir: string;
  engine: EngineClient;
  provider: ProviderCall;
  now: () => number;
  log: (line: string) => void;
  pass: (ripple: { chapter: number; changeId: string; reason: string; claim: string }) => Promise<PassResult>;
};

/** Turn one plan node set into the synthetic assignment's data block, then run the pass. */
export async function runDrainChapter(
  input: DrainPassInput,
  plan: RipplePlan,
  chapter: number,
  nodes: PlanNode[],
): Promise<ChapterRun> {
  const claim = nodes.map((node) => `«${node.quote}» — ${node.reason}`).join('; ').slice(0, 600);
  const result = await input.pass({
    chapter,
    changeId: plan.changeId,
    reason: nodes[0]?.reason ?? 'CAUSE_CHANGED',
    claim,
  });
  return {
    landed: result.status === 'closed',
    changedChars: chapterChangedChars(input.db, input.dataDir, chapter),
    costUsd: result.costUsd ?? 0,
    code: result.code ?? (result.status === 'closed' ? undefined : 'CHAPTER_REFUSED'),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}
