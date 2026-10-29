/**
 * The WebSocket hub (ARCHITECTURE.md §10): a read-only fan-out for readers.
 *
 * 100 connections hard, 20 per network (§10.1): over either cap the newcomer is refused with
 * `1013 CAPACITY` and shown the plate; an open seat is never taken from a reader. One envelope,
 * a per-connection `seq`; a chapter body is never framed (ADR-004). A slow client loses only a
 * snapshot, and a transition over the bound closes it `1011 SLOW` (BOOK-DOC-84 §3.4).
 *
 * The hub owns no transport setup: `app.ts` registers `@fastify/websocket` and calls `attach`
 * for `/ws`, which keeps the protocol testable with `app.injectWS`.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyRequest } from 'fastify';
import { WebSocket, type RawData } from 'ws';

import {
  COMMENT_MAX_CHARS,
  COMMENT_MIN_CHARS,
  EDIT_MAX_CHARS,
  ENVELOPE_VERSION,
  PROTOCOL_VERSION,
  type AuthorsCountDto,
  type ComposerInfo,
  type Envelope,
  type HelloPayload,
  type ServerEventType,
  type StateChangeReason,
  type StateSnapshotPayload,
  type LivePayload,
  type ViewerDto,
} from '@book/shared';

import { createAuthorsCount } from '../authors/count.ts';
import { liveSnapshot, type LiveDeps } from './live.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { listCatalog } from '../db/repo/chapters.ts';
import type { Imprint } from '@book/shared';
import type { StateService } from '../ingest/stateService.ts';
import { toIso } from '../util/time.ts';
import { clientIp, connectionKey, type HeaderBag } from '../util/ip.ts';

export type WsHubOptions = {
  db: Db;
  state: StateService;
  config: Config;
  imprint: Imprint;
  now?: () => Date;
  idFactory?: () => string;
  maxConnections?: number;
  perIp?: number;
  heartbeatMs?: number;
  backpressureBytes?: number;
  /** `state:updated` is coalesced per connection; 1 000 ms in production (§10.3). */
  stateThrottleMs?: number;
  trustedProxies?: string[];
  /**
   * §9: the session cookie resolved at upgrade; anonymous readers stay `false`. BOOK-DOC-84
   * §2.2 — the internal `identityId` rides beside the public DTO so `live.filings` can name the
   * viewer's own rows; it never appears on the wire.
   */
  resolveViewer?: (request: FastifyRequest) => ViewerContext;
  /** The byline count, shared with the HTTP app in production (BOOK-DOC-4). */
  authorsCount?: () => AuthorsCountDto;
  /** BOOK-DOC-84 §2.2: what the `live` block announces about the lane and the queue. */
  liveOptions?: { queueSoftCap?: number; maxPasses?: number };
};

/** The viewer as the hub keeps it: the public DTO plus the internal identity (never sent). */
export type ViewerContext = { viewer: ViewerDto; identityId: string | null };


type Connection = {
  id: string;
  socket: WebSocket;
  ipKey: string;
  seq: number;
  missedPongs: number;
  lastPingAt: number;
  stale: boolean;
  frames: { windowStart: number; count: number };
  pendingState: unknown | null;
  stateTimer: NodeJS.Timeout | null;
  lastStateAt: number;
  /** No frame may precede `hello`; broadcasts during the upgrade tick are dropped. */
  helloPending: boolean;
  viewer: ViewerDto;
  /** The viewer's own row id, for `live.filings`; `null` for an anonymous reader. */
  identityId: string | null;
};

const INBOUND_MAX_BYTES = 4_096;
const INBOUND_MAX_PER_MINUTE = 5;
const DEFAULT_BACKPRESSURE_BYTES = 256 * 1024;
/** BOOK-DOC-84 §3.4 — what a slow client may lose; every other frame is a transition. */

const COALESCIBLE_FRAMES = new Set<ServerEventType>(['state:updated', 'cascade:progress']);

