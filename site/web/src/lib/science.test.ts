import { describe, expect, it } from 'vitest';

import { SCIENCE_ROLE, scienceLine } from './science.ts';

/**
 * BOOK-76 — the change record's one line about the physics pass. Two states and a silence:
 * a change whose step has no answer claims nothing.
 */
describe('the physics pass on the change card (BOOK-76)', () => {
  it('prints the verdict and the role that answered it', () => {
    expect(scienceLine('passed')).toBe('пройдена · научный консультант');
    expect(scienceLine('failed')).toBe('не пройдена · научный консультант');
  });

  it('says nothing at all while no pass has answered', () => {
    expect(scienceLine(null)).toBeNull();
  });

  it('takes the name from one constant, so a second spelling cannot appear', () => {
    expect(SCIENCE_ROLE).toBe('научный консультант');
    expect(scienceLine('passed')).toContain(SCIENCE_ROLE);
    expect(scienceLine('failed')).toContain(SCIENCE_ROLE);
  });
});
