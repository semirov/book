// @vitest-environment jsdom
import type { CatalogEntry, ParagraphChainDto, ParagraphVersionDto } from '@book/shared';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { resetParagraphChainCache } from '../lib/paragraphChainCache.ts';
import { marginFits, noteWidth } from '../lib/marginPass.ts';
import { anchorFor } from '../lib/seam.ts';
import { closeSeam, openSeam } from '../lib/useSeam.ts';
import { useParagraphChain } from '../useParagraphChain.ts';
import { mediaBlocks, rules } from './cssRules.ts';
import { SentenceBlock } from './SentenceBlock.tsx';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-128 comment #3815 — «откуда эта фраза» is reader, like the word's record: a 44 px
 * row carrying one word, the sentence quoted, and three facts. No floating box, no close, no
 * CTA, no `ver` rows and no `blockId`.
 *
 * jsdom has no layout, so every geometry claim is read off the stylesheet (the declaration that
 * makes it true) and every state claim off the DOM. The three facts themselves are proven here
 * as they render; `lib/sentence.test.ts` holds the word table.
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

const BLOCK_ID = 'ch08#phraseblock';
const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

function version(overrides: Partial<ParagraphVersionDto> = {}): ParagraphVersionDto {
  return {
    blockUid: 'blk_1',
    ver: 2,
    blockId: BLOCK_ID,
    chapter: 8,
    rev: 5,
    at: '2026-10-28T09:08:00Z',
    op: 'revised',
    textHash: 'aa11bb22',
    chars: 112,
    changeId: 'chg_12',
    changeSeq: 12,
    stepId: 'stp_12',
    actor: { kind: 'writer', identityId: null, label: 'автор' },
    replacedBy: null,
    ...overrides,
  };
}

function chain(versions: ParagraphVersionDto[], alive = true): ParagraphChainDto {
  return { blockUid: 'blk_1', blockId: BLOCK_ID, chapter: 8, alive, line: '', versions };
}

/** A revised block under a machine pass: `right 012 · внесена 12:08`. */
const REVISED = chain([version()]);
/** Only the introduction: no change behind it. */
const INTRODUCED = chain([version({ op: 'introduced', changeSeq: null, changeId: null })]);

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
  await act(async () => closeSeam());
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  resetParagraphChainCache();
});

const block = (): HTMLElement | null => document.querySelector<HTMLElement>('.sentence-block');
const facts = (): string[] => [...(block()?.querySelectorAll('.sentence-fact') ?? [])].map((node) => node.textContent ?? '');

/** Every `text-transform: uppercase` selector of the sheets that dress this layer. */
function uppercaseSelectors(): string[] {
  return [reader, seamCss]
    .flatMap((sheet) => rules(sheet))
    .filter(([, body]) => /text-transform:\s*uppercase/u.test(body))
    .flatMap(([selector]) => selector.split(',').map((token) => token.trim()));
}

function blockClasses(): string[] {
  const node = block();
  if (node === null) return [];
  return [node, ...node.querySelectorAll<HTMLElement>('*')].flatMap((element) => [...element.classList]);
}

