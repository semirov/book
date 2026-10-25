/**
 * Attribution of an observed write to the engine's live lease (ARCHITECTURE.md §6.3 step 6,
 * §6A.11, §6F.3, §10.3).
 *
 * The site never infers a cause from an mtime. If a live lease holds the chapter (or the
 * first sheet), the write is the step's; otherwise it is an unattributed hand edit and the
 * site says so — and so does the history («правка вне процесса»). The actor is resolved
 * through the change and its comment, so the SPEC's chain reader → transformer → text is
 * preserved in the log, not reconstructed later.
 */

import type { Lane } from '@book/shared';

import type { Db } from '../db/db.ts';
import type { CauseKind } from '../db/repo/revisions.ts';
import type { AuthorKind } from '../history/log.ts';

export type WriteCauseKind = 'draft' | 'change' | 'cascade' | 'front' | 'ending' | 'sweep' | 'operator' | 'restore';

export type WriteCause = {
  kind: WriteCauseKind;
  lane: Lane | null;
  leaseId: string | null;
  changeId: string | null;
  cascadeId: string | null;
  stepId: string | null;
  /** §13.3: the revision whose text this write restored, when it is a restore. */
  restoredRev?: number | null;
};

export type WriteActor = {
  kind: AuthorKind;
  identityId: string | null;
  label: string;
};

const NO_CAUSE: WriteCause = {
  kind: 'draft',
  lane: null,
  leaseId: null,
  changeId: null,
  cascadeId: null,
  stepId: null,
};

/** §6F.3: the two labels the chain shows when no reader owns the sentence. */
export const AUTHOR_LABEL = 'автор';
export const OUT_OF_PROCESS_LABEL = 'правка вне процесса';
export const OPERATOR_LABEL = 'оператор';

type LeaseRow = {
  id: string;
  step_id: string;
  change_id: string | null;
  cascade_id: string | null;
  lane: Lane | null;
  kind: string;
  expires_at: string;
};

function causeFromLease(lease: LeaseRow | undefined, nowMs: number): WriteCause {
  if (lease === undefined || Date.parse(lease.expires_at) <= nowMs) return NO_CAUSE;
  return {
    // A cascade rewrite is still the change's rewrite; that is the cause a reader can see
    // (the text moved because a note two chapters away landed), not the engine's pass name.
    kind: lease.cascade_id === null ? (lease.kind as WriteCauseKind) : 'cascade',
    lane: lease.lane,
    leaseId: lease.id,
    changeId: lease.change_id,
    cascadeId: lease.cascade_id,
    stepId: lease.step_id,
  };
}

/** The live lease for the first sheet, if one exists right now. */
export function frontWriteCause(db: Db, nowMs: number): WriteCause {
  const lease = db
    .prepare(
      `SELECT id, step_id, change_id, cascade_id, lane, kind, expires_at FROM leases
        WHERE released_at IS NULL AND is_front = 1
        ORDER BY acquired_at DESC LIMIT 1`,
    )
    .get() as LeaseRow | undefined;
  return causeFromLease(lease, nowMs);
}

/** The live lease for one chapter, if one exists right now (§6F.1: the cause of a revision). */
export function chapterWriteCause(db: Db, n: number, nowMs: number): WriteCause {
  const lease = db
    .prepare(
      `SELECT id, step_id, change_id, cascade_id, lane, kind, expires_at FROM leases
        WHERE released_at IS NULL AND is_front = 0 AND chapter = ?
        ORDER BY acquired_at DESC LIMIT 1`,
    )
    .get(n) as LeaseRow | undefined;
  return causeFromLease(lease, nowMs);
}

type ChangeSourceRow = { source_comment: string | null; source_session: string | null };
type CommentAuthorRow = { identity_id: string; author: string };

/** The SPEC's chain for one change: a reader's comment, or the writer's own pass. */
export function actorForChange(db: Db, changeId: string | null): WriteActor {
  if (changeId === null) return { kind: 'writer', identityId: null, label: AUTHOR_LABEL };
  const change = db
    .prepare('SELECT source_comment, source_session FROM changes WHERE id = ?')
    .get(changeId) as ChangeSourceRow | undefined;
  if (change?.source_comment) {
    const comment = db
      .prepare('SELECT identity_id, author FROM comments WHERE id = ?')
      .get(change.source_comment) as CommentAuthorRow | undefined;
    if (comment !== undefined) {
      return { kind: 'reader', identityId: comment.identity_id, label: comment.author.slice(0, 32) };
    }
  }
  // A continuity change or an accepted intent without a surviving comment belongs to the
  // writing process, not to a reader.
  return { kind: 'writer', identityId: null, label: AUTHOR_LABEL };
}

/** Who caused this write: a reader's change, the writer's pass, or nobody in the process. */
export function actorForCause(db: Db, cause: WriteCause): WriteActor {
  if (cause.kind === 'restore') return { kind: 'operator', identityId: null, label: OPERATOR_LABEL };
  if (cause.stepId === null && cause.changeId === null) {
    return { kind: 'unattributed', identityId: null, label: OUT_OF_PROCESS_LABEL };
  }
  return actorForChange(db, cause.changeId);
}

/** `revisions.cause_kind` is narrower than `WriteCause.kind`; the lease kind maps 1:1. */
export function revisionCauseKind(cause: WriteCause): CauseKind {
  // A restore is never a step: no lease, no change, and the site says so (§13.3).
  if (cause.kind === 'restore') return 'restore';
  if (cause.leaseId === null) return 'draft';
  return cause.cascadeId === null ? cause.kind : 'cascade';
}

/**
 * `overwrites.by_kind` has no `front`/`ending`; those belong to their owner. A restore is an
 * operator's act (§13.3), so the block chain names the operator rather than «правка вне
 * процесса» — the label and the kind must not contradict each other.
 */
export function overwriteByKind(cause: WriteCause): 'change' | 'cascade' | 'draft' | 'sweep' | 'operator' | 'unattributed' {
  if (cause.kind === 'restore') return 'operator';
  if (cause.stepId === null) return 'unattributed';
  if (cause.cascadeId !== null) return 'cascade';
  if (cause.kind === 'sweep' || cause.kind === 'draft' || cause.kind === 'change') return cause.kind;
  return 'operator';
}
