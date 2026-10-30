import type {
  CatalogEntry,
  ChapterAppliedPayload,
  ChapterDto,
  CommentDto,
  ComposerInfo,
  Envelope,
  HelloPayload,
  PassStageEvent,
  ViewerDto,
} from '@book/shared';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { useRef, useState, type ReactNode } from 'react';

import { ChapterProse } from '../src/components/ChapterProse.tsx';
import { citedClass } from '../src/components/FilingMark.tsx';
import { HeadLine } from '../src/components/HeadLine.tsx';
import { appliedPrintPlans } from '../src/lib/appliedPrint.ts';
import type { ClientState } from '../src/lib/clientState.ts';
import { filingsForBlock } from '../src/lib/filings.ts';
import { publishFilingLive } from '../src/lib/filingLive.ts';
import { applyFrame, initialClientState } from '../src/lib/frames.ts';
import { publishLiveChange } from '../src/lib/liveChange.ts';
import { publishTheatrePage, resetTheatrePage, type TheatreTransport } from '../src/lib/theatreStage.tsx';
import { sweepOf, wordsOf } from '../src/lib/theatre.ts';
import { measure as measureGeometry } from '../src/lib/theatreLines.ts';

import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/chrome.css';
import '../src/styles/book.css';
import '../src/styles/live.css';
import '../src/styles/seam.css';
import '../src/styles/seam-form.css';
import '../src/styles/marginalia.css';
import '../src/styles/reader.css';
import '../src/styles/record.css';
import '../src/styles/head-status.css';
import '../src/styles/running-head.css';
import '../src/styles/theatre.css';
import '../src/styles/pass-live.css';
import '../src/styles/foot-jumps.css';

/**
 * BOOK-227 — the CDP harness entry: one performed sentence, every act, the real page.
 *
 * The sentence is the book's own: chapter 1, block `ch01#0594465f` — 349 characters, 57 words
 * (BOOK-DOC-86 §0). Everything an act is made of is the site's own code:
 *
 *   · the **frames** — synthetic `Envelope`s pushed through the real reducer (`applyFrame`,
 *     `initialClientState`, and a `hello` whose `live` block is a fixture), exactly as the socket
 *     delivers them; the three facts stores (`publishFilingLive`, `publishLiveChange`,
 *     `publishTheatrePage`) are the page's own, so `SentenceTheatre` reads what `App` publishes;
 *   · the **prose** — main's `ChapterProse`, mounted with a fixture chapter, so the writing plate
 *     shows **main's print** (`PrintPass`, `lib/appliedPrint.ts`, one caret) and never a copy of
 *     it;
 *   · the **head** — main's `HeadLine` on the same `ClientState`: the head's one word is the
 *     page's, not this file's.
 *
 * Not real, and by design: the *rows*. A filing's status arrives from the network on the real
 * page; here the harness holds it and rewrites it between acts, as a refetch would. No act is
 * painted by a timer here, and no mark is drawn by this file.
 *
 * `window.__theatre` is the whole command surface: `act(name, opts)` dispatches the frame(s) of
 * one act and answers the measured snapshot, `snapshot()` measures the page now.
 * `scripts/theatre-cdp.mjs` asserts against the numbers.
 */

/* ------------------------------------------------------------------- the sentence ---- */

/** `ch01#0594465f`: chapter 1's second paragraph, the one BOOK-DOC-86 measures. */
const BLOCK = 'Свет был не для меня. Он был для камеры в верхнем углу, для датчика над дверью и для человека, который когда-нибудь откроет запись и увидит, как я вхожу, снимаю куртку и сажусь на стул. Поэтому на рабочей поверхности было семьсот пятьдесят люкс. Я измерял их каждую смену люксметром, потому что измерять было единственным, что мне здесь разрешалось.';
/**
 * The sentence the filing names: the block's **second** sentence, 163 characters and 29 words —
 * the one that wraps (three lines at 640, five at 342), so the rule, the stub and the tallies are
 * checked across lines, as BOOK-DOC-86 §0 measures them. A filing's quote is one sentence and
 * main's prose splits the block the same way (`splitSentences`).
 */
const QUOTE = 'Он был для камеры в верхнем углу, для датчика над дверью и для человека, который когда-нибудь откроет запись и увидит, как я вхожу, снимаю куртку и сажусь на стул.';
/** The same block before one edit inside it: the write's span is the whole block, as the frame's is. */
const BLOCK_BEFORE = BLOCK.replace('снимаю куртку и сажусь на стул', 'снимаю шляпу и сажусь на скамью');
const BLOCK_ID = 'ch01#0594465f';
/** The paragraph above it: a page is more than the sentence it performs. */
const INTRO = 'Я вошёл в пустую комнату. Её освещал яркий свет.';
const TAIL = 'Дверь за мной осталась приоткрытой.';

const T0 = Date.parse('2026-10-29T12:00:00Z');

function row(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_A7K',
    number: 12,
    chapter: 1,
    anchor: { blockId: BLOCK_ID, blockIndex: 1, quote: QUOTE, prefix: null, suffix: null, resolved: true },
    author: 'семиров',
    authorColor: '#000',
    body: 'свет здесь должен быть человеческим',
    proposedText: null,
    interventionKind: 'document',
    status: 'batched',
    refusal: null,
    frame: null,
    premise: false,
    changeStatus: null,
    reason: null,
    attempt: null,
    createdAt: new Date(T0 - 60_000).toISOString(),
    decidedAt: null,
    changeId: 'chg_1',
    applied: null,
    ...overrides,
  };
}

