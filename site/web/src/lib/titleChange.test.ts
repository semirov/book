import type { FrontUpdatedPayload } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { IDLE_TITLE, nextTitleMotion, titleMotionClass } from './titleChange.ts';

function event(overrides: Partial<FrontUpdatedPayload> = {}): FrontUpdatedPayload {
  return {
    title: 'Земля, которая больше не кормит',
    about: 'Книга о том…',
    rev: 2,
    previousRev: 1,
    changed: { title: true, about: false },
    cause: { kind: 'cascade', changeId: 'chg_1', cascadeId: 'csc_1', stepId: 'stp_1' },
    ...overrides,
  };
}

describe('nextTitleMotion', () => {
  it('gives a ripple reaching chapter 1 the ring gesture', () => {
    const motion = nextTitleMotion(IDLE_TITLE, event());
    expect(motion).toEqual({ token: 1, mode: 'ripple' });
    expect(titleMotionClass(motion)).toBe('title-ripple');
  });

  it('advances the token so the same class replays', () => {
    const once = nextTitleMotion(IDLE_TITLE, event());
    const twice = nextTitleMotion(once, event({ rev: 3, previousRev: 2 }));
    expect(twice).toEqual({ token: 2, mode: 'ripple' });
  });

  it('only fades a hand-written title', () => {
    const motion = nextTitleMotion(IDLE_TITLE, event({ cause: { kind: 'edit', changeId: null, cascadeId: null, stepId: null } }));
    expect(motion).toEqual({ token: 1, mode: 'fade' });
    expect(titleMotionClass(motion)).toBe('title-fade');
  });

  it('does not animate when only the annotation changed', () => {
    const motion = nextTitleMotion({ token: 4, mode: 'ripple' }, event({ changed: { title: false, about: true } }));
    expect(motion).toEqual({ token: 4, mode: 'ripple' });
  });

  it('stays idle without an event', () => {
    expect(nextTitleMotion(IDLE_TITLE, null)).toBe(IDLE_TITLE);
    expect(titleMotionClass(IDLE_TITLE)).toBe('');
  });
});
