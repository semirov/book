/**
 * The ripple CLI's interface (BOOK-173 review, fixes 6 and 8a) — the claim, the release and the
 * exit code, with the drain loop injected.
 *
 * What is proven here is the part `main` promises an operator: one process takes a plan, a second
 * one skips it and says so, the claim is given back whatever the loop did, and the exit code says
 * `0` finished / `1` parked / `2` could not run. The loop's own arithmetic has its own tests
 * (`ripple/drain.test.ts`); this file is about the door in front of it.
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { claimPlan, storePlan, type RipplePlan } from '../../src/ledger/graph/plan.ts';
import type { DrainOutcome } from '../../src/writer/ripple/drain.ts';
import { runPlanCli, runRippleCli, type RippleCliInput } from '../../src/writer/rippleCli.ts';
import { AT, seedChange } from '../ledger/helpers.ts';
import { main } from '../../src/writer/main.ts';
import { blockOf, rippleGraph, rippleHarness, statusPatch } from './ripple/fixtures.ts';

const NODE = {
  factId: 'f:d:допуск@ch12#status',
  chapter: 12,
  blockId: null,
  mandatory: true,
  reason: 'CAUSE_CHANGED:edg_doc_12' as const,
  direction: 'forward' as const,
  hops: 1,
  via: [],
  quote: 'Допуск всё ещё выдан.',
};

function ripplePlan(changeId: string): RipplePlan {
  return {
    changeId,
    chapter: 5,
    outcome: 'ripple',
    proven: true,
    seeds: [],
    nodes: [NODE],
    edges: [],
    edgeDetail: [],
    patches: [],
    closureSize: { nodes: 1, edges: 0, chapters: 2, parts: 1 },
    chaptersTouched: [5, 12],
    bounds: { chars: 4_000, usd: 0.6, iterations: 4, nodes: 1_500, edges: 3_000 },
    unresolved: [],
    truncated: false,
  };
}

/** A change closed `ripple` with a plan the drainer will find, and the plan's row id. */
function owed(): { db: Db; planRowId: string; id: string } {
  const db = openDatabase(':memory:');
  migrate(db);
  const id = seedChange(db, { id: 'chg_cli', chapter: 5, at: AT });
  db.prepare(`UPDATE changes SET status = 'done', outcome = 'ripple' WHERE id = ?`).run(id);
  const planRowId = storePlan(db, ripplePlan(id), AT);
  return { db, planRowId, id };
}

function input(db: Db, lines: string[], drain?: RippleCliInput['drain']): RippleCliInput {
  return {
    db,
    // The seam is the drain: nothing below it is reached in this file.
    config: {} as RippleCliInput['config'],
    bookRoot: '/nonexistent',
    dataDir: '/nonexistent',
    engine: {} as RippleCliInput['engine'],
    provider: (() => {
      throw new Error('the CLI test must not call a provider');
    }) as RippleCliInput['provider'],
    now: () => Date.parse(AT),
    log: (line) => lines.push(line),
    claimedBy: 'proc-a',
    ...(drain === undefined ? {} : { drain }),
  };
}

function outcome(status: DrainOutcome['status'], reason: string): DrainOutcome {
  return { status, reason, iterations: [], plan: ripplePlan('chg_cli'), verification: null };
}

describe('--ripple takes, drains and releases the plan', () => {
  it('exits 0 when the drain finished, and leaves no claim behind', async () => {
    const { db, planRowId } = owed();
    const lines: string[] = [];
    const code = await runRippleCli(input(db, lines, async () => outcome('done', 'замыкание пройдено: 1 глав')));
    try {
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('замыкание пройдено');
      const row = db.prepare('SELECT claimed_at, claimed_by FROM change_plans WHERE id = ?').get(planRowId) as {
        claimed_at: string | null;
        claimed_by: string | null;
      };
      expect(row).toEqual({ claimed_at: null, claimed_by: null });
    } finally {
      db.close();
    }
  });

  it('exits 1 when the plan is parked, and says why in the author’s words', async () => {
    const { db } = owed();
    const lines: string[] = [];
    const code = await runRippleCli(
      input(db, lines, async () => outcome('parked', 'соседняя глава дважды не приняла правку — нужен автор')),
    );
    try {
      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('дважды не приняла правку');
    } finally {
      db.close();
    }
  });

  it('skips a plan another process claimed, in one line, and exits 0', async () => {
    const { db, planRowId } = owed();
    const lines: string[] = [];
    expect(claimPlan(db, planRowId, 'other-process', Date.now())).toBe(true);
    const code = await runRippleCli(
      input(db, lines, async () => {
        throw new Error('a claimed plan must not be drained');
      }),
    );
    try {
      // A claim that is not ours is «nothing to do» for this process — and it says whose it is.
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('уже взят другим процессом');
      const row = db.prepare('SELECT claimed_by FROM change_plans WHERE id = ?').get(planRowId) as {
        claimed_by: string | null;
      };
      expect(row.claimed_by).toBe('other-process');
    } finally {
      db.close();
    }
  });
});

