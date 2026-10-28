/**
 * Level 1 — the paragraph record (ADR-043 D2, BOOK-176).
 *
 * Every paragraph version already carries who, when and because of what: `actor_kind`,
 * `actor_label`, `identity_id`, `change_id`, `step_id`, `hseq`, `at` are columns `block_versions`
 * has had since M6b. This module adds **no table and no row** — it reads that row as the default
 * answer to «кто это написал», so a tap on a paragraph that carries no fact span still returns a
 * hand, a moment and a history, and there is no empty state anywhere in the book.
 *
 * The hand is the stored `actor_label` when a write path gave one (a reader's display name); when
 * it did not, the five words of ADR-043 are derived from the actor kind. They are the same words
 * `web/src/lib/provenance.ts` prints — the server cannot import the SPA, so the two lists are
 * kept identical by hand and by test, and the duplication is the only honest option here.
 */

import type { Db } from '../db/db.ts';

/** The hands the book prints. Level 1 has no other vocabulary. */
export const HAND_WRITER = 'печатник';
export const HAND_FRAME = 'рамка книги';
export const HAND_EDIT = 'правка';
export const HAND_UNATTRIBUTED = 'правка вне процесса';
export const HAND_LEGACY = 'legacy';

/** The last three versions a paragraph record shows — «история» in the margin. */
export const HISTORY_DEPTH = 3;

export type ParagraphHistoryEntry = {
  ver: number;
  hand: string;
  at: string;
  changeId: string | null;
};

export type ParagraphRecord = {
  blockUid: string;
  ver: number;
  hand: string;
  actorKind: string;
  at: string;
  changeId: string | null;
  stepId: string | null;
  history: ParagraphHistoryEntry[];
};

type VersionRow = {
  block_uid: string;
  ver: number;
  actor_kind: string;
  actor_label: string | null;
  at: string;
  change_id: string | null;
  step_id: string | null;
};

/** The hand a version row prints: its own label, else the word its actor kind means. */
export function handOf(actorKind: string, actorLabel: string | null): string {
  if (actorLabel !== null && actorLabel.trim() !== '') return actorLabel;
  switch (actorKind) {
    case 'writer':
      return HAND_WRITER;
    case 'author':
      return HAND_FRAME;
    case 'reader':
    case 'operator':
      return HAND_EDIT;
    case 'unattributed':
      return HAND_UNATTRIBUTED;
    case 'legacy':
      return HAND_LEGACY;
    default:
      return HAND_UNATTRIBUTED;
  }
}

/**
 * The record of a paragraph: its latest version, and the three before it, newest first.
 * `null` only when the block has never had a version — a paragraph that was never written has
 * nothing to attribute, and inventing a hand for it would be the empty state this level removes.
 */
export function paragraphRecord(db: Db, input: { chapter: number; blockUid: string }): ParagraphRecord | null {
  const rows = db
    .prepare(
      `SELECT block_uid, ver, actor_kind, actor_label, at, change_id, step_id
         FROM block_versions WHERE chapter = ? AND block_uid = ?
        ORDER BY ver DESC LIMIT ?`,
    )
    .all(input.chapter, input.blockUid, HISTORY_DEPTH) as VersionRow[];
  const latest = rows[0];
  if (latest === undefined) return null;
  return {
    blockUid: latest.block_uid,
    ver: latest.ver,
    hand: handOf(latest.actor_kind, latest.actor_label),
    actorKind: latest.actor_kind,
    at: latest.at,
    changeId: latest.change_id,
    stepId: latest.step_id,
    history: rows.map((row) => ({
      ver: row.ver,
      hand: handOf(row.actor_kind, row.actor_label),
      at: row.at,
      changeId: row.change_id,
    })),
  };
}
