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
    ...overrides,
  };
}

function render(comments: readonly CommentDto[] = []): string {
  return renderToStaticMarkup(
    <ProseParagraph
      entry={ENTRY}
      blockId={BLOCK_ID}
      blockIndex={1}
      baseRev={3}
      text={TEXT}
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

  it('draws the accepted mark, not a note, for a landed change', () => {
    const html = render([comment({ status: 'applied', applied: { chapter: 8, rev: 4 } })]);
    expect(html).toContain('filing-tick');
    expect(html).toContain('открыть запись');
    expect(html).not.toContain('margin-note');
    expect(html).not.toContain('phone-strip');
  });
});
