import type { HistoryTimelineDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChronicleRecords } from './Chronicle.tsx';

/**
 * BOOK-56 — the starting record needs a date, and an answer that does not carry one has none.
 *
 * `firstAt` is `null` on an empty log, but a server that predates the field answers without
 * the key at all: a comparison against `null` misses `undefined`, and the row printed
 * «начало книги — · —» as if that dash were the moment the book began. The quiet line needs
 * no date, so it stands alone there. The sibling cases (a dated row, an empty log, a failure)
 * live in `chronicle.test.tsx`, which is at the 500-line arch limit.
 */

const noop = (): void => undefined;

const begun = {
  lastHseq: 3,
  lastAt: '2026-10-21T06:12:00Z',
  firstAt: '2026-10-21T06:12:00Z',
  at: '2026-10-25T12:00:00Z',
  items: [],
  nextBefore: null,
} as HistoryTimelineDto;

describe('a timeline whose answer has no `firstAt` at all (BOOK-56)', () => {
  it('prints the quiet line alone: no row, and no dash standing where a date goes', () => {
    const absent = { ...begun } as Partial<HistoryTimelineDto>;
    delete absent.firstAt;

    const html = renderToStaticMarkup(
      <ChronicleRecords timeline={absent as HistoryTimelineDto} failed={false} onOpenChange={noop} />,
    );

    expect(html).toContain('перематывать пока нечего: книга ещё не правила читателем');
    expect(html).not.toContain('начало книги');
    expect(html).not.toContain('class="chr-timeline"');
    expect(html).not.toContain('—');
    // An unknown moment is not an empty log either: that sentence belongs to an answer that
    // says the log is empty (`firstAt: null`).
    expect(html).not.toContain('пока ничего не записано');
  });

  it('keeps the dated row when the field is there', () => {
    const html = renderToStaticMarkup(
      <ChronicleRecords timeline={begun} failed={false} onOpenChange={noop} />,
    );
    expect(html).toContain('<span class="chr-seq">начало книги</span>');
    expect(html).toContain('class="chr-timeline"');
  });
});
