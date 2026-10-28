/**
 * The ripple's door and its outcome word (BOOK-173 review, fix 7) — a `wide` plan is the author's
 * decision, and the vocabulary must not invite a machine to take it.
 *
 *   · `openRippleStep` refuses a `wide` plan with `WIDE_NEEDS_AUTHOR` before any step, lease or
 *     gate exists — an automatic pass may never be the answer to «this change is too big to
 *     decide alone»;
 *   · `rippleOutcomeFor` labels a change `ripple` only when its plan is a ripple, so a wide-only
 *     change keeps the outcome it earned and never reaches `drainablePlans`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { openRippleStep, rippleOutcomeFor, drainablePlans } from '../../src/engine/ripple.ts';
import { openDatabase, type Db } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { storePlan, type RipplePlan } from '../../src/ledger/graph/plan.ts';
import { AT, seedChange } from '../ledger/helpers.ts';
import { createEngineFixture, type Fixture } from './helpers.ts';

/** A written, published chapter — the door refuses a chapter the book does not hold yet. */
const WRITTEN = (title: string): string => `${title}\n\nПервый абзац главы.\n\nВторой абзац главы.\n`;

let db: Db | null = null;
let fixture: Fixture | null = null;

afterEach(() => {
  db?.close();
  db = null;
  fixture?.close();
  fixture = null;
});

function plan(changeId: string, outcome: RipplePlan['outcome']): RipplePlan {
  const node = {
    factId: 'f:d:допуск@ch12#status',
    chapter: 12,
    blockId: null,
    mandatory: outcome === 'ripple',
    reason: 'CAUSE_CHANGED:edg_doc_12' as const,
    direction: 'forward' as const,
    hops: 1,
    via: [],
    quote: 'Допуск всё ещё выдан.',
  };
  return {
    changeId,
    chapter: 5,
    outcome,
    proven: true,
    seeds: [],
    nodes: [node],
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

/** A change that already closed `ripple`, with the plan the closing left behind. */
function closedRipple(outcome: RipplePlan['outcome']): { id: string; db: Db } {
  db = openDatabase(':memory:');
  migrate(db);
  const id = seedChange(db, { id: `chg_${outcome}`, chapter: 5, at: AT });
  db.prepare(`UPDATE changes SET status = 'done', outcome = 'ripple' WHERE id = ?`).run(id);
  storePlan(db, plan(id, outcome), AT);
  return { id, db };
}

describe('rippleOutcomeFor — the word a closed change carries', () => {
  it('is `ripple` only for a plan that is a ripple', () => {
    const ripple = closedRipple('ripple');
    expect(rippleOutcomeFor(ripple.db, ripple.id, 'applied')).toBe('ripple');
    ripple.db.close();
    db = null;

    const wide = closedRipple('wide');
    // A wide plan is the author's decision: the change keeps `applied` and never enters the queue.
    expect(rippleOutcomeFor(wide.db, wide.id, 'applied')).toBe('applied');
    expect(drainablePlans(wide.db)).toEqual([]);
    // …and it is parked, so `--ripple` can say *why* nothing is draining.
    const row = wide.db.prepare('SELECT parked_at, park_reason FROM change_plans WHERE change_id = ?').get(wide.id) as {
      parked_at: string | null;
      park_reason: string | null;
    };
    expect(row.parked_at).not.toBeNull();
    expect(row.park_reason).toContain('решает автор');
    expect(row.park_reason).not.toContain('WIDE_NEEDS_AUTHOR');
  });

  it('never rewrites an outcome that was not `applied`', () => {
    const wide = closedRipple('wide');
    expect(rippleOutcomeFor(wide.db, wide.id, 'escalated')).toBe('escalated');
  });
});

describe('openRippleStep — a wide plan has no door', () => {
  it('refuses with WIDE_NEEDS_AUTHOR and opens no step', () => {
    fixture = createEngineFixture({ chapters: { 5: WRITTEN('Глава пятая'), 12: WRITTEN('Глава двенадцатая') } });
    const id = seedChange(fixture.db, { id: 'chg_wide_door', chapter: 5, at: AT });
    fixture.db.prepare(`UPDATE changes SET status = 'done', outcome = 'ripple' WHERE id = ?`).run(id);
    storePlan(fixture.db, plan(id, 'wide'), AT);

    let code: string | null = null;
    try {
      openRippleStep(fixture.deps, { changeId: id, chapter: 12, session: 'door-test' });
    } catch (error) {
      code = (error as { code?: string }).code ?? null;
    }
    expect(code).toBe('WIDE_NEEDS_AUTHOR');
    // Nothing was opened: a refusal is not a half-started chapter.
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toEqual({ n: 0 });
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM leases').get()).toEqual({ n: 0 });
  });

  it('still opens a ripple plan the way it did before', () => {
    fixture = createEngineFixture({ chapters: { 5: WRITTEN('Глава пятая'), 12: WRITTEN('Глава двенадцатая') } });
    const id = seedChange(fixture.db, { id: 'chg_ripple_door', chapter: 5, at: AT });
    fixture.db.prepare(`UPDATE changes SET status = 'done', outcome = 'ripple' WHERE id = ?`).run(id);
    storePlan(fixture.db, plan(id, 'ripple'), AT);

    const assignment = openRippleStep(fixture.deps, { changeId: id, chapter: 12, session: 'door-test' });
    expect(assignment.pass).toBe('cascade');
    expect(assignment.chapter).toBe(12);
  });
});
