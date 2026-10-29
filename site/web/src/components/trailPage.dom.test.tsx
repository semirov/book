// @vitest-environment jsdom
import { AUTHOR_COLORS, type CommentDto, type MyFilingsDto, type MyTraceDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dismissNotice, unfollow } from '../lib/follow.ts';
import { TrailPage } from './TrailPage.tsx';

/**
 * BOOK-207 — «ваш след» as its own page: signed out, empty, and two rows whose quotes are
 * doors back to the sentence. The page reads own-only (`/api/authors/me`, `/api/me/filings`)
 * and prints no total.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TRACE: MyTraceDto = {
  label: 'Аня',
  edits: 2,
  chars: 4_000,
  share: 0.004,
  series: [],
  hidden: false,
  isAuthor: false,
  survivedRevisions: 12,
};

function filing(id: string, chapter: number, blockIndex: number, quote: string): CommentDto {
  return {
    id,
    chapter,
    anchor: { blockId: `ch${chapter}#b${blockIndex}`, blockIndex, quote, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: AUTHOR_COLORS[0],
    body: 'пусть останется как есть',
    proposedText: null,
    interventionKind: null,
    premise: false,
    status: 'applied',
    frame: 'untouched',
    reason: null,
    createdAt: '2026-10-28T09:08:00Z',
    decidedAt: '2026-10-28T10:00:00Z',
    changeId: 'chg_1',
    applied: { chapter, rev: 4 },
    refusal: null,
    attempt: null,
    report: {
      line1: 'прочитано через бумагу, а не как сказано',
      line2: 'потому что в сцене это некому сказать',
      line3: 'где это в книге: глава 12 · абзац 9',
    },
  };
}

const FILINGS: MyFilingsDto = {
  items: [filing('cmt_A7K', 12, 8, 'Он вошёл в регистратуру.'), filing('cmt_B2C', 13, 3, 'Дверь осталась открытой.')],
};

let root: Root | null = null;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  unfollow('chg_1');
  dismissNotice();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/authors/me')) return json(TRACE);
    if (url.endsWith('/api/me/filings')) return json(FILINGS);
    return json({ code: 'NOT_FOUND', message: 'not found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  // jsdom has no layout and a real `scrollTo` is not implemented: the mode's landing is a spy.
  vi.stubGlobal('scrollTo', vi.fn());
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function mount(signedIn: boolean): Promise<void> {
  await act(async () => {
    root?.render(<TrailPage viewer={{ signedIn, displayName: signedIn ? 'Аня' : null }} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('«ваш след»', () => {
  it('asks a signed-out reader to sign in, and reads nothing', async () => {
    await mount(false);
    expect(container.textContent).toContain('войдите, чтобы увидеть свой след');
    expect(container.querySelector('a[href="/auth/yandex/start"]')?.textContent).toBe('войти через Яндекс');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector('.sled-head')?.textContent).toBe('ваш след');
    expect(container.querySelector('a[href="#toc"]')?.textContent).toBe('к оглавлению');
  });

  it('says «вы ещё ничего не написали» for a signed-in reader with no filings', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/authors/me')) return json(TRACE);
      if (url.endsWith('/api/me/filings')) return json({ items: [] });
      return json({ code: 'NOT_FOUND', message: 'not found' }, 404);
    });
    await mount(true);
    expect(container.textContent).toContain('вы ещё ничего не написали');
    expect(container.textContent).toContain('пережила 12 ревизий, сейчас 0,4 %');
    expect(container.querySelector('a[href="#toc"]')).not.toBeNull();
  });

  it('prints two rows, newest first, each quote a door to its sentence', async () => {
    await mount(true);
    const rows = [...container.querySelectorAll('.sled-row')];
    expect(rows).toHaveLength(2);
    // The filing's number with its noun, its state word, and its moment.
    expect(rows[0]?.querySelector('.sled-meta')?.textContent).toMatch(/^замечание №A7K · внесено · 28\.10, \d{2}:\d{2}$/u);
    expect(rows[1]?.querySelector('.sled-meta')?.textContent).toContain('замечание №B2C');
    // The quote is the way back to the text.
    const links = rows.map((row) => row.querySelector<HTMLAnchorElement>('.sled-quote a'));
    expect(links[0]?.getAttribute('href')).toBe('#ch-12-b8');
    expect(links[1]?.getAttribute('href')).toBe('#ch-13-b3');
    expect(links[0]?.textContent).toBe('«Он вошёл в регистратуру.»');
    // How it was read travels with it.
    expect(rows[0]?.textContent).toContain('прочитано через бумагу, а не как сказано');
    expect(rows[0]?.textContent).toContain('потому что в сцене это некому сказать');
    // The page prints no total, only the trace's own line.
    expect(container.textContent).not.toContain('всего');
    expect(container.textContent).not.toContain('50');
  });

  it('lands at the page’s top on entry, with the head focused', async () => {
    await mount(false);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    expect(document.activeElement).toBe(container.querySelector('.sled-head'));
  });

  it('carries «к оглавлению» to the contents once the book has mounted them', async () => {
    await mount(false);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const link = container.querySelector<HTMLAnchorElement>('a[href="#toc"]');
    expect(link?.textContent).toBe('к оглавлению');
    await act(async () => link?.click());
    // The hash is the mode change; the landing waits for the contents to exist.
    expect(window.location.hash).toBe('#toc');
    expect(frames).toHaveLength(1);
    await act(async () => {
      frames.shift()?.(0);
    });
    const toc = document.createElement('div');
    toc.id = 'toc';
    const into = vi.fn();
    toc.scrollIntoView = into;
    document.body.append(toc);
    await act(async () => {
      frames.shift()?.(16);
    });
    expect(into).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
  });

  it('says «след не прочитался» and offers «повторить» when the read fails', async () => {
    fetchMock.mockImplementation(async () => json({ code: 'INTERNAL', message: 'nope' }, 500));
    await mount(true);
    expect(container.textContent).toContain('след не прочитался');
    const retry = container.querySelector<HTMLButtonElement>('.sled-retry button');
    expect(retry?.textContent).toBe('повторить');
  });
});