describe('the phrase’s three facts', () => {
  it('a pass wrote it: the hand with its moment, mutating, and the change that landed', async () => {
    await act(async () => {
      root?.render(
        <SentenceBlock chain={REVISED} loading={false} failed={false} quote="Её освещал яркий свет." frame="none" place="flow" onRetry={() => undefined} onClose={() => undefined} />,
      );
    });
    expect(facts()).toEqual(['печатник · 28.10, 12:08', 'меняется', 'правка №12 · внесена 12:08']);
    // The one word above them, and the sentence in the book's quote style.
    expect(block()?.querySelector('.sentence-label')?.textContent).toBe('фраза');
    expect(block()?.querySelector('.sentence-quote')?.textContent).toBe('«Её освещал яркий свет.»');
  });

  it('an introduced block names no change: «правок не было»', async () => {
    await act(async () => {
      root?.render(
        <SentenceBlock chain={INTRODUCED} loading={false} failed={false} quote="Её освещал яркий свет." frame="none" place="flow" onRetry={() => undefined} onClose={() => undefined} />,
      );
    });
    expect(facts()).toEqual(['печатник · 28.10, 12:08', 'меняется', 'правок не было']);
  });

  it('the canon sentence says «рамка книги» and cannot change', async () => {
    await act(async () => {
      root?.render(
        <SentenceBlock chain={REVISED} loading={false} failed={false} quote="Её освещал яркий свет." frame="frame" place="flow" onRetry={() => undefined} onClose={() => undefined} />,
      );
    });
    expect(facts()).toEqual(['рамка книги', 'не меняется', 'правка №12 · внесена 12:08']);
  });

  it('page 2 says «основание книги» and cannot change', async () => {
    await act(async () => {
      root?.render(
        <SentenceBlock chain={null} loading={false} failed={false} quote="Материя — это свет." frame="basis" place="flow" onRetry={() => undefined} onClose={() => undefined} />,
      );
    });
    expect(facts()).toEqual(['основание книги', 'не меняется', 'правок не было']);
    expect(block()?.textContent).not.toContain('у этой строки нет истории');
  });

  it('a filing produced the version: the record’s number stands in for the hand', async () => {
    const reader = chain([version({ actor: { kind: 'reader', identityId: 'idt_1', label: 'Аня' } })]);
    await act(async () => {
      root?.render(
        <SentenceBlock chain={reader} loading={false} failed={false} quote="Её освещал яркий свет." frame="none" place="flow" onRetry={() => undefined} onClose={() => undefined} />,
      );
    });
    expect(facts()).toEqual(['правка · №12', 'меняется', 'правка №12 · внесена 12:08']);
  });

  it('a version nobody claims says «правка вне процесса», and it is the only place that word appears', async () => {
    const loose = chain([version({ actor: null, changeSeq: null, changeId: null })]);
    await act(async () => {
      root?.render(
        <SentenceBlock chain={loose} loading={false} failed={false} quote="Её освещал яркий свет." frame="none" place="flow" onRetry={() => undefined} onClose={() => undefined} />,
      );
    });
    expect(facts()[0]).toBe('правка вне процесса');

    await act(async () => {
      root?.render(
        <SentenceBlock chain={REVISED} loading={false} failed={false} quote="Её освещал яркий свет." frame="none" place="flow" onRetry={() => undefined} onClose={() => undefined} />,
      );
    });
    expect(block()?.textContent).not.toContain('вне процесса');
    expect(block()?.textContent).not.toContain('эта строка сейчас в тексте');
    expect(block()?.textContent).not.toContain('глава 8');
  });

  it('prints no version index and no block id in its visible text', async () => {
    await act(async () => {
      root?.render(
        <SentenceBlock chain={REVISED} loading={false} failed={false} quote="Её освещал яркий свет." frame="none" place="flow" onRetry={() => undefined} onClose={() => undefined} />,
      );
    });
    const text = block()?.textContent ?? '';
    expect(text).not.toMatch(/[0-9a-f]{8}/u);
    expect(text).not.toContain('ch08');
    expect(block()?.querySelector('.chain-id')).toBeNull();
    expect(block()?.querySelector('.chain-list')).toBeNull();
  });

  it('the wait and the failure are not facts: a retry stands only there', async () => {
    await act(async () => {
      root?.render(
        <SentenceBlock chain={null} loading={false} failed quote="Её освещал яркий свет." frame="none" place="flow" onRetry={() => undefined} onClose={() => undefined} />,
      );
    });
    expect(block()?.textContent).toContain('история не прочиталась');
    expect(facts()).toHaveLength(0);
    expect(block()?.querySelectorAll('button')).toHaveLength(1);

    await act(async () => {
      root?.render(
        <SentenceBlock chain={REVISED} loading={false} failed={false} quote="Её освещал яркий свет." frame="none" place="flow" onRetry={() => undefined} onClose={() => undefined} />,
      );
    });
    expect(block()?.querySelector('button'), 'no close and no CTA in the facts').toBeNull();
  });
});

