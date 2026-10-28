/**
 * BOOK-179 — the two checks the rubric described and nothing ran.
 *
 * The editor measured five explanations of one image inside 1 400 characters of ch01 and the
 * record said «HOLDS». These two checks read the text itself: a glossed image, and the absence
 * of one physical act the regulation did not ask for.
 */

import { describe, expect, it } from 'vitest';

import { actWithCost, checkProse, metaphorGloss } from '../../src/engine/prose.ts';

const GLOSSES = [
  'Дверь была как пасть: это означало, что вход не для людей.',
  'Дверь походила на пасть, то есть за ней никто не ждал.',
  'Дверь, иными словами, была пастью, которая закрывалась сама.',
].join('\n\n');

describe('the two prose checks', () => {
  it('flags an image explained more than once inside one window', () => {
    const found = metaphorGloss(GLOSSES);
    expect(found[0]).toMatchObject({ rule: 'METAPHOR_GLOSS', severity: 'major' });
    expect(found[0]?.defect).toMatch(/объяснён/u);
  });

  it('leaves one explanation alone', () => {
    expect(metaphorGloss(GLOSSES.split('\n\n')[0] ?? '')).toEqual([]);
  });

  it('flags a chapter where nobody does anything unchosen', () => {
    const procedural = 'Она внесла запись в журнал по форме 4-У. Затем проверила графу 16 и расписалась.';
    expect(actWithCost(procedural)[0]).toMatchObject({ rule: 'NO_ACT_WITH_COST', severity: 'major' });
  });

  it('accepts a chapter with one physical act outside the regulation', () => {
    const withAct = 'Она сорвала пломбу и высыпала письма на стол.';
    expect(actWithCost(withAct)).toEqual([]);
    expect(checkProse(withAct)).toEqual([]);
  });
});
