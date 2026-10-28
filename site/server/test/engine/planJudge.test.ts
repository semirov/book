/**
 * BOOK-181 — the plan reaches the editor's gate, and the judge answers each field.
 *
 * Five verdicts per chapter, as findings, not new vetoes: `act: absent` on a non-static chapter
 * and `metaphor: glossed` are majors (BOOK-179); the rest are notes. A chapter may declare
 * stillness — `документ`, `тишина` — and then the act is not demanded, only paid for.
 */

import { describe, expect, it } from 'vitest';

import type { ChapterPlan } from '@book/shared';

import { declaredStatic, judgePlan } from '../../src/engine/planJudge.ts';
import { chapterAnswer, createHarness } from '../writer/harness.ts';

const TEXT = 'Она сорвала пломбу и высыпала письма на стол. Дверь была как пасть.';

const PLAN: ChapterPlan = {
  act: { what: 'сорвала пломбу', cost: 'её смена', payer: 'она' },
  friction: { kind: 'physical', object: 'пломба', move: 'попытка' },
  metaphor: { image: 'пасть', glosses: 0 },
  want: 'Она',
  register_intent: 'с процедуры на телесное',
};

describe('the judge', () => {
  it('answers ok when the text does what the plan promised', () => {
    const verdicts = judgePlan(PLAN, TEXT).map((finding) => finding.defect.split(' — ')[0]);
    expect(verdicts).toEqual(['act: ok', 'friction: ok', 'metaphor: ok', 'want: ok', 'register: ok']);
  });

  it('answers act: absent when the plan promised an act the prose does not contain', () => {
    const prose = 'Она внесла запись в журнал по форме 4-У и расписалась в графе 16.';
    const found = judgePlan(PLAN, prose);
    expect(found[0]?.defect.startsWith('act: absent')).toBe(true);
    expect(found[0]?.severity).toBe('major');
  });

  it('answers metaphor: glossed on a second explanation, and it is a major', () => {
    const prose = `${TEXT} Пасть оставалась открытой, то есть вход не закрывался. Иными словами, пасть не закрывалась никогда.`;
    const found = judgePlan(PLAN, prose);
    const metaphor = found.find((item) => item.defect.includes('metaphor:'));
    expect(metaphor?.defect).toMatch(/metaphor: (glossed|second)/u);
  });

  it('lets a declared stillness pass without an act, if it names what the stillness pays', () => {
    const plan: ChapterPlan = {
      ...PLAN,
      act: null,
      static: { kind: 'документ', reason: 'смена документов, никто не действует', payer: 'смена' },
    };
    expect(declaredStatic(plan)).toBe(true);
    const verdicts = judgePlan(plan, TEXT).map((finding) => finding.defect.split(' — ')[0]);
    expect(verdicts[0]).toBe('act: ok');
  });

  it('does not accept stillness without a payer', () => {
    const plan: ChapterPlan = { ...PLAN, act: null, static: { kind: 'тишина', reason: 'так задумано', payer: '' } };
    expect(declaredStatic(plan)).toBe(false);
    expect(judgePlan(plan, TEXT)[0]?.defect.startsWith('act: absent')).toBe(true);
  });
});

describe('the gate envelope', () => {
  it('refuses a pass with no plan instead of judging the text blind', async () => {
    const harness = await createHarness();
    try {
      harness.plan = null;
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');
      const result = await harness.run({ chapter: 40 });
      expect(result.status).toBe('parked');
      expect(harness.logs.some((line) => line.includes('PLAN_MISSING'))).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