describe('--plan answers 1 when there is no plan', () => {
  it('prints nothing and returns 1 for an unknown change, 0 for a known one', () => {
    const { db, id } = owed();
    try {
      const missing: string[] = [];
      expect(runPlanCli({ db, changeId: 'chg_absent', log: (line) => missing.push(line) })).toBe(1);
      expect(missing.join('\n')).toContain('не найден');

      const found: string[] = [];
      expect(runPlanCli({ db, changeId: id, log: (line) => found.push(line) })).toBe(0);
      expect(found[0]).toContain(`план ${id}: ripple`);
    } finally {
      db.close();
    }
  });
});

describe('main --ripple drains a real plan through the door and releases the claim', () => {
  it('runs the chapters the plan named, verifies the closure, and answers 0', async () => {
    const harness = await rippleHarness();
    try {
      rippleGraph(harness);
      // The origin pass: the patch lands, the plan is frozen, the change closes `ripple`.
      // The patch, the causality judge, the local judge, then the pair (a non-empty closure).
      harness.script.push(statusPatch(harness), 'HOLDS', 'HOLDS', 'HOLDS', 'HOLDS');
      expect((await harness.run({ lanes: ['fwd'] })).status).toBe('closed');

      // ch12: the paragraph is rewritten and the claim's wording stays — the repair the loop used
      // to park on. ch19: a paragraph no fact stands on, so the chapter lands without retiring one.
      const deadline = blockOf(harness.fixture.db, 12, 0);
      const payment = blockOf(harness.fixture.db, 19, 1);
      harness.script.push(
        JSON.stringify({
          mode: 'patch',
          edits: [{ blockId: deadline.id, oldText: 'смена стоит', newText: 'смена идёт' }],
          facts: [],
          note: 'ripple chapter',
        }),
        'HOLDS',
        'HOLDS',
        'HOLDS',
        JSON.stringify({
          mode: 'patch',
          edits: [{ blockId: payment.id, oldText: 'Второй абзац девятнадцатой главы.', newText: 'Второй абзац девятнадцатой главы, сказали ему.' }],
          facts: [],
          note: 'ripple chapter',
        }),
        'HOLDS',
        'HOLDS',
        'HOLDS',
      );

      const lines: string[] = [];
      const code = await main({
        argv: ['--ripple'],
        env: harness.env,
        provider: harness.provider,
        now: () => harness.fixture.clock.now(),
        log: (line) => lines.push(line),
        claimedBy: 'proc-cli',
      });
      // Both chapters landed and the closure verified: 0 says the plan is finished.
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('ripple done');
      const row = harness.fixture.db
        .prepare('SELECT claimed_at, claimed_by, parked_at, iterations FROM change_plans LIMIT 1')
        .get() as { claimed_at: string | null; claimed_by: string | null; parked_at: string | null; iterations: string };
      // The claim is released on the way out, whatever the loop decided.
      expect(row.claimed_at).toBeNull();
      expect(row.claimed_by).toBeNull();
      expect(row.parked_at).toBeNull();
      expect((JSON.parse(row.iterations) as Array<{ chapter: number; landed: boolean }>).map((entry) => [entry.chapter, entry.landed])).toEqual([
        [12, true],
        [19, true],
      ]);
    } finally {
      await harness.close();
    }
  });
});
