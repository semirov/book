/**
 * `graph closure` (BOOK-174): a fact or a quoted sentence, the whole closure, the mandatory and
 * optional split, the mode and the price.
 *
 * The database is seeded with facts and edges and **no manuscript**: the command must be usable on
 * a projection that was imported elsewhere, and a quote resolves through the mentions and the
 * facts' own sentences, not through a chapter file.
 */

import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { runGraph } from '../../src/graph/cli.ts';
import { graphFixture, seedEdge, seedFact, seedMention, type GraphFixture } from './helpers.ts';

let fixture: GraphFixture | null = null;

afterEach(() => {
  if (fixture !== null) {
    rmSync(fixture.dataDir, { recursive: true, force: true });
    fixture = null;
  }
});

const io = (): { log: (line: string) => void; error: (line: string) => void; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  return { log: (line) => out.push(line), error: (line) => err.push(line), out, err };
};

/**
 * ch2 names the paper, ch3 carries a consequence that only that paper supports, ch4 a consequence
 * that keeps another support. So the closure from `fct_f` has one mandatory and one optional node.
 */
function prepare(): string {
  fixture = graphFixture();
  const db = fixture.db;
  seedFact(db, {
    id: 'fct_f',
    chapter: 2,
    kind: 'document',
    key: 'document:65-11877-арх',
    sentence: '— Номер 65/11877/арх.',
  });
  seedMention(db, { factId: 'fct_f', chapter: 2, witness: '65/11877/арх', start: 8 });
  seedFact(db, { id: 'fct_g', chapter: 3, kind: 'date', key: 'date:2065-09-14', sentence: 'Акт подписан 14.09.2065.' });
  seedMention(db, { factId: 'fct_g', chapter: 3, witness: '14.09.2065', start: 12 });
  seedFact(db, { id: 'fct_h', chapter: 4, kind: 'term', key: 'term:очередь', sentence: 'Очередь стояла.' });
  seedMention(db, { factId: 'fct_h', chapter: 4, witness: 'Очередь', start: 0 });
  seedFact(db, { id: 'fct_k', chapter: 1, kind: 'term', key: 'term:распоряжение' });
  // A witness its own sentence does not repeat: the only way to reach it is «the witness contains
  // the quote», so a partial paste proves that direction on its own.
  seedFact(db, { id: 'fct_doc', chapter: 2, kind: 'document', key: 'document:44-17-зап', sentence: 'Приказ вышел утром.' });
  seedMention(db, { factId: 'fct_doc', chapter: 2, witness: '№ 44/17-ЗАП', start: 0, blockId: 'blk_2_2' });
  // ch15's list of dates: two witnesses inside one pasted quote.
  seedFact(db, { id: 'fct_d12', chapter: 15, kind: 'date', key: 'date:--02-12', sentence: 'Смена с 12.02.' });
  seedMention(db, { factId: 'fct_d12', chapter: 15, witness: '12.02', start: 8, blockId: 'blk_15_1' });
  seedFact(db, { id: 'fct_d15', chapter: 15, kind: 'date', key: 'date:--02-15', sentence: 'И потом 15.02, ближе к вечеру.' });
  seedMention(db, { factId: 'fct_d15', chapter: 15, witness: '15.02', start: 9, blockId: 'blk_15_1' });
  seedEdge(db, { id: 'dep_fg', from: 'fct_f', to: 'fct_g', chapter: 3, kind: 'document' });
  seedEdge(db, { id: 'dep_fh', from: 'fct_f', to: 'fct_h', chapter: 4, kind: 'document' });
  seedEdge(db, { id: 'dep_kh', from: 'fct_k', to: 'fct_h', chapter: 4, kind: 'cause' });
  db.close();
  return fixture.dataDir;
}

/**
 * A crossing edge that touches nothing that changed: `fct_s` is the seed (ch2, the origin), its
 * one consequence `fct_m` is in the same chapter, and the only inter-chapter edge in the closure
 * is `fct_m → fct_x` (ch2 → ch9) between two optional nodes. `local` must stay reachable — the
 * change moves nothing mandatory out of ch2 (ADR-040 §4.1).
 */
function prepareOptionalCrossing(): string {
  fixture = graphFixture();
  const db = fixture.db;
  seedFact(db, { id: 'fct_s', chapter: 2, kind: 'document', key: 'document:s' });
  seedFact(db, { id: 'fct_m', chapter: 2, kind: 'term', key: 'term:m' });
  seedFact(db, { id: 'fct_x', chapter: 9, kind: 'term', key: 'term:x' });
  seedEdge(db, { id: 'dep_sm', from: 'fct_s', to: 'fct_m', chapter: 2, kind: 'document' });
  seedEdge(db, { id: 'dep_mx', from: 'fct_m', to: 'fct_x', chapter: 9, kind: 'cause' });
  db.close();
  return fixture.dataDir;
}

