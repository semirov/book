// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { changeIdFromSearch, clearChangeParam } from './changeLink.ts';

/**
 * `?change=<id>` is the one address a reader's change has: bounded, charset-limited, and one
 * landing per address. Closing the record removes the parameter so a reload does not reopen the
 * section the reader put away.
 */
describe('the change address', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('reads one id from the query and refuses anything that cannot be a change key', () => {
    expect(changeIdFromSearch('?change=chg_1')).toBe('chg_1');
    expect(changeIdFromSearch('?x=1&change=chg_1&y=2')).toBe('chg_1');
    expect(changeIdFromSearch('')).toBeNull();
    expect(changeIdFromSearch('?change=')).toBeNull();
    expect(changeIdFromSearch('?change=chg%201')).toBeNull();
    expect(changeIdFromSearch(`?change=${'a'.repeat(81)}`)).toBeNull();
    // A query on the wrong key is not a change link.
    expect(changeIdFromSearch('?changeId=chg_1')).toBeNull();
  });

  it('removes only the change parameter, keeping the rest of the address', () => {
    window.history.replaceState(null, '', '/?change=chg_1&x=1#ch-8');
    clearChangeParam();
    expect(window.location.search).toBe('?x=1');
    expect(window.location.hash).toBe('#ch-8');
  });

  it('leaves an address without the parameter alone', () => {
    window.history.replaceState(null, '', '/?x=1#ch-8');
    clearChangeParam();
    expect(window.location.search).toBe('?x=1');
    expect(window.location.hash).toBe('#ch-8');
  });
});
