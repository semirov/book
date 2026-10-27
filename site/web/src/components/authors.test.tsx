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
    },
    {
      identityId: 'idt_2',
      label: 'Борис',
      edits: 1,
      chars: 4_500,
      share: 0.045,
      firstAt: '2026-10-02T09:00:00Z',
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
    // A wait is not an empty roster (§10): the sentence about the text is a fact, not a form.
    expect(html).not.toContain('пока весь текст написан автором');
    expect(html).not.toContain('%');
  });

  it('renders the signed-in reader’s own trace in the end matter, and nothing for a guest', () => {
    const ownTrace = {
      label: 'Аня',
      edits: 2,
      chars: 400,
      share: 0.004,
      series: [],
      hidden: false,
      survivedRevisions: 4,
    };
    const signedIn = renderToStaticMarkup(
      <Authors
        authors={measured}
        imprint={imprint}
        lastRevisionAt={null}
        onOpenChronicle={() => undefined}
        ownTrace={ownTrace}
        onToggleHidden={() => undefined}
      />,
    );
    expect(signedIn).toContain('ваш след');
    expect(signedIn).toContain('пережила 4 ревизии, сейчас 0,4 %');
    expect(signedIn).toContain('скрыть из списка авторов');

    const guest = renderToStaticMarkup(
      <Authors authors={measured} imprint={imprint} lastRevisionAt={null} onOpenChronicle={() => undefined} />,
    );
    expect(guest).not.toContain('ваш след');
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

/**
 * BOOK-DOC-43 §3, §6, §7 — the shares are a measurement, and it has a wait (BOOK-66).
 *
 * The roster's slot keeps its shape: the status goes where the empty-state sentence already
 * lives, the three rows are a form with blank fields, and the author row is one of them — a
 * real row beside the form would be a fact and a blank for the same three cells.
 */
describe('«Авторы» while the shares are counted', () => {
  function markup(props: {
    authors: AuthorsDto | null;
    stage: 'quiet' | 'skeleton' | 'slow';
    authorsFailed?: boolean;
  }): string {
    return renderToStaticMarkup(
      <Authors
        authors={props.authors}
        stage={props.stage}
        {...(props.authorsFailed === true ? { authorsFailed: true } : {})}
        imprint={imprint}
        lastRevisionAt={null}
        onOpenChronicle={() => undefined}
      />,
    );
  }

  it('says what is loading instead of the false fact, and draws the form of three rows', () => {
    const html = markup({ authors: null, stage: 'skeleton' });
    expect(html).toContain('доли считаются');
    expect(html).toContain('class="skel skel-authors"');
    expect(html).toContain('aria-busy="true"');
    // The form keeps the list's box (18 px top margin), so the content below does not move
    // when the rows arrive: one `li` holds the hidden form inside the same `ol.authors-list`.
    expect(html).toContain('<ol class="authors-list"><li><div class="skel skel-authors"');
    expect(html).not.toContain('пока весь текст написан автором');
    // No pseudo-row: the author's name is a blank cell in the form, not a fact beside it.
    expect(html).not.toContain('authors-row');
    expect(html).not.toContain('>автор<');
    // Exactly one status, in the slot `.authors-empty` already owns.
    expect(html.match(/role="status"/gu)).toHaveLength(1);
    expect(html).toMatch(/<p class="authors-empty"><span role="status"/u);
  });

  it('carries the slow sentence in the same slot', () => {
    const html = markup({ authors: null, stage: 'slow' });
    expect(html).toContain('доли считаются дольше обычного · цифры появятся здесь же');
    expect(html.match(/role="status"/gu)).toHaveLength(1);
    expect(html).not.toContain('пока весь текст написан автором');
  });

  it('is busy for the whole request, not from the 150 ms sentence (§7 alignment)', () => {
    const html = renderToStaticMarkup(
      <Authors
        authors={null}
        stage="quiet"
        busy
        imprint={imprint}
        lastRevisionAt={null}
        onOpenChronicle={() => undefined}
      />,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('class="skel');
    const settled = renderToStaticMarkup(
      <Authors
        authors={measured}
        stage="quiet"
        busy={false}
        imprint={imprint}
        lastRevisionAt={null}
        onOpenChronicle={() => undefined}
      />,
    );
    expect(settled).not.toContain('aria-busy');
  });

  it('returns the real rows when the measurement lands: no form, no status, no busy claim', () => {
    const html = markup({ authors: measured, stage: 'quiet' });
    expect(html).toContain('class="authors-list"');
    expect(html).toContain('87,5 %');
    expect(html).not.toContain('class="skel');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('aria-busy');
  });

  it('is silent after a failure: no form, no status, no false fact, «—» stays', () => {
    const html = markup({ authors: null, stage: 'quiet', authorsFailed: true });
    expect(html).not.toContain('class="skel');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('aria-busy');
    expect(html).not.toContain('пока весь текст написан автором');
    expect(html).toContain('—');
    expect(html).toContain('Филипп Семиров');
  });

  it('does not claim an empty roster off a failed re-measure either', () => {
    // A measurement that failed after an earlier one may be stale: no sentence, but the rows stay.
    const html = markup({ authors: { ...measured, contributors: [] }, stage: 'quiet', authorsFailed: true });
    expect(html).not.toContain('пока весь текст написан автором');
  });
});