function stage(overrides: Partial<PassStageEvent>): PassStageEvent {
  return {
    passId: 'stp_1',
    chapter: 1,
    stageSeq: 1,
    stage: 'read',
    at: T0,
    actor: { process: 'writer', model: null },
    changeId: 'chg_1',
    summary: 'читает',
    span: null,
    tokens: null,
    costUsd: null,
    ...overrides,
  };
}

/** The chapter the prose is mounted from: three blocks, the performed one second. */
const CHAPTER: ChapterDto = {
  n: 1,
  title: 'Комната 1-04',
  rev: 15,
  chars: INTRO.length + BLOCK.length + TAIL.length,
  basis: false,
  blocks: [
    { id: 'ch01#00000001', i: 0, text: INTRO, hash: 'h1' },
    { id: BLOCK_ID, i: 1, text: BLOCK, hash: 'h2' },
    { id: 'ch01#00000003', i: 2, text: TAIL, hash: 'h3' },
  ] as ChapterDto['blocks'],
  writtenAt: new Date(T0 - 86_400_000).toISOString(),
  updatedAt: new Date(T0 - 3_600_000).toISOString(),
};

const ENTRY: CatalogEntry = {
  n: 1,
  part: 1,
  title: CHAPTER.title,
  rev: CHAPTER.rev,
  chars: CHAPTER.chars,
  blocks: CHAPTER.blocks.length,
  written: true,
  basis: false,
  opening: null,
  writtenAt: CHAPTER.writtenAt,
  updatedAt: CHAPTER.updatedAt,
  direction: 'forward',
};

const COMPOSER: ComposerInfo = { minChars: 8, maxChars: 600, editMaxChars: 600 };
const VIEWER: ViewerDto = { signedIn: true, displayName: 'читатель' };

/** The frame payloads: one real shape per fact, in the wire's own `Envelope`. */
let seq = 0;
const envelope = (type: string, data: unknown): Envelope =>
  ({ v: 1, type, seq: (seq += 1), ts: new Date().toISOString(), data } as Envelope);

function hello(overrides: Partial<HelloPayload> = {}): HelloPayload {
  const at = new Date().toISOString();
  return {
    connId: 'cn_harness',
    protocolVersion: 4,
    serverTime: at,
    limits: {
      commentsPerHour: 10,
      maxCommentChars: 600,
      maxEditChars: 600,
      queueSoftCap: 40,
      maxConnections: 200,
      perIp: 10,
      editSubmissionsPerDay: 3,
      maxWave: 1,
    },
    viewer: VIEWER,
    composer: COMPOSER,
    front: {
      title: 'Бланк',
      about: null,
      rev: 1,
      imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
      authors: { count: 1, measuredAt: at },
    },
    catalog: [ENTRY],
    state: {
      version: 1,
      at,
      engine: { status: 'running', heartbeatAt: at, laneId: 'forward' },
      phase: 'draft',
      front: { title: 'Бланк', about: null, rev: 1, updatedAt: at },
      chapters: { total: 1, written: [1], empty: [], count: 1, totalChars: CHAPTER.chars, basis: [] },
      cursors: {} as never,
      toc: [{ part: 1, n: 1, title: CHAPTER.title, written: true, rev: CHAPTER.rev }],
      meeting: { forwardFront: 1, backwardFront: 1, gap: 0, converged: true, seam: 'not_reached' },
      cascade: null,
      queue: { depth: 0, byState: { pending: 0, processing: 0, stale: 0, escalated: 0, done24h: 0 }, head: null, processing: null, lastDecidedAt: null, pending: [] },
      revising: [],
      current: null,
      unresolved: [],
      activity: { lastFileChangeAt: null, lastEngineEventAt: null, lastLogLineAt: null, source: 'files' },
      history: { live: true, readerChanges: 0, started: true },
    } as HelloPayload['state'],
    live: {
      at,
      passes: [],
      applied: null,
      queue: { depth: 0, pending: [] },
      filings: [{ commentId: 'cmt_A7K', chapter: 1, state: 'reading', attempts: 0, attemptsLeft: 6, changeId: null, at }],
      lane: { passesToday: 0, maxPasses: 4, writerAt: at },
    },
    currentChapter: null,
    comments: { open: 0 },
    ...overrides,
  };
}
/* -------------------------------------------------------------- the instrumentation ---- */

type FrameRecord = { frame: number; start: number; end: number };
const nativeRaf = window.requestAnimationFrame.bind(window);
const rafLog: FrameRecord[] = [];
/**
 * Every rAF the page makes is timed. The theatre's work is a rAF callback (the fill, the births),
 * so `end − start` is that frame's script time — the number §9.14 budgets. The harness's own
 * waits use the native call, so they never enter the log.
 */
window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
  return nativeRaf((at) => {
    const start = performance.now();
    try {
      callback(at);
    } finally {
      rafLog.push({ frame: at, start, end: performance.now() });
      if (rafLog.length > 6_000) rafLog.splice(0, 2_000);
    }
  });
};

