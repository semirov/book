// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { anchorFor, clampQuote, seamKey } from '../lib/seam.ts';
import { closeSeam, openSeam } from '../lib/useSeam.ts';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-33 — the seam as a reader meets it, in a DOM.
 *
 * The SSR tests prove what the markup says; these prove the interaction: a **written** ch01
 * offers no form (the freeze is keyed on chapter identity, not on `basis`), `Esc` and a tap
 * outside close the seam and hand focus back to the paragraph, the live region announces the
 * form once, and a sentence longer than the 280-character anchor bound keeps its mark.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENTRY: CatalogEntry = {
  n: 1,
  part: 1,
  title: 'Комната на восьмом',
  rev: 3,
  chars: 22_000,
  blocks: 1,
  written: true,
  basis: false,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';
const BLOCK_ID = 'ch01#aa11bb22';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 1,
    anchor: { blockId: BLOCK_ID, blockIndex: 0, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: null,
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

let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  root = createRoot(document.body.appendChild(document.createElement('div')));
});

afterEach(async () => {
  closeSeam();
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

type ParagraphProps = {
  entry?: CatalogEntry;
  blockId?: string;
  text?: string;
  frozen?: boolean;
  comments?: readonly CommentDto[];
};

/** The paragraph is the unit that renders the strip, so a fixed entry drives the freeze. */
async function mountParagraph(props: ParagraphProps = {}): Promise<void> {
  const entry = props.entry ?? ENTRY;
  const blockId = props.blockId ?? BLOCK_ID;
  const text = props.text ?? TEXT;
  const anchor = anchorFor({ text, blockId, baseRev: entry.rev, offset: 0 });
  const origin = document.createElement('div');
  origin.tabIndex = -1;
  origin.setAttribute('data-origin', 'true');
  document.body.append(origin);
  await act(async () => {
    root?.render(
      <ProseParagraph
        entry={entry}
        blockId={blockId}
        blockIndex={0}
        baseRev={entry.rev}
        text={text}
        frozen={props.frozen ?? false}
        comments={props.comments ?? []}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        onPosted={() => undefined}
      />,
    );
  });
  // Open the seam after the paragraph subscribed: the store update then lands inside act.
  await act(async () => {
    openSeam({ chapter: entry.n, blockId, key: seamKey(entry.n, blockId, anchor!.sentence, entry.rev), anchor, origin });
  });
}

describe('a written ch01 is frozen by identity (blocker 1)', () => {
  it('offers no form at all on the chapter the server refuses', async () => {
    // `basis: false` and `written: true` — the BOOK-32 shape, which used to get a live form.
    await mountParagraph();
    const seam = document.querySelector('.seam');
    expect(seam).not.toBeNull();
    expect(seam?.getAttribute('data-frozen')).toBe('true');
    expect(seam?.textContent).toContain('закреплено');
    expect(seam?.querySelector('.seam-form')).toBeNull();
    expect(seam?.textContent).not.toContain('вмешаться');
    expect(seam?.textContent).toContain('рамка книги');
    // §4: the desktop outer-margin action is absent on a frozen chapter too.
    expect(document.querySelector('.seam-rail')).toBeNull();
  });

  it('leaves an ordinary chapter its form', async () => {
    await mountParagraph({ entry: { ...ENTRY, n: 8 }, blockId: 'ch08#aa11bb22' });
    const seam = document.querySelector('.seam');
    expect(seam?.getAttribute('data-frozen')).toBeNull();
    expect(seam?.textContent).toContain('вмешаться');
  });

  it('shows the ≥1024 margin rail only on a chapter that can take a form', async () => {
    const { ProseParagraph } = await import('./ProseParagraph.tsx');
    const render = async (entry: CatalogEntry): Promise<void> => {
      await act(async () => {
        root?.render(
          <ProseParagraph
            entry={entry}
            blockId="ch08#aa11bb22"
            blockIndex={0}
            baseRev={entry.rev}
            text={TEXT}
            frozen={false}
            comments={[]}
            composer={EMPTY_COMPOSER}
            viewer={{ signedIn: true, displayName: 'Филипп' }}
            onPosted={() => undefined}
          />,
        );
      });
    };
    await render({ ...ENTRY, n: 8 });
    expect(document.querySelector('.seam-rail')).not.toBeNull();
    await render({ ...ENTRY, n: 1 });
    expect(document.querySelector('.seam-rail')).toBeNull();
  });

  it('announces the open form once through a polite live region', async () => {
    await mountParagraph({ entry: { ...ENTRY, n: 8 }, blockId: 'ch08#aa11bb22' });
    const announce = document.querySelector('.seam-announce');
    expect(announce?.getAttribute('aria-live')).toBe('polite');
    // Closed seam: the region says nothing; the form is not announced until it opens.
    expect(announce?.textContent).toBe('');
    await act(async () => {
      (document.querySelector('.seam-cta') as HTMLElement).click();
    });
    expect(document.querySelector('.seam-announce')?.textContent).toBe('форма открыта');
  });
});

describe('closing the seam (major 4)', () => {
  it('closes on Escape and returns focus to the paragraph', async () => {
    await mountParagraph();
    expect(document.querySelector('.seam')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('.seam')).toBeNull();
    // Focus went back to the element the tap came from, not to the top of the page.
    expect(document.activeElement?.getAttribute('data-origin')).toBe('true');
  });

  it('closes on a pointer outside the strip and leaves a tap inside alone', async () => {
    await mountParagraph();
    await act(async () => {
      document.querySelector('.seam')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(document.querySelector('.seam')).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(document.querySelector('.seam')).toBeNull();
  });
});

describe('a sentence longer than the anchor bound keeps its mark (major 9)', () => {
  it('matches the filing by the clamped quote the server stored', async () => {
    const long = `${'слово '.repeat(60)}конец.`;
    const anchor = anchorFor({ text: long, blockId: 'ch08#aa11bb22', baseRev: 2, offset: 0 });
    expect(anchor?.quote.length).toBeLessThanOrEqual(280);
    expect(anchor?.quote).toBe(clampQuote(long));

    const filing = comment({
      id: 'cmt_long_1',
      chapter: 8,
      anchor: { blockId: 'ch08#aa11bb22', blockIndex: 0, quote: anchor?.quote ?? '', prefix: null, suffix: null, resolved: true },
    });
    await mountParagraph({
      entry: { ...ENTRY, n: 8 },
      blockId: 'ch08#aa11bb22',
      text: long,
      comments: [filing],
    });
    expect(document.querySelector('.filing-mark')).not.toBeNull();
    expect(document.querySelector('.cited')).not.toBeNull();
    // The visible numeral is the button: tapping it opens the filing, not the seam.
    await act(async () => {
      (document.querySelector('.filing-mark') as HTMLElement).click();
    });
    expect(document.querySelector('.filing-panel')).not.toBeNull();
    expect(document.querySelector('.filing-panel')?.textContent).toContain('замечание');
  });
});
