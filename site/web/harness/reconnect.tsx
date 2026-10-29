import {
  STAGE_DEADLINE_MS,
  type ChapterAppliedPayload,
  type HelloPayload,
  type LivePass,
  type LivePayload,
} from '@book/shared';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { Header } from '../src/components/Header.tsx';
import { initialClientState, type ClientState } from '../src/lib/clientState.ts';
import { EMPTY_COMPOSER } from '../src/lib/composer.ts';
import { applyFrame } from '../src/lib/frames.ts';
import { BOOK } from '../src/lib/framesFixtures.ts';
import { connectionAfter, FIRST_CONNECTION, type ConnectionState } from '../src/lib/socketStatus.ts';
import { BookSocket, websocketUrl, type SocketStatus } from '../src/lib/ws.ts';

import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/chrome.css';
import '../src/styles/running-head.css';
import '../src/styles/head-status.css';
import '../src/styles/book.css';
import '../src/styles/live.css';

/**
 * BOOK-DOC-84 §11.1 — the reconnect harness: the real socket, the real fold, the real head.
 *
 * It is not a second client. `BookSocket` owns the reconnect (0.5 s → 15 s, jittered), `applyFrame`
 * folds every frame, `connectionAfter` counts the consecutive failures and `HeadLine` prints the
 * one word `connectionWordOf` names. The hub (`scripts/lib/wsHub.mjs`) is the only thing this page
 * does not share with the site: it is the server side, and the script closes it.
 *
 * The two payloads are the harness's own facts and they are posted to the hub before the socket
 * connects, so the hello the page receives is byte for byte the one this file typed:
 *
 *   · `before` — a filing is queued and a pass is writing chapter 3 (`машина пишет главу 3`);
 *   · `after` — the three frames the outage hid: the change was decided, the pass reached its
 *     gate round, and a write landed (§3.3: the hello *is* the snapshot).
 *
 * `window.__reconnect` answers the script: the committed timeline (every status, the delay since
 * the previous word, the word the DOM actually shows), the page's own facts, and the moment the
 * recovering hello arrived, so the script can measure the second the state line needs.
 */

/** 17:04 in Moscow — the contract's example time, the fixtures' own moment. */
const T = Date.parse('2026-10-29T14:04:00Z');
const MINUTE = 60_000;

const pass = (overrides: Partial<LivePass> = {}): LivePass => ({
  chapter: 3,
  passId: 'stp_1',
  changeId: 'chg_2',
  lane: 'forward',
  stage: 'drafting',
  stageSeq: 3,
  since: T,
  deadlineAt: T + 225 * MINUTE,
  attempt: 1,
  maxAttempts: 5,
  ...overrides,
});

const BEFORE: LivePayload = {
  at: new Date(T).toISOString(),
  passes: [pass()],
  applied: null,
  queue: { depth: 1, pending: [{ id: 'chg_2', chapter: 3, seq: 2, ahead: 0, kind: 'edit', enqueuedAt: new Date(T).toISOString() }] },
  filings: [
    { commentId: 'cmt_1', chapter: 3, state: 'accepted', attempts: 1, attemptsLeft: 2, changeId: 'chg_2', at: new Date(T).toISOString() },
  ],
  lane: { passesToday: 2, maxPasses: 4, writerAt: new Date(T).toISOString() },
};

/** The write the outage hid, and the round that started after it. */
const WRITE: Pick<ChapterAppliedPayload, 'n' | 'rev' | 'appliedAt' | 'patch' | 'patchTruncated' | 'span'> = {
  n: 3,
  rev: 13,
  appliedAt: T + 2 * MINUTE,
  patch: [{ op: 'replace', id: 'ch03#a', i: 0, newId: 'ch03#b', text: 'Новый абзац' }],
  patchTruncated: false,
  span: [{ blockId: 'ch03#a', before: 'Старый абзац', after: 'Новый абзац', truncated: false }],
};

const AFTER: LivePayload = {
  at: new Date(T + 5 * MINUTE).toISOString(),
  passes: [
    pass({
      stage: 'verdict',
      stageSeq: 4,
      since: T + 4 * MINUTE,
      deadlineAt: T + 4 * MINUTE + STAGE_DEADLINE_MS,
      gate: 'editor',
      round: 1,
    }),
  ],
  applied: WRITE,
  queue: { depth: 0, pending: [] },
  filings: [
    { commentId: 'cmt_1', chapter: 3, state: 'applied', attempts: 1, attemptsLeft: 2, changeId: 'chg_2', at: new Date(T + 2 * MINUTE).toISOString() },
  ],
  lane: { passesToday: 3, maxPasses: 4, writerAt: null },
};

function helloOf(live: LivePayload): HelloPayload {
  return {
    connId: `c${live.at}`,
    protocolVersion: 4,
    serverTime: live.at,
    limits: { commentsPerHour: 5, maxCommentChars: 1_200, maxEditChars: 800, queueSoftCap: 50, maxConnections: 500, perIp: 8, editSubmissionsPerDay: 3, maxWave: 2 },
    viewer: { signedIn: false, displayName: null },
    composer: EMPTY_COMPOSER,
    front: {
      title: 'Бланк',
      about: null,
      rev: 1,
      imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
      authors: { count: 1, measuredAt: live.at },
    },
    catalog: BOOK.catalog,
    state: BOOK.state,
    live,
    currentChapter: null,
    comments: { open: 0 },
  };
}

