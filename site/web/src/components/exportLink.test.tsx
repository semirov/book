import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Authors } from './Authors.tsx';
import { ExportLink } from './ExportLink.tsx';

/**
 * BOOK-60 / BOOK-DOC-41 §6 — the download line in the end matter.
 *
 * Before the click the reader must be able to say which file and which edition they are
 * about to get. The export date is deliberately not printed: it is the click's own moment, so
 * the line says where it lives instead of inventing one.
 */

const imprint = { author: 'Филипп Семиров', copyright: '© Филипп Семиров' };
const REVISION = 4_503_599_627_370_495;

describe('the FB2 download (BOOK-60)', () => {
  it('AC7 — the end matter carries the link, the filename and the revision before the click', () => {
    const html = renderToStaticMarkup(<ExportLink revision={REVISION} />);
    // An anchor, never a button that shouts.
    expect(html).toContain('<a class="authors-export-link" href="/book.fb2">скачать в fb2</a>');
    expect(html).not.toContain('<button');
    // The file's name and the edition number are on the page before the click.
    expect(html).toContain(`blank-${REVISION}.fb2`);
    expect(html).toContain(`ревизия ${REVISION}`);
    expect(html).toContain('дата выгрузки — в файле');
    // No invented export date: the moment is the download's, not the page load's.
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
  });

  it('AC7 — the download sits in the end matter between the shares and the copyright', () => {
    // An explicit quiet stage keeps the measurement row on the page: without it the assertion
    // would compare against `indexOf` misses and prove nothing.
    const html = renderToStaticMarkup(
      <Authors authors={null} imprint={imprint} lastRevisionAt={null} live stage="quiet" revision={REVISION} />,
    );
    const share = html.indexOf('authors-share');
    const link = html.indexOf('href="/book.fb2"');
    expect(share).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(share);
    expect(link).toBeLessThan(html.indexOf('authors-copyright'));
    expect(html).toContain(`blank-${REVISION}.fb2`);
  });

  it('AC7 — the download is reachable with history off, where the authors list is not', () => {
    const html = renderToStaticMarkup(
      <Authors authors={null} imprint={imprint} lastRevisionAt={null} live={false} revision={REVISION} />,
    );
    expect(html).toContain('href="/book.fb2"');
    expect(html).toContain(`blank-${REVISION}.fb2`);
    expect(html).not.toContain('authors-list');
  });

  it('AC7 — an old payload without an edition still links, and prints no invented line', () => {
    const html = renderToStaticMarkup(<ExportLink />);
    expect(html).toContain('href="/book.fb2"');
    expect(html).toContain('скачать в fb2');
    expect(html).not.toContain('blank-');
    expect(html).not.toContain('ревизия');
  });
});
