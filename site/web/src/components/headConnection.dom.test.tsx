// @vitest-environment jsdom
import { STAGE_DEADLINE_MS, type HelloPayload } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ClientState } from '../lib/clientState.ts';
import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { applyFrame } from '../lib/frames.ts';
import { apply, resetSeq } from '../lib/framesFixtures.ts';
import type { ConnectionState } from '../lib/socketStatus.ts';
import {
  accepted,
  applied,
  base,
  CATALOG,
  LIVE,
  MINUTE,
  page,
  stage,
  STATE,
  T,
} from './headLineFixtures.ts';
import { Header } from './Header.tsx';

/**
 * BOOK-DOC-84 §11.1 — **the head's socket truth**, in the real head.
 *
 * Two facts of one line, asserted where a reader meets them: the connection's own word
 * (`lib/socketStatus.ts`: nothing while `connecting`, `связи нет` from the second failed attempt,
 * the retry from the fourth, the full hall in its own words) and what a reconnect does to the
 * line (one `hello` is the whole repair — the state line is back on that render, and it is the
 * state the page missed, never the one the dead socket left behind).
 *
 * The split from `headLine.dom.test.tsx` is the file bound, not a layer: both suites mount the
 * same `Header` over the same fixtures (`./headLineFixtures.ts`).
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(
  client: ClientState,
  options: { nowMs?: number | null; connection?: ConnectionState | null } = {},
): Promise<void> {
  await act(async () => {
    root?.render(
      <Header
        state={STATE}
        ribbon={null}
        catalog={CATALOG}
        markers={[]}
        onOpenChange={() => undefined}
        live
        client={client}
        connection={options.connection ?? null}
        {...(options.nowMs === null ? {} : { nowMs: options.nowMs ?? T })}
        reading={{ n: 1, page: 1 }}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** The line's own text, with the separators' no-break space read as a space. */
function text(): string | null {
  const node = container.querySelector('.head-line');
  if (node === null) return null;
  return (node.textContent ?? '').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
}

