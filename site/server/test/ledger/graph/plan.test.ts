import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../src/db/db.ts';
import { migrate } from '../../../src/db/migrate.ts';
import {
  buildPlan,
  changedChars,
  openPlans,
  plansFor,
  storePlan,
  RIPPLE_MAX_CHANGED_CHARS,
  RIPPLE_MAX_ITERATIONS,
  RIPPLE_MAX_USD,
} from '../../../src/ledger/graph/plan.ts';
import { closure } from '../../../src/graph/closure.ts';
import { AT, seedChange } from '../helpers.ts';
import { graphFixture, promiseFixture, type GraphFixture } from './fixtures.ts';

let db: Db;
let fixture: GraphFixture;

afterEach(() => {
  db.close();
});

function open(): void {
  db = openDatabase(':memory:');
  migrate(db);
  fixture = graphFixture(db);
}

/** The design's filing: the promise in ch05, the deadline restated in ch12. */
function filing(): { promise: string; deadline: string; edgeId: string } {
  return promiseFixture(db);
}

const BEFORE = 'Я обещаю вернуть акт через 30 дней.';
const AFTER = 'Я обещаю вернуть акт через 45 дней.';

describe('buildPlan — three outcomes, priced before any money', () => {
  it('is local when nothing mandatory hangs off the change', () => {
    open();
    promiseFixture(db);
    // Only the seed is in the graph, and no seed is a consequence.
    const plan = buildPlan({
      db,
      changeId: seedChange(db, { id: 'chg_local', chapter: 5 }),
      chapter: 5,
      seeds: [],
      before: BEFORE,
      after: AFTER,
    });
    expect(plan.outcome).toBe('local');
    expect(plan.proven).toBe(false); // nothing was named, so nothing is proved
    expect(plan.unresolved).toEqual([]);
    expect(plan.nodes).toEqual([]);
    expect(plan.patches).toEqual([]);
    expect(plan.closureSize).toEqual({ nodes: 0, edges: 0, chapters: 0, parts: 0 });
  });

  it('is ripple when two nodes are mandatory and every cap holds', () => {
    open();
    const { promise, deadline } = filing();
    const changeId = seedChange(db, { id: 'chg_ripple', chapter: 5 });
    // A second consequence of the same seed, in another chapter.
    db.prepare(
      `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, created_at)
       VALUES ('f:n:30@ch19#cc', 19, 'state', 'оплата через тридцать дней', 'тридцать дней', 19, ?)`,
    ).run(AT);
    const block = db.prepare('SELECT id FROM blocks WHERE chapter = 12').get() as { id: string };
    db.prepare(
      `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, role, witness, edge_path)
       SELECT 'bkd_T12_0:1:0', ?, 12, 0, 10, 'fact', 'f:n:30@ch19#cc', 'assert', witness, '[]'
         FROM mentions WHERE block_id = ? LIMIT 1`,
    ).run(block.id, block.id);
    fixture.edge({ id: 'dep_second', from: promise, to: 'f:n:30@ch19#cc', chapter: 19, kind: 'cause' });

    const plan = buildPlan({ db, changeId, chapter: 5, seeds: [promise], before: BEFORE, after: AFTER });
    expect(plan.outcome).toBe('ripple');
    expect(plan.proven).toBe(true);
    expect(plan.nodes.filter((node) => node.mandatory).map((node) => node.factId)).toEqual([deadline, 'f:n:30@ch19#cc']);
    expect(plan.chaptersTouched).toEqual([5, 12, 19]);
    // ch05 is part 1 (2–11), ch12 and ch19 are part 2 — the closure reaches two parts.
    expect(plan.closureSize).toMatchObject({ nodes: 3, edges: 2, chapters: 3, parts: 2 });
    expect(plan.bounds).toEqual({
      chars: RIPPLE_MAX_CHANGED_CHARS,
      usd: RIPPLE_MAX_USD,
      iterations: RIPPLE_MAX_ITERATIONS,
      nodes: 1_500,
      edges: 3_000,
    });
  });

  it('is wide when the character bound is exceeded', () => {
    open();
    const { promise } = filing();
    const plan = buildPlan({
      db,
      changeId: seedChange(db, { id: 'chg_wide_chars', chapter: 5 }),
      chapter: 5,
      seeds: [promise],
      before: BEFORE,
      after: `${AFTER} ${'и ещё одна строка.'.repeat(300)}`,
      bounds: { chars: 100 },
    });
    expect(plan.outcome).toBe('wide');
    // The closure is printed whole — a wide plan is never a smaller plan.
    expect(plan.nodes).toHaveLength(1);
  });

  it('is wide when the iteration bound is passed, a bound trips, or the money is over', () => {
    open();
    const { promise } = filing();
    const changeId = seedChange(db, { id: 'chg_wide_misc', chapter: 5 });
    expect(buildPlan({ db, changeId, chapter: 5, seeds: [promise], before: BEFORE, after: AFTER, bounds: { iterationsUsed: 5 } }).outcome).toBe(
      'wide',
    );
    expect(buildPlan({ db, changeId, chapter: 5, seeds: [promise], before: BEFORE, after: AFTER, bounds: { nodes: 1 } }).outcome).toBe(
      'wide',
    );
    // The money bound is the writer's estimate against the frozen cap.
    expect(
      buildPlan({
        db,
        changeId,
        chapter: 5,
        seeds: [promise],
        before: BEFORE,
        after: AFTER,
        bounds: { estimatedUsd: 1.2 },
      }).outcome,
    ).toBe('wide');
    // The edge bound is a data-bug valve: a closure past it is `wide` with the closure intact.
    expect(buildPlan({ db, changeId, chapter: 5, seeds: [promise], before: BEFORE, after: AFTER, bounds: { edges: 0 } }).outcome).toBe(
      'wide',
    );
  });

  it('builds its closure from main’s closure() over fact_dependency, and from nothing else', () => {
    open();
    const { promise, deadline, edgeId } = filing();
    const changeId = seedChange(db, { id: 'chg_main_closure', chapter: 5 });
    // A second consequence in another chapter, so the closure has to cross a chapter boundary.
    const second = fixture.fact({ id: 'f:second@ch19#cc', chapter: 19, statement: 'Оплата через тридцать дней.' });
    fixture.edge({ id: 'dep_second', from: promise, to: second, chapter: 19, kind: 'cause' });

    const expected = closure(db, [promise]);
    const plan = buildPlan({ db, changeId, chapter: 5, seeds: [promise], before: BEFORE, after: AFTER });

    expect(plan.edges).toEqual(expected.edges.map((edge) => edge.id));
    expect(plan.chaptersTouched).toEqual(expected.chapters);
    expect(plan.closureSize).toEqual({
      nodes: expected.nodes.length,
      edges: expected.edges.length,
      chapters: expected.chapters.length,
      parts: expected.parts.length,
    });
    // Every node of the plan is a node of main's closure, minus the seed itself.
    const closureIds = new Set(expected.nodes.map((node) => node.factId));
    for (const node of plan.nodes) expect(closureIds.has(node.factId)).toBe(true);
    expect(plan.nodes.map((node) => node.factId).sort()).toEqual([deadline, second].sort());
    expect(plan.edgeDetail.map((edge) => edge.id).sort()).toEqual([edgeId, 'dep_second'].sort());

    // The graph is `fact_dependency`: retire the edge and the consequence leaves the plan.
    db.prepare(`UPDATE fact_dependency SET retired_by_run = NULL, superseded_by = id WHERE id = ?`).run(edgeId);
    const after = buildPlan({ db, changeId, chapter: 5, seeds: [promise], before: BEFORE, after: AFTER });
    expect(after.nodes.map((node) => node.factId)).not.toContain(deadline);
  });

  it('prints proven:false when a seed names no live fact — never «ничего не зависит»', () => {
    open();
    seedChange(db, { id: 'chg_unproven', chapter: 5 });
    const plan = buildPlan({
      db,
      changeId: 'chg_unproven',
      chapter: 5,
      seeds: ['f:missing'],
      before: BEFORE,
      after: AFTER,
    });
    expect(plan.proven).toBe(false);
    expect(plan.unresolved).toEqual(['f:missing']);
    expect(plan.outcome).toBe('local');
  });

  it('sorts several seeds, resolves what it can, and names what it cannot', () => {
    open();
    const { promise } = filing();
    seedChange(db, { id: 'chg_many', chapter: 5 });
    db.prepare(
      `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, created_at)
       VALUES ('f:second_seed', 5, 'state', 'акт остался у смотрителя', 'акт', 5, ?)`,
    ).run(AT);
    const plan = buildPlan({
      db,
      changeId: 'chg_many',
      chapter: 5,
      seeds: [promise, 'f:missing', 'f:second_seed'],
      before: BEFORE,
      after: AFTER,
    });
    expect(plan.proven).toBe(false);
    expect(plan.unresolved).toEqual(['f:missing']);
    expect(plan.seeds.map((seed) => seed.factId)).toEqual([promise, 'f:second_seed'].sort());
    // A fact stated in ch12 is not a seed at ch05 — it is a consequence the walk reaches instead.
    expect(plan.seeds.map((seed) => seed.factId)).not.toContain('f:n:30@ch12#bb');
    expect(plan.nodes.map((node) => node.factId)).toContain('f:n:30@ch12#bb');
  });

  it('is deterministic: two builds of the same rows are byte-identical', () => {
    open();
    const { promise } = filing();
    seedChange(db, { id: 'chg_twice', chapter: 5 });
    const build = (): unknown => buildPlan({ db, changeId: 'chg_twice', chapter: 5, seeds: [promise], before: BEFORE, after: AFTER });
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});

describe('the plan is stored, not remembered', () => {
  it('round-trips through change_plans and lists only the changes still in flight', () => {
    open();
    const { promise, deadline } = filing();
    seedChange(db, { id: 'chg_open', chapter: 5 });
    seedChange(db, { id: 'chg_done', chapter: 6 });
    // `seedChange` writes a closed row; an open plan belongs to a change still in flight.
    db.prepare(`UPDATE changes SET status = 'pending' WHERE id = 'chg_open'`).run();
    const plan = buildPlan({ db, changeId: 'chg_open', chapter: 5, seeds: [promise], before: BEFORE, after: AFTER });
    const id = storePlan(db, plan, AT);
    expect(id).toMatch(/^pln_/u);

    const stored = plansFor(db, 'chg_open');
    expect(stored).toEqual([plan]);
    expect(stored[0]?.nodes.find((node) => node.factId === deadline)?.mandatory).toBe(true);

    const closed = buildPlan({ db, changeId: 'chg_done', chapter: 6, seeds: [], before: '', after: '' });
    storePlan(db, closed, AT);
    expect(openPlans(db).map((entry) => entry.changeId)).toEqual(['chg_open']);
    expect(plansFor(db, 'chg_done')).toEqual([closed]);

    // A re-plan is the same row: the bounds are cumulative per change, so the journal survives.
    db.prepare(`UPDATE change_plans SET iterations = '[{"chapter":12,"landed":true}]' WHERE id = ?`).run(id);
    expect(storePlan(db, plan, AT)).toBe(id);
    expect(plansFor(db, 'chg_open')).toHaveLength(1);
    expect(
      (db.prepare('SELECT iterations FROM change_plans WHERE id = ?').get(id) as { iterations: string }).iterations,
    ).toContain('"chapter":12');
  });
});

describe('changedChars — what the 4 000-character bound measures', () => {
  it('counts the region between the common prefix and suffix', () => {
    expect(changedChars('', '')).toBe(0);
    expect(changedChars('abc', 'abc')).toBe(0);
    expect(changedChars('30 дней', '45 дней')).toBe(4);
    expect(changedChars('a', '')).toBe(1);
    expect(changedChars('сорок пять дней', 'тридцать дней')).toBe(14);
  });
});
