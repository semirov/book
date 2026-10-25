/**
 * The only writer of `events` (ARCHITECTURE.md §6F.1, §6F.0).
 *
 * The log is append-only and carries a global monotonic `hseq` — the book's clock. Every
 * fact the engine records (a change queued, a step opened, a gate answered, a cascade
 * closed) is one row here, in the same transaction as the state it describes, so a reader
 * of the history can reconstruct what happened without reading the engine's working tables.
 * The triggers in `schema.ts` refuse UPDATE/DELETE; there is no update path in this module.
 */

import type { HistoryAuthorKind, HistoryKind } from '@book/shared';

import type { Db } from '../db/db.ts';
import { toIso } from '../util/time.ts';

export type { HistoryKind };

/** The five author kinds of §6F.1; the wire type lives in `shared/src/history.ts`. */
export type AuthorKind = HistoryAuthorKind;

export type AppendEventInput = {
  kind: HistoryKind;
  authorKind?: AuthorKind;
  chapter?: number | null;
  isFront?: boolean;
  rev?: number | null;
  changeId?: string | null;
  cascadeId?: string | null;
  stepId?: string | null;
  identityId?: string | null;
  authorLabel?: string;
  payload?: Record<string, unknown>;
};

/**
 * Append one fact and return its `hseq`. `prev_hseq` is read and written inside the same
 * statement sequence, which is safe because the engine is the single writer of this table
 * (WAL serialises writers at the SQLite level anyway).
 */
export function appendEvent(db: Db, input: AppendEventInput, nowMs: number = Date.now()): number {
  const at = toIso(nowMs);
  const previous = db.prepare('SELECT MAX(hseq) AS hseq FROM events').get() as { hseq: number | null };
  const result = db
    .prepare(
      `INSERT INTO events
         (at, kind, chapter, is_front, rev, change_id, cascade_id, step_id,
          author_kind, identity_id, author_label, payload, prev_hseq)
       VALUES
         (@at, @kind, @chapter, @isFront, @rev, @changeId, @cascadeId, @stepId,
          @authorKind, @identityId, @authorLabel, @payload, @prev)`,
    )
    .run({
      at,
      kind: input.kind,
      chapter: input.chapter ?? null,
      isFront: input.isFront === true ? 1 : 0,
      rev: input.rev ?? null,
      changeId: input.changeId ?? null,
      cascadeId: input.cascadeId ?? null,
      stepId: input.stepId ?? null,
      authorKind: input.authorKind ?? 'author',
      identityId: input.identityId ?? null,
      authorLabel: input.authorLabel ?? '',
      payload: JSON.stringify(input.payload ?? {}),
      prev: previous.hseq,
    });
  return Number(result.lastInsertRowid);
}

export type ChangeEventType =
  | 'queued'
  | 'processing'
  | 'stale'
  | 'adapted'
  | 'decided'
  | 'escalated'
  | 'released'
  | 'cancelled';

/** The change's own audit trail; `meta` carries structure, never a prose body. */
export function appendChangeEvent(
  db: Db,
  changeId: string,
  type: ChangeEventType,
  meta: Record<string, unknown> = {},
  nowMs: number = Date.now(),
): void {
  db.prepare('INSERT INTO change_events (change_id, at, type, meta) VALUES (?, ?, ?, ?)').run(
    changeId,
    toIso(nowMs),
    type,
    JSON.stringify(meta),
  );
}
