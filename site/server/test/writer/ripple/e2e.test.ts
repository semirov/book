/**
 * One ripple, end to end (BOOK-173 round 3, the reviewer's answer) — real filing, real plan, a real
 * ripple chapter through the real pass, the drainer's own recompute and `verifyRipple`, all on a
 * real fixture database. Nothing here stubs the drainer's seam: the only scripted thing is the
 * model's text, as in every other writer test.
 *
 * The path the test walks, in the order the book walks it:
 *
 *   1. **the filing** — an operator change on ch05 («в главе 5 допуск отзывают»), the origin pass
 *      patches one word and its closure names ch12 as mandatory; the change closes `ripple`;
 *   2. **the door** — the drainer asks the engine for ch12's step (`pass: 'cascade'`), the engine
 *      refuses a chapter the plan does not name and opens this one;
 *   3. **the chapter** — a real pass patches ch12's paragraph, the gates run, the step closes;
 *   4. **the journal** — the iteration is a row in `change_plans.iterations`, not a variable;
 *   5. **the fixpoint** — the recomputed closure owes nothing, `verifyRipple` answers `ok`, and the
 *      change is still the `ripple` it closed as.
 */

import { describe, expect, it } from 'vitest';

import { drainablePlans, latestPlan } from '../../../src/engine/ripple.ts';
import { drainAll, frameProbe, readIterations, runDrainChapter } from '../../../src/writer/ripple/drain.ts';
import { runPass } from '../../../src/writer/pass.ts';
import type { EngineClient } from '../../../src/writer/client.ts';
import type { Harness } from '../harness.ts';
import { CONSEQUENCES, ORIGIN, blockOf, rippleHarness, seedEdge, seedFact, statusPatch } from './fixtures.ts';

const CH12 = CONSEQUENCES[0];

/**
 * The smallest graph a ripple can walk: one document in ch05, restated in ch12, plus the
 * irreversible marker ch12 needs (a chapter the ripple changed must hold a decision or a paper).
 * Built here instead of `rippleGraph` on purpose — this test is about the wiring end to end, not
 * about a two-chapter closure.
 */
function oneConsequence(harness: Harness): { seed: string; deadline: string } {
  const db = harness.fixture.db;
  seedFact(db, {
    id: 'f:d:решение@ch05',
    chapter: ORIGIN,
    kind: 'decision',
    statement: 'Решено: смена идёт.',
    block: blockOf(db, ORIGIN, 3),
  });
  const seed = seedFact(db, {
    id: 'f:d:допуск@ch05#status',
    chapter: ORIGIN,
    kind: 'document',
    statement: 'Допуск выдан Ковалёву на руки.',
    term: 'допуск',
    block: blockOf(db, ORIGIN, 1),
  });
  const deadline = seedFact(db, {
    id: 'f:d:допуск@ch12#status',
    chapter: CH12,
    kind: 'document',
    statement: 'Допуск всё ещё выдан, и смена стоит.',
    term: 'допуск',
    block: blockOf(db, CH12, 0),
    witness: 'Допуск всё ещё выдан',
  });
  seedEdge(db, { id: 'edg_doc_12', from: seed, to: deadline, chapter: CH12 });
  seedFact(db, {
    id: 'f:d:акт@ch12',
    chapter: CH12,
    kind: 'document',
    statement: 'Акт подписан.',
    block: blockOf(db, CH12, 2),
  });
  return { seed, deadline };
}

