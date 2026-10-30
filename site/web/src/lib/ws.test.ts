import type { Envelope } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { capacityDelay } from './capacity.ts';
import { BookSocket, reconnectDelay, websocketUrl, type Scheduler, type WebSocketLike } from './ws.ts';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const delays: number[] = [];
  const scheduled: Array<() => void> = [];
  const events: Envelope[] = [];
  const statuses: string[] = [];
  let gaps = 0;

  const schedule: Scheduler = (callback, delay) => {
    delays.push(delay);
    scheduled.push(callback);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  };

  const socket = new BookSocket(
    'ws://example.test/ws',
    {
      onEvent: (event) => events.push(event),
      onStatus: (status) => statuses.push(status),
      onGap: () => {
        gaps += 1;
      },
    },
    () => {
      const next = new FakeSocket();
      sockets.push(next);
      return next;
    },
    schedule,
    () => 0.5,
  );

  return {
    socket,
    sockets,
    delays,
    scheduled,
    events,
    statuses,
    gaps: () => gaps,
  };
}

describe('reconnectDelay', () => {
  it('starts at 0.5 s and doubles', () => {
    const noJitter = () => 0.5;
    expect(reconnectDelay(0, noJitter)).toBe(500);
    expect(reconnectDelay(1, noJitter)).toBe(1_000);
    expect(reconnectDelay(2, noJitter)).toBe(2_000);
    expect(reconnectDelay(3, noJitter)).toBe(4_000);
  });

  it('caps at 15 s and jitters ±20 %', () => {
    expect(reconnectDelay(9, () => 1)).toBe(18_000);
    expect(reconnectDelay(20, () => 0)).toBe(12_000);
    for (const value of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = reconnectDelay(4, () => value);
      expect(delay).toBeGreaterThanOrEqual(6_400);
      expect(delay).toBeLessThanOrEqual(9_600);
    }
  });

  it('treats a negative attempt as the first one', () => {
    expect(reconnectDelay(-3, () => 0.5)).toBe(500);
  });
});

describe('capacityDelay', () => {
  it('waits 16–24 s on the first knock — far longer than the ordinary backoff', () => {
    expect(capacityDelay(0, () => 0)).toBe(16_000);
    expect(capacityDelay(0, () => 0.5)).toBe(20_000);
    expect(capacityDelay(0, () => 1)).toBe(24_000);
  });

  it('grows once, then holds a 30 s base, and stays jittered at both ends', () => {
    expect(capacityDelay(1, () => 0.5)).toBe(30_000);
    expect(capacityDelay(9, () => 0.5)).toBe(30_000);
    expect(capacityDelay(9, () => 0)).toBe(24_000);
    expect(capacityDelay(9, () => 1)).toBe(36_000);
    // A negative attempt is the first one, like `reconnectDelay`.
    expect(capacityDelay(-3, () => 0.5)).toBe(20_000);
  });

  it('jitters ±20 % around the base', () => {
    expect(capacityDelay(0, () => 0.25)).toBe(18_000);
    expect(capacityDelay(0, () => 0.75)).toBe(22_000);
  });
});

