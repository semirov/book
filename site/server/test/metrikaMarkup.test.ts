import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * BOOK-63 — the Webvisor rules, as a source guard (comment #3618).
 *
 * Webvisor records the DOM and typing; this site has a reader's own words in many places.
 * The counter's «Записывать все поля» setting stays off (the operator's job, stated in the
 * report), but the code is belt and braces: no `ym-record-keys` anywhere, `ym-disable-keys`
 * on every field, and `ym-hide-content` over every block that renders a reader's words, name
 * or quote — the seam, the form, the thread, the receipt, the draft (BOOK-63), and the end
 * matter, the change card, the filing and provenance panels, the chronicle, the chain and
 * the premise slot (BOOK-77, audit F1). A new surface that forgets the class fails here
 * instead of shipping: the consent line promises «Текст и имя в неё не попадают».
 */

import { METRIKA_INIT, METRIKA_TAG_URL } from '../../web/src/lib/analytics.ts';

const SRC = join(import.meta.dirname, '..', '..', 'web', 'src');

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

/** Every `<input …>` / `<textarea …>` tag in a file, across the lines a formatter wraps. */
function fields(source: string): string[] {
  return [...source.matchAll(/<(?:input|textarea)\b[^>]*>/gu)].map((match) => match[0]);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

describe('the reader’s fields are never recorded', () => {
  it('marks every input and textarea in the seam, the form and the thread', () => {
    for (const file of ['components/InterventionForm.tsx', 'components/InterventionKinds.tsx', 'components/Discussion.tsx', 'components/Chronicle.tsx']) {
      const tags = fields(read(file));
      for (const tag of tags) expect(tag, `${file}: ${tag}`).toContain('ym-disable-keys');
    }
    // The two text fields the reader actually writes in.
    const form = fields(read('components/InterventionForm.tsx'));
    expect(form.length).toBeGreaterThanOrEqual(2);
  });

  it('hides the seam, the form, the thread, the receipt and the draft from the recording', () => {
    const expectations: Array<[string, string]> = [
      ['components/Seam.tsx', 'className="seam ym-hide-content"'],
      ['components/Seam.tsx', 'className="seam-draft ym-hide-content"'],
      ['components/Seam.tsx', 'className="seam-receipt ym-hide-content"'],
      ['components/InterventionForm.tsx', 'className="seam-form ym-hide-content"'],
      ['components/Discussion.tsx', 'className="page talks ym-hide-content"'],
      // BOOK-77 (audit F1): every other surface that renders a reader's name, quote or body.
      ['components/Authors.tsx', 'className="page authors ym-hide-content"'],
      ['components/Authors.tsx', 'className="authors-row ym-disable-clickmap"'],
      ['components/OwnTrace.tsx', 'className="own-trace ym-disable-clickmap"'],
      ['components/ChangeCard.tsx', 'className="change-card ym-hide-content"'],
      ['components/FilingPanel.tsx', 'filing-panel ym-hide-content'],
      ['components/ProvenancePanel.tsx', 'prov-panel ym-hide-content'],
      ['components/Chronicle.tsx', 'className="chronicle page sheet ym-hide-content"'],
      ['components/Chronicle.tsx', 'className="chr-row ym-hide-content"'],
      ['components/ParagraphChain.tsx', 'chain ym-hide-content'],
      ['components/PremiseRow.tsx', 'className="premise ym-hide-content"'],
      ['components/FocusView.tsx', 'className="focus-note ym-hide-content"'],
    ];
    for (const [file, marker] of expectations) expect(read(file), file).toContain(marker);
  });

  it('never asks Webvisor to record a field', () => {
    for (const file of walk(SRC)) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('ym-record-keys');
    }
  });
});

describe('the loader is the external tag, under our CSP', () => {
  it('loads tag.js and initialises exactly the shipped options, with no ecommerce', () => {
    expect(METRIKA_TAG_URL).toBe('https://mc.yandex.ru/metrika/tag.js');
    expect(METRIKA_INIT).toEqual({
      ssr: true,
      webvisor: true,
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
    });
  });

  it('is not loaded from an inline script in the shell', () => {
    const html = readFileSync(join(SRC, '..', 'index.html'), 'utf8');
    expect(html).not.toContain('mc.yandex.ru');
    expect(html).not.toContain('ym(');
  });
});
