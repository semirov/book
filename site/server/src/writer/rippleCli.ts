/**
 * `--plan <changeId>` and `--ripple` — the two commands that read the ripple (BOOK-173).
 *
 * They live here rather than in `main.ts` for the same reason `--backfill-ledger` does: the CLI
 * file is the argument parser, and every command that needs the ledger, the lane and the engine
 * belongs next to its own rules. Both read the engine's database directly — the short-lived
 * reader `--revert` uses, because the CLI is co-located with the engine by construction — and
 * neither writes prose: `--plan` prints, `--ripple` drains the plan still owed work.
 *
 * **The interface, in one place** (review fix 8a):
 *
 *   · `0` — every plan finished, or nothing to do;
 *   · `1` — a plan is parked (wide, unstable, refused, a chapter that did not take, or a judge
 *     that found a GAP); the line says which, in the author's words;
 *   · `2` — the run could not start (config, database, engine door).
 *
 * `--plan <changeId>` answers `1` when that change has no plan: «nothing printed» is not success.
 *
 * **One loop iteration is one chapter and one normal pass.** The journal in
 * `change_plans.iterations` carries the state between them, so a killed run resumes where the
 * supervisor would have restarted it — `drainAll` saves the process, not the state. The plan is
 * claimed before the first chapter and released after the last (review fix 6), so two `--ripple`
 * processes never take the same plan; the second says one line and exits.
 */

import type { Db } from '../db/db.ts';
import { drainablePlans, latestPlan } from '../engine/ripple.ts';
import { claimPlan, claimedPlans, parkedPlans, releasePlanClaim } from '../ledger/graph/plan.ts';
import type { EngineClient } from './client.ts';
import { runPass } from './pass.ts';
import type { ProviderCall } from './passLane.ts';
import { drainAll, frameProbe, planTable, runDrainChapter } from './ripple/drain.ts';

/** `--plan <changeId>`: print the reviewable table. `1` when the change has no plan. */
export function runPlanCli(input: { db: Db; changeId: string | null; log: (line: string) => void }): number {
  const found = input.changeId === null ? null : latestPlan(input.db, input.changeId);
  if (found === null) {
    input.log(`[writer] план для ${input.changeId ?? '—'} не найден`);
    return 1;
  }
  for (const row of planTable(input.db, found.plan)) input.log(row);
  return 0;
}

export type RippleCliInput = {
  db: Db;
  config: Parameters<typeof runPass>[0]['config'];
  bookRoot: string;
  dataDir: string;
  engine: EngineClient;
  provider: ProviderCall;
  now: () => number;
  log: (line: string) => void;
  /** Who holds the plan while it is drained (`hostname:pid`). */
  claimedBy: string;
  /**
   * Test seam: the loop itself. Everything above — the claim, the release, the exit code — is the
   * interface this file owns, and it is worth proving without a model call per chapter.
   */
  drain?: typeof drainAll;
};

/** `--ripple`: drain the oldest plan still owed work, one chapter per iteration. */
export async function runRippleCli(input: RippleCliInput): Promise<number> {
  const queued = drainablePlans(input.db, input.now());
  if (queued.length === 0) {
    // Say which: a parked plan is a decision the author owes, and a claimed one belongs to another
    // process — neither is «nothing to do» that a reader should have to guess.
    const parked = parkedPlans(input.db)[0];
    if (parked !== undefined) {
      input.log(`[writer] ripple: план ${parked.changeId} припаркован (${parked.at}): ${parked.reason}`);
      return 1;
    }
    const claimed = claimedPlans(input.db, input.now())[0];
    if (claimed !== undefined) {
      input.log(`[writer] ripple: план ${claimed.changeId} уже взят другим процессом (${claimed.claimedBy}) — пропуск`);
      return 0;
    }
    input.log('[writer] ripple: незакрытых планов нет');
    return 0;
  }
  const oldest = queued[0] as (typeof queued)[number];
  if (!claimPlan(input.db, oldest.planRowId, input.claimedBy, input.now())) {
    input.log('[writer] ripple: план уже взят другим процессом — пропуск');
    return 0;
  }
  let outcome;
  try {
    outcome = await (input.drain ?? drainAll)({
      db: input.db,
      planRowId: oldest.planRowId,
      plan: oldest.plan,
      frameOk: frameProbe(input.bookRoot),
      now: input.now,
      runChapter: (chapter, nodes) =>
        runDrainChapter(
          {
            db: input.db,
            config: input.config,
            bookRoot: input.bookRoot,
            dataDir: input.dataDir,
            engine: input.engine,
            provider: input.provider,
            now: input.now,
            log: input.log,
            pass: (ripple) =>
              runPass({
                config: input.config,
                bookRoot: input.bookRoot,
                dataDir: input.dataDir,
                engine: input.engine,
                provider: input.provider,
                now: input.now,
                log: input.log,
                chapter: null,
                ripple,
                dryRun: false,
              }),
          },
          oldest.plan,
          chapter,
          nodes,
        ),
    });
  } finally {
    releasePlanClaim(input.db, oldest.planRowId, input.claimedBy);
  }
  for (const entry of outcome.iterations) {
    input.log(
      `[writer] ripple ${String(entry.chapter)}: ${entry.landed ? 'легла' : `отказ ${entry.code ?? ''}`}, ` +
        `${String(entry.changedChars)} знаков, $${entry.costUsd.toFixed(4)}, узлов ${String(entry.nodes.length)}`,
    );
  }
  input.log(`[writer] ripple ${outcome.status}: ${outcome.reason}`);
  return outcome.status === 'done' ? 0 : 1;
}