describe('the block obeys the margin’s one rule', () => {
  it('never uppercases a word, never scrolls, never shadows, never prints an id', async () => {
    await act(async () => {
      root?.render(
        <SentenceBlock chain={REVISED} loading={false} failed={false} quote="Её освещал яркий свет." frame="none" place="margin" onRetry={() => undefined} onClose={() => undefined} />,
      );
    });
    const upper = uppercaseSelectors();
    expect(upper.length).toBeGreaterThan(0);
    for (const name of blockClasses()) {
      for (const selector of upper) expect(selector.includes(`.${name}`), `${selector} uppercases .${name}`).toBe(false);
    }
    // jsdom has no layout: the honest claim is the rule plus the box it reports.
    expect(block()?.scrollHeight ?? 0).toBeLessThanOrEqual(block()?.clientHeight ?? 0);
    const rule = rules(reader).find(([selector]) => selector.split(',').some((token) => token.trim() === '.sentence-block'))?.[1] ?? '';
    expect(rule).toContain('overflow: visible');
    expect(rule).toContain('box-shadow: none');
    expect(rule).toContain('left: calc(100% + var(--note-gap))');
    expect(rule).toContain('width: var(--note-fit)');
    expect(rule).not.toContain('z-index');
    expect(rule).not.toContain('max-height');
    // Only the margin variant enters the page's ledger (BOOK-128 #3815).
    expect(block()?.getAttribute('data-margin-item')).toBe('sentence');
  });

  it('keeps the flow variant out of the ledger and out of the margin’s geometry', async () => {
    await act(async () => {
      root?.render(
        <SentenceBlock chain={REVISED} loading={false} failed={false} quote="Её освещал яркий свет." frame="none" place="flow" onRetry={() => undefined} onClose={() => undefined} />,
      );
    });
    // A chronicle reads a past chapter at any width: nothing places the block there, so nothing
    // may hide it until a pass says so — and no pass runs on that page at all.
    expect(block()?.classList.contains('sentence-flow')).toBe(true);
    expect(block()?.hasAttribute('data-margin-item')).toBe(false);
    expect(block()?.getAttribute('data-placed')).toBeNull();
    expect(block()?.getAttribute('style')).toBeNull();
  });

  it('is a margin item at ≥1024 over a zero-height seat, and a 44 px row at ≤1023', () => {
    const seat = rules(reader).find(([selector]) => selector.trim() === '.sentence-seat')?.[1] ?? '';
    expect(seat).toContain('position: relative');
    expect(seat).toContain('height: 0');
    const phone = mediaBlocks(reader, 'max-width: 1023px').join('\n');
    expect(phone).toContain('.sentence-block');
    expect(phone).toContain('position: static');
    expect(phone).toMatch(/\.sentence-label \{[^}]*min-height: 44px/u);
    // The strip's own row keeps its margin when the seat stands between it and the paragraph.
    expect(seamCss).toMatch(/\.sentence-seat \+ \.seam/u);
  });

  it('at 1440 the item starts 40 px right of the prose and stays inside the viewport', () => {
    // The design's arithmetic, with the tokens the sheet uses: a centred 640 px measure at 1440
    // ends at 1040, the tie starts at 1080, the note's used width is 188, and 8 px of air stay
    // between the item and the frame (BOOK-91 / BOOK-DOC-47 §7). Pure, so it needs no layout.
    const proseRight = (1440 + 640) / 2;
    expect(noteWidth(1440, 640)).toBe(188);
    expect(proseRight + 40 + noteWidth(1440, 640) + 8).toBeLessThanOrEqual(1440);
    expect(marginFits(proseRight, 1440)).toBe(true);
    // And at 1024 the same rule narrows the item instead of demoting the paragraph to a strip.
    expect(noteWidth(1024, 640)).toBe(144);
    // The pass passes the width it computed, not the design's 188: 832 + 40 + 144 + 8 = 1024.
    expect(marginFits((1024 + 640) / 2, 1024, 40, 144)).toBe(true);
  });
});

