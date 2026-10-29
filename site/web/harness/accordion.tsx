import type { CatalogEntry } from '@book/shared';
import { createRoot } from 'react-dom/client';

import { EMPTY_COMPOSER } from '../src/lib/composer.ts';
import { resetParagraphChainCache } from '../src/lib/paragraphChainCache.ts';
import { ProseParagraph } from '../src/components/ProseParagraph.tsx';

import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/chrome.css';
import '../src/styles/book.css';
import '../src/styles/live.css';
import '../src/styles/seam.css';
import '../src/styles/seam-form.css';
import '../src/styles/panels.css';
import '../src/styles/marginalia.css';
import '../src/styles/reader.css';
import '../src/styles/record.css';
import '../src/styles/record-notice.css';
import '../src/styles/foot-jumps.css';

/**
 * BOOK-128 comment #3852 — the CDP harness entry.
 *
 * It mounts the real `ProseParagraph` with a written paragraph and exposes three measurements
 * the script drives over CDP: the paragraph's line boxes, the block's height, and the tap. The
 * fixture text carries the shapes the design must not disturb (a double space, an em dash, a
 * closing quote, an ellipsis) because a line that re-wraps is the defect this issue exists for.
 */

/**
 * The fixture paragraph. `?len=645` / `?len=1065` builds the two shapes the owner measured
 * (the p98 and the maximum), so the scroll policy is measured on a paragraph, not on a guess.
 */
const BASE =
  'Я вошёл в пустую комнату. Её освещал яркий свет, и на столе лежал лист бумаги, ' +
  'на нём не было ни строки.  Свет был включён до меня — и никто не сказал об этом. ' +
  'Потом я закрыл дверь и долго стоял в темноте, слушая, как часы идут по кругу.';

function paragraphOf(length: number | null): string {
  if (length === null) return BASE;
  const sentences = [
    'Я вошёл в пустую комнату, и её освещал яркий свет.',
    'На столе лежал лист бумаги, и на нём не было ни строки.',
    'Свет был включён до меня, и об этом никто не говорил.',
    'Потом я закрыл дверь и долго стоял в темноте.',
    'Часы шли по кругу, и никто не спрашивал, который час.',
  ];
  let text = '';
  let index = 0;
  while (text.length < length) {
    text = `${text}${text === '' ? '' : ' '}${sentences[index % sentences.length]}`;
    index += 1;
  }
  return text.slice(0, length).replace(/[^.!?»]$/u, '.').padEnd(2, '.');
}

const params = new URLSearchParams(location.search);
const WANTED = params.get('len') === null ? null : Number(params.get('len'));
const TEXT = paragraphOf(Number.isFinite(WANTED) ? WANTED : null);
const ROWS = Math.max(0, Math.min(8, Number(params.get('rows') ?? '0') || 0));
/** The signed-out viewer: the record's `вмешаться` prints the product's own sign-in copy. */
const SIGNED_OUT = params.get('out') === '1';

/** The filings of sentence 1 — the reader's own first, then older others, for the fold. */
const COMMENTS = Array.from({ length: ROWS }, (_, index) => ({
  id: `cmt_harness_${String(index)}A7K`.replace(/[^A-Za-z0-9_]/gu, ''),
  chapter: 1,
  anchor: { blockId: 'ch01#harness', blockIndex: 0, quote: 'Её освещал яркий свет, и на столе лежал лист бумаги, на нём не было ни строки.', prefix: null, suffix: null, resolved: true },
  author: index === 0 ? 'Филипп' : 'Аня',
  authorColor: '#6f9bb5',
  body: 'в комнате должен быть свет, но не от лампы',
  proposedText: null,
  interventionKind: null,
  status: index === 0 ? 'new' : index === 1 ? 'applied' : 'new',
  refusal: null,
  attempt: null,
  frame: null,
  premise: false,
  reason: null,
  createdAt: `2026-10-2${String(Math.max(0, 9 - index))}T12:0${String(index)}:00Z`,
  decidedAt: null,
  changeId: null,
  applied: index === 1 ? { chapter: 1, rev: 2 } : null,
}));

