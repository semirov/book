// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { resetParagraphChainCache } from '../lib/paragraphChainCache.ts';
import { wordFacts } from '../lib/provenance.ts';
import { anchorFor, seamKey } from '../lib/seam.ts';
import { hideFiling } from '../lib/useFiling.ts';
import { closeSeam, openSeam } from '../lib/useSeam.ts';
import { mediaBlocks, rules } from './cssRules.ts';
import { PROV_BLOCK_CLASS, ProvenanceBlock } from './ProvenanceBlock.tsx';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-128 comment #3815 — «откуда это слово» is **reader**: three facts and one sentence
 * beside the strip that opened them, never a floating panel.
 *
 * What is proven here: one case per hand the book can print (the words are
 * `lib/provenance.test.ts`); a filing on the word is a real `<a>` that opens the site's one
 * card; the block never scrolls, prints no id, uppercases no word and carries no shadow or
 * close; in flow it grows under the row and a close returns the strip and the focus.
 *
 * jsdom has no layout: the geometry claims are read off the stylesheets (a rule, not a pixel)
 * and the state claims off the DOM. Where a number is claimed (44 px, the 40 px tie, the
 * `--note-fit` width) the assertion names the declaration that makes it true.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sheets = import.meta.glob<string>('../styles/*.css', { query: '?raw', import: 'default', eager: true });
const reader = sheets['../styles/reader.css'] ?? '';
const seamCss = sheets['../styles/seam.css'] ?? '';