/**
 * The other side of the rule: `fct_s` (ch2, the origin) registers an edge to an optional node in
 * ch6. Nothing mandatory leaves ch2, but the change does cross the origin boundary while touching
 * a changed fact, so the change is a `ripple`.
 */
function prepareTouchedCrossing(): string {
  fixture = graphFixture();
  const db = fixture.db;
  seedFact(db, { id: 'fct_s', chapter: 2, kind: 'document', key: 'document:s' });
  seedFact(db, { id: 'fct_o', chapter: 6, kind: 'term', key: 'term:o' });
  seedFact(db, { id: 'fct_k', chapter: 1, kind: 'date', key: 'date:k' });
  seedEdge(db, { id: 'dep_so', from: 'fct_s', to: 'fct_o', chapter: 6, kind: 'document' });
  seedEdge(db, { id: 'dep_ko', from: 'fct_k', to: 'fct_o', chapter: 6, kind: 'cause' });
  db.close();
  return fixture.dataDir;
}

describe('graph closure', () => {
  it('prints the split and the price for one fact', () => {
    const dir = prepare();
    const captured = io();
    const code = runGraph(['closure', '--data-dir', dir, '--fact', 'fct_f'], captured, { bookRoot: dir });
    expect(code).toBe(0);
    const text = captured.out.join('\n');
    expect(text).toContain('1 seed: fct_f (document:65-11877-арх, ch02)');
    expect(text).toContain('closure: 3 nodes · 3 chapters (2,3,4)');
    expect(text).toContain('mandatory (1):');
    expect(text).toContain('fct_g');
    expect(text).toContain('sole support: dep_fg');
    // The seed is listed too — as optional, for being the change itself — so the split adds up to
    // the closure's three nodes and a reader can reconcile the counts.
    expect(text).toContain('optional (2):');
    expect(text).toContain('support: dep_kh');
    expect(text).toContain('origin');
    expect(text).toContain('mode: ripple');
    expect(text).toContain('price: $0.17 · 2 chapters · 2 patches · 0 chars');
    expect(text).not.toContain('refused:');
    expect(captured.err).toEqual([]);
  });

  it('prints the whole object with --json, including the mandatory/optional split', () => {
    const dir = prepare();
    const captured = io();
    const code = runGraph(['closure', '--data-dir', dir, '--fact', 'fct_f', '--json'], captured, { bookRoot: dir });
    expect(code).toBe(0);
    const payload = JSON.parse(captured.out.join('\n')) as {
      seeds: string[];
      nodes: Array<{ factId: string }>;
      edges: Array<{ id: string }>;
      mandatory: Array<{ factId: string; reason: string }>;
      optional: Array<{ factId: string; reason: string }>;
      price: { usd: number; chapters: number; patches: number; changedChars: number };
      decision: { mode: string; refused: unknown };
    };
    expect(payload.seeds).toEqual(['fct_f']);
    expect(payload.nodes.map((node) => node.factId)).toEqual(['fct_f', 'fct_g', 'fct_h']);
    expect(payload.mandatory).toEqual([
      { factId: 'fct_g', chapter: 3, key: 'date:2065-09-14', kind: 'date', reason: 'sole support: dep_fg' },
    ]);
    expect(payload.optional.map((entry) => entry.factId)).toEqual(['fct_f', 'fct_h']);
    expect(payload.optional[0]?.reason).toBe('origin');
    expect(payload.price).toMatchObject({ usd: 0.17, chapters: 2, patches: 2, changedChars: 0 });
    expect(payload.decision).toMatchObject({ mode: 'ripple', refused: null });
  });

  it('resolves a chapter quote through the mention witnesses', () => {
    const dir = prepare();
    const captured = io();
    const code = runGraph(
      ['closure', '--data-dir', dir, '--chapter', '2', '--quote', '65-11877-арх', '--changed-chars', '480', '--json'],
      captured,
      { bookRoot: dir },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(captured.out.join('\n')) as {
      seeds: string[];
      price: { changedChars: number };
      decision: { mode: string };
    };
    // The normalised quote matches the witness written with slashes.
    expect(payload.seeds).toEqual(['fct_f']);
    expect(payload.price.changedChars).toBe(480);
    expect(payload.decision.mode).toBe('ripple');
  });

  it('resolves the quote in three directions: sentence, witness-inside-quote, quote-inside-witness', () => {
    const dir = prepare();
    const seedsFor = (chapter: string, quote: string): string[] => {
      const captured = io();
      expect(runGraph(['closure', '--data-dir', dir, '--chapter', chapter, '--quote', quote, '--json'], captured, {
        bookRoot: dir,
      })).toBe(0);
      return (JSON.parse(captured.out.join('\n')) as { seeds: string[] }).seeds;
    };

    // 1. The stored sentence contains the quote; neither witness nor quote contains the other.
    expect(seedsFor('3', 'акт подписан')).toEqual(['fct_g']);
    // 2. A partial paste: the witness «№ 44/17-ЗАП» contains «44/17», the sentence does not.
    expect(seedsFor('2', '44/17')).toEqual(['fct_doc']);
    // 3. A pasted list of dates: the quote contains each witness, and both are seeds.
    expect(seedsFor('15', '12.02, 15.02')).toEqual(['fct_d12', 'fct_d15']);
  });

  it('prints both seeds of a pasted date list with the price', () => {
    const dir = prepare();
    const captured = io();
    const code = runGraph(
      ['closure', '--data-dir', dir, '--chapter', '15', '--quote', '12.02, 15.02'],
      captured,
      { bookRoot: dir },
    );
    expect(code).toBe(0);
    const text = captured.out.join('\n');
    expect(text).toContain('2 seeds:');
    expect(text).toContain('fct_d12');
    expect(text).toContain('fct_d15');
    expect(text).toContain('closure: 2 nodes · 1 chapter (15)');
    expect(text).toContain('price: $0.09 · 1 chapter · 1 patch · 0 chars');
  });

  it('reports a quote that resolves to nothing as a finding and exits 0', () => {
    const dir = prepare();
    const captured = io();
    const code = runGraph(
      ['closure', '--data-dir', dir, '--chapter', '3', '--quote', 'ни одного такого слова'],
      captured,
      { bookRoot: dir },
    );
    expect(code).toBe(0);
    expect(captured.err).toEqual([]);
    expect(captured.out[0]).toBe('no fact in this sentence');
    expect(captured.out.join('\n')).toContain('nearby: ch03  fct_g');
  });

  it('benchmarks every live fact and reports the budget it measured', () => {
    const dir = prepare();
    const captured = io();
    const code = runGraph(['bench', '--data-dir', dir, '--json'], captured, { bookRoot: dir });
    const result = JSON.parse(captured.out.join('\n')) as { runs: number; p95: number; nodesMax: number };
    expect(result.runs).toBe(7);
    // Load tolerance, not the budget: an upper bound two orders of magnitude over 25 ms catches a
    // real regression without turning a loaded machine's slow compile into a red test.
    expect(result.p95).toBeLessThanOrEqual(2000);
    expect(result.nodesMax).toBeGreaterThanOrEqual(3);
    // The 25 ms budget is the command's **exit code**, so the code must agree with the p95 the
    // same run printed: 0 inside the budget, 1 over it. Never a machine-speed assumption.
    expect(code).toBe(result.p95 > 25 ? 1 : 0);

    const text = io();
    // Same measurement in the human format; its own exit code is covered by the JSON run above.
    runGraph(['bench', '--data-dir', dir], text, { bookRoot: dir });
    expect(text.out.join('\n')).toContain('bench: 7 runs');
    expect(text.out.join('\n')).toContain('json');
  });

  it('is a usage error without a seed and a missing-fact error for an unknown id', () => {
    const dir = prepare();
    expect(runGraph(['closure', '--data-dir', dir], io(), { bookRoot: dir })).toBe(2);
    expect(
      runGraph(['closure', '--data-dir', dir, '--chapter', 'двенадцать', '--quote', 'x'], io(), { bookRoot: dir }),
    ).toBe(2);
    expect(runGraph(['closure', '--data-dir', dir, '--fact', 'fct_f', '--nonsense'], io(), { bookRoot: dir })).toBe(2);
    const captured = io();
    expect(runGraph(['closure', '--data-dir', dir, '--fact', 'fct_nope'], captured, { bookRoot: dir })).toBe(1);
    expect(captured.err.join('\n')).toContain('no fact fct_nope');
  });

  it('refuses --fact together with --chapter/--quote instead of ignoring the quote', () => {
    const dir = prepare();
    for (const extra of [['--chapter', '2'], ['--quote', '65/11877/арх'], ['--chapter', '2', '--quote', 'x']]) {
      const captured = io();
      expect(
        runGraph(['closure', '--data-dir', dir, '--fact', 'fct_f', ...extra], captured, { bookRoot: dir }),
      ).toBe(2);
      expect(captured.err.join('\n')).toContain('one selector per run');
      // Nothing was measured: a silent second selector would have priced a change nobody asked for.
      expect(captured.out).toEqual([]);
    }
  });

  it('refuses a --changed-chars that is not a non-negative number', () => {
    const dir = prepare();
    // A bare flag has no number at all, which is also a usage error rather than a silent zero.
    const bare = io();
    expect(
      runGraph(['closure', '--data-dir', dir, '--fact', 'fct_f', '--changed-chars'], bare, { bookRoot: dir }),
    ).toBe(2);
    expect(bare.err.join('\n')).toContain('--changed-chars needs a number');
    for (const value of ['abc', '-1', '4o0']) {
      const captured = io();
      expect(
        runGraph(['closure', '--data-dir', dir, '--fact', 'fct_f', '--changed-chars', value], captured, {
          bookRoot: dir,
        }),
      ).toBe(2);
      expect(captured.err.join('\n')).toContain('is not a non-negative number');
    }
    // A zero is a number: the cap stays armed and the price prints it.
    const zero = io();
    expect(
      runGraph(['closure', '--data-dir', dir, '--fact', 'fct_f', '--changed-chars', '0', '--json'], zero, {
        bookRoot: dir,
      }),
    ).toBe(0);
    expect((JSON.parse(zero.out.join('\n')) as { price: { changedChars: number } }).price.changedChars).toBe(0);
  });

  it('refuses a mandatory chapter that --apply leaves out, and executes it for all', () => {
    const dir = prepare();
    const decideWith = (apply: string[]): unknown => {
      const captured = io();
      expect(
        runGraph(['closure', '--data-dir', dir, '--fact', 'fct_f', ...apply, '--json'], captured, { bookRoot: dir }),
      ).toBe(0);
      return (JSON.parse(captured.out.join('\n')) as { decision: { refused: unknown } }).decision.refused;
    };

    // `fct_g` (ch3) is mandatory: apply ch2 only and its cause is gone with nothing to patch it.
    expect(decideWith(['--apply', '2'])).toEqual({
      code: 'CAUSE_MISSING',
      sentence: 'следствие в главе 3 осталось без причины: глава 2 больше её не даёт',
    });
    // `all` is the default: every priced chapter is executed, so nothing is missing.
    expect(decideWith(['--apply', 'all'])).toBeNull();
    expect(decideWith([])).toBeNull();
    // A list that covers the mandatory chapter is as good as `all` for this plan.
    expect(decideWith(['--apply', '2,3'])).toBeNull();
  });

  it('refuses an --apply that is neither "all" nor chapters', () => {
    const dir = prepare();
    for (const value of ['двенадцать', '0', '2,x', '68']) {
      expect(
        runGraph(['closure', '--data-dir', dir, '--fact', 'fct_f', '--apply', value], io(), { bookRoot: dir }),
      ).toBe(2);
    }
  });

  it('stays local when the only crossing edge touches nothing that changed', () => {
    const dir = prepareOptionalCrossing();
    const captured = io();
    expect(runGraph(['closure', '--data-dir', dir, '--fact', 'fct_s', '--json'], captured, { bookRoot: dir })).toBe(0);
    const payload = JSON.parse(captured.out.join('\n')) as {
      decision: { mode: string; refused: unknown; reasons: string[] };
      edges: Array<{ id: string; fromFact: string; toFact: string }>;
    };
    // The inter-chapter edge is induced and does cross a chapter boundary — it just crosses
    // between two optional nodes, so it is not the origin boundary plus a changed fact.
    expect(payload.edges.map((edge) => edge.id)).toEqual(['dep_sm', 'dep_mx']);
    expect(payload.decision.mode).toBe('local');
    expect(payload.decision.refused).toBeNull();
  });

  it('is a ripple when a touched fact registers an edge into another chapter', () => {
    const dir = prepareTouchedCrossing();
    const captured = io();
    expect(runGraph(['closure', '--data-dir', dir, '--fact', 'fct_s', '--json'], captured, { bookRoot: dir })).toBe(0);
    const payload = JSON.parse(captured.out.join('\n')) as {
      mandatory: Array<{ factId: string }>;
      decision: { mode: string };
    };
    // Nothing mandatory leaves ch2: the edge alone is why this is not a local change.
    expect(payload.mandatory).toEqual([]);
    expect(payload.decision.mode).toBe('ripple');
  });
});