const ENTRY: CatalogEntry = {
  n: 1,
  part: 1,
  title: 'Комната',
  rev: 1,
  chars: TEXT.length,
  blocks: 1,
  written: true,
  basis: false,
  opening: null,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

// The block's reads are not what this harness measures: an answer with no chain is the
// honest fixture (one line «у этой строки нет истории»), and it keeps every run identical.
resetParagraphChainCache();
/**
 * The sentence's history: **two versions**, introduced and revised by the pass, the second one
 * numbered by its change. This is what a written chapter's chain answers with (`paragraphChainCache`),
 * and it is what makes `история N` a section rather than an absence: the record must print the
 * header and its rows, and the state line `правка 012`.
 *
 * The `связи` ledger has no route in this build, so its section cannot be exercised here — that
 * gap is named in the report, never faked with a fixture.
 */
const CHAIN = {
  blockUid: 'u-ch01-harness',
  blockId: 'ch01#harness',
  chapter: 1,
  alive: true,
  versions: [
    {
      blockUid: 'u-ch01-harness',
      ver: 1,
      blockId: 'ch01#harness',
      chapter: 1,
      rev: 1,
      at: '2026-10-21T12:03:00Z',
      op: 'introduced',
      textHash: 'h1',
      chars: TEXT.length,
      changeId: null,
      changeSeq: null,
      stepId: null,
      actor: { kind: 'writer', label: 'печатник', identityId: 'id-pass' },
      replacedBy: null,
    },
    {
      blockUid: 'u-ch01-harness',
      ver: 2,
      blockId: 'ch01#harness',
      chapter: 1,
      rev: 2,
      at: '2026-10-28T12:08:00Z',
      op: 'revised',
      textHash: 'h2',
      chars: TEXT.length,
      changeId: 'chg_12',
      changeSeq: 12,
      stepId: null,
      actor: { kind: 'writer', label: 'печатник', identityId: 'id-pass' },
      replacedBy: null,
    },
  ],
  line: 'переписано правкой 12',
};

/** The answer a submit gets: one filing, whatever `rows` the page mounted. */
const POSTED = {
  id: 'cmt_harness_posted',
  chapter: 1,
  anchor: {
    blockId: 'ch01#harness',
    blockIndex: 0,
    quote: 'Её освещал яркий свет, и на столе лежал лист бумаги, на нём не было ни строки.',
    prefix: null,
    suffix: null,
    resolved: true,
  },
  author: 'Филипп',
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
  createdAt: '2026-10-28T12:00:00Z',
  decidedAt: null,
  changeId: null,
  applied: null,
};

globalThis.fetch = async (input, init) =>
  String(input).includes('/api/history/paragraphs/')
    ? new Response(JSON.stringify(CHAIN), { status: 200, headers: { 'content-type': 'application/json' } })
    : String(input).includes('/api/comments') && init?.method === 'POST'
      ? // The submit is a page that answers late: the matrix presses the record while the
        // request is still in flight, and a dead state must not be what the reader gets.
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({
                    comment: POSTED,
                    remaining: { perHour: 5, remaining: 2, resetAt: null, editsPerDay: 3, editsRemaining: 2 },
                    queue: { depth: 1 },
                  }),
                  { status: 201, headers: { 'content-type': 'application/json' } },
                ),
              ),
            1500,
          ),
        )
      : new Response('{}', { status: 404 });

const mount = document.getElementById('mount');
if (mount === null) throw new Error('#mount is missing');

createRoot(mount).render(
  <ProseParagraph
    entry={ENTRY}
    blockId="ch01#harness"
    blockIndex={0}
    baseRev={ENTRY.rev}
    text={TEXT}
    blockCount={1}
    comments={COMMENTS}
    composer={EMPTY_COMPOSER}
    viewer={{ signedIn: !SIGNED_OUT, displayName: SIGNED_OUT ? null : 'Филипп' }}
    onPosted={() => undefined}
    history
  />,
);

type Line = { top: number; left: number; width: number; text: string };

/** The paragraph's line boxes, read from character ranges — the only honest line count. */
function linesOf(paragraph: HTMLElement): Line[] {
  const out: Line[] = [];
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    const owner = node.parentElement;
    // Chrome is not prose: the rail, the mark's own chrome and the filing numerals are not
    // the paragraph's lines.
    if (owner !== null && owner.closest('.seam-rail, .filing-mark, .caret-inline, .revising-label, .phone-strip')) continue;
    let at = 0;
    while (at < text.length) {
      while (at < text.length && /\s/u.test(text[at] ?? '')) at += 1;
      let end = at;
      while (end < text.length && !/\s/u.test(text[end] ?? '')) end += 1;
      if (end <= at) break;
      range.setStart(node, at);
      range.setEnd(node, end);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      for (const rect of rects) {
        out.push({ top: round(rect.top), left: round(rect.left), width: round(rect.width), text: text.slice(at, end) });
      }
      at = end;
    }
  }
  return out;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Line count and the ordered per-line `top`s: the pair a reflow would change. The `top`s are
 * **relative to the paragraph's own box**, because the harness scrolls the page in the anchor
 * case and a viewport coordinate would report the scroll as a reflow.
 */
