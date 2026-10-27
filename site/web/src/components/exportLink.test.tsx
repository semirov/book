import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Authors } from './Authors.tsx';
import { ExportLink } from './ExportLink.tsx';

/**
 * BOOK-60 / BOOK-138 — the download, on both surfaces.
 *
 * The reader must be able to take the book away with one click, and the link must say how big
 * the file is. What it must not do is invent anything: the size is the number the payload
 * carried, the name is the response's (`content-disposition`), and the edition number and the
 * export moment are in the file — never in the label.
 */

const imprint = { author: 'Филипп Семиров', copyright: '© Филипп Семиров' };
const BYTES = 1_500_000;

describe('the FB2 download (BOOK-138)', () => {
  it('AC1 — is one real anchor with `download`, and the size the payload measured', () => {
    const html = renderToStaticMarkup(<ExportLink exportBytes={BYTES} />);
    expect(html).toBe('<a class="export-link" href="/book.fb2" download="">скачать fb2 · 1,5 МБ</a>');
    // No JS path to the file: no handler, no script, no button, no fetch-and-blob, no icon.
    for (const gone of ['onClick', 'onclick', '<script', '<button', '<img', 'fetch(', 'aria-']) {
      expect(html, gone).not.toContain(gone);
    }
  });

  it('AC1 — the label is the size the prop carries, so two payloads print two labels', () => {
    expect(renderToStaticMarkup(<ExportLink exportBytes={512_000} />)).toContain('скачать fb2 · 512 КБ');
    expect(renderToStaticMarkup(<ExportLink exportBytes={2_340_000} />)).toContain('скачать fb2 · 2,3 МБ');
  });

  it('AC1 — an unknown size prints the verb alone: no dot, no unit, no invented number', () => {
    for (const html of [
      renderToStaticMarkup(<ExportLink />),
      renderToStaticMarkup(<ExportLink exportBytes={null} />),
      renderToStaticMarkup(<ExportLink exportBytes={Number.NaN} />),
      // A file is never zero bytes: a zero is a broken payload, not a measurement.
      renderToStaticMarkup(<ExportLink exportBytes={0} />),
      renderToStaticMarkup(<ExportLink exportBytes={-1} />),
    ]) {
      expect(html).toBe('<a class="export-link" href="/book.fb2" download="">скачать fb2</a>');
      for (const gone of ['·', 'КБ', 'МБ', 'null', 'NaN', 'blank-', 'ревизия', 'выгрузки']) {
        expect(html, gone).not.toContain(gone);
      }
    }
  });

  it('AC1 — the end matter carries it after the shares and before the last-change date', () => {
    // An explicit quiet stage keeps the measurement row on the page: without it the assertion
    // would compare against `indexOf` misses and prove nothing. The closing line is the date:
    // BOOK-137 removed the second «©», so the rights statement has no copy here to sit before.
    const html = renderToStaticMarkup(
      <Authors
        authors={null}
        imprint={imprint}
        lastRevisionAt="2026-10-25T09:20:00Z"
        live
        stage="quiet"
        exportBytes={BYTES}
      />,
    );
    const share = html.indexOf('authors-share');
    const link = html.indexOf('href="/book.fb2"');
    expect(share).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(share);
    expect(link).toBeLessThan(html.indexOf('authors-updated'));
    expect(html).toContain('скачать fb2 · 1,5 МБ');
    // BOOK-137 — one © on the page: the end matter prints no rights statement of its own.
    expect(html).not.toContain('authors-copyright');
    // BOOK-138 removed the second line: the edition is in the file and on the ETag, not here.
    expect(html).not.toContain('blank-');
    expect(html).not.toContain('ревизия');
  });

  it('AC1 — stays reachable with history off, where the authors list is not', () => {
    const html = renderToStaticMarkup(
      <Authors authors={null} imprint={imprint} lastRevisionAt={null} live={false} exportBytes={BYTES} />,
    );
    expect(html).toContain('href="/book.fb2"');
    expect(html).toContain('скачать fb2 · 1,5 МБ');
    expect(html).not.toContain('authors-list');
  });

  it('AC1 — an old payload without a size still links, and prints no number', () => {
    const html = renderToStaticMarkup(
      <Authors authors={null} imprint={imprint} lastRevisionAt={null} live={false} />,
    );
    expect(html).toContain('<a class="export-link" href="/book.fb2" download="">скачать fb2</a>');
    expect(html).not.toContain('КБ');
    expect(html).not.toContain('МБ');
  });
});
