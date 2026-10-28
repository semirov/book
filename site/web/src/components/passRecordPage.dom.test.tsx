// @vitest-environment jsdom
import type { FrontDto, PassStage, PassStageEvent, StageSpan, StateSnapshot } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MIDDOT } from '../lib/format.ts';
import { passRecordView } from '../lib/passRecord.ts';
import { PassRecordPage } from './PassRecordPage.tsx';

/**
 * BOOK-166 — the record is a mode of the same page: the running head, the record and the
 * colophon, and nothing between them. The owner asked for the two ends to stay; this proves the
 * record does not become a modal and does not lose the page's own chrome.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const FRONT = {
  title: 'Бланк',
  about: null,
  rev: 1,
  toc: [],
  imprint: { author: 'Автор', copyright: '© Автор' },
  authors: { count: 0 },
} as unknown as FrontDto;

const STATE = {
  version: 1,
  at: '',
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: 'Бланк', about: null, rev: 1, updatedAt: null },
  chapters: { total: 42, written: [], empty: [], count: 0, totalChars: 0 },
  cursors: {},
  toc: [],
  meeting: { forwardFront: null, backwardFront: null, gap: 42, converged: false, seam: 'not_reached' },
  cascade: null,
  queue: {
    depth: 0,
    byState: { pending: 0, processing: 0, stale: 0, escalated: 0, done24h: 0 },
    head: null,
    processing: null,
    lastDecidedAt: null,
  },
  revising: [],
  current: null,
  unresolved: [],
  activity: { lastFileChangeAt: null, lastEngineEventAt: null, lastLogLineAt: null, source: 'files' },
} as unknown as StateSnapshot;

const VIEW = passRecordView({
  key: { kind: 'change', changeId: 'chg_gone' },
  stages: [],
  change: null,
  chapter: null,
  anchorIndex: null,
  nowMs: Date.parse('2026-10-25T08:20:56Z'),
});

const T0 = Date.parse('2026-10-25T08:18:00Z');
const T1 = Date.parse('2026-10-25T08:20:56Z');

const stageOf = (stage: PassStage, stageSeq: number, at: number, span: StageSpan[] | null = null): PassStageEvent => ({
  passId: 'stp_7',
  chapter: 7,
  stageSeq,
  stage,
  at,
  actor: { process: 'writer', model: null },
  changeId: 'chg_7',
  summary: `строка ${String(stageSeq)}`,
  span,
  tokens: stage === 'landed' ? { in: 100_000, out: 26_099 } : null,
  costUsd: stage === 'landed' ? 0.08 : null,
});

/** A pass that is over: its link is the chapter's own head, `#ch-7`. */
const ENDED = passRecordView({
  key: { kind: 'change', changeId: 'chg_7' },
  stages: [
    stageOf('read', 1, T0),
    stageOf('landed', 2, T1, [{ blockId: 'ch07#b', before: 'старый фонарь', after: 'новый фонарь', truncated: false }]),
    stageOf('typing', 3, T1 + 60_000),
  ],
  change: null,
  chapter: {
    title: 'Дорога',
    blocks: [
      { id: 'ch07#a', i: 0, text: 'абзац 1', hash: 'h' },
      { id: 'ch07#b', i: 1, text: 'новый фонарь', hash: 'h' },
    ],
  },
  anchorIndex: null,
  nowMs: T1 + 120_000,
});

const CHROME = {
  state: STATE,
  front: FRONT,
  ribbon: null,
  catalog: [],
  escalation: [],
  viewer: { signedIn: false, displayName: null },
  cost: null,
  donateUrl: null,
  exportBytes: null,
  capacity: false,
  live: true,
};

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
  vi.stubGlobal('scrollTo', vi.fn());
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the record page', () => {
  it('keeps the running head and the colophon around the record', async () => {
    await act(async () => {
      root?.render(
        <PassRecordPage
          record={{ phase: 'ready', hash: '#проход-chg_gone', key: { kind: 'change', changeId: 'chg_gone' }, view: VIEW }}
          chrome={CHROME}
          card={null}
          onCloseCard={() => undefined}
          onOpenChange={() => undefined}
          onOpenChapter={() => undefined}
        />,
      );
    });

    const head = container.querySelector('header.top');
    const record = container.querySelector('section.pass-record');
    const colophon = container.querySelector('footer.colophon');
    expect(head).not.toBeNull();
    expect(record).not.toBeNull();
    expect(colophon).not.toBeNull();
    // The order the page reads in: head, then the record, then the footer.
    expect(head!.compareDocumentPosition(record!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(record!.compareDocumentPosition(colophon!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(record!.querySelector('.pr-head')?.textContent).toBe('пока не писалась');
  });

  it('brings the book view back for the chapter link — the record may be opened from the chronicle', async () => {
    const onOpenChapter = vi.fn();
    await act(async () => {
      root?.render(
        <PassRecordPage
          record={{ phase: 'ready', hash: '#проход-chg_7', key: { kind: 'change', changeId: 'chg_7' }, view: ENDED }}
          chrome={CHROME}
          card={null}
          onCloseCard={() => undefined}
          onOpenChange={() => undefined}
          onOpenChapter={onOpenChapter}
        />,
      );
    });

    const link = container.querySelector('.pr-jump') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#ch-7');
    expect(link.textContent).toBe(`к главе 7${MIDDOT}абзац 2 →`);

    // No `#ch-7` exists while the chronicle is the view: the page's own switch is the way back,
    // and only then can the scroll after paint find the chapter's head.
    await act(async () => {
      link.click();
    });
    expect(onOpenChapter).toHaveBeenCalledWith(7);
    expect(window.location.hash).toBe('#ch-7');
  });
});
