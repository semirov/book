import type { MyTraceDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { OwnTrace, revisionsWord, traceLine } from './OwnTrace.tsx';

function trace(overrides: Partial<MyTraceDto> = {}): MyTraceDto {
  return {
    label: 'Аня',
    edits: 3,
    chars: 4_000,
    share: 0.004,
    series: [],
    hidden: false,
    survivedRevisions: 4,
    ...overrides,
  };
}

describe('the reader’s own trace (BOOK-DOC-4)', () => {
  it('prints the measured share with a Russian decimal comma', () => {
    const html = renderToStaticMarkup(<OwnTrace trace={trace()} />);
    expect(html).toContain('пережила 4 ревизии, сейчас 0,4 %');
    expect(html).not.toContain('0.4');
    expect(html).toContain('Аня');
    expect(html).toContain('правок: 3');
  });

  it('counts the revisions it actually survived in Russian', () => {
    const html = renderToStaticMarkup(<OwnTrace trace={trace({ survivedRevisions: 1, share: 0.1234 })} />);
    expect(html).toContain('пережила 1 ревизию, сейчас 12,3 %');
    expect(revisionsWord(0)).toBe('ревизий');
    expect(revisionsWord(2)).toBe('ревизии');
    expect(revisionsWord(11)).toBe('ревизий');
    expect(revisionsWord(21)).toBe('ревизию');
  });

  it('tells a reader with no trace the truth instead of drawing a curve', () => {
    const html = renderToStaticMarkup(
      <OwnTrace trace={trace({ edits: 0, chars: 0, share: 0, survivedRevisions: 0, series: [] })} />,
    );
    expect(html).toContain('пережила 0 ревизий, сейчас 0,0 %');
    // BOOK-70: a zero edit count prints no suffix at all — «правок пока нет» counted nothing.
    expect(html).toContain('<p class="own-trace-edits">Аня</p>');
    expect(html).not.toContain('правок пока нет');
    expect(html).not.toContain('правок: 0');
    expect(html).not.toContain('svg');
    expect(html).not.toContain('polyline');
  });

  it('offers the honest, reversible hide copy and says nothing is lost', () => {
    const shown = renderToStaticMarkup(<OwnTrace trace={trace()} onToggleHidden={() => undefined} />);
    expect(shown).toContain('скрыть из списка авторов');
    expect(shown).not.toContain('вернуть в список');

    const hidden = renderToStaticMarkup(
      <OwnTrace trace={trace({ hidden: true })} onToggleHidden={() => undefined} />,
    );
    expect(hidden).toContain('вернуть в список');
    expect(hidden).toContain('вас нет в списке авторов');
    expect(hidden).toContain('история и доля сохранены');
  });

  it('has one sentence for the line, so the page and the test cannot drift', () => {
    expect(traceLine(trace())).toBe('пережила 4 ревизии, сейчас 0,4 %');
  });
});
