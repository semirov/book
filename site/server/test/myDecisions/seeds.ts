import { upsertIdentity, type IdentityRow } from '../../src/db/repo/identities.ts';
import type { Harness } from '../comments/helpers.ts';

/**
 * The rows `GET /api/me/decisions` reads, written the way the engine writes them.
 *
 * A comment is inserted without its `change_id` and linked afterwards: the two tables point
 * at each other, and the acceptance writes them in one transaction. Nothing here emits a
 * frame — the point of BOOK-13 is that the record exists without one.
 */

export type CommentSeed = {
  id: string;
  identityId: string;
  chapter?: number;
  status?: string;
  reason?: string | null;
  decidedAt?: string | null;
  createdAt?: string;
  auditVerdict?: string | null;
};

export function seedComment(h: Harness, seed: CommentSeed): void {
  h.db
    .prepare(
      `INSERT INTO comments
         (id, identity_id, chapter, author, body, body_sha, flags, ip_hash, status, guard,
          created_at, decided_at, reason, change_id, audit_verdict, number)
       VALUES (?, ?, ?, 'Аня', 'тело', ?, '[]', 'ip', ?, NULL, ?, ?, ?, NULL, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM comments))`,
    )
    .run(
      seed.id,
      seed.identityId,
      seed.chapter ?? 8,
      `sha_${seed.id}`,
      seed.status ?? 'new',
      seed.createdAt ?? '2026-10-25T12:00:00Z',
      seed.decidedAt ?? null,
      seed.reason ?? null,
      seed.auditVerdict ?? null,
    );
}

export type ChangeSeed = {
  id: string;
  seq: number;
  chapter?: number;
  status: string;
  outcome?: string | null;
  reason?: string | null;
  intent?: string;
  commentId?: string | null;
  cascadeId?: string | null;
  finishedAt?: string | null;
};

export function seedChange(h: Harness, change: ChangeSeed): void {
  h.db
    .prepare(
      `INSERT INTO changes
         (seq, id, kind, chapter, intent, source_comment, base_rev, base_sha256, base_blocks,
          scope_hint, status, outcome, reason, cascade_id, tokens_in, tokens_out, enqueued_at,
          started_at, finished_at, attempts)
       VALUES (?, ?, 'accepted_comment', ?, ?, ?, 2, 'sha', '[]', 'phrase', ?, ?, ?, ?, 0, 0, ?,
               ?, ?, 0)`,
    )
    .run(
      change.seq,
      change.id,
      change.chapter ?? 8,
      change.intent ?? 'внести документ в главу 8',
      change.commentId ?? null,
      change.status,
      change.outcome ?? null,
      change.reason ?? null,
      change.cascadeId ?? null,
      '2026-10-25T11:00:00Z',
      '2026-10-25T11:30:00Z',
      change.finishedAt ?? null,
    );
  if (change.commentId !== undefined && change.commentId !== null) {
    h.db.prepare('UPDATE comments SET change_id = ? WHERE id = ?').run(change.id, change.commentId);
  }
}

export function seedCascade(h: Harness, id: string, changeId: string, wave: number): void {
  h.db
    .prepare(
      `INSERT INTO cascades (id, change_id, status, outcome, wave, depth_fwd, depth_bwd, step_count,
         tokens, budget, opened_at, closed_at)
       VALUES (?, ?, 'closed', 'consistent', ?, 1, 2, 3, 0, ?, '2026-10-25T11:30:00Z',
               '2026-10-25T12:30:00Z')`,
    )
    .run(id, changeId, wave, JSON.stringify({ maxSteps: 8, maxWallMs: 1_800_000 }));
}

export function seedImpact(h: Harness, changeId: string, chapters: number[], blocks: number): void {
  h.db
    .prepare(
      `INSERT INTO change_impact
         (change_id, chapters_touched, chapters_rewritten, blocks_changed, chars_added, chars_removed,
          overwrites, seams, depth_down, depth_up, tokens, cost_rub, ms, from_hseq, to_hseq, computed_at)
       VALUES (?, ?, '[]', ?, 0, 0, 0, '[]', 0, 0, 0, 0, 0, 0, 0, '2026-10-25T12:30:00Z')`,
    )
    .run(changeId, JSON.stringify(chapters), blocks);
}

/** A surviving paragraph of one reader: the rows the history writer produces. */
export function seedSurviving(h: Harness, identityId: string, uid: string, chars: number): void {
  h.db
    .prepare(
      `INSERT INTO block_versions
         (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
          change_id, step_id, actor_kind, actor_label, identity_id, at)
       VALUES (?, 1, 8, 2, 100, ?, 'h', ?, 'introduced', NULL, NULL,
               NULL, NULL, 'reader', 'читатель', ?, '2026-10-25T12:00:00Z')`,
    )
    .run(uid, `ch08#${uid}`, chars, identityId);
}

/** A second reader with a session of their own: the other side of «own only». */
export function otherReader(h: Harness): { identity: IdentityRow; cookie: string } {
  const identity = upsertIdentity(h.db, {
    yandexSub: 'yandex-2002',
    displayName: 'Борис',
    at: '2026-10-25T12:00:00Z',
  });
  return { identity, cookie: h.sessions.issue(identity.id, { ipKey: '127.0.0.2' }).cookie };
}