describe('the door in the prose opens the block, and takes it away', () => {
  /** One paragraph with the page's own chain mode, as `App` hands it down. */
  function Paragraph(): ReactElement {
    const mode = useParagraphChain();
    return (
      <ProseParagraph
        entry={ENTRY}
        blockId={BLOCK_ID}
        blockIndex={0}
        baseRev={ENTRY.rev}
        text={TEXT}
        blockCount={40}
        comments={[]}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: false, displayName: null }}
        onPosted={() => undefined}
        history
        sentence={mode}
        onReanchor={() => undefined}
      />
    );
  }

  async function mountParagraph(): Promise<void> {
    await act(async () => root?.render(<Paragraph />));
  }

  async function press(selector: string): Promise<void> {
    await act(async () => {
      document.querySelector<HTMLElement>(selector)?.click();
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });
  }

  it('opens beside the phrase, closes on its own door, and hands focus back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    await mountParagraph();
    const door = document.querySelector<HTMLElement>('.prov');
    expect(door, 'the phrase’s door is rendered while history is live').not.toBeNull();
    expect(door?.getAttribute('aria-expanded')).toBe('false');

    await press('.prov');

    const opened = block();
    expect(opened).not.toBeNull();
    // It sits after the paragraph, in the seat the pass places — never inside the prose.
    const seat = document.querySelector('.sentence-seat');
    expect(seat?.contains(opened)).toBe(true);
    expect(document.querySelector('p.p')?.nextElementSibling).toBe(seat);
    expect(document.querySelector('.prov')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.chain, .prov-panel, .filing-panel')).toBeNull();

    await press('.prov');
    expect(block()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('.prov'));
  });

  it('Escape puts it away without touching the paragraph', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    await mountParagraph();
    await press('.prov');
    expect(block()).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    });
    expect(block()).toBeNull();
    expect(document.querySelector('p.p')?.textContent).toContain('Её освещал яркий свет.');
    expect(document.activeElement).toBe(document.querySelector('.prov'));
  });

  it('treats its own door as part of the layer: a press on it closes nothing by itself', async () => {
    // A fine pointer at a desktop's width: `outsideCloseAllowed` is true here, so this is the one
    // place the gesture order can go wrong. The door is the page's own `.prov` — the same class
    // the prose and the chronicle render — and it is the layer's toggle, not an outside press.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
    const onClose = vi.fn();
    /** One press, one release: what `attachOutsideClose` reads. The click is the door's own. */
    const press = async (target: Element): Promise<void> => {
      await act(async () => {
        for (const type of ['pointerdown', 'pointerup']) {
          target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: 5, clientY: 5, pointerId: 1 }));
        }
        for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
      });
    };

    // The page's own nodes, beside the root: a door as the prose draws it and an outside line.
    const door = document.body.appendChild(document.createElement('button'));
    door.className = 'prov';
    const paragraph = document.body.appendChild(document.createElement('p'));
    paragraph.className = 'p';
    await act(async () => {
      root?.render(
        <SentenceBlock chain={REVISED} loading={false} failed={false} quote="Её освещал яркий свет." frame="none" place="margin" onRetry={() => undefined} onClose={onClose} />,
      );
    });

    // The press on the door is inside the layer: nothing closes on `pointerup`, so the door's own
    // click is the only act of the gesture — one press, one close, never close-then-reopen.
    await press(door);
    expect(onClose).not.toHaveBeenCalled();
    // …and a press anywhere else still closes it: the layer keeps the behaviour it had.
    await press(paragraph);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('is not rendered at all with history off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    await act(async () => {
      root?.render(
        <ProseParagraph
          entry={ENTRY}
          blockId={BLOCK_ID}
          blockIndex={0}
          baseRev={ENTRY.rev}
          text={TEXT}
          blockCount={40}
          comments={[]}
          composer={EMPTY_COMPOSER}
          viewer={{ signedIn: false, displayName: null }}
          onPosted={() => undefined}
          history={false}
        />,
      );
    });
    expect(document.querySelector('.prov')).toBeNull();
    expect(block()).toBeNull();
  });

  it('does not disturb an open strip', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    await mountParagraph();
    const anchor = anchorFor({ text: TEXT, blockId: BLOCK_ID, baseRev: ENTRY.rev, offset: 0 });
    await act(async () => {
      openSeam({ chapter: 8, blockId: BLOCK_ID, key: 'ch8:phrase', anchor, origin: container });
    });
    await press('.prov');
    expect(document.querySelector('.seam')).not.toBeNull();
    expect(block()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    });
    // The phrase's block owns the first Escape; the strip is closed by its own ✕.
    expect(block()).toBeNull();
    expect(document.querySelector('.seam')).not.toBeNull();
  });
});
