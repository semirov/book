// @vitest-environment jsdom
import type { CommentDto, CommentRevise } from '@book/shared';
import { act, useCallback, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviseNote } from '../components/ReviseNote.tsx';
import { reviseView } from './revise.ts';
import { nextCooldown, useReviseTick } from './useReviseTick.ts';

/**
 * BOOK-158 review M2 — the cooldown lifts on the page, not only on a reload.
 *
 * The DTO freezes `revise`, so the page owes itself two things while a refusal cools down: the
 * printed minutes must count, and the chapter must be re-read just after `revise.at` so the
 * server's `allowed:true` can open the door. One hook does both (`useReviseTick`), and these
 * tests drive it with fake timers, exactly as a reader would leave the tab open.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const BASE = Date.parse('2026-10-28T12:00:00Z');
const AT_MS = BASE + 10 * 60_000;
const AT = new Date(AT_MS).toISOString();

function revise(overrides: Partial<CommentRevise> = {}): CommentRevise {
  return { allowed: false, at: null, attemptsLeft: 2, closed: false, blocked: null, ...overrides };
}

function refused(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_refused',
    number: 1,
    chapter: 8,
    anchor: {
      blockId: 'ch08#aa11bb22',
      blockIndex: 2,
      quote: 'Её освещал яркий свет.',
      prefix: null,
      suffix: null,
      resolved: true,
    },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: null,
    status: 'rejected',
    frame: 'untouched',
    premise: false,
    reason: 'вне рамок: не про текст этой главы',
    hint: 'сформулируйте одно событие этой главы, которого ещё нет в тексте',
    revise: revise({ at: AT, blocked: 'cooldown' }),
    createdAt: '2026-10-27T12:00:00Z',
    decidedAt: new Date(AT_MS - 10 * 60_000).toISOString(),
    changeId: null,
    applied: null,
    refusal: 'auditor',
    attempt: null,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement;
let refreshed: Array<number | undefined>;

/** The page's own wiring: the hook's clock read by the same view the register uses. */
function Host({ first, next }: { first: CommentDto; next: CommentDto }) {
  const [comments, setComments] = useState<readonly CommentDto[]>([first]);
  const refreshComments = useCallback(
    async (chapter?: number) => {
      refreshed.push(chapter);
      setComments([next]);
    },
    [next],
  );
  const nowMs = useReviseTick(comments, {}, refreshComments);
  const view = reviseView(comments[0]!, nowMs);
  if (view === null) return null;
  return <ReviseNote view={view} onRevise={() => undefined} className="comment-revise" />;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(BASE);
  refreshed = [];
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('nextCooldown', () => {
  it('picks the nearest future cooldown across the register and the chapter feeds', () => {
    const nearest = nextCooldown(
      {
        comments: [refused({ id: 'cmt_register' })],
        chapterFeed: {
          9: {
            loaded: true,
            items: [
              refused({
                id: 'cmt_chapter',
                number: 2,
                chapter: 9,
                revise: revise({ at: new Date(AT_MS + 5 * 60_000).toISOString(), blocked: 'cooldown' }),
              }),
            ],
          },
        },
      },
      BASE,
    );
    expect(nearest).toEqual({ chapter: 8, at: AT_MS });
  });

  it('ignores a row that is allowed, blocked by a counter, or already past `at`', () => {
    const feeds = {
      comments: [
        refused({ id: 'cmt_open', revise: revise({ allowed: true, at: AT, blocked: null }) }),
        refused({ id: 'cmt_spent', revise: revise({ at: AT, blocked: 'attempts' }) }),
        refused({ id: 'cmt_past', revise: revise({ at: new Date(BASE - 1_000).toISOString(), blocked: 'cooldown' }) }),
      ],
      chapterFeed: {},
    };
    expect(nextCooldown(feeds, BASE)).toBeNull();
  });
});

describe('the page’s revise clock', () => {
  it('counts the cooldown down, then refreshes the chapter and opens the door', async () => {
    const closed = refused();
    // What a re-read one second after `at` answers: still the same refused row, now open.
    const open = refused({ revise: revise({ allowed: true, at: AT, attemptsLeft: 2 }) });
    await act(async () => root?.render(<Host first={closed} next={open} />));

    const door = (): HTMLButtonElement | null =>
      container.querySelector<HTMLButtonElement>('.revise .seam-inline-action');
    expect(container.querySelector('.revise-why')?.textContent).toBe('можно повторить через 10 минут');
    expect(door()?.disabled).toBe(true);

    // Nine minutes later the frozen DTO says nothing new; the tick says «через 1 минуту».
    await act(async () => {
      vi.advanceTimersByTime(9 * 60_000);
    });
    expect(container.querySelector('.revise-why')?.textContent).toBe('можно повторить через 1 минуту');
    expect(door()?.disabled).toBe(true);
    expect(refreshed).toEqual([]);

    // The refresh lands one second after `at`, and the refreshed DTO opens the door.
    await act(async () => {
      vi.advanceTimersByTime(60_000 + 2_000);
    });
    expect(refreshed).toEqual([8]);
    expect(container.querySelector('.revise-why')).toBeNull();
    expect(door()?.disabled).toBe(false);
  });

  it('schedules nothing while no cooldown is live, and clears both timers on unmount', async () => {
    const open = refused({ revise: revise({ allowed: true, at: AT }) });
    await act(async () => root?.render(<Host first={open} next={open} />));
    expect(vi.getTimerCount()).toBe(0);

    // A fresh mount for the cooling row: a prop change keeps the state it started with.
    await act(async () => root?.unmount());
    container.remove();
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
    const cooling = refused();
    await act(async () => root?.render(<Host first={cooling} next={cooling} />));
    expect(vi.getTimerCount()).toBe(2);

    await act(async () => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
    expect(refreshed).toEqual([]);
  });
});
