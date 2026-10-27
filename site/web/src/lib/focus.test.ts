import type { BlockDto, ChangeDto, ChangeImpactDto, HistoryDiffOpDto, PatchOp } from '@book/shared';
import { describe, expect, it } from 'vitest';

import type { Ribbon } from './cascade.ts';
import {
  assessmentCopy,
  basisCopy,
  blocksFromPatch,
  canPrint,
  changedBlocksFromDiff,
  costLine,
  exitTarget,
  focusHash,
  focusScale,
  focusStage,
  focusWingPair,
  focusWings,
  footnoteCopy,
  iterationCopy,
  parseFocusHash,
  scaleTicks,
  sheetChapter,
  sheetCopy,
  sheetNotice,
  stageCopy,
  touchedChaptersCopy,
  waveOf,
  type FocusStage,
} from './focus.ts';

const change: ChangeDto = {
  id: 'chg_1',
  seq: 14,
  kind: 'accepted_comment',
  interventionKind: null,
  chapter: 8,
  intent: 'в абзаце дважды «слово» — оставить одно упоминание',
  premise: false,
  source: { commentId: 'cmt_1', author: 'Аня' },
  base: { rev: 3 },
  scopeHint: 'phrase',
  status: 'done',
  outcome: 'applied',
  reason: null,
  position: null,
  relevance: null,
  cascade: {
    id: 'csc_1',
    status: 'closed',
    outcome: 'consistent',
    wave: 2,
    depth: { forward: 1, backward: 1 },
    chaptersChecked: [9],
    chaptersRewritten: [8, 7],
    seams: [],
    wings: {
      down: { frontier: 7, wave: 1, state: 'settled', reached: [7] },
      up: { frontier: 9, wave: 1, state: 'settled', reached: [9] },
    },
    modes: [],
    gates: { cycles: 2, findingSurvived: false },
    tokens: { total: 150_572 },
    ms: 41_000,
  },
  steps: [
    {
      seq: 1,
      wave: 0,
      wing: null,
      chapter: 8,
      pass: 'change',
      boundary: 8,
      outcome: 'rewritten',
      revBefore: 3,
      revAfter: 4,
      seamsIn: [],
      seamsOut: [],
      charsDelta: 41,
      note: null,
      at: '2026-10-25T12:00:00Z',
      cycles: 1,
      findingSurvived: false,
    },
    {
      seq: 2,
      wave: 1,
      wing: 'downward',
      chapter: 7,
      pass: 'cascade',
      boundary: 7,
      outcome: 'rewritten',
      revBefore: 2,
      revAfter: 3,
      seamsIn: [],
      seamsOut: [],
      charsDelta: -9,
      note: null,
      at: '2026-10-25T12:01:00Z',
      cycles: 0,
      findingSurvived: false,
    },
    {
      seq: 3,
      wave: 1,
      wing: 'upward',
      chapter: 9,
      pass: 'cascade',
      boundary: 9,
      outcome: 'holds',
      revBefore: 1,
      revAfter: 1,
      seamsIn: [],
      seamsOut: [],
      charsDelta: 0,
      note: null,
      at: '2026-10-25T12:02:00Z',
      cycles: 0,
      findingSurvived: false,
    },
  ],
  appliedRevs: [
    { chapter: 7, rev: 3 },
    { chapter: 8, rev: 4 },
  ],
  cost: { model: 'deepseek-flash', tokensIn: 120_000, tokensOut: 30_572, rub: 0.04 },
  modes: [],
  history: { fromHseq: 10, toHseq: 14 },
  enqueuedAt: '2026-10-25T11:59:00Z',
  startedAt: '2026-10-25T12:00:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
};

function ribbon(step: number | null, overrides: Partial<Ribbon> = {}): Ribbon {
  return {
    changeId: 'chg_1',
    cascadeId: 'csc_1',
    chapter: 8,
    wave: 1,
    status: 'open',
    outcome: null,
    touched: [8, 7, 9],
    rewritten: [8],
    wings: {
      down: { frontier: 7, wave: 1, state: 'moving', reached: [7] },
      up: { frontier: 9, wave: 1, state: 'moving', reached: [9] },
    },
    step,
    frontier: { down: 7, up: 9 },
    seams: [],
    ...overrides,
  };
}

const impact: ChangeImpactDto = {
  changeId: 'chg_1',
  chaptersTouched: [8, 7, 9],
  chaptersRewritten: [8, 7],
  blocksChanged: 4,
  charsAdded: 41,
  charsRemoved: 9,
  overwrites: 0,
  seams: [],
  depth: { down: 1, up: 1 },
  tokens: 150_572,
  costRub: 0.04,
  ms: 41_000,
  history: { fromHseq: 10, toHseq: 14 },
  computedAt: '2026-10-25T12:05:00Z',
};

