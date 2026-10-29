import { describe, expect, it } from 'vitest';

import { passHashOf } from './passHash.ts';

/** An old pass address still names a change or a chapter — never a page of its own. */
describe('the old #проход- addresses', () => {
  it('reads a change id as the record’s `правка` section', () => {
    expect(passHashOf('#проход-chg_1')).toEqual({ kind: 'change', changeId: 'chg_1' });
    expect(passHashOf('проход-chg_1')).toEqual({ kind: 'change', changeId: 'chg_1' });
    expect(passHashOf('#проход-%D1%81%2D1')).toBeNull();
  });

  it('reads a bare pass as the chapter it was writing', () => {
    expect(passHashOf('#проход-4-stp_bare')).toEqual({ kind: 'chapter', chapter: 4 });
    expect(passHashOf('#проход-0-stp')).toBeNull();
    expect(passHashOf('#проход-69-stp')).toBeNull();
  });

  it('is not a pass address for anything else', () => {
    expect(passHashOf('#ch-4')).toBeNull();
    expect(passHashOf('#проход-')).toBeNull();
    expect(passHashOf('#проход-chg 1')).toBeNull();
    expect(passHashOf(`#проход-${'a'.repeat(81)}`)).toBeNull();
  });
});