function lineShape(paragraph: HTMLElement): { count: number; tops: number[]; text: string } {
  const origin = paragraph.getBoundingClientRect().top;
  const lines = linesOf(paragraph);
  const tops: number[] = [];
  for (const line of lines) {
    const top = round(line.top - origin);
    if (tops.length === 0 || Math.abs(top - (tops.at(-1) ?? 0)) > 0.01) tops.push(top);
  }
  return { count: tops.length, tops, text: lines.map((line) => line.text).join(' ') };
}

function blockHeight(): number {
  const block = document.querySelector<HTMLElement>('.rec');
  return block === null ? 0 : round(block.getBoundingClientRect().height);
}

/** One tap on the nth sentence, as the browser's own pointer would send it. */
function tapSentence(index: number, word = false): { sentence: string; word: string } {
  const paragraph = document.querySelector<HTMLElement>('p.p');
  if (paragraph === null) throw new Error('no paragraph');
  const span = [...paragraph.querySelectorAll<HTMLElement>('[data-s]')][index];
  if (span === undefined) throw new Error(`no sentence ${String(index)}`);
  const rect = span.getBoundingClientRect();
  const options = {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + Math.min(rect.width / 2, 12),
    clientY: rect.top + rect.height / 2,
    pointerId: 1,
    pointerType: 'mouse',
    // The paragraph opens on the **primary** pointer's own release; the DOM's default is false.
    isPrimary: true,
  };
  span.dispatchEvent(new PointerEvent('pointerdown', options));
  span.dispatchEvent(new PointerEvent('pointerup', options));
  return { sentence: span.textContent ?? '', word };
}

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function at(until: number): Promise<void> {
  const left = until - performance.now();
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
  await frame();
}

/** Height in the block's own box, and the line shape, at the instants the design names. */
async function sample(t0: number): Promise<Array<{ ms: number; block: number; lines: ReturnType<typeof lineShape> }>> {
  const out: Array<{ ms: number; block: number; lines: ReturnType<typeof lineShape> }> = [];
  for (const ms of [0, 100, 200, 220]) {
    await at(t0 + ms);
    const paragraph = document.querySelector<HTMLElement>('p.p');
    if (paragraph === null) throw new Error('no paragraph');
    const block = document.querySelector<HTMLElement>('.rec');
    const inner = block?.querySelector<HTMLElement>('.rec-inner');
    out.push({
      ms,
      block: blockHeight(),
      lines: lineShape(paragraph),
      // The block never scrolls: its clipped child's content must fit its own box at the end.
      innerScroll: inner === null ? false : inner.scrollHeight > inner.clientHeight + 2,
    });
  }
  return out;
}

declare global {
  interface Window {
    __accordion: {
      ready: () => boolean;
      before: () => { lines: ReturnType<typeof lineShape>; width: number };
      open: (index: number) => Promise<{ before: ReturnType<typeof lineShape>; samples: Awaited<ReturnType<typeof sample>> }>;
      blockHeight: () => number;
      rows: () => number;
      scrollToLine: (line: number, top?: number) => void;
      policy: (sentence: number) => {
        scroll: number;
        lineHeight: number;
        lineOnScreen: boolean;
        marker: boolean;
        blockTop: number;
        bottom: number;
        lineTop: number;
      };
      marker: () => Promise<{ scrolled: number; after: boolean }>;
      swap: (index: number) => Promise<{ before: ReturnType<typeof lineShape>; after: ReturnType<typeof lineShape>; delta: number; block: number }>;
      anchor: () => Promise<{ before: number; after: number }>;
      reduced: () => Promise<{ first: number; final: number }>;
      afterTop: () => number;
      scrollAfter: (top: number) => void;
      wait: (ms: number) => Promise<void>;
    };
  }
}

