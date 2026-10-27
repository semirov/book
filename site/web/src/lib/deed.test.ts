import type { RetroMode } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  DEED_WORDS,
  changeDeedLine,
  deedLine,
  deedStates,
  deedWord,
  type DeedInput,
} from './deed.ts';

const NONE = { accepted: false, steps: 0, rewritten: [], modes: [] } as const;

function deed(overrides: Partial<DeedInput> = {}): DeedInput {
  return { accepted: true, steps: 0, rewritten: [], modes: [], ...overrides };
}

describe('the five public states of a change', () => {
  it('uses exactly five lowercase words, with no exclamation', () => {
    expect(Object.values(DEED_WORDS)).toEqual([
      'зарегистрировано',
      'заведено дело',
      'внесены изменения',
      'причина установлена',
      'расхождение зафиксировано',
    ]);
    for (const word of Object.values(DEED_WORDS)) {
      expect(word).toBe(word.toLowerCase());
      expect(word).not.toContain('!');
    }
  });

  it('shows none of them for a refusal: nothing was registered', () => {
    expect(deedStates(NONE)).toEqual([]);
    expect(deedLine(NONE)).toBe('');
    expect(changeDeedLine(null)).toBeNull();
  });

  it('adds a state only when its data exists', () => {
    expect(deedStates(deed())).toEqual(['registered']);
    expect(deedStates(deed({ steps: 1 }))).toEqual(['registered', 'filed']);
    expect(deedStates(deed({ steps: 3, rewritten: [7] }))).toEqual(['registered', 'filed', 'changed']);
    // A mode without a case file is not a filed cause: the chain never skips its own evidence.
    expect(deedStates(deed({ modes: ['оформление'] }))).toEqual(['registered']);
    expect(deedStates(deed({ steps: 1, modes: ['оформление'] }))).toEqual([
      'registered',
      'filed',
      'cause',
    ]);
    expect(deedStates(deed({ steps: 1, modes: ['расхождение'] }))).toEqual([
      'registered',
      'filed',
      'divergence',
    ]);
  });

  it('reads an established cause with its mode, and an amendment as an amendment', () => {
    expect(deedWord('cause', ['оформление'])).toBe('причина установлена · оформление');
    expect(deedWord('cause', ['поправка'])).toBe(
      'причина установлена · поправка: пункт изложен в новой редакции',
    );
    expect(deedWord('divergence', [])).toBe('расхождение зафиксировано');
    const amendment = deedLine(deed({ steps: 2, rewritten: [8], modes: ['поправка'] }));
    expect(amendment).toBe(
      'зарегистрировано · заведено дело · внесены изменения · причина установлена · поправка: пункт изложен в новой редакции',
    );
    expect(amendment).not.toMatch(/исправлен|ошибк/u);
  });

  it('keeps the fixed order when both a cause and a divergence were recorded', () => {
    const modes: RetroMode[] = ['расхождение', 'оформление'];
    expect(deedStates(deed({ steps: 1, rewritten: [8], modes }))).toEqual([
      'registered',
      'filed',
      'changed',
      'cause',
      'divergence',
    ]);
    expect(deedLine(deed({ steps: 1, rewritten: [8], modes }))).toBe(
      'зарегистрировано · заведено дело · внесены изменения · причина установлена · оформление · расхождение зафиксировано',
    );
  });

  it('derives the line from a change DTO', () => {
    const fromChange = changeDeedLine({
      cascade: { chaptersRewritten: [7, 8] },
      steps: [{}, {}] as never,
      modes: ['оформление'],
    } as never);
    expect(fromChange).toBe('зарегистрировано · заведено дело · внесены изменения · причина установлена · оформление');
  });

  it('counts a local change’s landed step as an amendment, since no cascade carries it', () => {
    const local = changeDeedLine({
      cascade: null,
      steps: [{ chapter: 8, outcome: 'rewritten' }],
      modes: [],
    } as never);
    expect(local).toBe('зарегистрировано · заведено дело · внесены изменения');
  });
});
