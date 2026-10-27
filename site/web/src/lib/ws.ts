/**
 * The reader's socket (ARCHITECTURE.md §10.4): connect, dispatch, heal.
 *
 * Reconnect is exponential, 0.5 s → 15 s with ±20 % jitter, reset by a successful
 * `hello`. A `1013` close is not a stop any more: the hub is full and the seat frees on its
 * own, so the socket waits with its own slow cadence (`capacityDelay`, BOOK-75) and reports
 * `'capacity'` while it waits — the plate takes no click.
 *
 * The transport is injected so the reconnect rules can be tested without a browser.
 */

import type { Envelope } from '@book/shared';

import { capacityDelay } from './capacity.ts';

export type SocketStatus = 'connecting' | 'open' | 'closed' | 'capacity';

export type SocketInfo = { closeCode?: number; attempt?: number };

export type BookSocketHandlers = {
  onEvent: (event: Envelope) => void;
  onStatus?: (status: SocketStatus, info?: SocketInfo) => void;
  /** A gap in `seq` (or a reconnect) means the client should resynchronise from REST. */
  onGap?: () => void;
};

export type WebSocketLike = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type SocketFactory = (url: string) => WebSocketLike;
export type Scheduler = (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;

const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

/** 0.5 s, 1 s, 2 s … capped at 15 s, jittered ±20 %. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(6, Math.trunc(attempt)));
  const base = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** exponent);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(base * jitter);
}

/** `/ws` on the same origin, `wss:` under HTTPS. */
export function websocketUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class BookSocket {
  private socket: WebSocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** The full hall's own counter: a queue, not a failure, so it never feeds the 15 s backoff. */
  private capacityAttempt = 0;
  /** True from a `1013` until the next socket opens; `open()` stays quiet while it is set. */
  private waiting = false;
  private lastSeq = 0;
  private stopped = true;

  constructor(
    private readonly url: string,
    private readonly handlers: BookSocketHandlers,
    private readonly factory: SocketFactory = (target) => new WebSocket(target) as unknown as WebSocketLike,
    private readonly schedule: Scheduler = setTimeout,
    private readonly random: () => number = Math.random,
  ) {}

  get status(): SocketStatus {
    if (this.socket === null) return 'closed';
    return this.socket.readyState === 1 ? 'open' : 'connecting';
  }

  connect(): void {
    this.stopped = false;
    this.attempt = 0;
    this.capacityAttempt = 0;
    this.waiting = false;
    this.open();
  }

  /** One attempt on demand; the same cadence applies after it. */
  retry(): void {
    this.connect();
  }

  close(): void {
    this.stopped = true;
    this.waiting = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close(1000, 'CLIENT_CLOSE');
    this.socket = null;
  }

  sendPing(t = Date.now()): void {
    if (this.socket === null || this.socket.readyState !== 1) return;
    this.socket.send(JSON.stringify({ type: 'ping', data: { t } }));
  }

  private open(): void {
    if (this.stopped) return;
    // A capacity attempt must not flicker the plate back to the connection-lost status: the
    // status stays `'capacity'` until this socket opens (or fails for another reason).
    if (!this.waiting) this.handlers.onStatus?.('connecting');
    let socket: WebSocketLike;
    try {
      socket = this.factory(this.url);
    } catch {
      this.waiting = false;
      this.handlers.onStatus?.('closed');
      this.reconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.waiting = false;
      this.lastSeq = 0;
      this.handlers.onStatus?.('open');
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = (event) => {
      this.socket = null;
      if (event.code === 1013) {
        // The hall is full: report the wait and knock again on the capacity cadence.
        this.waiting = true;
        this.handlers.onStatus?.('capacity', { closeCode: event.code });
        this.reconnectCapacity();
        return;
      }
      this.waiting = false;
      this.handlers.onStatus?.('closed', { closeCode: event.code });
      this.reconnect();
    };
    socket.onerror = () => {
      // The close event follows and owns the retry; an error alone is not a second path.
    };
  }

  private receive(data: unknown): void {
    let parsed: unknown = data;
    if (typeof data === 'string') {
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
    } else if (data instanceof ArrayBuffer) {
      try {
        parsed = JSON.parse(new TextDecoder().decode(data));
      } catch {
        return;
      }
    }
    if (parsed === null || typeof parsed !== 'object') return;
    const envelope = parsed as Partial<Envelope>;
    if (typeof envelope.type !== 'string' || typeof envelope.seq !== 'number') return;

    if (this.lastSeq !== 0 && envelope.seq !== this.lastSeq + 1) this.handlers.onGap?.();
    this.lastSeq = envelope.seq;
    // §10.4: the backoff resets on a successful hello, not merely on a TCP upgrade — and a
    // reader who has been waiting for a seat starts a fresh queue too.
    if (envelope.type === 'hello') {
      this.attempt = 0;
      this.capacityAttempt = 0;
    }
    this.handlers.onEvent(envelope as Envelope);
  }

  private reconnect(): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    const delay = reconnectDelay(this.attempt, this.random);
    this.attempt += 1;
    this.handlers.onStatus?.('closed', { attempt: this.attempt });
    this.timer = this.schedule(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  /** The full hall's knock: slow, jittered, and it never stops (BOOK-75). */
  private reconnectCapacity(): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    const delay = capacityDelay(this.capacityAttempt, this.random);
    this.capacityAttempt += 1;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.open();
    }, delay);
  }
}