/** 100 seats hard, 20 per network: over either cap the newcomer is refused (§10.1, BOOK-75). */
export class WsHub {
  private readonly conns = new Map<string, Connection>();
  private readonly db: Db;
  private readonly state: StateService;
  private readonly config: Config;
  private readonly imprint: Imprint;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly maxConnections: number;
  private readonly perIp: number;
  private readonly heartbeatMs: number;
  private readonly backpressureBytes: number;
  private readonly stateThrottleMs: number;
  private readonly trustedProxies: string[];
  private readonly resolveViewer: ((request: FastifyRequest) => ViewerContext) | null;
  private readonly liveOptions: { queueSoftCap?: number; maxPasses?: number };
  private readonly authorsCount: () => AuthorsCountDto;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: WsHubOptions) {
    this.db = options.db;
    this.state = options.state;
    this.config = options.config;
    this.imprint = options.imprint;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `ws_${randomUUID()}`);
    this.maxConnections = options.maxConnections ?? options.config.maxWs;
    this.perIp = options.perIp ?? options.config.wsPerIp;
    this.heartbeatMs = options.heartbeatMs ?? options.config.wsHeartbeatMs;
    this.backpressureBytes = options.backpressureBytes ?? DEFAULT_BACKPRESSURE_BYTES;
    this.stateThrottleMs = options.stateThrottleMs ?? 1_000;
    this.trustedProxies = options.trustedProxies ?? options.config.trustedProxies.split(',').map((part) => part.trim());
    this.resolveViewer = options.resolveViewer ?? null;
    this.liveOptions = options.liveOptions ?? {};
    this.authorsCount = options.authorsCount ?? createAuthorsCount(options.db, this.now);
  }

  connectionCount(): number {
    return this.conns.size;
  }

  connectionsFor(ipKey: string): number {
    let count = 0;
    for (const conn of this.conns.values()) if (conn.ipKey === ipKey) count += 1;
    return count;
  }

  /** Attach a freshly upgraded socket. Listeners are registered synchronously (§README). */
  attach(socket: WebSocket, request: FastifyRequest): void {
    const peer = request.socket?.remoteAddress ?? request.ip ?? '';
    const ip = clientIp(request.headers as HeaderBag, peer, this.trustedProxies);
    const key = connectionKey(ip);

    // Over either cap the newcomer is refused before any connection record exists. The
    // refusal path builds nothing, so a waiting reader's retry is cheap (§10.1, BOOK-75).
    if (this.conns.size >= this.maxConnections) {
      this.reject(socket, 'CAPACITY');
      return;
    }
    if (this.connectionsFor(key) >= this.perIp) {
      this.reject(socket, 'CAPACITY');
      return;
    }

    const resolved = this.resolveViewer?.(request) ?? { viewer: { signedIn: false, displayName: null }, identityId: null };
    const conn: Connection = {
      id: this.idFactory(),
      socket,
      ipKey: key,
      seq: 0,
      missedPongs: 0,
      lastPingAt: this.now().getTime(),
      stale: false,
      frames: { windowStart: this.now().getTime(), count: 0 },
      pendingState: null,
      stateTimer: null,
      lastStateAt: 0,
      helloPending: true,
      viewer: resolved.viewer,
      identityId: resolved.identityId,
    };
    this.conns.set(conn.id, conn);

    socket.on('pong', () => {
      conn.missedPongs = 0;
      conn.lastPingAt = this.now().getTime();
    });
    socket.on('message', (data) => this.onMessage(conn, data));
    socket.on('close', () => this.drop(conn));
    socket.on('error', () => this.drop(conn));

    // `hello` is the first frame, but not inside the upgrade callback: `injectWS` (and a
    // real browser) attaches its stream after the handler returns, so an immediate frame
    // can be lost. A tick later it is still the first thing the reader sees.
    setImmediate(() => {
      if (!this.conns.has(conn.id)) return;
      this.send(conn, 'hello', this.helloPayload(conn), true);
      conn.helloPending = false;
    });
    this.ensureTimer();
  }

  /**
   * Fan-out. `state:updated`/`cascade:progress` may be skipped for a slow client (§3.4); every
   * other frame is a transition and is never skipped — a client too slow for it is closed.
   */
  publish(type: Exclude<ServerEventType, 'hello' | 'state:snapshot'>, data: unknown): void {
    for (const conn of this.conns.values()) this.send(conn, type, data, false);
  }

  /**
   * A full snapshot: the heal path with real callers now (BOOK-DOC-84 #2) — a `resync{since}`
   * and the slow-client drain. `since` echoes the request, so a client can name its own gap.
   */
  publishSnapshot(reason: StateChangeReason = 'manual', since?: number): void {
    for (const conn of this.conns.values()) this.sendSnapshot(conn, reason, since);
  }

  /** One connection's snapshot: the one carrier of `live` besides `hello`. */
  private sendSnapshot(conn: Connection, reason: StateChangeReason, since?: number): void {
    if (conn.stateTimer !== null) {
      clearTimeout(conn.stateTimer);
      conn.stateTimer = null;
    }
    conn.pendingState = null;
    conn.stale = false;
    const payload: StateSnapshotPayload = {
      state: this.state.snapshot(),
      live: this.live(conn),
      reason,
      ...(since === undefined ? {} : { since }),
    };
    this.send(conn, 'state:snapshot', payload, true);
  }

  /** BOOK-DOC-84 §2.2 — the one live builder, called by both carriers. */
  private live(conn: Connection): LivePayload {
    const deps: LiveDeps = { db: this.db, dataDir: this.config.dataDir, now: () => this.now().getTime(),
      queueSoftCap: this.liveOptions.queueSoftCap ?? this.config.queueSoftCap,
      maxPasses: this.liveOptions.maxPasses ?? this.config.writerMaxPasses };
    return liveSnapshot(deps, conn.identityId);
  }

  close(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const conn of this.conns.values()) {
      if (conn.stateTimer !== null) clearTimeout(conn.stateTimer);
      try {
        conn.socket.close(1000, 'SERVER_SHUTDOWN');
      } catch {
        /* already closed */
      }
    }
    this.conns.clear();
  }

  /** One heartbeat tick; public so a test can drive it without waiting 30 s. */
  tick(): void {
    const nowMs = this.now().getTime();
    for (const conn of [...this.conns.values()]) {
      this.drain(conn);
      if (nowMs - conn.lastPingAt < this.heartbeatMs) continue;
      if (conn.missedPongs >= 2) {
        this.drop(conn);
        try {
          conn.socket.terminate();
        } catch {
          /* already gone */
        }
        continue;
      }
      conn.missedPongs += 1;
      conn.lastPingAt = nowMs;
      try {
        conn.socket.ping();
      } catch {
        this.drop(conn);
      }
    }
  }

  helloPayload(conn: Connection): HelloPayload {
    const state = this.state.snapshot();
    const catalog = listCatalog(this.db);
    const current = state.current;
    const currentChapter =
      current !== null && current.chapter !== 'front'
        ? {
            n: current.chapter,
            lane: current.lane,
            kind: current.kind,
            title: catalog.find((entry) => entry.n === current.chapter)?.title ?? null,
          }
        : null;
    const composer: ComposerInfo = {
      minChars: COMMENT_MIN_CHARS,
      maxChars: COMMENT_MAX_CHARS,
      editMaxChars: EDIT_MAX_CHARS,
    };

    return {
      connId: conn.id,
      protocolVersion: PROTOCOL_VERSION,
      serverTime: toIso(this.now()),
      limits: {
        commentsPerHour: this.config.commentsPerHour,
        maxCommentChars: COMMENT_MAX_CHARS,
        maxEditChars: EDIT_MAX_CHARS,
        queueSoftCap: this.config.queueSoftCap,
        maxConnections: this.maxConnections,
        perIp: this.perIp,
        editSubmissionsPerDay: this.config.editSubmissionsPerDay,
        maxWave: this.config.budgetMaxWave,
      },
      viewer: conn.viewer,
      composer,
      front: {
        title: state.front.title,
        about: state.front.about,
        rev: state.front.rev,
        imprint: { author: this.imprint.author, copyright: this.imprint.copyright },
        authors: this.authorsCount(),
        // BOOK-126: the footer's gift row survives a reconnect; the value is boot-validated.
        donateUrl: this.config.donateUrl,
      },
      catalog,
      state,
      live: this.live(conn),
      currentChapter,
      comments: { open: this.openComments() },
    };
  }

  /** For tests and the operator: the exact frame a client would receive. */
  buildEnvelope<T extends ServerEventType>(conn: Connection | { seq: number }, type: T, data: unknown): Envelope<T> {
    const next = conn.seq + 1;
    conn.seq = next;
    return { v: ENVELOPE_VERSION, type, seq: next, ts: toIso(this.now()), data };
  }

  private send(
    conn: Connection,
    type: ServerEventType,
    data: unknown,
    force: boolean,
  ): void {
    if (conn.socket.readyState !== WebSocket.OPEN) return;
    if (conn.helloPending && type !== 'hello') return;
    if (!force && type === 'state:updated' && this.stateThrottleMs > 0) {
      this.queueState(conn, data);
      return;
    }
    if (!force) {
      const overBound = conn.socket.bufferedAmount > this.backpressureBytes;
      if (COALESCIBLE_FRAMES.has(type)) {
        // A snapshot or a projection: skipped, and healed by `state:snapshot` on the drain.
        if (conn.stale || overBound) {
          conn.stale = true;
          return;
        }
      } else if (overBound) {
        // A transition is never skipped (§3.4): the reader loses the socket, not the fact, and
        // the reconnect's `hello.live` is the snapshot that heals everything it missed.
        this.closeSlow(conn);
        return;
      }
    }
    try {
      conn.socket.send(JSON.stringify(this.buildEnvelope(conn, type, data)));
    } catch {
      this.drop(conn);
    }
  }

  /** At most one `state:updated` per throttle window; the last payload wins (§10.3). */
  private queueState(conn: Connection, data: unknown): void {
    conn.pendingState = data;
    if (conn.stateTimer !== null) return;
    const elapsed = this.now().getTime() - conn.lastStateAt;
    const delay = Math.max(0, this.stateThrottleMs - elapsed);
    conn.stateTimer = setTimeout(() => {
      conn.stateTimer = null;
      if (!this.conns.has(conn.id)) return;
      const pending = conn.pendingState;
      conn.pendingState = null;
      if (pending === null) return;
      if (conn.stale || conn.socket.bufferedAmount > this.backpressureBytes) {
        conn.stale = true;
        return;
      }
      conn.lastStateAt = this.now().getTime();
      this.send(conn, 'state:updated', pending, true);
    }, delay);
    conn.stateTimer.unref?.();
  }

  /** `1011 SLOW`: a normal reconnect for the client (`lib/ws.ts` treats it that way). */
  private closeSlow(conn: Connection): void {
    try {
      conn.socket.close(1011, 'SLOW');
    } catch {
      /* already gone */
    }
    this.drop(conn);
  }

  private drop(conn: Connection): void {
    if (conn.stateTimer !== null) {
      clearTimeout(conn.stateTimer);
      conn.stateTimer = null;
    }
    conn.pendingState = null;
    this.conns.delete(conn.id);
  }

  private drain(conn: Connection): void {
    if (!conn.stale) return;
    if (conn.socket.readyState !== WebSocket.OPEN) return;
    if (conn.socket.bufferedAmount > this.backpressureBytes) return;
    conn.stale = false;
    if (conn.stateTimer !== null) {
      clearTimeout(conn.stateTimer);
      conn.stateTimer = null;
    }
    conn.pendingState = null;
    this.sendSnapshot(conn, 'manual');
  }

  private onMessage(conn: Connection, raw: RawData): void {
    const bytes = Array.isArray(raw)
      ? raw.reduce((sum, part) => sum + part.byteLength, 0)
      : raw instanceof ArrayBuffer
        ? raw.byteLength
        : raw.byteLength;
    if (bytes > INBOUND_MAX_BYTES) {
      this.reject(conn.socket, 'PAYLOAD');
      this.drop(conn);
      return;
    }

    const nowMs = this.now().getTime();
    if (nowMs - conn.frames.windowStart >= 60_000) {
      conn.frames = { windowStart: nowMs, count: 0 };
    }
    conn.frames.count += 1;
    if (conn.frames.count > INBOUND_MAX_PER_MINUTE) {
      this.reject(conn.socket, 'RATE_LIMITED');
      this.drop(conn);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      this.send(conn, 'error', { code: 'INVALID', message: 'frame is not JSON' }, true);
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    const message = parsed as { type?: unknown; data?: { t?: unknown; since?: unknown } };
    if (message.type === 'ping') {
      const t = typeof message.data?.t === 'number' ? message.data.t : 0;
      this.send(conn, 'pong', { t, serverTime: toIso(this.now()) }, true);
      return;
    }
    if (message.type === 'resync') {
      // §3.3: the snapshot is complete for everything a surface shows; the hub keeps no buffer.
      const since = typeof message.data?.since === 'number' ? message.data.since : undefined;
      this.sendSnapshot(conn, 'manual', since);
      return;
    }
    this.send(conn, 'error', { code: 'INVALID', message: 'readers may send ping or resync only' }, true);
  }

  private reject(socket: WebSocket, reason: 'CAPACITY' | 'PAYLOAD' | 'RATE_LIMITED'): void {
    const code = reason === 'CAPACITY' ? 1013 : 1009;
    const label = reason === 'PAYLOAD' ? 'PAYLOAD_TOO_LARGE' : reason === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'CAPACITY';
    try {
      socket.close(code, label);
    } catch {
      /* the socket never opened */
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.tick();
    }, Math.min(1_000, Math.max(200, Math.floor(this.heartbeatMs / 3))));
    this.timer.unref?.();
  }

  private openComments(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE status = 'new'`).get() as { n: number };
    return row.n;
  }
}