type MutRecord = { t: number; type: string; prop: string | null; target: string; block: string | null; value: string | null; prev: string | null; node: number };
const mutLog: MutRecord[] = [];
let nodeSeq = 0;
const nodeIds = new WeakMap<Node, number>();
const nodeId = (node: Node): number => {
  const held = nodeIds.get(node);
  if (held !== undefined) return held;
  nodeSeq += 1;
  nodeIds.set(node, nodeSeq);
  return nodeSeq;
};
const describe = (node: Node): string => {
  if (node instanceof Element) return `${node.tagName.toLowerCase()}${node.className === '' ? '' : `.${node.className.split(' ')[0]}`}`;
  return node.nodeName.toLowerCase();
};
const propertyIn = (style: string, name: string): string | null => {
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]*)`, 'u').exec(style);
  return match === null ? null : (match[1] ?? '').trim();
};
const observer = new MutationObserver((records) => {
  const t = performance.now();
  for (const record of records) {
    if (record.type === 'attributes') {
      const after = (record.target as Element).getAttribute('style') ?? '';
      const before = record.oldValue ?? '';
      for (const prop of ['clip-path', 'transform', 'opacity']) {
        if (propertyIn(before, prop) !== propertyIn(after, prop)) {
          const block = record.target instanceof Element ? (record.target.closest('.p')?.getAttribute('data-block-id') ?? null) : null;
          mutLog.push({ t, type: 'style', prop, target: describe(record.target), block, value: propertyIn(after, prop), prev: propertyIn(before, prop), node: nodeId(record.target) });
        }
      }
      continue;
    }
    mutLog.push({ t, type: record.type, prop: null, target: describe(record.target), block: null, value: null, prev: null, node: nodeId(record.target) });
  }
  if (mutLog.length > 8_000) mutLog.splice(0, 4_000);
});

/* ------------------------------------------------------------------- measurement ---- */

type Box = { top: number; left: number; right: number; bottom: number; width: number; height: number };
type Grid = { tops: number[]; lefts: number[]; rights: number[]; widths: number[] };
const round = (value: number): number => Math.round(value * 100) / 100;
/**
 * How much of a rule is **painted**: the node's own width minus the clip's right inset, read from
 * the **computed** `clip-path` — so the sheet's default (`inset(0 100% 0 0)`) counts as the zero
 * ink it is. A node's presence proves nothing; this is the number the plates are checked against.
 */
function paintedWidth(node: HTMLElement): number {
  const width = node.getBoundingClientRect().width;
  const clip = getComputedStyle(node).clipPath;
  if (clip === 'none' || clip === '') return round(width);
  const shape = /inset\(([^)]*)\)/u.exec(clip);
  if (shape === null) return round(width);
  const tokens = (shape[1] ?? '').trim().split(/\s+/u).filter((token) => token !== '');
  const px = (token: string | undefined): number => {
    if (token === undefined) return 0;
    const match = /^(-?[\d.]+)(px|%)?$/u.exec(token);
    if (match === null) return 0;
    const value = Number(match[1]);
    return match[2] === '%' ? (value / 100) * width : value;
  };
  // `inset(top right bottom left)`; a one-value inset is all four.
  const right = tokens.length >= 2 ? px(tokens[1]) : px(tokens[0]);
  return round(Math.max(0, width - right));
}
const boxOf = (rect: DOMRect, origin: DOMRect): Box => ({
  top: round(rect.top - origin.top),
  left: round(rect.left - origin.left),
  right: round(rect.right - origin.left),
  bottom: round(rect.bottom - origin.top),
  width: round(rect.width),
  height: round(rect.height),
});

/** A rect per *line*, not per inline fragment: fragments sharing a top are one line box. */
function linesOf(rects: readonly DOMRect[], origin: DOMRect): Grid {
  const lines = new Map<number, { left: number; right: number }>();
  for (const rect of rects) {
    if (rect.width <= 0) continue;
    const top = round(rect.top - origin.top);
    const held = lines.get(top);
    const left = round(rect.left - origin.left);
    const right = round(rect.right - origin.left);
    lines.set(top, held === undefined ? { left, right } : { left: Math.min(held.left, left), right: Math.max(held.right, right) });
  }
  const tops = [...lines.keys()].sort((left, right) => left - right);
  return {
    tops,
    lefts: tops.map((top) => lines.get(top)?.left ?? 0),
    rights: tops.map((top) => lines.get(top)?.right ?? 0),
    widths: tops.map((top) => round((lines.get(top)?.right ?? 0) - (lines.get(top)?.left ?? 0))),
  };
}

/** The paragraph's prose text nodes, never a mark or a hidden announcement. */
const SKIP = '.visually-hidden, .filing-mark, .margin-note, .phone-strip, .theatre, .seam-rail';
function proseNodes(paragraph: HTMLElement | null): Text[] {
  if (paragraph === null) return [];
  const out: Text[] = [];
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || parent.closest(SKIP) !== null) continue;
    if ((node.textContent ?? '').length === 0) continue;
    out.push(node as Text);
  }
  return out;
}

function gridOf(paragraph: HTMLElement | null): Grid & { lines: number } {
  if (paragraph === null) return { tops: [], lefts: [], rights: [], widths: [], lines: 0 };
  const nodes = proseNodes(paragraph);
  if (nodes.length === 0) return { tops: [], lefts: [], rights: [], widths: [], lines: 0 };
  const origin = paragraph.getBoundingClientRect();
  // One range per prose text node: a range that spans the whole paragraph would also measure the
  // mark and the note standing between two sentences (an absolute box, not a line of the text).
  const rects: DOMRect[] = [];
  for (const node of nodes) {
    const range = document.createRange();
    range.selectNodeContents(node);
    rects.push(...range.getClientRects());
  }
  const grid = linesOf(rects, origin);
  return { ...grid, lines: grid.tops.length };
}

function pointIn(nodes: Text[], offset: number): { node: Text; offset: number } | null {
  let base = 0;
  for (const node of nodes) {
    if (offset <= base + node.length) {
      return { node, offset: Math.max(0, Math.min(node.length, offset - base)) };
    }
    base += node.length;
  }
  const last = nodes[nodes.length - 1];
  return last === undefined ? null : { node: last, offset: last.length };
}

/** Every word of the paragraph's prose, in document coordinates: the pen's own boxes. */
function wordBoxes(paragraph: HTMLElement | null): Array<{ left: number; top: number; width: number; right: number }> {
  const nodes = proseNodes(paragraph);
  if (paragraph === null || nodes.length === 0) return [];
  const origin = document.documentElement.getBoundingClientRect();
  const text = nodes.map((node) => node.data).join('');
  const out: Array<{ left: number; top: number; width: number; right: number }> = [];
  const pattern = /\S+/gu;
  let match = pattern.exec(text);
  while (match !== null) {
    const from = pointIn(nodes, match.index);
    const to = pointIn(nodes, match.index + match[0].length);
    if (from !== null && to !== null) {
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      // A hyphenated word owns two fragments: the head is the press, the tail is the true end.
      const fragments = [...range.getClientRects()].filter((rect) => rect.width > 0);
      const head = fragments[0] ?? range.getBoundingClientRect();
      const tail = fragments[fragments.length - 1] ?? head;
      const box = boxOf(head, origin);
      if (box.width > 0) out.push({ left: box.left, top: box.top, width: box.width, right: round(tail.right - origin.left) });
    }
    match = pattern.exec(text);
  }
  return out;
}

/** Is this mark on the page the reader is looking at? A hidden box is not a mark. */
function shown(node: Element | null): boolean {
  if (node === null) return false;
  const style = getComputedStyle(node);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.5
    && node.getBoundingClientRect().width > 0;
}

/** The taste rules, read off the DOM the pictures are taken of. */
function audit(): Record<string, unknown> {
  const root = document.documentElement;
  const tokens = ['ink', 'ink-2', 'ink-3', 'rule', 'rule-2', 'live'].map((name) =>
    getComputedStyle(root).getPropertyValue(`--${name}`).trim(),
  );
  const toRgb = (hex: string): string | null => {
    const value = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex.trim());
    if (value === null) return null;
    return `rgb(${String(Number.parseInt(value[1] ?? '0', 16))}, ${String(Number.parseInt(value[2] ?? '0', 16))}, ${String(Number.parseInt(value[3] ?? '0', 16))})`;
  };
  const palette = new Set(tokens.map(toRgb).filter((one): one is string => one !== null));
  const scope = [...document.querySelectorAll('main *, header *')];
  const families = new Set<string>();
  const colours = new Set<string>();
  const shadows: string[] = [];
  const shout: string[] = [];
  for (const element of scope) {
    const style = getComputedStyle(element);
    families.add(style.fontFamily);
    for (const value of [style.color, style.backgroundColor, style.textDecorationColor, style.borderTopColor]) {
      if (value !== '' && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') colours.add(value);
    }
    if (style.boxShadow !== 'none' && style.boxShadow !== '') shadows.push(`${describe(element)} · box-shadow ${style.boxShadow}`);
    if (style.textShadow !== 'none' && style.textShadow !== '') shadows.push(`${describe(element)} · text-shadow ${style.textShadow}`);
    if (style.textTransform === 'uppercase') shout.push(`${describe(element)} · text-transform: uppercase`);
  }
  // A text node the theatre adds, never the book's prose (the book keeps its own capitals) and
  // never the filing's numeral (`№A7K` is the code's, not the canon's — BOOK-DOC-86 §3).
  const walker = document.createTreeWalker(document.querySelector('main') ?? document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (!/\p{Lu}/u.test(text)) continue;
    const parent = node.parentElement;
    if (parent === null) continue;
    // The book's own prose is not the theatre's: only the words a mark adds are held to canon.
    if (parent.closest('.margin-note-word, .margin-note-who, .margin-note-next, .head-status') === null) continue;
    shout.push(`${describe(parent)} · "${text.slice(0, 24)}"`);
  }
  return {
    families: [...families],
    palette: [...palette],
    colours: [...colours].filter((value) => !palette.has(value)),
    shadows,
    shout,
    animations: document.getAnimations().map((animation) => ({
      kind: animation.constructor.name,
      property: animation instanceof CSSTransition ? animation.transitionProperty : 'unknown',
      playState: animation.playState,
      iterations: animation.effect?.getTiming().iterations ?? null,
      duration: animation.effect?.getTiming().duration ?? null,
    })),
  };
}

/* ------------------------------------------------------------------------ the scene ---- */

/**
 * The page's own state, as `App` keeps it: one reducer, one commit, the same three publishes.
 * `push` is the socket's `handle` without the effects — this page has no REST to refresh.
 */
type Ephemeral = {
  /** The filing's row: a refetch's answer, never a frame (the one thing that is not real). */
  row: CommentDto;
  transport: TheatreTransport;
  /**
   * BOOK-227 — the chapter's renderer is remounted per act. `ChapterProse` settles each print plan
   * once and keeps it settled (a settled plan never replays, D5); the harness runs the same write
   * twice, so each act is a fresh page, exactly as a reload would be.
   */
  epoch: number;
  /** The chapter's write, when the act's own `chapter:applied` frame is not enough. */
  applied?: ChapterAppliedPayload | null;
};

type ActName =
  | 'arrival'
  | 'thinking'
  | 'verdict'
  | 'queue'
  | 'writing'
  | 'checking'
  | 'landing'
  | 'failure-fault'
  | 'failure-verdict'
  | 'link-down';

type ActOptions = {
  back?: number;
  scroll?: number;
  /** Stop at the act's first painted frame: the plate of a shape before its own birth. */
  freeze?: boolean;
};

export type Snapshot = Record<string, unknown>;

type Bridge = {
  ready: true;
  act: (name: ActName, options?: ActOptions) => Promise<Snapshot>;
  snapshot: (options?: { since?: number }) => Snapshot;
  facts: () => Record<string, unknown>;
  words: () => Array<{ left: number; top: number; width: number; right: number }>;
  /** The renderer's own geometry, read by the renderer's own `measure`. */
  geometry: () => Record<string, unknown> | null;
  /** The paragraph with `history` off: no `.sentence-door`, the marks inside the same `[data-s]`. */
  plain: () => Promise<Snapshot>;
  reset: () => Promise<Snapshot>;
};

declare global {
  interface Window {
    __theatre?: Bridge;
  }
}

const paint = (times = 2): Promise<void> =>
  new Promise((resolve) => {
    const step = (left: number): void => {
      if (left <= 0) {
        resolve();
        return;
      }
      nativeRaf(() => step(left - 1));
    };
    step(times);
  });

const wait = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

let page: ClientState = initialClientState();
let scene: Ephemeral = { row: row(), transport: 'up', epoch: 0 };
let setScene: ((next: Ephemeral) => void) | null = null;
let setPage: ((next: ClientState) => void) | null = null;
let windowStart = performance.now();
/** The plans the last render handed the prose: the harness's own view of PR #121's answer. */
let lastPrints: readonly unknown[] = [];
/** `history` on: the paragraph the site serves by default. */
let historyOn = true;

const publish = (next: ClientState): void => {
  page = next;
  publishLiveChange({ lines: next.lines, passes: next.passes });
  publishFilingLive({ reading: next.reading, filingUpdates: next.filingUpdates, decisions: next.decisions });
  publishTheatrePage({ stages: next.stages, applied: next.applied, transport: scene.transport });
};

const commit = (next: ClientState): void => {
  publish(next);
  flushSync(() => setPage?.(next));
};

/** The socket's handler, minus the effects: one envelope, one commit. */
const push = (...frames: Envelope[]): void => {
  let next = page;
  for (const frame of frames) next = applyFrame(next, frame, {}).state;
  commit(next);
};

const setRow = (row_: CommentDto, transport: TheatreTransport = 'up'): void => {
  scene = { row: row_, transport, epoch: scene.epoch + 1 };
  flushSync(() => setScene?.(scene));
  publishTheatrePage({ stages: page.stages, applied: page.applied, transport });
};

let lastClaim: { fact: number; by: number } | null = null;
const claim = (at: number): void => {
  lastClaim = { fact: at, by: Date.now() };
  push(
    envelope('filing:reading', {
      commentId: 'cmt_A7K',
      chapter: 1,
      phase: 'claimed',
      attempt: 1,
      maxAttempts: 6,
      widened: null,
      desperate: false,
      at,
      deadlineAt: at + 900_000,
      retryAt: null,
      reason: null,
      costUsd: null,
      estimated: false,
      readingSeq: 12,
    }),
  );
};

/** The write's own record: the span is the whole block on both sides, as `applied.ts` builds it. */
const applyFrameOfWrite = (appliedAt: number, rev = 16): Envelope =>
  envelope('chapter:applied', {
    n: 1,
    rev,
    hseq: rev,
    appliedAt,
    createdAt: new Date(appliedAt).toISOString(),
    kind: 'edit',
    cause: { stepId: 'stp_1', changeId: 'chg_1', cascadeId: null, lane: 'forward', direction: 'forward' },
    patch: [{ op: 'replace', id: BLOCK_ID, i: 1, text: BLOCK }],
    patchTruncated: false,
    span: [{ blockId: BLOCK_ID, before: BLOCK_BEFORE, after: BLOCK, truncated: false }],
    chars: BLOCK.length,
    delta: BLOCK.length - BLOCK_BEFORE.length,
    blocksTouched: 1,
    attributed: true,
  });

/** One act's frames, in the page's own reducer. The page is reset first, so no act inherits one. */
async function act(name: ActName, options: ActOptions = {}): Promise<Snapshot> {
  const back = options.back ?? 400;
  const now = Date.now();
  windowStart = performance.now();
  lastClaim = null;
  seq = 0;
  window.scrollTo(0, 0);
  commit(initialClientState());
  push(envelope('hello', hello()));
  await paint();

  switch (name) {
    case 'arrival': {
      // triage is reading it: «идёт» · «читает триаж»
      setRow(row({ status: 'batched' }));
      await paint();
      if (options.scroll !== undefined) {
        window.scrollTo(0, options.scroll);
        await paint(1);
      }
      claim(now - back);
      await paint(2);
      return snapshot();
    }
    case 'thinking': {
      setRow(row({ status: 'accepted', changeStatus: 'processing', decidedAt: new Date(now - 5_000).toISOString() }));
      push(envelope('pass:stage', stage({ stage: 'drafting', at: now - back, summary: 'пишется' })));
      await paint();
      await wait(560);
      return snapshot();
    }
    case 'verdict': {
      setRow(row({ status: 'accepted', changeStatus: 'processing', decidedAt: new Date(now - back).toISOString() }));
      await paint();
      await wait(620);
      return snapshot();
    }
    case 'queue': {
      setRow(row({ status: 'accepted', changeStatus: 'pending', decidedAt: new Date(now - 900).toISOString() }));
      await paint(3);
      await wait(320);
      return snapshot();
    }
    case 'writing': {
      // The print's own clock: `appliedAt` is the frame's, and the plate is taken 800 ms in.
      setRow(row({ status: 'accepted', changeStatus: 'processing', decidedAt: new Date(now - 5_000).toISOString() }));
      push(applyFrameOfWrite(now - (options.back ?? 250)));
      await paint(2);
      await wait(240);
      return snapshot();
    }
    case 'checking': {
      setRow(row({ status: 'accepted', changeStatus: 'processing', decidedAt: new Date(now - 9_000).toISOString() }));
      push(
        applyFrameOfWrite(now - 7_000),
        envelope('pass:stage', stage({ stage: 'drafting', stageSeq: 1, at: now - 8_000 })),
        envelope('pass:stage', stage({ stage: 'verdict', stageSeq: 2, at: now - 500, summary: 'редактор' })),
        envelope('pass:stage', stage({ stage: 'verdict', stageSeq: 3, at: now - 300, summary: 'консультант' })),
      );
      await paint(2);
      await wait(1_400);
      return snapshot();
    }
    case 'landing': {
      setRow(
        row({
          status: 'applied',
          decidedAt: new Date(now - 60_000).toISOString(),
          applied: { chapter: 1, rev: 16 },
        }),
      );
      push(applyFrameOfWrite(now - 7_000));
      await paint();
      // The lift starts 120 ms after the sink: a plate of the rule still standing stops here.
      if (options.freeze !== true) await wait(460);
      return snapshot();
    }
    case 'failure-fault': {
      setRow(
        row({
          status: 'accepted',
          attempt: 'failed',
          decidedAt: new Date(now - back).toISOString(),
          reason: 'модель не ответила за 480 с',
        }),
      );
      await paint();
      await wait(320);
      return snapshot();
    }
    case 'failure-verdict': {
      setRow(
        row({
          status: 'rejected',
          refusal: 'rights',
          reason: 'не принято: право на цитату не подтверждено',
          decidedAt: new Date(now - back).toISOString(),
        }),
      );
      await paint();
      await wait(320);
      return snapshot();
    }
    case 'link-down': {
      setRow(row({ status: 'batched' }), 'down');
      await paint(2);
      await wait(200);
      return snapshot();
    }
    default:
      return snapshot();
  }
}

/** The class the sentence's cite carries: `citedClass`'s own reading of the row. */
const citedOf = (row_: CommentDto): string | null => citedClass(filingsForBlock([row_], BLOCK_ID)[0]);

/** The block the filing performs, its sentence, and the theatre's overlay — never the page's first. */
const performedBlock = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(`.p[data-block-id="${BLOCK_ID}"]`);
const performedSentence = (): HTMLElement | null =>
  [...(performedBlock()?.querySelectorAll<HTMLElement>('[data-s]') ?? [])].find(
    (node) => node.dataset.quote === QUOTE,
  ) ?? null;
const performedOverlay = (): HTMLElement | null => performedBlock()?.querySelector<HTMLElement>('.theatre') ?? null;

/* ------------------------------------------------------------------------ the snapshot ---- */

function snapshot(options: { since?: number } = {}): Snapshot {
  const since = options.since ?? windowStart;
  const paragraph = performedBlock();
  const sentence = performedSentence();
  const host = performedOverlay();
  const origin = document.documentElement.getBoundingClientRect();
  const lines = [...document.querySelectorAll<HTMLElement>('.theatre-line')].map((node) => ({
    box: boxOf(node.getBoundingClientRect(), origin),
    clip: node.style.clipPath,
    painted: paintedWidth(node),
    opacity: getComputedStyle(node).opacity,
    lift: node.dataset.lift ?? null,
  }));
  const spine = document.querySelector<HTMLElement>('.theatre-spine');
  const nib = document.querySelector<HTMLElement>('.theatre-nib');
  const noteRule = document.querySelector<HTMLElement>('.theatre-note-rule');
  const ruleEnd = document.querySelector<HTMLElement>('.theatre-rule-end');
  const grid = gridOf(paragraph);
  /** The performed sentence's own lines: the rule, the stub and the foot are its, not the block's. */
  const sentenceGrid = gridOf(sentence);

  return {
    at: Date.now(),
    width: window.innerWidth,
    height: window.innerHeight,
    reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    // The head's one word is main's `HeadLine`, on the same `ClientState` as the prose
    // (`/harness/theatre.html` asserts it printed before a plate is taken).
    head: document.querySelector('.head-line') === null ? null : (document.querySelector('.head-line')?.textContent ?? null),
    claim: lastClaim === null ? null : { fact: lastClaim.fact, by: lastClaim.by, elapsed: Date.now() - lastClaim.fact },
    act:
      sentence === null || sentence.dataset.theatre === undefined
        ? null
        : {
            kind: sentence.dataset.theatre,
            outcome: sentence.dataset.outcome ?? null,
            cause: sentence.dataset.cause ?? null,
          },
    theatre:
      host === null
        ? null
        : {
            nodes: host.querySelectorAll('*').length,
            lines: lines.length,
            lineBoxes: lines.map((line) => line.box),
            clips: lines.map((line) => line.clip),
            painted: lines.map((line) => line.painted),
            lineOpacity: lines.map((line) => line.opacity),
            lifts: lines.map((line) => line.lift),
            nib: nib === null ? null : { box: boxOf(nib.getBoundingClientRect(), origin), shape: nib.dataset.shape ?? null, opacity: nib.style.opacity, width: nib.style.width },
            spine: spine === null ? null : { open: spine.dataset.open ?? null, box: boxOf(spine.getBoundingClientRect(), origin), transform: spine.style.transform },
            tallies: [...document.querySelectorAll<HTMLElement>('.theatre-tally')].map((node) => ({
              ink: node.dataset.ink ?? null,
              box: boxOf(node.getBoundingClientRect(), origin),
              gate: node.dataset.gate ?? null,
            })),
            foot: document.querySelector<HTMLElement>('.theatre-foot')?.dataset.open ?? null,
            box: host === null ? null : boxOf(host.getBoundingClientRect(), origin),
            ruleEnd: ruleEnd !== null,
            ruleEndBox: ruleEnd === null ? null : boxOf(ruleEnd.getBoundingClientRect(), origin),
            noteRule: noteRule === null ? null : { transform: getComputedStyle(noteRule).transform, withdraw: noteRule.dataset.withdraw ?? null },
            ends: document.querySelectorAll('.theatre-end').length,
          },
    grid,
    sentenceGrid,
    paragraph: paragraph === null ? null : boxOf(paragraph.getBoundingClientRect(), origin),
    marks: {
      filing: document.querySelectorAll('.filing-mark').length,
      notes: document.querySelectorAll('.margin-note').length,
      strips: document.querySelectorAll('.phone-strip').length,
      state: document.querySelector<HTMLElement>('.filing-mark')?.dataset.state ?? null,
      cited: citedOf(scene.row),
      word: document.querySelector('.margin-note-word')?.textContent ?? null,
      // BOOK-227 — the margin's boxes, so "the margin does not move for the sentence's own act"
      // is a number, not an opinion.
      // §0 — the margin's own boxes, measured from the paragraph: the head's row belongs to the
      // head, and a word appearing there must not read as the margin having moved.
      markBox: document.querySelector('.filing-mark') === null || paragraph === null ? null : boxOf((document.querySelector('.filing-mark') as HTMLElement).getBoundingClientRect(), paragraph.getBoundingClientRect()),
      noteBox: document.querySelector('.margin-note') === null || paragraph === null ? null : boxOf((document.querySelector('.margin-note') as HTMLElement).getBoundingClientRect(), paragraph.getBoundingClientRect()),
      stripBox: document.querySelector('.phone-strip') === null || paragraph === null ? null : boxOf((document.querySelector('.phone-strip') as HTMLElement).getBoundingClientRect(), paragraph.getBoundingClientRect()),
      sentenceSpans: document.querySelectorAll('.p [data-s]').length,
      act: sentence?.dataset.theatre ?? null,
      // The phone's tick is the mark's `::before` bar: its ink must follow the act (§3), and the
      // sheet used to hard-code the accent there.
      bar: (() => {
        const mark = document.querySelector<HTMLElement>('.filing-mark');
        return mark === null ? null : getComputedStyle(mark, '::before').backgroundColor;
      })(),
      markInk: document.querySelector<HTMLElement>('.filing-mark') === null
        ? null
        : getComputedStyle(document.querySelector<HTMLElement>('.filing-mark') as HTMLElement).color,
      markShown: shown(document.querySelector('.filing-mark')),
      noteShown: shown(document.querySelector('.margin-note')),
      stripShown: shown(document.querySelector('.phone-strip')),
    },
    theme: {
      live: getComputedStyle(document.documentElement).getPropertyValue('--live').trim(),
      ink3: getComputedStyle(document.documentElement).getPropertyValue('--ink-3').trim(),
    },
    paragraphs: document.querySelectorAll('.p').length,
    scroll: { y: window.scrollY, visible: sentence === null ? false : sentence.getBoundingClientRect().bottom > 0 && sentence.getBoundingClientRect().top < window.innerHeight },
    rule: sentence === null ? null : { style: getComputedStyle(sentence).textDecorationStyle, colour: getComputedStyle(sentence).textDecorationColor },
    /**
     * The print (§9.4): main's own shape, measured — the block the print inks, its beat, the one
     * caret, the ghost — and the spine the theatre puts on it. `::after` is read through
     * `getComputedStyle`, because a pseudo-element has no rect: `content: none` is "no spine".
     */
    print: (() => {
      const block = document.querySelector<HTMLElement>('.p-pass'); // one print, one block
      const spine = block === null ? null : getComputedStyle(block, '::after');
      const caret = document.querySelector<HTMLElement>('.caret-ink');
      const ghost = document.querySelector<HTMLElement>('.pass-ghost');
      return {
        blocks: document.querySelectorAll('.p-pass').length,
        beat: block?.dataset.pass ?? null,
        revealed: block?.dataset.revealed ?? null,
        spine: spine === null ? null : {
          content: spine.content,
          width: spine.width,
          colour: spine.backgroundColor,
          left: spine.left,
        },
        caret: caret === null ? null : { box: boxOf(caret.getBoundingClientRect(), origin), opacity: getComputedStyle(caret).opacity },
        carets: document.querySelectorAll('.caret-ink').length,
        ghost: ghost === null ? null : { opacity: getComputedStyle(ghost).opacity },
      };
    })(),
    writes: writesSince(since),
    style: audit(),
  };
}

/** Per-frame write counts and the mutation record, both bounded by `since`. */
function writesSince(since: number): Record<string, unknown> {
  const frames = rafLog.filter((entry) => entry.start >= since);
  const muts = mutLog.filter((entry) => entry.t >= since);
  const perFrame = new Map<number, { clip: number; transform: number; opacity: number; targets: string[] }>();
  const commit = { clip: 0, transform: 0, opacity: 0 };
  // Chrome sometimes reports one attribute write as two records with the same before/after pair
  // (a style attribute set twice in one task): one write is one write.
  const seen = new Set<string>();
  for (const mut of muts) {
    if (mut.type !== 'style' || mut.prop === null) continue;
    const key = `${String(mut.node)}|${mut.prop}|${mut.prev ?? ''}|${mut.value ?? ''}`;
    if (!seen.has(key)) seen.add(key);
    else continue;
    const frame = [...frames].reverse().find((entry) => entry.start <= mut.t && mut.t <= entry.end);
    if (frame === undefined) {
      if (mut.prop === 'clip-path') commit.clip += 1;
      if (mut.prop === 'transform') commit.transform += 1;
      if (mut.prop === 'opacity') commit.opacity += 1;
      continue;
    }
    const bucket = perFrame.get(frame.frame) ?? { clip: 0, transform: 0, opacity: 0, targets: [] };
    if (mut.prop === 'clip-path') bucket.clip += 1;
    if (mut.prop === 'transform') bucket.transform += 1;
    if (mut.prop === 'opacity') bucket.opacity += 1;
    bucket.targets.push(`${Math.round(mut.t * 100) / 100}ms #${String(mut.node)} ${mut.prop}:${mut.target} ${mut.prev ?? ''}→${mut.value ?? ''}`);
    perFrame.set(frame.frame, bucket);
  }

  return {
    rafCount: frames.length,
    raf: {
      script: stats(frames.map((entry) => entry.end - entry.start)),
      deltas: stats(frames.slice(1).map((entry, index) => entry.start - (frames[index]?.start ?? entry.start))),
    },
    mutations: {
      style: muts.filter((mut) => mut.type === 'style').length,
      childList: muts.filter((mut) => mut.type === 'childList').length,
      characterData: muts.filter((mut) => mut.type === 'characterData').length,
      childListDetail: muts.filter((mut) => mut.type === 'childList').map((mut) => mut.target).slice(0, 16),
    },
    perFrame: {
      maxClip: Math.max(0, ...[...perFrame.values()].map((bucket) => bucket.clip)),
      maxTransform: Math.max(0, ...[...perFrame.values()].map((bucket) => bucket.transform)),
      maxOpacity: Math.max(0, ...[...perFrame.values()].map((bucket) => bucket.opacity)),
      frames: perFrame.size,
      over: [...perFrame.values()].filter((bucket) => bucket.opacity > 1 || bucket.transform > 1 || bucket.clip > 1).map((bucket) => bucket.targets),
      commit,
    },
  };
}