window.__accordion = {
  ready: () => document.querySelectorAll('p.p [data-s]').length > 1,
  before: () => {
    const paragraph = document.querySelector<HTMLElement>('p.p');
    if (paragraph === null) throw new Error('no paragraph');
    return { lines: lineShape(paragraph), width: Math.round(paragraph.getBoundingClientRect().width) };
  },
  open: async (index: number) => {
    const paragraph = document.querySelector<HTMLElement>('p.p');
    if (paragraph === null) throw new Error('no paragraph');
    const before = lineShape(paragraph);
    const scrollBefore = Math.round(window.scrollY);
    const t0 = performance.now();
    tapSentence(index);
    const samples = await sample(t0);
    // At rest (past the disclosure) the block must hold its own content: one more read.
    await at(t0 + 420);
    const restBlock = document.querySelector<HTMLElement>('.rec');
    const restInner = restBlock?.querySelector<HTMLElement>('.rec-inner');
    const innerScroll = restInner === null || restInner === undefined ? false : restInner.scrollHeight > restInner.clientHeight + 2;
    return { before, samples, innerScroll, scrollBefore, scrollAfter: Math.round(window.scrollY) };
  },
  tap: (index: number) => ({ sentence: tapSentence(index).sentence }),
  blockHeight,
  rows: () => COMMENTS.length,
  scrollToLine: (line: number, top = 8) => {
    // Park the requested line at `top` in the viewport — the reader's own scroll, and the
    // geometry each policy case is built from.
    const paragraph = document.querySelector<HTMLElement>('p.p');
    if (paragraph === null) return;
    const rects = [...new Set(linesOf(paragraph).map((row) => row.top))];
    const at = rects[Math.min(line, rects.length - 1)] ?? paragraph.getBoundingClientRect().top;
    window.scrollTo({ top: at + window.scrollY - top, behavior: 'auto' });
  },
  policy: (sentence: number) => {
    const paragraph = document.querySelector<HTMLElement>('p.p');
    if (paragraph === null) throw new Error('no paragraph');
    const lineHeight = Math.round((paragraph.getBoundingClientRect().height / Math.max(1, new Set(linesOf(paragraph).map((row) => row.top)).size)) * 100) / 100;
    const before = Math.round(window.scrollY);
    tapSentence(sentence);
    // The policy runs a frame after the disclosure (240 ms): wait past both.
    const wait = 420;
    return new Promise((resolve) => {
      setTimeout(() => {
        const line = document.querySelector<HTMLElement>('.p [data-touch]');
        const lineTop = line?.getBoundingClientRect().top ?? -1;
        const block = document.querySelector<HTMLElement>('.rec');
        resolve({
          scroll: Math.round(window.scrollY) - before,
          lineHeight,
          lineOnScreen: lineTop >= 0 && lineTop < window.innerHeight,
          marker: document.querySelector('.rec-marker') !== null,
          blockTop: Math.round(block?.getBoundingClientRect().top ?? -1),
          bottom: window.innerHeight,
          lineTop: Math.round(lineTop),
        });
      }, wait);
    });
  },
  marker: async () => {
    const before = Math.round(window.scrollY);
    const link = document.querySelector<HTMLElement>('.rec-marker');
    link?.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { scrolled: Math.round(window.scrollY) - before, after: document.querySelector('.rec-marker') !== null };
  },
  swap: async (index: number) => {
    // The second tap is the swap: the old block leaves in the same commit the new one enters.
    // The line measured is the one about to be touched — the line the swap must not move.
    const paragraph = document.querySelector<HTMLElement>('p.p');
    if (paragraph === null) throw new Error('no paragraph');
    const target = [...paragraph.querySelectorAll<HTMLElement>('[data-s]')][index];
    if (target === undefined) throw new Error(`no sentence ${String(index)}`);
    const beforeTop = round(target.getBoundingClientRect().top - paragraph.getBoundingClientRect().top);
    const before = lineShape(paragraph);
    tapSentence(index);
    await at(performance.now() + 260);
    const after = lineShape(paragraph);
    const delta = round(target.getBoundingClientRect().top - paragraph.getBoundingClientRect().top - beforeTop);
    return { before, after, delta, block: blockHeight() };
  },
  anchor: async () => {
    // The tail paragraph is at the top of the viewport; the block opens **above** it.
    const tail = document.getElementById('after');
    if (tail === null) throw new Error('no tail');
    // A script scroll suppresses the engine's own anchoring for a frame; the reader's scroll
    // is a gesture, so let the suppression pass before the tap.
    await new Promise((resolve) => setTimeout(resolve, 200));
    tapSentence(1);
    // The contract is the **open**: the block mounts at 0fr, and from that place the line must
    // not move. The mount itself (a sibling inserted under the paragraph) is not a movement of
    // the line the hold promises; the tail's position at 0fr is the target.
    await at(performance.now() + 0);
    const before = round(tail.getBoundingClientRect().top);
    await at(performance.now() + 900);
    return { before, after: round(tail.getBoundingClientRect().top) };
  },
  reduced: async () => {
    // The contract is «no animation»: the first frame in which the block is visible carries
    // its final height. Nothing is sampled before the block exists — a zero would say nothing.
    const t0 = performance.now();
    tapSentence(1);
    let first = 0;
    while (performance.now() - t0 < 500) {
      await frame();
      const height = blockHeight();
      if (height > 0) {
        first = height;
        break;
      }
    }
    const acc = document.querySelector<HTMLElement>('.rec')?.getAttribute('data-acc') ?? null;
    await at(performance.now() + 320);
    return {
      first,
      final: blockHeight(),
      acc,
      media: matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
  },
  afterTop: () => {
    const tail = document.getElementById('after');
    return tail === null ? 0 : round(tail.getBoundingClientRect().top);
  },
  scrollAfter: (top: number) => {
    const tail = document.getElementById('after');
    if (tail === null) return;
    const y = tail.getBoundingClientRect().top + window.scrollY - top;
    window.scrollTo({ top: y, behavior: 'auto' });
  },
  wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/* ---------- the tap matrix (scripts/record-tap.mjs) ---------- */

type Point = { x: number; y: number };

/** How many times the block entered and left the page: one tap must be one mount, no ghost. */
const mounts = { added: 0, removed: 0 };
new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element && (node.matches('.rec') || node.querySelector('.rec') !== null)) mounts.added += 1;
    }
    for (const node of record.removedNodes) {
      if (node instanceof Element && (node.matches('.rec') || node.querySelector('.rec') !== null)) mounts.removed += 1;
    }
  }
}).observe(document.body, { childList: true, subtree: true });

