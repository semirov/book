/**
 * WebSocket protocol seam (ARCHITECTURE.md §10).
 *
 * M0 ships no socket hub: text arrives over REST and nothing is pushed. The types live
 * here anyway so the server, the SPA and the engine agree on one envelope before the hub
 * exists (M2). Adding an event here without adding it to §10.3 is the mistake this file
 * is meant to prevent.
 */

import type { CatalogEntry, StateSnapshot } from './types.ts';

export const PROTOCOL_VERSION = 1;

export type ServerEventType =
  | 'hello'
  | 'state:updated'
  | 'chapter:created'
  | 'chapter:revision'
  | 'block:revising'
  | 'cursor:moved'
  | 'change:queued'
  | 'change:processing'
  | 'change:stale'
  | 'change:decided'
  | 'cascade:progress'
  | 'engine:state'
  | 'comment:added'
  | 'comment:decision'
  | 'presence';

export type Envelope<T extends ServerEventType = ServerEventType, P = unknown> = {
  t: T;
  /** Server sequence; a gap means "refetch", never "ignore". */
  seq: number;
  at: string;
  v: typeof PROTOCOL_VERSION;
  payload: P;
};

/** The first frame on every connection (§10.3). */
export type HelloEvent = Envelope<
  'hello',
  {
    state: StateSnapshot;
    /** All 67 slots — the опись renders without a request. */
    catalog: CatalogEntry[];
    firstChapter: number | null;
    /** M0: absent. Text is fetched per chapter over REST. */
    ws?: { max: number; intervalMs: number };
  }
>;

/** Client frames (read-only readers; §ADR-005). */
export type ClientEvent = { t: 'ping'; at: string } | { t: 'resync'; since: number };