describe('websocketUrl', () => {
  it('points at /ws on the same origin, wss under https', () => {
    expect(websocketUrl('https://book.semirov.dev/some/path?x=1#y')).toBe('wss://book.semirov.dev/ws');
    expect(websocketUrl('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080/ws');
  });
});

describe('BookSocket', () => {
  it('dispatches frames and reports open', () => {
    const rig = setup();
    rig.socket.connect();
    expect(rig.sockets).toHaveLength(1);
    expect(rig.statuses).toEqual(['connecting']);

    rig.sockets[0]!.open();
    expect(rig.statuses).toEqual(['connecting', 'open']);
    rig.sockets[0]!.deliver({ v: 1, type: 'hello', seq: 1, ts: '', data: {} });
    expect(rig.events).toHaveLength(1);
    expect(rig.events[0]?.type).toBe('hello');
  });

  it('detects a sequence gap and asks for a resync', () => {
    const rig = setup();
    rig.socket.connect();
    const socket = rig.sockets[0]!;
    socket.open();
    socket.deliver({ v: 1, type: 'hello', seq: 1, ts: '', data: {} });
    socket.deliver({ v: 1, type: 'state:updated', seq: 2, ts: '', data: {} });
    expect(rig.gaps()).toBe(0);
    socket.deliver({ v: 1, type: 'state:updated', seq: 8, ts: '', data: {} });
    expect(rig.gaps()).toBe(1);
    expect(rig.events).toHaveLength(3);
  });

  it('ignores malformed frames instead of crashing the page', () => {
    const rig = setup();
    rig.socket.connect();
    const socket = rig.sockets[0]!;
    socket.open();
    socket.deliver('not json');
    socket.deliver({ nope: true });
    socket.deliver(null);
    expect(rig.events).toHaveLength(0);
    expect(rig.gaps()).toBe(0);
  });

  it('reconnects with exponential backoff after a normal close', () => {
    const rig = setup();
    rig.socket.connect();
    const first = rig.sockets[0]!;
    first.open();
    first.serverClose(1006);
    expect(rig.delays).toEqual([500]);
    expect(rig.statuses).toContain('closed');

    rig.scheduled[0]!();
    expect(rig.sockets).toHaveLength(2);
    rig.sockets[1]!.open();
    rig.sockets[1]!.serverClose(1006);
    expect(rig.delays[1]).toBe(1_000);
  });

  it('waits out a 1013 on its own cadence instead of stopping', () => {
    const rig = setup();
    rig.socket.connect();
    rig.sockets[0]!.open();
    rig.sockets[0]!.serverClose(1013, 'CAPACITY');

    expect(rig.statuses.at(-1)).toBe('capacity');
    // One knock, slow: not the ordinary 500 ms backoff, and inside the queue's own range.
    expect(rig.delays).toHaveLength(1);
    expect(rig.delays[0]).toBeGreaterThanOrEqual(16_000);
    expect(rig.delays[0]).toBeLessThanOrEqual(30_000);

    // The wait itself knocks again — no button, no reload — while the reported status stays
    // `'capacity'`: the plate must not flicker back to the connection-lost line.
    rig.scheduled[0]!();
    expect(rig.sockets).toHaveLength(2);
    expect(rig.statuses.at(-1)).toBe('capacity');
    expect(rig.statuses.filter((status) => status === 'connecting')).toHaveLength(1);

    // A seat freed: the socket opens and the plate goes away.
    rig.sockets[1]!.open();
    expect(rig.statuses.at(-1)).toBe('open');

    // `hello` resets the queue: a refusal after it waits 20 s again, not the grown 30 s.
    rig.sockets[1]!.deliver({ v: 1, type: 'hello', seq: 1, ts: '', data: {} });
    rig.sockets[1]!.serverClose(1013, 'CAPACITY');
    expect(rig.delays[1]).toBe(20_000);

    rig.scheduled[1]!();
    rig.sockets[2]!.open();
    rig.sockets[2]!.deliver({ v: 1, type: 'hello', seq: 1, ts: '', data: {} });
    rig.sockets[2]!.serverClose(1006);
    // Back on the ordinary backoff, from attempt 0: the full hall did not inflate it.
    expect(rig.delays[2]).toBe(500);
  });

  it('closes cleanly and stops reconnecting', () => {
    const rig = setup();
    rig.socket.connect();
    rig.sockets[0]!.open();
    rig.socket.close();
    expect(rig.sockets[0]!.closed[0]).toEqual({ code: 1000, reason: 'CLIENT_CLOSE' });
    expect(rig.delays).toEqual([]);
  });

  it('schedules its own wait with no receiver: the default timer is a wrapper, not `window.setTimeout`', () => {
    // A browser's `setTimeout` is a method of `window`: calling it as `this.schedule(…)` throws
    // «Illegal invocation» and the first close would end the reconnect for good (the phone's
    // head that never healed). The default is a plain function, so it is called with no receiver.
    const real = globalThis.setTimeout;
    const calls: number[] = [];
    const stub = function (this: unknown, callback: () => void, delayMs?: number): unknown {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push(delayMs ?? 0);
      return real(callback, delayMs);
    };
    (globalThis as { setTimeout: unknown }).setTimeout = stub;
    try {
      const sockets: FakeSocket[] = [];
      // No scheduler handed in: the class's own default is the one under test.
      const socket = new BookSocket(
        'ws://example.test/ws',
        { onEvent: () => undefined, onStatus: () => undefined },
        () => {
          const next = new FakeSocket();
          sockets.push(next);
          return next;
        },
        undefined,
        () => 0.5,
      );
      socket.connect();
      sockets[0]!.serverClose(1006);
      // The wait was scheduled (0.5 s × 1.0, the jitter of `() => 0.5`), not thrown away.
      expect(calls).toEqual([500]);
      socket.close();
    } finally {
      (globalThis as { setTimeout: unknown }).setTimeout = real;
    }
  });

  it('sends a ping only on an open socket', () => {
    const rig = setup();
    rig.socket.sendPing(5);
    rig.socket.connect();
    rig.socket.sendPing(6);
    rig.sockets[0]!.open();
    rig.socket.sendPing(7);
    expect(rig.sockets[0]!.sent).toEqual([JSON.stringify({ type: 'ping', data: { t: 7 } })]);
  });
});
