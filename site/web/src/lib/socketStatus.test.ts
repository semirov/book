import { describe, expect, it } from 'vitest';

import {
  connectionAfter,
  connectionWordOf,
  FIRST_CONNECTION,
  type ConnectionState,
} from './socketStatus.ts';

/**
 * BOOK-DOC-84 §11.1 — **the head's honesty about the socket**, as a matrix.
 *
 * The defect this file exists for: every status that was not `open` read `связи нет`, so the
 * handshake a healthy page starts with and a full hall's refusal were both called a lost
 * connection. Each row below is one of the owner's cases, and the counter's reset is asserted
 * where it happens (`connectionAfter`), not inferred from a word.
 */

const closed = (attempts: number): ConnectionState => ({ status: 'closed', attempts });

describe('§11.1 — the status matrix, one word per state', () => {
  it('says nothing while connecting: the page has nothing true to say yet', () => {
    for (const attempts of [0, 1, 3, 6]) {
      expect(connectionWordOf({ status: 'connecting', attempts })).toBeNull();
    }
  });

  it('says nothing when open: the state line is the fact, or the head is empty', () => {
    expect(connectionWordOf({ status: 'open', attempts: 0 })).toBeNull();
    // A count left over from an outage is not a word: an open socket has reset it anyway.
    expect(connectionWordOf({ status: 'open', attempts: 6 })).toBeNull();
  });

  it('holds its tongue through the first failure, then says связи нет', () => {
    expect(connectionWordOf(closed(0))).toBeNull();
    expect(connectionWordOf(closed(1))).toBeNull();
    expect(connectionWordOf(closed(2))).toEqual({ kind: 'offline', text: 'связи нет' });
    expect(connectionWordOf(closed(3))).toEqual({ kind: 'offline', text: 'связи нет' });
  });

  it('names the retry from the fourth attempt, and never adds a machine noun', () => {
    expect(connectionWordOf(closed(4))).toEqual({ kind: 'offline', text: 'связи нет · пробуем снова' });
    expect(connectionWordOf(closed(5))).toEqual({ kind: 'offline', text: 'связи нет · пробуем снова' });
    expect(connectionWordOf(closed(6))).toEqual({ kind: 'offline', text: 'связи нет · пробуем снова' });
    for (const text of [connectionWordOf(closed(2))?.text, connectionWordOf(closed(4))?.text]) {
      expect(text ?? '').not.toMatch(/сокет|модель|лейн|очередь/iu);
    }
  });

  it('gives the full hall its own word, at any count', () => {
    // 1013 is a refusal with a live hub behind it: the page is not offline and must not say so.
    expect(connectionWordOf({ status: 'capacity', attempts: 0 })).toEqual({
      kind: 'capacity',
      text: 'мест нет · ждём места',
    });
    expect(connectionWordOf({ status: 'capacity', attempts: 6 })).toEqual({
      kind: 'capacity',
      text: 'мест нет · ждём места',
    });
    expect(connectionWordOf({ status: 'capacity', attempts: 6 })?.text).not.toContain('связи нет');
  });

  it('treats a count that is not a number as the first attempt: no invented outage', () => {
    for (const attempts of [Number.NaN, Number.POSITIVE_INFINITY, -3, 1.9]) {
      expect(connectionWordOf(closed(attempts))?.kind ?? null).not.toBe('offline');
    }
  });
});

describe('§11.1 — the counter is consecutive failures, and an open resets it', () => {
  it('counts 1..6 through a single outage, keeping the count across `connecting`', () => {
    let state = FIRST_CONNECTION;
    const seen: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      state = connectionAfter(state, 'closed', { attempt });
      seen.push(state.attempts);
      // The socket reports `connecting` before each attempt; the count survives it.
      state = connectionAfter(state, 'connecting');
      expect(state.attempts).toBe(attempt);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.status).toBe('connecting');
  });

  it('resets the moment the socket opens — the word goes back to nothing at attempt 1', () => {
    let state: ConnectionState = FIRST_CONNECTION;
    for (let attempt = 1; attempt <= 6; attempt += 1) state = connectionAfter(state, 'closed', { attempt });
    expect(connectionWordOf(state)?.text).toBe('связи нет · пробуем снова');

    state = connectionAfter(state, 'open');
    expect(state).toEqual({ status: 'open', attempts: 0 });

    // The next outage starts over: one failure says nothing, two say the word again.
    state = connectionAfter(state, 'closed', { attempt: 1 });
    expect(connectionWordOf(state)).toBeNull();
    state = connectionAfter(state, 'closed', { attempt: 2 });
    expect(connectionWordOf(state)?.text).toBe('связи нет');
  });

  it('does not count the same attempt twice when the socket reports it twice', () => {
    // `BookSocket` reports `closed` once from a factory that threw and again from the reconnect
    // that follows it; a repeated report is the same failure, never a second one.
    let state = connectionAfter(FIRST_CONNECTION, 'closed');
    expect(state).toEqual({ status: 'closed', attempts: 0 });
    state = connectionAfter(state, 'closed', { attempt: 1 });
    expect(state.attempts).toBe(1);
    state = connectionAfter(state, 'closed', { attempt: 1 });
    expect(state.attempts).toBe(1);
    expect(connectionWordOf(state)).toBeNull();
  });

  it('clears the streak on a seat refusal: the hub answered, so it is alive', () => {
    let state = FIRST_CONNECTION;
    for (let attempt = 1; attempt <= 5; attempt += 1) state = connectionAfter(state, 'closed', { attempt });
    state = connectionAfter(state, 'capacity', { closeCode: 1013 });
    expect(state.attempts).toBe(0);
    expect(connectionWordOf(state)?.kind).toBe('capacity');
  });
});
