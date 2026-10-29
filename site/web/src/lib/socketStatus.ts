/**
 * BOOK-DOC-84 §11.1 — **the page's own honesty about the socket**: one mapping from what the
 * connection is doing to the one word the head may print.
 *
 * The head used to read `связи нет` for every status that was not `open` — including
 * `connecting`, which is the handshake every healthy page starts with, and including the full
 * hall (`1013`), which is a refusal with a live hub behind it, not a lost connection. A word
 * that is printed while nothing is wrong is a word readers stop believing, so the mapping is a
 * function here and nothing else decides it:
 *
 *   · `connecting` — no word: the page is asking and has nothing true to say yet;
 *   · `open` — no connection word either: the state line (`lib/nowState.ts`) is the fact, or the
 *     head prints nothing at all when the frames say nothing;
 *   · `closed` — `связи нет` from the **second** consecutive failed attempt, and from the fourth
 *     `связи нет · пробуем снова`. One attempt is a moment (`reconnectDelay` starts at 0.5 s) and
 *     naming a lost connection after a half-second blink is the lie this mapping exists for;
 *   · `capacity` — its own word: the plate's meaning (`CAPACITY_PLATE`), that there are no seats
 *     and the page waits for one. The page is not offline and must not say so.
 *
 * The counter is **consecutive failures since the last open**: `connectionAfter` resets it the
 * moment the socket opens (and on a seat refusal, which is evidence the hub is alive), and a
 * `connecting` between two failed attempts keeps it. `BookSocket` reports the 1-based attempt on
 * every `closed`; the counter never goes back while the socket is down, so a repeated report of
 * the same attempt is not a second failure.
 */

import { CAPACITY_HEAD_WORD, offlineWord } from '@book/shared';

import type { SocketInfo, SocketStatus } from './ws.ts';

export type ConnectionState = {
  status: SocketStatus;
  /** Consecutive failed attempts since the last open; `0` while connected or still booting. */
  attempts: number;
};

/** Where a page stands before its first socket has spoken; also the quiet default of a head. */
export const FIRST_CONNECTION: ConnectionState = { status: 'connecting', attempts: 0 };

/** The head's connection word: what to print, and the `data-kind` it belongs to. */
export type ConnectionWord = { kind: 'offline' | 'capacity'; text: string };

const OPEN: ConnectionState = { status: 'open', attempts: 0 };
const CAPACITY: ConnectionState = { status: 'capacity', attempts: 0 };

/**
 * The next connection state, from the socket's own report. Pure: the page hands it to a React
 * state updater, and a re-delivered report produces the same state.
 */
export function connectionAfter(
  current: ConnectionState,
  status: SocketStatus,
  info?: SocketInfo,
): ConnectionState {
  if (status === 'open') return OPEN;
  if (status === 'capacity') return CAPACITY;
  if (status === 'closed') {
    // A bare `closed` (the factory threw before a socket existed) carries no attempt: it is the
    // same failure the reconnect's own report names, never a second one.
    const reported = info?.attempt;
    const attempts = typeof reported === 'number' ? Math.max(current.attempts, reported) : current.attempts;
    return { status: 'closed', attempts };
  }
  // `connecting`: the count survives — an attempt in flight is not a healed connection.
  return { status: 'connecting', attempts: current.attempts };
}

/**
 * The one honest status mapping (§11.1). `null` means the head prints no connection word at all:
 * either the page has nothing true to say (`connecting`), or the state line speaks for itself
 * (`open`), or the outage has not outlived a blink yet (`closed` at one attempt).
 */
export function connectionWordOf(connection: ConnectionState): ConnectionWord | null {
  if (connection.status === 'capacity') return { kind: 'capacity', text: CAPACITY_HEAD_WORD };
  if (connection.status !== 'closed') return null;
  const text = offlineWord(connection.attempts);
  return text === null ? null : { kind: 'offline', text };
}