const ENTRY: CatalogEntry = {
  n: 8,
  part: 2,
  title: 'Комната на восьмом',
  rev: 3,
  chars: 22_000,
  blocks: 40,
  written: true,
  basis: false,
  opening: null,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

const BLOCK_ID = 'ch08#wordblock';
const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';
const SEAM_QUOTE = 'Я вошёл в пустую комнату.';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: { blockId: BLOCK_ID, blockIndex: 0, quote: SEAM_QUOTE, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: null,
    status: 'new',
    refusal: null,
    attempt: null,
    frame: null,
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
let container: HTMLDivElement;

beforeEach(() => {
  resetParagraphChainCache();
  vi.stubGlobal('IntersectionObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    hideFiling();
    closeSeam();
  });
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  resetParagraphChainCache();
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
}

/** The paragraph with its strip open: the block's only door lives in that row. */
async function mountStrip(comments: readonly CommentDto[] = [], history = true): Promise<void> {
  const anchor = anchorFor({ text: TEXT, blockId: BLOCK_ID, baseRev: ENTRY.rev, offset: 0 });
  await act(async () => {
    root?.render(
      <ProseParagraph
        entry={ENTRY}
        blockId={BLOCK_ID}
        blockIndex={0}
        baseRev={ENTRY.rev}
        text={TEXT}
        blockCount={40}
        comments={comments}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        onPosted={() => undefined}
        history={history}
      />,
    );
  });
  await act(async () => {
    openSeam({ chapter: 8, blockId: BLOCK_ID, key: seamKey(8, BLOCK_ID, anchor!.sentence, ENTRY.rev), anchor, origin: container });
  });
}

const block = (): HTMLElement | null => document.querySelector<HTMLElement>('.prov-block');
const strip = (): HTMLElement => document.querySelector<HTMLElement>('.seam') as HTMLElement;
const lines = (): string[] => [...(block()?.querySelectorAll('p') ?? [])].map((node) => node.textContent ?? '');

/** Every `text-transform: uppercase` rule of the two sheets that dress this layer, by selector. */
function uppercaseSelectors(): string[] {
  return [reader, seamCss]
    .flatMap((sheet) => rules(sheet))
    .filter(([, body]) => /text-transform:\s*uppercase/u.test(body))
    .flatMap(([selector]) => selector.split(',').map((token) => token.trim()));
}

/** The classes of the block and of everything inside it. */
function blockClasses(): string[] {
  const node = block();
  if (node === null) return [];
  return [node, ...node.querySelectorAll<HTMLElement>('*')].flatMap((element) => [...element.classList]);
}

describe('the word’s facts as the block prints them — one case per hand', () => {
  it('a pass wrote it: «печатник», the moment, no trace, and the one sentence', async () => {
    await act(async () => {
      root?.render(
        <ProvenanceBlock
          view={wordFacts({ variant: 'machine', actor: null, at: '2026-10-28T09:08:00Z', share: { kind: 'none' }, filing: null })}
          failed={false}
          onFiling={() => undefined}
        />,
      );
    });

    expect(lines()).toEqual([
      'печатник',
      'с 28.10.2026, 12:08',
      'следа нет',
      'печатник — смена, которая пишет книгу; рамку держит автор.',
    ]);
  });

  it('the frozen frame and page 2 name their own surface, and say no moment', async () => {
    await act(async () => {
      root?.render(
        <ProvenanceBlock
          view={wordFacts({ variant: 'frozen', actor: null, frozenOf: 'frame', at: null, share: { kind: 'none' }, filing: null })}
          failed={false}
          onFiling={() => undefined}
        />,
      );
    });
    expect(lines()).toEqual(['рамка книги', 'вне правок', 'следа нет']);

    await act(async () => {
      root?.render(
        <ProvenanceBlock
          view={wordFacts({ variant: 'frozen', actor: null, frozenOf: 'basis', at: null, share: { kind: 'none' }, filing: null })}
          failed={false}
          onFiling={() => undefined}
        />,
      );
    });
    expect(lines()).toEqual(['основание книги', 'вне правок', 'следа нет']);
  });

  it('a reader’s own version carries their name and their curve, and no gloss', async () => {
    await act(async () => {
      root?.render(
        <ProvenanceBlock
          view={wordFacts({
            variant: 'reader',
            actor: 'Аня',
            at: '2026-10-28T09:08:00Z',
            share: { kind: 'own', share: 0.004, survivedRevisions: 4 },
            filing: null,
          })}
          failed={false}
          onFiling={() => undefined}
        />,
      );
    });
    expect(lines()).toEqual(['Аня', 'с 28.10.2026, 12:08', 'пережила 4 ревизии']);
  });

  it('a version nobody claims says «правка вне процесса» and no trace it cannot know', async () => {
    await act(async () => {
      root?.render(
        <ProvenanceBlock
          view={wordFacts({ variant: 'unattributed', actor: null, at: null, share: { kind: 'none' }, filing: null })}
          failed={false}
          onFiling={() => undefined}
        />,
      );
    });
    expect(lines()).toEqual(['правка вне процесса', 'вне правок', 'следа нет']);
  });

  it('a filing on the word is line three, and it is a link — never a button', async () => {
    await act(async () => {
      root?.render(
        <ProvenanceBlock
          view={wordFacts({
            variant: 'machine',
            actor: null,
            at: '2026-10-28T09:08:00Z',
            share: { kind: 'none' },
            filing: { number: '№A7K', seq: null, state: 'ждёт', href: '#ch-8-b0' },
          })}
          failed={false}
          onFiling={() => undefined}
        />,
      );
    });
    const door = block()?.querySelector<HTMLAnchorElement>('.prov-door');
    expect(door?.tagName).toBe('A');
    expect(door?.getAttribute('href')).toBe('#ch-8-b0');
    expect(door?.textContent).toBe('№A7K · ждёт');
    expect(block()?.querySelector('button')).toBeNull();
    // The hand names the record that stands on the word.
    expect(block()?.querySelector('.prov-hand')?.textContent).toBe('правка · №A7K');
  });

  it('a failed read is one line, and the block still exists', async () => {
    await act(async () => {
      root?.render(<ProvenanceBlock view={null} failed onFiling={() => undefined} />);
    });
    expect(lines()).toEqual(['история не прочиталась']);
    expect(block()?.querySelector('.prov-gloss')).toBeNull();
  });

  it('prints nothing before the log answers', async () => {
    await act(async () => {
      root?.render(<ProvenanceBlock view={null} failed={false} onFiling={() => undefined} />);
    });
    expect(block()).toBeNull();
  });
});

describe('the strip’s body: one row, then the facts under it', () => {
  it('opens under the 44 px row, in flow, and closes back to the row with focus on the door', async () => {
    await mountStrip();
    expect(block()).toBeNull();
    expect(strip().querySelector('.seam-prov')?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      strip().querySelector<HTMLElement>('.seam-prov')?.click();
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    const opened = block();
    expect(opened, 'the door opens the strip’s own body').not.toBeNull();
    // The body is the strip's child, after the row: no floating frame anywhere.
    expect(strip().contains(opened)).toBe(true);
    expect(strip().querySelector('.seam-prov')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.prov-panel')).toBeNull();
    // The row itself is untouched: the word, the door, «вмешаться» and the one ✕ are all there.
    for (const kept of ['.seam-row', '.seam-word', '.seam-prov', '.seam-cta', '.seam-close']) {
      expect(strip().querySelector(kept), kept).not.toBeNull();
    }
    // There is no second close and no CTA in the layer: the strip's ✕ is the one close.
    expect(document.querySelectorAll('.seam-close, .filing-close, .prov-close')).toHaveLength(1);
    expect(block()?.querySelector('button')).toBeNull();

    await act(async () => {
      strip().querySelector<HTMLElement>('.seam-close')?.click();
    });
    expect(block()).toBeNull();
    expect(document.querySelector('.seam')).toBeNull(); // ✕ closes the strip itself
  });

  it('the door is a toggle: a second press puts the body away and hands focus back', async () => {
    await mountStrip();
    await act(async () => {
      strip().querySelector<HTMLElement>('.seam-prov')?.click();
      await Promise.resolve();
    });
    expect(block()).not.toBeNull();

    await act(async () => {
      strip().querySelector<HTMLElement>('.seam-prov')?.click();
      await Promise.resolve();
    });
    expect(block()).toBeNull();
    expect(document.activeElement).toBe(strip().querySelector('.seam-prov'));
  });

  it('Escape closes the body first, and only a second Escape closes the strip', async () => {
    await mountStrip();
    await act(async () => {
      strip().querySelector<HTMLElement>('.seam-prov')?.click();
      await Promise.resolve();
    });
    expect(block()).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(block()).toBeNull();
    expect(document.querySelector('.seam'), 'the strip stays').not.toBeNull();
    expect(document.activeElement).toBe(strip().querySelector('.seam-prov'));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('.seam')).toBeNull();
  });

  it('a filing standing on the word opens the site’s one card from line three', async () => {
    // A 404 is an answer: the word is the pass's, and the filing is still the record line 3 prints.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    await mountStrip([comment()]);
    await act(async () => {
      strip().querySelector<HTMLElement>('.seam-prov')?.click();
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    const door = block()?.querySelector<HTMLAnchorElement>('.prov-door');
    expect(door?.textContent).toBe('№4Q7 · ждёт');
    expect(door?.getAttribute('href')).toBe('#ch-8-b0');

    await act(async () => {
      door?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    const card = document.querySelector<HTMLElement>('.filing-panel');
    expect(card, 'the card is the page’s one floating frame').not.toBeNull();
    expect(card?.textContent).toContain('в комнате должен быть свет, но не от лампы');
    expect(card?.textContent).toContain('ждёт');
    // The strip under it is not a second surface: it collapses to its one line and its ✕ goes
    // with the rows, so one close stands on the page.
    expect(strip().getAttribute('data-state')).toBe('card');
    expect(document.querySelectorAll('.seam-close, .filing-close')).toHaveLength(1);
    expect(document.querySelector('.filing-close')).not.toBeNull();
  });

  it('asks nothing with history off — there is no door to an empty room', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await mountStrip([], false);

    // With history off there are no facts behind the word's door, so no door is drawn; the
    // phrase's door is gone with it (BOOK-128 §8).
    expect(strip().querySelector('.seam-prov')).toBeNull();
    expect(document.querySelector('.prov')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the block obeys the margin’s one rule', () => {
  it('never uppercases a word: no class of the layer is named by an uppercase rule', async () => {
    await act(async () => {
      root?.render(
        <ProvenanceBlock
          view={wordFacts({
            variant: 'machine',
            actor: null,
            at: '2026-10-28T09:08:00Z',
            share: { kind: 'none' },
            filing: { number: '№A7K', seq: null, state: 'ждёт', href: '#ch-8-b0' },
          })}
          failed={false}
          onFiling={() => undefined}
        />,
      );
    });
    const upper = uppercaseSelectors();
    expect(upper.length, 'the sheets do uppercase other registers').toBeGreaterThan(0);
    for (const name of blockClasses()) {
      for (const selector of upper) {
        expect(selector.includes(`.${name}`), `${selector} uppercases .${name}`).toBe(false);
      }
    }
  });

  it('prints no hash, no uuid and no id in its visible text', async () => {
    await act(async () => {
      root?.render(
        <ProvenanceBlock
          view={wordFacts({ variant: 'reader', actor: 'Аня', at: '2026-10-28T09:08:00Z', share: { kind: 'none' }, filing: null })}
          failed={false}
          onFiling={() => undefined}
        />,
      );
    });
    expect(block()?.textContent ?? '').not.toMatch(/[0-9a-f]{8}/u);
    expect(block()?.textContent ?? '').not.toContain('ch08');
  });

  it('never scrolls, never shadows, never fills and never owns a close', async () => {
    await act(async () => {
      root?.render(
        <ProvenanceBlock
          view={wordFacts({ variant: 'machine', actor: null, at: null, share: { kind: 'none' }, filing: null })}
          failed={false}
          onFiling={() => undefined}
        />,
      );
    });
    const node = block();
    // jsdom has no layout: the honest claim is the rule plus the box it reports.
    expect(node?.scrollHeight ?? 0).toBeLessThanOrEqual(node?.clientHeight ?? 0);
    const rule = rules(reader).find(([selector]) => selector.split(',').some((token) => token.trim() === '.prov-block'))?.[1] ?? '';
    expect(rule).toContain('overflow: visible');
    expect(rule).toContain('box-shadow: none');
    expect(rule).toContain('background: none');
    expect(rule).toContain('border-top: 1px solid var(--rule-2)');
    // BOOK-128 #3852 — no margin geometry any more: the block is in the document's flow, and
    // the accordion (`record.css`) is what carries it on the reading path.
    expect(rule).not.toContain('left: calc(100% + var(--note-gap))');
    expect(rule).not.toContain('width: var(--note-fit)');
    expect(rule).toContain('position: static');
    expect(rule).not.toContain('z-index');
    expect(rule).not.toContain('max-height');
    expect(node?.querySelector('.prov-close')).toBeNull();
    expect(node?.querySelector('[role="dialog"]')).toBeNull();
  });

  it('sits in the margin at ≥1024 and in flow under the row at ≤1023', () => {
    // The strip is the containing block (so `100%` is the prose's right edge), and the phone
    // takes the same node out of the pass and into the flow.
    expect(seamCss).toMatch(/\.seam \{[^}]*position: relative/u);
    const phone = mediaBlocks(reader, 'max-width: 1023px').join('\n');
    expect(phone, 'the phone body is in flow').toContain('position: static');
    expect(phone).toContain('border-top: 1px solid var(--rule)');
    // The row above it is the strip's 44 px target, unchanged by the body.
    expect(seamCss).toMatch(/\.seam-row \{[^}]*min-height: 44px/u);
    // And the class the layer wears is the one the masking guard reads (BOOK-77).
    expect(PROV_BLOCK_CLASS).toContain('ym-hide-content');
  });

  it('keeps the strip one 44 px row at 390, and the body a sibling that cannot stretch it', () => {
    const phone = mediaBlocks(seamCss, 'max-width: 767px').join('\n');
    // The ordinary row is one line: `nowrap` is stated, so the body under it cannot push the
    // row's own items apart.
    expect(phone).toMatch(/\.seam-row \{\s*flex-wrap: nowrap;/u);
    expect(seamCss).toMatch(/\.seam-row \{[^}]*min-height: 44px/u);
    // The frozen strip is BOOK-111's stack — its door and its link are two long phrases.
    expect(phone).toContain(".seam[data-frozen='true'] .seam-row {\n    flex-wrap: wrap;");
    // Collapsing back to the row is closing the body: the strip's own box is not touched.
    expect(seamCss).toMatch(/\.seam \{[^}]*border-top: 1px solid var\(--rule-2\)/u);
  });

  it('no longer enters the margin ledger: no item, no placement (review M6)', async () => {
    // The pass marks only positioned items; the block in flow keeps no `top` of its own.
    await act(async () => {
      root?.render(
        <ProvenanceBlock
          view={wordFacts({ variant: 'machine', actor: null, at: null, share: { kind: 'none' }, filing: null })}
          failed={false}
          onFiling={() => undefined}
        />,
      );
    });
    // The block is the legacy strip's own flow body: the page's margin pass has no claim on it.
    expect(block()?.hasAttribute('data-margin-item')).toBe(false);
    await settle();
    // jsdom computes `position: static`, so the pass skips it — exactly what the phone does.
    expect(block()?.getAttribute('data-placed')).toBeNull();
    expect(block()?.getAttribute('style')).toBeNull();
  });
});