const GATE_WORDS = ['вердикт', 'findings', 'редактор', 'консультант', 'HOLDS', 'GAP', 'gate'];

describe('the focus hash', () => {
  it('builds and parses #правка-<id>, including an encoded hash', () => {
    expect(focusHash('chg_1')).toBe('#правка-chg_1');
    expect(parseFocusHash('#правка-chg_1')).toBe('chg_1');
    expect(parseFocusHash('#%D0%BF%D1%80%D0%B0%D0%B2%D0%BA%D0%B0-chg_1')).toBe('chg_1');
    expect(parseFocusHash('правка-chg_1')).toBe('chg_1');
  });

  it('rejects every other hash instead of inventing a change', () => {
    expect(parseFocusHash('#glava-8')).toBeNull();
    expect(parseFocusHash('#правка-')).toBeNull();
    expect(parseFocusHash('#правка-chg 1')).toBeNull();
    expect(parseFocusHash('#%E0%A4%A')).toBeNull();
    expect(parseFocusHash('')).toBeNull();
  });
});

describe('the stage', () => {
  it('names the queue, the moved base and the terminal states', () => {
    expect(focusStage({ ...change, status: 'pending' }, null)).toBe('queue');
    expect(focusStage({ ...change, status: 'stale' }, null)).toBe('stale');
    expect(focusStage({ ...change, status: 'escalated' }, null)).toBe('escalated');
    expect(focusStage({ ...change, status: 'failed' }, null)).toBe('failed');
    expect(focusStage({ ...change, status: 'void' }, null)).toBe('void');
    expect(focusStage({ ...change, status: 'done', outcome: 'superseded' }, null)).toBe('void');
    expect(focusStage(change, null)).toBe('done');
    expect(focusStage({ ...change, status: 'done', outcome: 'dropped' }, null)).toBe('void');
  });

  it('takes the wing from where the ripple is now', () => {
    const processing: ChangeDto = { ...change, status: 'processing' };
    expect(focusStage(processing, null)).toBe('edit');
    expect(focusStage(processing, ribbon(7))).toBe('down');
    expect(focusStage(processing, ribbon(8))).toBe('edit');
    expect(focusStage(processing, ribbon(9))).toBe('up');
    expect(focusStage(processing, ribbon(7, { changeId: 'other' }))).toBe('edit');
  });

  it('has one Russian word per stage', () => {
    expect(stageCopy('queue')).toBe('очередь');
    expect(stageCopy('stale')).toBe('основа изменилась');
    expect(stageCopy('edit')).toBe('правка');
    expect(stageCopy('down')).toBe('вниз');
    expect(stageCopy('up')).toBe('вверх');
    expect(stageCopy('done')).toBe('готово');
    expect(stageCopy('escalated')).toBe('ждёт решения');
    expect(stageCopy('void')).toBe('снято');
    expect(stageCopy('failed')).toBe('не внесено');
    expect(stageCopy('unknown' as FocusStage)).toBe('правка');
  });
});

describe('wings', () => {
  it('reads both wings from the steps of a finished change', () => {
    expect(focusWings(change, null)).toEqual({ down: 7, up: 9 });
  });

  it('lets the live ribbon win while the ripple moves', () => {
    const processing: ChangeDto = { ...change, status: 'processing', steps: [change.steps[0]!] };
    expect(focusWings(processing, ribbon(7))).toEqual({ down: 7, up: 9 });
  });

  it('says nothing of a change that never moved, and takes the pair from the cascade record', () => {
    expect(focusWings({ ...change, steps: [] }, null)).toEqual({ down: null, up: null });
    expect(focusWingPair(change, null)).toEqual(change.cascade?.wings);
    expect(focusWingPair({ ...change, cascade: null }, null)).toEqual({
      down: { frontier: 8, wave: 0, state: 'waiting', reached: [] },
      up: { frontier: 8, wave: 0, state: 'waiting', reached: [] },
    });
  });
});

describe('the sheet chapter', () => {
  it('follows the ripple from 8 to 7 and 9', () => {
    const processing: ChangeDto = { ...change, status: 'processing' };
    expect(sheetChapter(processing, ribbon(7), null)).toBe(7);
    expect(sheetChapter(processing, ribbon(8), null)).toBe(8);
    expect(sheetChapter(processing, ribbon(9), null)).toBe(9);
  });

  it('keeps a manual pick until following is turned back on', () => {
    const processing: ChangeDto = { ...change, status: 'processing' };
    expect(sheetChapter(processing, ribbon(7), 9)).toBe(9);
    expect(sheetChapter(change, null, null)).toBe(8);
  });

  it('falls back to the first rewritten step, then to the change chapter', () => {
    const originOnly: ChangeDto = { ...change, steps: [change.steps[1]!] };
    expect(sheetChapter(originOnly, null, null)).toBe(7);
    expect(sheetChapter({ ...change, steps: [] }, null, null)).toBe(8);
  });
});

