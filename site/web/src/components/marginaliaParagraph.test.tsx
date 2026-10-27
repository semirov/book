import type { CatalogEntry, CommentDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-90 — the paragraph with its marginalia, without a browser.
 *
 * AC1/AC3: an alive filing is in the DOM with no interaction (the note at ≥1024, the strip at
 * <1024 — the width alone decides which is painted), and both live **inside** the paragraph:
 * the note is `position: absolute` (CSS contract) and the strip is the last child, so the
 * prose is not re-typeset when a filing arrives.
 */

const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';
const BLOCK_ID = 'ch08#aa11bb22';
const QUOTE = 'Её освещал яркий свет.';

const ENTRY: CatalogEntry = {
  n: 8,
  part: 2,
  title: 'Комната на восьмом',
  rev: 3,
  chars: 22_000,
  blocks: 40,
  written: true,
  basis: false,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: { blockId: BLOCK_ID, blockIndex: 1, quote: QUOTE, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: 'testimony',
    status: 'new',
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    attempt: null,
    ...overrides,
  };
}

function render(comments: readonly CommentDto[] = [], text = TEXT): string {
  return renderToStaticMarkup(
    <ProseParagraph
      entry={ENTRY}
      blockId={BLOCK_ID}
      blockIndex={1}
      baseRev={3}
      text={text}
      frozen={false}
      comments={comments}
      history
      composer={EMPTY_COMPOSER}
      viewer={{ signedIn: true, displayName: 'Филипп' }}
      onPosted={() => undefined}
    />,
  );
}

describe('a filing in the paragraph', () => {
  it('hangs the note inside the paragraph, at the anchored sentence, with no interaction', () => {
    const html = render([comment()]);
    expect(html).toContain('class="margin-note');
    expect(html).toContain('ждёт');
    expect(html).toContain('попадёт в триаж');
    // The note is inside the sentence span whose quote it cites: the sentence opens, the note
    // follows it before the span closes.
    const sentence = html.indexOf('data-quote="Её освещал яркий свет."');
    const note = html.indexOf('class="margin-note');
    expect(sentence).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(sentence);
    // The mark sits between the sentence and the note: the note hangs at the same sentence.
    expect(html.indexOf('class="filing-mark-slot')).toBeGreaterThan(sentence);
    expect(html.indexOf('class="filing-mark-slot')).toBeLessThan(note);
  });

  it('puts the phone strip after every sentence, as the paragraph’s last child', () => {
    const html = render([comment()]);
    expect(html).toContain('class="phone-strip');
    // The strip is the last thing before the closing tag (no caret, no ⋯ in this fixture).
    expect(html).toMatch(/class="phone-strip[\s\S]*<\/p>$/u);
  });

  it('renders an empty paragraph with a silent margin: no note, no strip, no placeholders', () => {
    const html = render();
    expect(html).not.toContain('margin-note');
    expect(html).not.toContain('phone-strip');
    expect(html).not.toContain('ждёт');
  });

  it('keeps a held, rejected or expired filing alive in both surfaces', () => {
    for (const status of ['quarantined', 'rejected', 'expired', 'accepted'] as const) {
      const html = render([comment({ status })]);
      expect(html, status).toContain('class="margin-note');
      expect(html, status).toContain('class="phone-strip');
    }
  });

  it('prints nothing for a hidden filing and only the stale line for an unresolved anchor', () => {
    expect(render([comment({ status: 'hidden' })])).not.toContain('margin-note');
    const stale = render([comment({ anchor: { ...comment().anchor, resolved: false, quote: null } })]);
    expect(stale).not.toContain('margin-note');
    expect(stale).not.toContain('phone-strip');
    expect(stale).toContain('абзац изменился');
  });

  it('keeps the landed tick on the sentence the change rewrote', () => {
    // The change landed and rewrote its sentence: the stored quote matches no sentence now.
    // The place still does, and the object opened from that tick reads «стало» from the same
    // resolution — so the record stays reachable from the text it changed.
    const CHANGED = 'Я вошёл в пустую комнату. Её освещал тусклый свет.';
    const anchor = { ...comment().anchor, prefix: 'Я вошёл в пустую комнату. ' };
    const html = render([comment({ status: 'applied', applied: { chapter: 8, rev: 4 }, changeId: 'chg_1', anchor })], CHANGED);
    expect(html).toContain('filing-tick');
    expect(html).toContain('data-quote="Её освещал тусклый свет."');
  });

  it('keeps an alive note on the sentence its place points at', () => {
    const CHANGED = 'Я вошёл в пустую комнату. Её освещал тусклый свет.';
    const anchor = { ...comment().anchor, prefix: 'Я вошёл в пустую комнату. ' };
    const html = render([comment({ anchor })], CHANGED);
    expect(html).toContain('class="margin-note');
    expect(html).toContain('ждёт');
    expect(html).toContain('data-quote="Её освещал тусклый свет."');
  });

  it('gives the one mark on a rewritten sentence to the alive filing', () => {
    // Both anchors resolve to the same rewritten sentence; the alive filing wins the slot (the
    // same rule `FilingMark` uses), so a pending note is never displaced by a landed tick.
    const CHANGED = 'Я вошёл в пустую комнату. Свет был включён до меня и горел всю ночь.';
    const pending = comment({ anchor: { ...comment().anchor, quote: 'Свет был включён' } });
    const landed = comment({
      id: 'cmt_01J9Z8K4Q8',
      status: 'applied',
      applied: { chapter: 8, rev: 4 },
      anchor: { ...comment().anchor, quote: 'горел всю ночь' },
    });
    const html = render([landed, pending], CHANGED);
    expect(html).toContain('filing-alive');
    expect(html).not.toContain('filing-tick');
    expect(html).toContain('cited rule-dotted ink-quiet');
  });

  it('invents no place for an unresolved anchor whose wording is gone', () => {
    const CHANGED = 'Я вошёл в пустую комнату. Её освещал тусклый свет.';
    const html = render(
      [
        comment({
          status: 'applied',
          applied: { chapter: 8, rev: 4 },
          anchor: { ...comment().anchor, prefix: 'Я вошёл в пустую комнату. ', resolved: false },
        }),
      ],
      CHANGED,
    );
    expect(html).not.toContain('filing-tick');
    expect(html).toContain('абзац изменился');
  });

  it('leaves a landed-only sentence unruled — a pending sentence keeps its rule', () => {
    // BOOK-90: `applied` ink has `rule: 'none'`; the tick is the whole mark. A rule on the
    // sentence would be a live filing's claim, so the class must not be there at all.
    const landed = render([comment({ status: 'applied', applied: { chapter: 8, rev: 4 } })]);
    expect(landed).toContain('filing-tick');
    expect(landed).not.toContain('cited');
    expect(landed).not.toContain('rule-dotted');
    const pending = render([comment()]);
    expect(pending).toContain('class="cited rule-dotted ink-quiet"');
  });

  it('draws the accepted mark, not a note, for a landed change', () => {
    const html = render([comment({ status: 'applied', applied: { chapter: 8, rev: 4 } })]);
    expect(html).toContain('filing-tick');
    expect(html).toContain('открыть запись');
    expect(html).not.toContain('margin-note');
    expect(html).not.toContain('phone-strip');
  });
});
