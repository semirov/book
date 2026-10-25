import type { AuthorsDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Authors } from './Authors.tsx';

const imprint = { author: 'Филипп Семиров', copyright: '© Филипп Семиров' };

const measured: AuthorsDto = {
  totalChars: 100_000,
  measuredAt: '2026-10-25T12:00:00Z',
  measured: 2,
  author: { label: 'Филипп Семиров', share: 0.875, chars: 87_500 },
  contributors: [
    {
      identityId: 'idt_1',
      label: 'Аня',
      edits: 3,
      chars: 8_000,
      share: 0.08,
      firstAt: '2026-10-01T09:00:00Z',
      series: [],
    },
    {
      identityId: 'idt_2',
      label: 'Борис',
      edits: 1,
      chars: 4_500,
      share: 0.045,
      firstAt: '2026-10-02T09:00:00Z',
      series: [],
    },
  ],
  sum: 1,
};

describe('the end matter (§6C.5)', () => {
  it('lists the author first with the remainder, then the readers by descending share', () => {
    const html = renderToStaticMarkup(
      <Authors
        authors={measured}
        imprint={imprint}
        lastRevisionAt="2026-10-25T09:20:00Z"
        onOpenChronicle={() => undefined}
      />,
    );
    expect(html).toContain('Авторы');
    expect(html).toContain('доля в окончательном тексте');
    expect(html).toContain('Филипп Семиров');
    expect(html).toContain('автор');
    expect(html).toContain('87,5 %');
    expect(html).toContain('Аня');
    expect(html).toContain('8,0 %');
    expect(html).toContain('Борис');
    expect(html).toContain('правок: 3');
    // The author's row comes before every reader's row.
    expect(html.indexOf('Филипп Семиров')).toBeLessThan(html.indexOf('Аня'));
    expect(html.indexOf('Аня')).toBeLessThan(html.indexOf('Борис'));
  });

  it('prints the copyright and the last revision date, and no publisher', () => {
    const html = renderToStaticMarkup(
      <Authors
        authors={measured}
        imprint={imprint}
        lastRevisionAt="2026-10-25T09:20:00Z"
        onOpenChronicle={() => undefined}
      />,
    );
    expect(html).toContain('© Филипп Семиров');
    expect(html).toContain('последняя правка');
    expect(html).toContain('25.10.2026');
    expect(html).not.toContain('издательство');
    expect(html).not.toContain('ISBN');
    // No year on the cover; the end matter carries the date instead (§6C.6).
    expect(html).not.toContain('© Филипп Семиров, 20');
  });

  it('offers the erosion curve, not just a number', () => {
    const html = renderToStaticMarkup(
      <Authors authors={measured} imprint={imprint} lastRevisionAt={null} onOpenChronicle={() => undefined} />,
    );
    expect(html).toContain('как менялись доли');
  });

  it('shows one author and no invented share while the measurement is in flight', () => {
    const html = renderToStaticMarkup(
      <Authors authors={null} imprint={imprint} lastRevisionAt={null} onOpenChronicle={() => undefined} />,
    );
    expect(html).toContain('Филипп Семиров');
    expect(html).toContain('—');
    expect(html).toContain('пока весь текст написан автором');
    expect(html).not.toContain('%');
  });

  it('says plainly when no reader’s text survives', () => {
    const empty: AuthorsDto = {
      ...measured,
      author: { label: 'Филипп Семиров', share: 1, chars: 100_000 },
      contributors: [],
      sum: 1,
    };
    const html = renderToStaticMarkup(
      <Authors authors={empty} imprint={imprint} lastRevisionAt={null} onOpenChronicle={() => undefined} />,
    );
    expect(html).toContain('100,0 %');
    expect(html).toContain('пока весь текст написан автором');
  });
});