/**
 * One row of the record: what the socket said, when, and the word the DOM showed **after that
 * commit**. The time is the event's own (`performance.now()` in the callback), never the moment
 * of a React effect: an effect runs after the next status has already arrived, and its clock
 * would show six retries one millisecond apart.
 */
type Row = {
  status: SocketStatus;
  attempts: number;
  /** ms since the page started, at the event. */
  at: number;
  /** ms since the previous row (usually the `connecting` a millisecond before this failure). */
  sinceRowMs: number;
  /** The head's line as committed, or `''` when the head prints nothing. */
  word: string;
  /** Only on a recovering hello: ms from the socket's `open` to this committed word. */
  helloAfterMs: number | null;
};

const rows: Row[] = [];
const probe = {
  page: initialClientState() as ClientState,
  connection: FIRST_CONNECTION as ConnectionState,
  hellos: 0,
  error: null as string | null,
  statuses: [] as string[],
  events: [] as string[],
  failure: null as string | null,
};

/** The head's line as the browser paints it — never a string this file composed. */
const wordOf = (): string => {
  const node = document.querySelector('.head-line');
  return (node?.textContent ?? '').replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim();
};

const params = new URLSearchParams(window.location.search);
const hubHttp = params.get('hubHttp') ?? window.location.origin;
const hubWss = params.get('hub') ?? websocketUrl(window.location.origin);

const mount = document.getElementById('mount');
if (mount === null) throw new Error('the harness has no mount');
const root = createRoot(mount);

const started = performance.now();

function Harness() {
  const [page, setPage] = useState<ClientState>(() => initialClientState());
  const [connection, setConnection] = useState<ConnectionState>(FIRST_CONNECTION);
  const openAt = useRef<number | null>(null);

  /** One row, after the commit: the DOM is the reader's line, not this file's guess. */
  const record = (at: number, helloAfterMs: number | null = null): void => {
    const last = rows.at(-1);
    rows.push({
      status: probe.connection.status,
      attempts: probe.connection.attempts,
      at: Math.round(at - started),
      sinceRowMs: Math.round(at - (last === undefined ? started : started + last.at)),
      word: wordOf(),
      helloAfterMs,
    });
  };

  useEffect(() => {
    const socket = new BookSocket(hubWss, {
      onEvent: (event) => {
        probe.events.push(event.type);
        let next: ClientState;
        try {
          next = applyFrame(probe.page, event).state;
        } catch (error) {
          probe.failure = error instanceof Error ? error.message : String(error);
          throw error;
        }
        probe.page = next;
        const at = performance.now();
        // The commit is synchronous, so the word recorded below is the one this frame painted.
        flushSync(() => setPage(next));
        if (event.type === 'hello') {
          probe.hellos += 1;
          record(at, openAt.current === null ? null : Math.round(at - openAt.current));
        }
      },
      onStatus: (status, info) => {
        probe.statuses.push(`${status}${info?.attempt === undefined ? '' : `:${String(info.attempt)}`}`);
        const at = performance.now();
        const next = connectionAfter(probe.connection, status, info);
        probe.connection = next;
        if (status === 'open') openAt.current = at;
        flushSync(() => setConnection(next));
        record(at);
      },
    });
    // The page owns the payloads: the hub relays whichever one it holds. A refused post is not a
    // silent no-op: it is `window.__reconnect.error()`, and the script fails on it.
    void (async () => {
      try {
        const answer = await fetch(`${hubHttp}/fixtures`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ before: helloOf(BEFORE), after: helloOf(AFTER) }),
        });
        if (!answer.ok) throw new Error(`the hub refused the fixtures: ${String(answer.status)}`);
        socket.connect();
      } catch (error) {
        probe.error = error instanceof Error ? error.message : String(error);
      }
    })();
    return () => socket.close();
  }, []);

  return (
    <Header
      state={BOOK.state}
      ribbon={null}
      catalog={BOOK.catalog}
      markers={[]}
      onOpenChange={() => undefined}
      live={false}
      client={page}
      connection={connection}
      reading={{ n: 3, page: 1 }}
    />
  );
}

root.render(<Harness />);

declare global {
  interface Window {
    __reconnect: {
      ready: () => boolean;
      error: () => string | null;
      statuses: () => string[];
      events: () => string[];
      failure: () => string | null;
      timeline: () => Row[];
      word: () => string;
      state: () => {
        stage: string | null;
        stageSeq: number | null;
        appliedRev: number | null;
        filingState: string | null;
        queue: number;
        hellos: number;
        status: SocketStatus;
        attempts: number;
      };
    };
  }
}

window.__reconnect = {
  ready: () => document.querySelector('.top-row') !== null && document.querySelector('#first') !== null,
  error: () => probe.error,
  statuses: () => [...probe.statuses],
  events: () => [...probe.events],
  failure: () => probe.failure,
  timeline: () => rows.map((row) => ({ ...row })),
  word: () => wordOf(),
  state: () => {
    const client = probe.page;
    const stage = client.stages[3]?.at(-1) ?? null;
    return {
      stage: stage?.stage ?? null,
      stageSeq: stage?.stageSeq ?? null,
      appliedRev: client.applied?.rev ?? null,
      filingState: client.filings[0]?.state ?? null,
      queue: client.queue.length,
      hellos: probe.hellos,
      status: probe.connection.status,
      attempts: probe.connection.attempts,
    };
  },
};