function sentenceSpans(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('p.p [data-s]')];
}

/** The first line's text box of a sentence: the point a finger lands on the prose itself. */
function textRectOf(span: HTMLElement, chars = 10): DOMRect | null {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode();
  if (!(node instanceof Text)) return null;
  const length = Math.min(chars, (node.nodeValue ?? '').length);
  if (length === 0) return null;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, length);
  return range.getClientRects()[0] ?? null;
}

function pointOnSentence(index: number, fraction = 0.5): Point {
  const span = sentenceSpans()[index];
  if (span === undefined) throw new Error(`no sentence ${String(index)}`);
  const rect = textRectOf(span);
  if (rect === null) throw new Error(`sentence ${String(index)} has no text box`);
  return { x: Math.round(rect.left + Math.max(4, rect.width * fraction)), y: Math.round(rect.top + rect.height / 2) };
}

function centerOf(element: Element): Point {
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
}

function gripHeight(): number {
  const nav = document.querySelector<HTMLElement>('nav.foot-jumps');
  if (nav === null) return 0;
  return Math.round(Number.parseFloat(getComputedStyle(nav).getPropertyValue('--grip-h')) || 0);
}

window.__recordTap = {
  ready: () => sentenceSpans().length > 1,
  sentences: () => sentenceSpans().map((span) => ({ start: Number(span.dataset.s), text: span.textContent ?? '' })),
  mounts: () => ({ ...mounts }),
  pointOnSentence,
  pointOf: (selector: string) => {
    const element = document.querySelector(selector);
    if (element === null) throw new Error(`no ${selector}`);
    return centerOf(element);
  },
  count: (selector: string) => document.querySelectorAll(selector).length,
  text: (selector: string) => document.querySelector(selector)?.textContent ?? null,
  topOf: (selector: string) => {
    const element = document.querySelector(selector);
    return element === null ? null : Math.round(element.getBoundingClientRect().top * 100) / 100;
  },
  topOfText: (label: string) => {
    const element = [...document.querySelectorAll<HTMLElement>('.rec-section')].find((node) =>
      (node.textContent ?? '').includes(label),
    );
    return element === undefined ? null : Math.round(element.getBoundingClientRect().top * 100) / 100;
  },
  scan: (point?: Point) => {
    const block = document.querySelector<HTMLElement>('.rec');
    const form = document.querySelector<HTMLElement>('form[data-form]');
    const field =
      form?.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), textarea',
      ) ?? null;
    const paragraph = document.querySelector<HTMLElement>('p.p');
    let at: string | null = null;
    if (point !== undefined) {
      const hit = document.elementFromPoint(point.x, point.y);
      if (hit === null) at = null;
      else if (hit.closest('nav.foot-jumps') !== null) at = 'grip';
      else at = hit.closest('[data-s]')?.getAttribute('data-s') ?? (hit.className || hit.tagName);
    }
    return {
      rec: document.querySelectorAll('.rec').length,
      acc: block?.getAttribute('data-acc') ?? null,
      body: block?.getAttribute('data-body') ?? null,
      form: form !== null,
      firstField: field?.id ?? null,
      focused: document.activeElement instanceof HTMLElement ? document.activeElement.id || document.activeElement.tagName : null,
      firstFieldFocused: field !== null && document.activeElement === field,
      draft: document.querySelector<HTMLTextAreaElement>('textarea.seam-text')?.value ?? null,
      signin: document.querySelector('.seam-signin')?.textContent ?? null,
      stateWord: document.querySelector('.rec-state')?.textContent ?? null,
      submit: document.querySelector<HTMLElement>('.seam-submit')?.textContent ?? null,
      touchAction: paragraph === null ? null : getComputedStyle(paragraph).touchAction,
      scale: window.visualViewport?.scale ?? 1,
      at,
      scrollY: Math.round(window.scrollY),
      innerHeight: window.innerHeight,
      grip: gripHeight(),
      recordTop: block === null ? null : Math.round(block.getBoundingClientRect().top),
    };
  },
  /** Bring a sentence back on screen (the form scrolls the page under it). */
  sentenceInto: (index: number) => {
    sentenceSpans()[index]?.scrollIntoView({ block: 'center', inline: 'nearest' });
  },
  /** Park a sentence's first line at the viewport's bottom edge, `gap` px above the grip. */
  sentenceAtBottom: (index: number, gap = 4) => {
    const span = sentenceSpans()[index];
    if (span === undefined) throw new Error(`no sentence ${String(index)}`);
    const rect = textRectOf(span);
    if (rect === null) throw new Error('no text box');
    const target = window.innerHeight - gripHeight() - gap;
    window.scrollBy({ top: rect.top - target, behavior: 'auto' });
  },
  /** Scroll so the record's top sits at `top` (negative: partly above the viewport). */
  recordTopAt: (top: number) => {
    const block = document.querySelector<HTMLElement>('.rec');
    if (block === null) throw new Error('no record');
    window.scrollBy({ top: block.getBoundingClientRect().top - top, behavior: 'auto' });
  },
  scrollTop: () => window.scrollTo({ top: 0, behavior: 'auto' }),
  scrollInto: (selector: string) => {
    document.querySelector(selector)?.scrollIntoView({ block: 'center', inline: 'nearest' });
  },
  typeInto: (selector: string, value: string) => {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (element === null) throw new Error(`no ${selector}`);
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  },
  wait: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

declare global {
  interface Window {
    __recordTap: {
      ready: () => boolean;
      sentences: () => { start: number; text: string }[];
      mounts: () => { added: number; removed: number };
      pointOnSentence: (index: number, fraction?: number) => Point;
      pointOf: (selector: string) => Point;
      count: (selector: string) => number;
      text: (selector: string) => string | null;
      topOf: (selector: string) => number | null;
      topOfText: (label: string) => number | null;
      scan: (point?: Point) => {
        rec: number;
        acc: string | null;
        body: string | null;
        form: boolean;
        firstField: string | null;
        focused: string | null;
        firstFieldFocused: boolean;
        draft: string | null;
        signin: string | null;
        stateWord: string | null;
        submit: string | null;
        touchAction: string | null;
        scale: number;
        at: string | null;
        scrollY: number;
        innerHeight: number;
        grip: number;
        recordTop: number | null;
      };
      sentenceAtBottom: (index: number, gap?: number) => void;
      sentenceInto: (index: number) => void;
      recordTopAt: (top: number) => void;
      scrollTop: () => void;
      scrollInto: (selector: string) => void;
      typeInto: (selector: string, value: string) => void;
      wait: (ms: number) => Promise<void>;
    };
  }
}
