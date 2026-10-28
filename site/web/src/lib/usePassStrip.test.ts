import { describe, expect, it } from 'vitest';

import { closeSeam, currentSeam, openSeam } from './useSeam.ts';
import { closePassStrip, currentPassStrip, openPassStrip } from './usePassStrip.ts';

/**
 * One strip at a time, and who closes whom (BOOK-111, BOOK-167). The store is a module, so
 * these tests read it through its own accessors and leave it closed.
 */

describe('the pass strip’s slot', () => {
  it('opens on a block and closes without stopping anything', () => {
    expect(currentPassStrip()).toBeNull();
    openPassStrip({ chapter: 7, blockId: 'ch07#bbbb2222' });
    expect(currentPassStrip()).toEqual({ chapter: 7, blockId: 'ch07#bbbb2222' });
    // A second open moves the strip: one place at a time.
    openPassStrip({ chapter: 8, blockId: 'ch08#aa11bb22' });
    expect(currentPassStrip()).toEqual({ chapter: 8, blockId: 'ch08#aa11bb22' });
    // The same place twice is not a second open: the strip keeps its one read.
    openPassStrip({ chapter: 8, blockId: 'ch08#aa11bb22' });
    expect(currentPassStrip()).toEqual({ chapter: 8, blockId: 'ch08#aa11bb22' });
    closePassStrip();
    expect(currentPassStrip()).toBeNull();
    // Closing a closed strip is a no-op, never a throw.
    closePassStrip();
    expect(currentPassStrip()).toBeNull();
  });

  it('takes the seam’s place when it opens', () => {
    openSeam({ chapter: 7, blockId: 'ch07#bbbb2222', key: 'ch7:bbbb', anchor: null, origin: null });
    expect(currentSeam()).not.toBeNull();
    openPassStrip({ chapter: 7, blockId: 'ch07#bbbb2222' });
    expect(currentSeam()).toBeNull();
    expect(currentPassStrip()).not.toBeNull();
    // And the seam takes the strip's place back, through the same registry.
    openSeam({ chapter: 7, blockId: 'ch07#bbbb2222', key: 'ch7:bbbb', anchor: null, origin: null });
    expect(currentPassStrip()).toBeNull();
    closeSeam();
  });
});
