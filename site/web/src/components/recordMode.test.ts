import type { CatalogEntry, StateSnapshot } from '@book/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HEAD_WORDS } from '../lib/marginalia.ts';
import type { Stages } from '../lib/useStages.ts';
import type { SocketStatus } from '../lib/ws.ts';
import { state, stubDocument } from './colophon.fixture.ts';
import { RecordMode, recordModeOf } from './RecordMode.tsx';

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
 * even on a page whose readings are no longer live. And the record's head takes the page's
 * `socket` (BOOK-218): without it a trail would claim a live line it cannot know.
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

describe('a record page and the page’s facts (BOOK-218, BOOK-225)', () => {
  /** The stage log is not what this file asserts; neither record branch reads it. */
  const stages = { log: {}, passes: {}, note: () => undefined, reset: () => undefined } as unknown as Stages;

  /**
   * The colophon's fixture is the empty book; the head reads the book's own title, so this page
   * gets one. Nothing else in a record page reads the position.
   */
  const filled = { ...(state as unknown as Record<string, unknown>), front: { title: 'Бланк' } } as unknown as StateSnapshot;

  const front = {
    title: 'Бланк',
    about: null,
    rev: 1,
    toc: [],
    imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
    authors: { count: 1, measuredAt: '2026-10-29T12:00:00Z' },
    revision: 1,
  };

  /** One record page; only the head reads the position, so an empty book is enough here. */
  const render = (mode: 'trail' | 'chronicle', socket: SocketStatus, live = true): string =>
    renderToStaticMarkup(
      createElement(RecordMode, {
        mode,
        view: mode === 'trail' ? 'book' : 'chronicle',
        onViewChange: () => undefined,
        state: filled,
        ribbon: null,
        catalog: [] as CatalogEntry[],
        markers: [],
        onOpenChange: () => undefined,
        live,
        socket,
        stages,
        reading: { n: null, page: null },
        viewer: { signedIn: false, displayName: null },
        front,
        historyTick: 0,
        doorLine: null,
        plate: false,
        loadChapter: () => undefined,
      }),
    );

  it('renders «книга · хроника» even when the page’s own live fact is off', () => {
    const html = render('chronicle', 'open', false);
    expect(html).toContain('aria-label="как читать"');
    expect(html).toContain('книга');
    expect(html).toContain('хроника');
  });

  it('and the switch is the same one when the page is live', () => {
    expect(render('chronicle', 'open')).toBe(render('chronicle', 'open', false));
  });

  it('hands the page’s connection to the record’s head (BOOK-218)', () => {
    stubDocument();
    // The head says `связи нет` from the fact the page holds, so the record must receive it —
    // the trail has no socket of its own to fall back on.
    expect(render('trail', 'closed')).toContain(HEAD_WORDS.offline);
    expect(render('trail', 'open')).not.toContain(HEAD_WORDS.offline);
  });
});