describe('what can be printed', () => {
  it('prints a landed change and a live one; never a dropped or stale one', () => {
    expect(canPrint(change)).toBe(true);
    expect(canPrint({ ...change, status: 'processing' })).toBe(true);
    expect(canPrint({ ...change, status: 'stale' })).toBe(false);
    expect(canPrint({ ...change, status: 'void', outcome: 'dropped' })).toBe(false);
    expect(canPrint({ ...change, status: 'done', outcome: 'dropped' })).toBe(false);
    expect(canPrint({ ...change, status: 'done', outcome: 'superseded' })).toBe(false);
  });
});

describe('the changed blocks, never the chapter', () => {
  it('reads a live patch and keeps only what moved', () => {
    const patch: PatchOp[] = [
      { op: 'replace', id: 'ch08#old', i: 2, newId: 'ch08#new', text: 'новый абзац' },
      { op: 'insert', id: '', i: 3, newId: 'ch08#ins', text: 'вставка' },
      { op: 'remove', id: 'ch08#gone', i: 4 },
    ];
    expect(blocksFromPatch(patch)).toEqual([
      { id: 'ch08#new', text: 'новый абзац', op: 'replaced' },
      { id: 'ch08#ins', text: 'вставка', op: 'added' },
      { id: 'ch08#gone', text: '', op: 'removed' },
    ]);
    expect(blocksFromPatch([{ op: 'replace', id: 'x', i: 0 }])).toEqual([]);
  });

  it('picks the change’s blocks out of the log and orders them as the chapter does', () => {
    const blocks: BlockDto[] = [
      { id: 'ch08#b', i: 1, text: 'второй', hash: 'h2' },
      { id: 'ch08#a', i: 0, text: 'первый', hash: 'h1' },
      { id: 'ch08#c', i: 2, text: 'третий', hash: 'h3' },
    ];
    const ops: HistoryDiffOpDto[] = [
      { op: 'added', chapter: 8, blockId: 'ch08#c', replacedBy: null, textHash: 'h3', at: null, changeId: 'chg_1' },
      { op: 'replaced', chapter: 8, blockId: 'ch08#b', replacedBy: 'ch08#a', textHash: 'h1', at: null, changeId: 'chg_1' },
      { op: 'removed', chapter: 8, blockId: 'ch08#gone', replacedBy: null, textHash: 'hx', at: null, changeId: 'chg_1' },
      { op: 'replaced', chapter: 8, blockId: 'ch08#orphan', replacedBy: null, textHash: 'ho', at: null, changeId: 'chg_1' },
      { op: 'added', chapter: 9, blockId: 'ch09#x', replacedBy: null, textHash: 'h9', at: null, changeId: 'chg_1' },
    ];
    expect(changedBlocksFromDiff(ops, 8, blocks)).toEqual([
      { id: 'ch08#a', text: 'первый', op: 'replaced' },
      { id: 'ch08#c', text: 'третий', op: 'added' },
      { id: 'ch08#gone', text: '', op: 'removed' },
      { id: 'ch08#orphan', text: '', op: 'removed' },
    ]);
  });
});

