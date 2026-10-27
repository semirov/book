// @vitest-environment jsdom
import type { ParagraphChainDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { placePopover, type AnchorRect } from '../lib/popover.ts';
import { ParagraphChain } from './ParagraphChain.tsx';

/**
 * BOOK-30 — the anchored panel's box is a live CSSOM write, not a `style` prop.
 *
 * The panel is the fourth surface that used to carry a style attribute. jsdom reports a
 * zero-sized panel, so the expected box comes from the same pure placement function.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const CHAIN: ParagraphChainDto = {
  blockUid: 'bkd_1',
  blockId: 'ch08#0b7e9c31',
  chapter: 8,
  alive: true,
  versions: [],
  line: 'переписано в 14:20 правкой 7 · было: правка 3 (Аня)',
};

const ANCHOR: AnchorRect = { top: 120, left: 10, width: 80, height: 20 };

let root: Root | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('the paragraph chain panel under a browser', () => {
  it('writes the measured box through CSSOM and clears it without an anchor', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const render = (anchor: AnchorRect | null) => (
      <ParagraphChain chain={CHAIN} loading={false} onClose={() => undefined} anchor={anchor} />
    );

    await act(async () => root?.render(render(null)));
    const panel = container.querySelector<HTMLElement>('aside.chain');
    expect(panel).not.toBeNull();
    expect(panel?.style.top).toBe('');

    await act(async () => root?.render(render(ANCHOR)));
    const box = placePopover(ANCHOR, { width: 0, height: 0 }, { width: window.innerWidth, height: window.innerHeight });
    expect(panel?.style.top).toBe(`${box.top}px`);
    expect(panel?.style.left).toBe(`${box.left}px`);
    expect(panel?.style.width).toBe(`${box.width}px`);
    expect(panel?.style.maxHeight).toBe(`${box.maxHeight}px`);

    await act(async () => root?.render(render(null)));
    expect(panel?.style.top).toBe('');
    expect(panel?.style.maxHeight).toBe('');
  });
});