const stats = (values: number[]): Record<string, number> => {
  if (values.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const at = (share: number): number => round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0);
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted[sorted.length - 1] ?? 0) };
};

/* ------------------------------------------------------------------------- the page ---- */

/**
 * The page: the running head (`HeadLine`), then main's `ChapterProse` — the paragraph, the
 * margin, and, while a write is inside its window, main's print. Nothing here draws a mark.
 */
function Page(): ReactNode {
  const [world, setWorld] = useState<Ephemeral>(scene);
  const [state, setState] = useState<ClientState>(page);
  const installed = useRef(false);
  scene = world;
  page = state;
  if (!installed.current) {
    installed.current = true;
    setScene = (next) => setWorld(next);
    setPage = (next) => setState(next);
  }
  // PR #121's own plans: the same function `ChapterArticle` hands the prose.
  const now = Date.now();
  const prints = appliedPrintPlans(state.applied, { nowMs: now, visible: () => true });
  lastPrints = prints;
  // The site's own shell: `main.tsx` hands every page the one canvas, and `App` the one column.
  return (
    <div className="canvas">
      <header className="top">
        <div className="page sheet top-in">
          <div className="top-row">
            <span className="brand">Бланк</span>
            <span className="top-chapter" data-n={1}>
              <span className="top-chapter-n">1</span>
              <span className="top-chapter-w">{CHAPTER.title}</span>
            </span>
          </div>
          <HeadLine client={state} connection={null} nowMs={now} />
        </div>
      </header>
      <main className="page">
        <article className="chapter" data-n={1}>
          <ChapterProse
            key={world.epoch}
            entry={ENTRY}
            chapter={CHAPTER}
            reveal={null}
            revising={null}
            caret={{ show: false, live: false }}
            printing={false}
            comments={[world.row]}
            changes={[]}
            nowMs={now}
            composer={COMPOSER}
            viewer={VIEWER}
            history={historyOn}
            prints={prints}
            onPosted={() => undefined}
            onReanchor={() => undefined}
          />
        </article>
        <div className="harness-tail" />
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing');
createRoot(root).render(<Page />);
observer.observe(document.body, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeOldValue: true,
  attributeFilter: ['style'],
});
document.body.dataset.harnessReady = 'true';

window.__theatre = {
  ready: true,
  act,
  snapshot,
  /**
   * What the act is made of, as the page holds it: the write, the read, the stage log, and the
   * performed **sentence's** own numbers — the design's 57 words belong to the block, the fill
   * belongs to the sentence that carries it (§2), and the checks read the latter.
   */
  facts: () => {
    const quote = performedSentence()?.dataset.quote ?? '';
    const words = wordsOf(quote).length;
    return {
      blockId: BLOCK_ID,
      quote,
      words,
      sweepMs: sweepOf(words),
      act: page.applied === null ? null : { n: page.applied.n, rev: page.applied.rev, appliedAt: page.applied.appliedAt },
      reading: page.reading === null ? null : { phase: page.reading.phase, commentId: page.reading.commentId },
      stages: Object.fromEntries(Object.entries(page.stages).map(([chapter, events]) => [chapter, events.map((event) => `${event.passId}:${String(event.stageSeq)}:${event.stage}`)])),
      rows: [scene.row.status, scene.row.changeStatus, scene.row.number],
      /** PR #121's plans as this render handed them over: one write, one block. */
      prints: lastPrints.length,
      transport: scene.transport,
    };
  },
  /** The performed sentence's words, in document coordinates: the pen's own boxes. */
  words: () => wordBoxes(performedSentence()),
  geometry: () => {
    const host = performedOverlay();
    if (host === null) return null;
    const geometry = measureGeometry(host);
    if (geometry === null) return null;
    return {
      lines: geometry.lines.length,
      words: geometry.words.length,
      linePx: geometry.linePx,
      lineTops: geometry.lines.map((line) => round(line.top)),
      ruleTops: geometry.ruleTops.map((top) => round(top)),
      wordTops: geometry.words.map((word) => round(word.top)),
      widths: geometry.words.map((word) => round(word.width)),
      firstLeft: round(geometry.words[0]?.left ?? 0),
      lastRight: round(geometry.words.at(-1)?.right ?? 0),
    };
  },
  plain: async () => {
    historyOn = false;
    commit(initialClientState());
    push(envelope('hello', hello()));
    await paint(2);
    return snapshot();
  },
  reset: async () => {
    historyOn = true;
    resetTheatrePage();
    commit(initialClientState());
    push(envelope('hello', hello()));
    await paint(2);
    return snapshot();
  },
};