describe('the panel’s lines', () => {
  it('names the footnote, the wave and the assessed stage', () => {
    expect(waveOf(change)).toBe(2);
    expect(waveOf({ ...change, cascade: null })).toBe(1);
    expect(footnoteCopy(change)).toBe('сноска 014');
    // The bound is the server's: the fallback is the shipped default (BOOK-DOC-4 rule 3).
    expect(iterationCopy(change)).toBe('итерация 014 · волна 2 из 5');
    expect(assessmentCopy(change, null)).toBe('волна 2 из 5 · этап: готово');
  });

  it('takes the wave bound from the caller instead of carrying one of its own', () => {
    expect(iterationCopy(change, 4)).toBe('итерация 014 · волна 2 из 4');
    expect(assessmentCopy(change, null, 4)).toBe('волна 2 из 4 · этап: готово');
    // A change with no wave says nothing about the bound.
    expect(iterationCopy({ ...change, cascade: { ...change.cascade!, wave: 0 }, steps: [] }, 4)).not.toContain('волн');
  });

  it('states the basis and the touched chapters as facts', () => {
    expect(basisCopy(change)).toContain('замечание Аня · глава 8');
    expect(touchedChaptersCopy(change, impact)).toBe('07 · 08 · 09 (проверена)');
  });

  it('shows actual tokens and rubles, from the cost or from the impact', () => {
    expect(costLine(change, impact)).toBe('deepseek-flash · 150\u00a0572\u00a0токена · 0,04\u00a0₽');
    expect(costLine({ ...change, cost: null }, impact)).toBe('150\u00a0572\u00a0токена · 0,04\u00a0₽');
    expect(costLine({ ...change, cost: null }, null)).toBeNull();
  });

  it('prints no money for a cost that was never measured (BOOK-23)', () => {
    // `rub: null` is the absence of a measurement — the row's `cost_rub` placeholder zero.
    const unmeasured = {
      ...change,
      cost: { model: 'deepseek-flash', tokensIn: 120_000, tokensOut: 30_572, rub: null },
    };
    expect(costLine(unmeasured, null)).toBe('deepseek-flash · 150\u00a0572\u00a0токена');
    expect(costLine(unmeasured, null)).not.toContain('₽');
    // The impact projection obeys the same rule: its own zero-sum is not a measurement.
    expect(costLine({ ...change, cost: null }, { ...impact, costRub: null })).toBe('150\u00a0572\u00a0токена');
  });

  it('prints a measured zero, so «free» is not mistaken for «unmeasured»', () => {
    // This exact DTO is what `GET /api/changes/:id` emits for a row with `cost_priced = 1`
    // and `cost_rub = 0` (`server/test/engineState.test.ts` proves the wire value).
    const free = { ...change, cost: { model: 'deepseek-flash', tokensIn: 120_000, tokensOut: 30_572, rub: 0 } };
    expect(costLine(free, null)).toBe('deepseek-flash · 150\u00a0572\u00a0токена · 0,00\u00a0₽');
  });

  it('never prints a number that cannot be a price', () => {
    for (const rub of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const broken = { ...change, cost: { model: 'deepseek-flash', tokensIn: 120_000, tokensOut: 30_572, rub } };
      const line = costLine(broken, null) ?? '';
      expect(line).not.toContain('₽');
      expect(line).not.toContain('NaN');
    }
  });

  it('gives every degenerate case its own line and never types it', () => {
    expect(sheetNotice({ ...change, status: 'pending', position: 2 })).toBe('правка в очереди · 2-я');
    expect(
      sheetNotice({
        ...change,
        status: 'stale',
        relevance: {
          grade: 'partial',
          revAtRecord: 3,
          revNow: 5,
          anchor: 'moved',
          applies: 'partial',
          overlap: 0.5,
          chapterRewritten: false,
          evidence: [],
          reason: null,
        },
      }),
    ).toBe('основа изменилась · основа изменилась частично');
    expect(sheetNotice({ ...change, status: 'escalated' })).toBe('правка ждёт решения автора');
    expect(sheetNotice({ ...change, status: 'failed' })).toBe('не удалось внести · замечание сохранено');
    expect(sheetNotice({ ...change, status: 'void', outcome: 'dropped' })).toBe('снято · текст менять не нужно');
    expect(sheetNotice({ ...change, status: 'void', outcome: 'superseded' })).toBe('правка перекрыта более поздней');
    expect(sheetNotice(change)).toBeNull();
    expect(sheetCopy('снято · текст менять не нужно', 'в главе уже одно упоминание', false, 'void')).toBe(
      'снято · текст менять не нужно · в главе уже одно упоминание',
    );
    expect(sheetCopy(null, null, true, 'processing')).toBe('изменённые абзацы читаются');
    expect(sheetCopy(null, null, false, 'processing')).toBe('правка идёт · текст появится, когда шаг закроется');
  });

  it('never names a gate, a finding or a hidden role', () => {
    const lines = [
      stageCopy('down'),
      stageCopy('done'),
      footnoteCopy(change),
      iterationCopy(change),
      assessmentCopy(change, null),
      basisCopy(change),
      touchedChaptersCopy(change, impact),
      costLine(change, impact) ?? '',
      sheetNotice({ ...change, status: 'void', outcome: 'dropped' }) ?? '',
      sheetCopy(null, null, false, 'processing'),
    ]
      .join(' ')
      .toLowerCase();
    for (const word of GATE_WORDS) expect(lines).not.toContain(word.toLowerCase());
  });
});

describe('the ring field and the exit', () => {
  it('keeps a local window around the ripple and clamps it to the book', () => {
    expect(focusScale([8, 7, 9])).toEqual({ from: 5, to: 11 });
    expect(focusScale([1])).toEqual({ from: 1, to: 3 });
    expect(focusScale([67])).toEqual({ from: 65, to: 67 });
    expect(focusScale([])).toEqual({ from: 1, to: 5 });
    expect(scaleTicks(5, 11)).toEqual([5, 6, 7, 8, 9, 10, 11]);
    expect(scaleTicks(1, 30)).toEqual([]);
  });

  it('returns to the saved offset, or to the chapter the reader asked for', () => {
    expect(exitTarget(1240, null)).toEqual({ kind: 'offset', offset: 1240 });
    expect(exitTarget(1240, 8)).toEqual({ kind: 'chapter', chapter: 8 });
  });
});
