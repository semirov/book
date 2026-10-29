import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RowsList } from './RecordParts.tsx';

/**
 * BOOK-128 #3900 §1 — the fold's count is a fact about the list it drew.
 *
 * The line used to print a literal `6` beside the real total, so the one number the reader can
 * check said the same thing whatever was above it. It now reads the window's own length: the
 * shown count and the total cannot disagree, because only one of them is a variable.
 */

const noop = (): void => undefined;

function windowOf(shown: number, total: number) {
  const all = Array.from({ length: total }, (_, index) => ({
    id: `row-${String(index)}`,
    facts: `факт ${String(index)}`,
    specimen: `строка ${String(index)}`,
  }));
  return { rows: all.slice(0, shown), more: 0, over: total - shown };
}

describe('the fold’s count', () => {
  it('prints the rows it drew and the real total', () => {
    const html = renderToStaticMarkup(
      <RowsList rows={windowOf(6, 8)} lifted total={8} onLift={noop} onFold={noop} />,
    );
    expect(html).toContain('показаны 6 из 8');
  });

  it('follows the window instead of a fixed six', () => {
    const html = renderToStaticMarkup(
      <RowsList rows={windowOf(4, 9)} lifted total={9} onLift={noop} onFold={noop} />,
    );
    expect(html).toContain('показаны 4 из 9');
    expect(html).not.toContain('показаны 6');
  });

  it('prints no fold line while nothing is over the ceiling', () => {
    const html = renderToStaticMarkup(
      <RowsList rows={windowOf(3, 3)} lifted total={3} onLift={noop} onFold={noop} />,
    );
    expect(html).not.toContain('показаны');
  });
});
