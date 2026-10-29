import type { CatalogEntry } from '@book/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { state } from './colophon.fixture.ts';
import { RecordMode, recordModeOf } from './RecordMode.tsx';
import type { Stages } from '../lib/useStages.ts';

/**
 * BOOK-225 — the gate outranks the record's two modes, and the chronicle keeps its way back.
 *
 * «след» and «хроника» both lead into past chapters, and a past chapter is prose: the history's
 * chapter route refuses it without the acknowledgement. So the one predicate that decides
 * whether the book page is replaced must answer `null` for a gated reader — whichever deep link
 * they arrived on — and the same predicate is what `App` and `RecordMode` read, so the early
 * return and the page it renders cannot disagree.
 *
 * The mode's own switch is **not** the page's `live` fact: `recordModeOf` grants «хроника» only
 * once the record has started, so the switch in that mode is the way back and is always there —
 * even on a page whose readings are no longer live. The render below pins that, so the shorthand
 * can never be read as «this page is live» again.
 */
describe('which record page a request is (BOOK-225)', () => {
  const gated = { acknowledged: false, trail: false, view: 'book' as const, chronicle: true };

  it('answers no mode at all while the gate stands, whatever the link says', () => {
    expect(recordModeOf(gated)).toBeNull();
    expect(recordModeOf({ ...gated, trail: true })).toBeNull();
    expect(recordModeOf({ ...gated, view: 'chronicle' })).toBeNull();
    expect(recordModeOf({ ...gated, trail: true, view: 'chronicle' })).toBeNull();
  });

  it('answers the mode a reader past the gate asked for, and the book page for no link', () => {
    expect(recordModeOf({ acknowledged: true, trail: true, view: 'book', chronicle: true })).toBe('trail');
    expect(recordModeOf({ acknowledged: true, trail: false, view: 'chronicle', chronicle: true })).toBe('chronicle');
    expect(recordModeOf({ acknowledged: true, trail: false, view: 'book', chronicle: true })).toBeNull();
    // A chronicle before the book has begun is not a page: the switch is not offered either.
    expect(recordModeOf({ acknowledged: true, trail: false, view: 'chronicle', chronicle: false })).toBeNull();
  });
});

describe('the chronicle mode keeps its way back (BOOK-225)', () => {
  /** The trail's stage log is not what this file asserts; the chronicle branch never reads it. */
  const stages = { log: {}, passes: {}, note: () => undefined, reset: () => undefined } as unknown as Stages;

  const mode = (live: boolean): string =>
    renderToStaticMarkup(
      createElement(RecordMode, {
        mode: 'chronicle',
        view: 'chronicle',
        onViewChange: () => undefined,
        state,
        ribbon: null,
        catalog: [] as CatalogEntry[],
        markers: [],
        onOpenChange: () => undefined,
        live,
        stages,
        reading: { n: null, page: null },
        viewer: { signedIn: false, displayName: null },
        front: {
          title: 'Бланк',
          about: null,
          rev: 1,
          toc: [],
          imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
          authors: { count: 1, measuredAt: '2026-10-29T12:00:00Z' },
          revision: 1,
        },
        historyTick: 0,
        doorLine: null,
        plate: false,
        loadChapter: () => undefined,
      }),
    );

  it('renders «книга · хроника» even when the page’s own live fact is off', () => {
    const html = mode(false);
    expect(html).toContain('aria-label="как читать"');
    expect(html).toContain('книга');
    expect(html).toContain('хроника');
  });

  it('and the switch is the same one when the page is live', () => {
    expect(mode(true)).toBe(mode(false));
  });
});