describe('one ripple end to end', () => {
  it('files, plans, patches the consequence through the door, journals it and verifies', async () => {
    const harness = await rippleHarness();
    try {
      const graph = oneConsequence(harness);
      const db = harness.fixture.db;
      const changeId = (
        db.prepare(`SELECT id FROM changes WHERE chapter = ? AND status = 'pending'`).get(ORIGIN) as { id: string }
      ).id;

      // 1. The filing and the point patch: the change closes `ripple`, and the frozen plan names
      //    exactly one consequence chapter.
      // The patch, the causality judge, the local judge, then the pair (a non-empty closure).
      harness.script.push(statusPatch(harness), 'HOLDS', 'HOLDS', 'HOLDS', 'HOLDS');
      expect((await harness.run({ lanes: ['fwd'] })).status).toBe('closed');
      const stored = latestPlan(db, changeId);
      if (stored === null) throw new Error('the origin landing froze no plan');
      expect(stored.plan.outcome).toBe('ripple');
      expect(stored.plan.nodes.filter((node) => node.mandatory).map((node) => node.chapter)).toEqual([CH12]);
      expect(
        db.prepare('SELECT status, outcome FROM changes WHERE id = ?').get(changeId),
      ).toEqual({ status: 'done', outcome: 'ripple' });

      // 2–3. The drainer's real one-chapter runner: the engine's ripple door opens ch12's step,
      //      the pass patches the paragraph (the claim's wording stays) and the step closes. The
      //      client is the real one with one seam: the site's watcher publishes the chapter's file
      //      first, so the engine's own ingest answers `unchanged` and the ledger is settled by
      //      `land`'s second door — a ripple chapter owes a retirement too, never a second plan.
      const engine: EngineClient = {
        ...harness.client,
        land: (leaseId: string, input) => {
          // The site's watcher publishes the writer's own bytes first — BOOK-187: the text
          // travels in the request, so the seam hands the same text to the ingest.
          if (input?.text !== undefined) harness.fixture.seedChapter(CH12, input.text);
          return harness.client.land(leaseId, input);
        },
      };
      harness.script.push(
        JSON.stringify({
          mode: 'patch',
          edits: [{ blockId: blockOf(db, CH12, 0).id, oldText: 'смена стоит', newText: 'смена идёт' }],
          facts: [],
          note: 'the premise moved',
        }),
        'HOLDS',
        'HOLDS',
        'HOLDS',
      );
      const outcome = await drainAll({
        db,
        planRowId: stored.planRowId,
        plan: stored.plan,
        frameOk: frameProbe(db),
        runChapter: (chapter, nodes) =>
          runDrainChapter(
            {
              db,
              config: harness.config,
              bookRoot: harness.bookRoot,
              dataDir: harness.dataDir,
              engine,
              provider: harness.provider,
              now: () => harness.fixture.clock.now(),
              log: (line) => harness.logs.push(line),
              pass: (ripple) =>
                runPass({
                  config: harness.config,
                  bookRoot: harness.bookRoot,
                  dataDir: harness.dataDir,
                  engine,
                  provider: harness.provider,
                  now: () => harness.fixture.clock.now(),
                  log: (line) => harness.logs.push(line),
                  chapter: null,
                  ripple,
                  dryRun: false,
                }),
            },
            stored.plan,
            chapter,
            nodes,
          ),
      });

      // 4. The journal is a row: one iteration, ch12, landed, carrying the node it repaired.
      const journal = readIterations(db, stored.planRowId);
      expect(journal.map((entry) => [entry.chapter, entry.landed, entry.nodes])).toEqual([
        [CH12, true, [graph.deadline]],
      ]);
      // A real step of the cascade pass exists for it.
      const step = db
        .prepare(`SELECT pass, chapter, outcome FROM steps WHERE chapter = ? AND pass = 'cascade'`)
        .get(CH12) as { pass: string; chapter: number; outcome: string };
      expect(step).toEqual({ pass: 'cascade', chapter: CH12, outcome: 'rewritten' });
      // The watcher's publish is the chapter's only revision: the landing added none, and still
      // settled the ledger (this is the branch where `land` finds the bytes already published).
      expect((db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = ?').get(CH12) as { n: number }).n).toBe(2);

      // 5. The fixpoint: nothing mandatory is left, the ledger answers for the whole ripple, and
      //    the plan is no longer work. The change keeps the outcome it earned at the origin.
      expect(outcome.status).toBe('done');
      expect(outcome.verification?.ok).toBe(true);
      expect(outcome.plan.nodes.filter((node) => node.mandatory)).toEqual([]);
      expect(drainablePlans(db)).toEqual([]);
      expect(db.prepare('SELECT outcome FROM changes WHERE id = ?').get(changeId)).toEqual({ outcome: 'ripple' });
    } finally {
      await harness.close();
    }
  });
});
