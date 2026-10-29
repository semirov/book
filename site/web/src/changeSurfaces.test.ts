import { describe, expect, it } from 'vitest';

/**
 * A change is a section of the sentence's record, and nothing else.
 *
 * The full-screen change surface (the focus view) and the fixed change card were deleted; this
 * guard is the cheap, always-on half of the deletion: no source file may bring the names back,
 * and no source may declare a modal dialog (`aria-modal="true"`), which is what the focus
 * shell was. Tests are excluded — they legitimately carry the old fragments as negative cases.
 * The built bundle is checked by the release's own grep; the build has no dead import to keep.
 */

const sources = import.meta.glob<string>('./**/*.{ts,tsx,css}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const READER_FACING = Object.entries(sources).filter(
  ([path]) => !path.includes('.test.') && !path.endsWith('changeSurfaces.test.ts'),
);

describe('no surface brings the deleted change view back', () => {
  it('has no focus-view source, no change card and no modal dialog', () => {
    for (const [path, text] of READER_FACING) {
      for (const gone of ['FocusView', 'FocusShell', 'FocusWings', 'focusHash', 'прицел', 'change-card', 'aria-modal="true"']) {
        expect(text, `${path} must not mention ${gone}`).not.toContain(gone);
      }
    }
  });

  it('addresses a change only by the query the page reads', () => {
    for (const [path, text] of READER_FACING) {
      expect(text, `${path} must not carry a change hash`).not.toContain('#правка-');
    }
  });
});