beforeEach(async () => {
  resetSeq();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  await mount(page());
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('§11.1 — the connection word, per status and per failed attempt', () => {
  const writing = (): ClientState =>
    apply(apply(base(), 'pass:accepted', accepted).state, 'pass:stage', stage('drafting')).state;

  it('says nothing while connecting — the handshake is not a lost connection', async () => {
    await mount(writing(), { connection: { status: 'connecting', attempts: 0 } });
    expect(text()).toBeNull();
    expect(container.textContent).not.toContain('связи нет');
    expect(container.querySelector('.head-line')).toBeNull();
  });

  it('says nothing after one failed attempt, and связи нет from the second', async () => {
    // The first failure is a moment (the first retry is 0.5 s): the state line is not shown
    // either, because a state derived from a dead socket would be a stale claim.
    await mount(writing(), { connection: { status: 'closed', attempts: 1 } });
    expect(text()).toBeNull();
    await mount(writing(), { connection: { status: 'closed', attempts: 2 } });
    expect(text()).toBe('связи нет');
    expect(container.querySelector('.head-line')?.getAttribute('data-kind')).toBe('offline');
    expect(container.querySelector('.head-line a')).toBeNull();
    await mount(writing(), { connection: { status: 'closed', attempts: 3 } });
    expect(text()).toBe('связи нет');
  });

  it('names the retry from the fourth attempt', async () => {
    for (const attempts of [4, 5, 6]) {
      await mount(writing(), { connection: { status: 'closed', attempts } });
      expect(text()).toBe('связи нет · пробуем снова');
    }
  });

  it('gives the full hall its own word, never «связи нет»', async () => {
    await mount(writing(), { connection: { status: 'capacity', attempts: 0 } });
    expect(text()).toBe('мест нет · ждём места');
    expect(container.querySelector('.head-line')?.getAttribute('data-kind')).toBe('capacity');
    expect(container.querySelector('.head-line a')).toBeNull();
    expect(container.textContent).not.toContain('связи нет');
  });

  it('lets the state line speak again the moment the socket opens', async () => {
    await mount(writing(), { connection: { status: 'closed', attempts: 6 } });
    expect(text()).toBe('связи нет · пробуем снова');
    await mount(writing(), { connection: { status: 'open', attempts: 0 } });
    expect(text()).toBe('машина пишет главу 1 · правка 012 · попытка 1 из 5 · 17:04');
  });
});

describe('§3.3 — the reconnect resyncs the head, and it is not stale', () => {
  // 17:08, the gate round's own moment: the frame's clock, not the test's.
  const ROUND = Date.parse('2026-10-29T14:08:00Z');

  /** The three frames the page missed while the socket was down, as the new `hello` carries them. */
  const HEALED: HelloPayload = {
    connId: 'c2',
    protocolVersion: 4,
    serverTime: new Date(ROUND).toISOString(),
    limits: { commentsPerHour: 5, maxCommentChars: 1_200, maxEditChars: 800, queueSoftCap: 50, maxConnections: 500, perIp: 8, editSubmissionsPerDay: 3, maxWave: 2 },
    viewer: { signedIn: false, displayName: null },
    composer: EMPTY_COMPOSER,
    front: { title: 'Бланк', about: null, rev: 1, imprint: { author: 'А', copyright: '© А' }, authors: { count: 1, measuredAt: new Date(ROUND).toISOString() } },
    catalog: CATALOG,
    state: STATE,
    live: {
      ...LIVE,
      at: new Date(ROUND).toISOString(),
      // 2 — the pass reached its gate round.
      passes: [
        {
          chapter: 1,
          passId: 'stp_1',
          changeId: 'chg_12',
          lane: 'forward',
          stage: 'verdict',
          stageSeq: 4,
          since: ROUND,
          deadlineAt: ROUND + STAGE_DEADLINE_MS,
          attempt: 1,
          maxAttempts: 5,
          gate: 'editor',
          round: 1,
        },
      ],
      // 3 — a write landed.
      applied: { n: 1, rev: 13, appliedAt: ROUND - 2 * MINUTE, patch: applied.patch, patchTruncated: false, span: applied.span },
      // 1 — the viewer's filing was decided.
      filings: [{ commentId: 'cmt_012', chapter: 1, state: 'applied', attempts: 1, attemptsLeft: 3, changeId: 'chg_12', at: new Date(ROUND).toISOString() }],
      queue: { depth: 0, pending: [] },
    },
    currentChapter: null,
    comments: { open: 0 },
  };

  it('shows the healed state on the first frame after the socket opens', async () => {
    const stale = apply(apply(base(), 'pass:accepted', accepted).state, 'pass:stage', stage('drafting')).state;
    await mount(stale, { nowMs: ROUND, connection: { status: 'closed', attempts: 4 } });
    expect(text()).toBe('связи нет · пробуем снова');

    // The socket is back: one `hello` is the whole repair — the page applies it, the head
    // re-derives on that render, and no timer is involved (the harness proves the second).
    const healed = applyFrame(stale, { v: 1, type: 'hello', seq: 1, ts: new Date(ROUND).toISOString(), data: HEALED } as never).state;
    await mount(healed, { nowMs: ROUND, connection: { status: 'open', attempts: 0 } });

    expect(text()).toBe('машина проверяет главу 1 · правка 012 · редактор, раунд 1 · 17:08');
    expect(container.textContent).not.toContain('связи нет');
    // Not stale: the writing state the dead socket left behind is gone, and so is the wait.
    expect(text()).not.toContain('пишет главу 1');
    // The write the page missed is in the page's own state, read from the one snapshot.
    expect(healed.applied?.rev).toBe(13);
    // And a re-delivery of the same write is the same state object: no second apply, no reprint.
    const again = applyFrame(healed, { v: 1, type: 'chapter:applied', seq: 2, ts: new Date(ROUND).toISOString(), data: applied } as never);
    expect(again.state).toBe(healed);
  });
});

