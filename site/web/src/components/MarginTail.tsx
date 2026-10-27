import { useEffect, useLayoutEffect } from 'react';

import { attachMarginPass } from '../lib/marginPass.ts';

/** Subscribe before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * BOOK-90 §1.10 — the page's last defence against a clipped note.
 *
 * In flow, after the colophon, `aria-hidden`, normally 0 px tall. The margin pass grows it by
 * whatever the last note reaches past the flow's bottom, so the page can always scroll far
 * enough for the last object. It is the only element in the margin's family that is *below*
 * everything: growing it moves nothing anyone is reading.
 *
 * The same component owns the page's one margin engine (resize + `document.fonts.ready`), so
 * a note does not install a listener of its own.
 */
export function MarginTail() {
  useMeasuredLayout(() => attachMarginPass(), []);
  return <div className="margin-tail" data-margin-tail="" aria-hidden="true" />;
}
