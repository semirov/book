/**
 * The paragraph chain (§6F.3): stable identities, versions and explicit overwrites.
 *
 * A block id is content-derived, so it changes whenever its paragraph is rewritten. That is
 * enough to anchor a comment but not enough to answer «откуда эта фраза»; the chain adds a
 * ULID per paragraph (`block_uid`) that survives the rewrite, one `block_versions` row per
 * version, and an `overwrites` row for every paragraph that disappeared:
 * «переписано в 14:20 правкой 7 · было: правка 3 (Аня)».
 *
 * This module writes history only; it never touches the projection or the prose.
 */

import type { Db } from '../db/db.ts';
import type { BlockRow } from '../db/repo/chapters.ts';
import type { WriteActor, WriteCause } from '../ingest/attribution.ts';
import { OUT_OF_PROCESS_LABEL, overwriteByKind } from '../ingest/attribution.ts';
import { ulid } from '../util/ulid.ts';
import { recordBlockDelta } from './deltaWrite.ts';
import { appendEvent } from './log.ts';
import { REPLACE_SIMILARITY, pairBySimilarity } from './similarity.ts';

export type BlockInput = { id: string; text: string; hash: string };

export type RecordBlocksInput = {
  db: Db;
  chapter: number;
  rev: number;
  hseq: number;
  at: string;
  nowMs: number;
  before: ReadonlyArray<BlockRow>;
  after: ReadonlyArray<BlockInput>;
  cause: WriteCause;
  actor: WriteActor;
};

export type BlockOverwrite = {
  blockId: string;
  blockUid: string;
  replacedBy: string | null;
  byLabel: string;
};

export type RecordedBlocks = {
  introduced: number;
  revised: number;
  erased: number;
  overwrites: BlockOverwrite[];
};

type LiveUidRow = {
  block_id: string;
  block_uid: string;
  ver: number;
  change_id: string | null;
};

export function newBlockUid(nowMs: number = Date.now()): string {
  return `bkd_${ulid(nowMs)}`;
}

/** ADR-043 D5: one checkpoint per eight versions of a block (and the first one). */
export const CHECKPOINT_EVERY = 8;

export function isCheckpoint(ver: number): boolean {
  return ver === 1 || ver % CHECKPOINT_EVERY === 0;
}

/**
 * What a version stores in `block_versions.text`: its whole text on a checkpoint, `''` otherwise.
 * The change span is the delta; the checkpoint is the point a replay may start from.
 */
export function checkpointText(ver: number, text: string): string {
  return isCheckpoint(ver) ? text : '';
}

/** The latest version of every paragraph still in the chapter's text. */
export function readLiveUids(db: Db, chapter: number): Map<string, LiveUidRow> {
  const rows = db
    .prepare(
      `SELECT v.block_id, v.block_uid, v.ver, v.change_id FROM block_versions v
         JOIN (SELECT block_uid, MAX(ver) AS ver FROM block_versions WHERE chapter = ? GROUP BY block_uid) last
           ON last.block_uid = v.block_uid AND last.ver = v.ver
        WHERE v.chapter = ? AND v.op != 'erased'`,
    )
    .all(chapter, chapter) as LiveUidRow[];
  return new Map(rows.map((row) => [row.block_id, row]));
}

function insertVersion(
  db: Db,
  input: RecordBlocksInput,
  version: {
    uid: string;
    ver: number;
    blockId: string;
    textHash: string;
    chars: number;
    op: 'introduced' | 'revised' | 'erased';
    prevVer: number | null;
    replacedBy: string | null;
    /** BOOK-176: the JSON span list of this version; '[]' for a version written without one. */
    spans?: string;
    /** ADR-043 D5: the block's full text on a checkpoint version, '' otherwise. */
    text?: string;
    /** ADR-041 §2.2: the version's whole text — the input of its delta, never a re-read. */
    nextText: string;
  },
): void {
  db.prepare(
    `INSERT INTO block_versions
       (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
        change_id, step_id, actor_kind, actor_label, identity_id, at, spans, text)
     VALUES
       (@blockUid, @ver, @chapter, @rev, @hseq, @blockId, @textHash, @chars, @op, @prevVer, @replacedBy,
        @changeId, @stepId, @actorKind, @actorLabel, @identityId, @at, @spans, @text)`,
  ).run({
    spans: version.spans ?? '[]',
    text: version.text ?? '',
    blockUid: version.uid,
    ver: version.ver,
    chapter: input.chapter,
    rev: input.rev,
    hseq: input.hseq,
    blockId: version.blockId,
    textHash: version.textHash,
    chars: version.chars,
    op: version.op,
    prevVer: version.prevVer,
    replacedBy: version.replacedBy,
    changeId: input.cause.changeId,
    stepId: input.cause.stepId,
    actorKind: input.actor.kind,
    actorLabel: input.actor.label,
    identityId: input.actor.identityId,
    at: input.at,
  });
  // ADR-041 §2.2 / BOOK-187 AC 10: the version and the change that produced it are written in
  // one place and one transaction. The delta is skipped (with a code) rather than invented when
  // the ledger cannot replay the predecessor.
  recordBlockDelta({
    db,
    chapter: input.chapter,
    blockUid: version.uid,
    ver: version.ver,
    prevVer: version.prevVer,
    op: version.op,
    nextText: version.nextText,
    spans: version.spans,
    rev: input.rev,
    hseq: input.hseq,
    at: input.at,
    changeId: input.cause.changeId,
    stepId: input.cause.stepId,
  });
}

function openLineage(db: Db, input: RecordBlocksInput, blockId: string, chars: number): void {
  db.prepare(
    `INSERT INTO block_lineage
       (block_id, chapter, first_rev, last_rev, first_hseq, last_hseq, cause_kind, change_id, identity_id, chars, replaced_by)
     VALUES (@blockId, @chapter, @rev, NULL, @hseq, NULL, @causeKind, @changeId, @identityId, @chars, NULL)
     ON CONFLICT(block_id) DO UPDATE SET last_rev = NULL, last_hseq = NULL, replaced_by = NULL`,
  ).run({
    blockId,
    chapter: input.chapter,
    rev: input.rev,
    hseq: input.hseq,
    causeKind: overwriteByKind(input.cause),
    changeId: input.cause.changeId,
    identityId: input.actor.identityId,
    chars,
  });
}

function closeLineage(db: Db, input: RecordBlocksInput, blockId: string, replacedBy: string | null): void {
  db.prepare('UPDATE block_lineage SET last_rev = ?, last_hseq = ?, replaced_by = ? WHERE block_id = ?').run(
    input.rev,
    input.hseq,
    replacedBy,
    blockId,
  );
}

/**
 * Record one revision of a chapter against the paragraph chain. The caller has already
 * appended the revision's own event, so its `hseq` is this revision's `hseq` too.
 */
export function recordBlockRevision(input: RecordBlocksInput): RecordedBlocks {
  const { db } = input;
  const result: RecordedBlocks = { introduced: 0, revised: 0, erased: 0, overwrites: [] };
  if (input.after.length === 0) return result;

  const live = readLiveUids(db, input.chapter);
  const pairs = pairBySimilarity(input.before, input.after, REPLACE_SIMILARITY);
  const pairOfOld = new Map<number, { newIndex: number; score: number }>();
  const oldOfNew = new Map<number, number>();
  for (const pair of pairs) {
    pairOfOld.set(pair.oldIndex, { newIndex: pair.newIndex, score: pair.score });
    oldOfNew.set(pair.newIndex, pair.oldIndex);
  }

  // 1. The new text: an untouched block keeps its identity, a rewritten one continues it,
  //    a genuinely new paragraph is born.
  const uidOfNew = new Map<number, string>();
  for (let newIndex = 0; newIndex < input.after.length; newIndex += 1) {
    const block = input.after[newIndex];
    if (block === undefined) continue;
    const oldIndex = oldOfNew.get(newIndex);
    if (oldIndex !== undefined) {
      const old = input.before[oldIndex];
      const pair = pairOfOld.get(oldIndex);
      if (old === undefined) continue;
      if (pair !== undefined && pair.score >= 1 && old.hash === block.hash) {
        const known = live.get(old.id);
        const uid = known?.block_uid ?? newBlockUid(input.nowMs);
        if (known === undefined) {
          // A pre-M6b block seen for the first time: its introduction is this revision.
          insertVersion(db, input, {
            uid,
            ver: 1,
            blockId: block.id,
            textHash: block.hash,
            chars: block.text.length,
            op: 'introduced',
            prevVer: null,
            replacedBy: null,
            text: block.text,
            nextText: block.text,
          });
          result.introduced += 1;
        }
        openLineage(db, input, block.id, block.text.length);
        uidOfNew.set(newIndex, uid);
        continue;
      }
      const known = live.get(old.id);
      const uid = known?.block_uid ?? newBlockUid(input.nowMs);
      const ver = (known?.ver ?? 0) + 1;
      insertVersion(db, input, {
        uid,
        ver,
        blockId: block.id,
        textHash: block.hash,
        chars: block.text.length,
        op: 'revised',
        prevVer: known?.ver ?? null,
        replacedBy: null,
        text: checkpointText(ver, block.text),
        nextText: block.text,
      });
      closeLineage(db, input, old.id, block.id);
      openLineage(db, input, block.id, block.text.length);
      uidOfNew.set(newIndex, uid);
      result.revised += 1;
      continue;
    }

    const uid = newBlockUid(input.nowMs);
    insertVersion(db, input, {
      uid,
      ver: 1,
      blockId: block.id,
      textHash: block.hash,
      chars: block.text.length,
      op: 'introduced',
      prevVer: null,
      replacedBy: null,
      text: block.text,
      nextText: block.text,
    });
    openLineage(db, input, block.id, block.text.length);
    uidOfNew.set(newIndex, uid);
    result.introduced += 1;
  }

  // 2. The paragraphs that disappeared: an overwrite each (§6F.3). A removed block with an
  //    unpaired newcomer in its place gets a lineage link; with none, the chain ends there.
  const heirOfOld = nearestHeirs(input.before.length, input.after.length, pairOfOld, oldOfNew);
  const byLabel = input.actor.kind === 'unattributed' ? OUT_OF_PROCESS_LABEL : input.actor.label;
  for (let oldIndex = 0; oldIndex < input.before.length; oldIndex += 1) {
    if (pairOfOld.has(oldIndex)) continue;
    const old = input.before[oldIndex];
    if (old === undefined) continue;
    const known = live.get(old.id);
    const uid = known?.block_uid ?? newBlockUid(input.nowMs);
    const heirIndex = heirOfOld.get(oldIndex) ?? null;
    const heir = heirIndex === null ? undefined : input.after[heirIndex];
    const heirUid = heirIndex === null ? null : (uidOfNew.get(heirIndex) ?? null);
    const previousCause = known?.change_id ?? null;

    insertVersion(db, input, {
      uid,
      ver: (known?.ver ?? 0) + 1,
      blockId: old.id,
      textHash: old.hash,
      chars: old.text.length,
      op: 'erased',
      prevVer: known?.ver ?? null,
      replacedBy: heirUid,
      text: checkpointText((known?.ver ?? 0) + 1, old.text),
      nextText: old.text,
    });
    closeLineage(db, input, old.id, heir?.id ?? null);

    const hseq = appendEvent(
      db,
      {
        kind: 'overwrite',
        chapter: input.chapter,
        rev: input.rev,
        changeId: input.cause.changeId,
        cascadeId: input.cause.cascadeId,
        stepId: input.cause.stepId,
        authorKind: input.actor.kind,
        identityId: input.actor.identityId,
        authorLabel: byLabel,
        payload: { blockId: old.id, blockUid: uid, replacedBy: heir?.id ?? null },
      },
      input.nowMs,
    );
    db.prepare(
      `INSERT INTO overwrites
         (block_id, chapter, hseq, at, by_change_id, by_step_id, by_kind, by_label, replaced_by, previous_cause)
       VALUES (@blockId, @chapter, @hseq, @at, @changeId, @stepId, @byKind, @byLabel, @replacedBy, @previousCause)`,
    ).run({
      blockId: old.id,
      chapter: input.chapter,
      hseq,
      at: input.at,
      changeId: input.cause.changeId,
      stepId: input.cause.stepId,
      byKind: overwriteByKind(input.cause),
      byLabel,
      replacedBy: heir?.id ?? null,
      previousCause,
    });
    result.erased += 1;
    result.overwrites.push({ blockId: old.id, blockUid: uid, replacedBy: heir?.id ?? null, byLabel });
  }

  return result;
}

/**
 * For a disappeared block, the newcomer that most plausibly took its place: the same
 * position when that slot is new, otherwise the nearest new block within one step. Cells
 * are consumed once, so a chain never invents a second heir.
 */
function nearestHeirs(
  oldCount: number,
  newCount: number,
  pairOfOld: Map<number, { newIndex: number; score: number }>,
  oldOfNew: Map<number, number>,
): Map<number, number> {
  const heirs = new Map<number, number>();
  const usedNew = new Set<number>();
  for (let oldIndex = 0; oldIndex < oldCount; oldIndex += 1) {
    if (pairOfOld.has(oldIndex)) continue;
    for (const candidate of [oldIndex, oldIndex - 1, oldIndex + 1]) {
      if (candidate < 0 || candidate >= newCount) continue;
      if (oldOfNew.has(candidate) || usedNew.has(candidate)) continue;
      usedNew.add(candidate);
      heirs.set(oldIndex, candidate);
      break;
    }
  }
  return heirs;
}

export type RecordPatchedBlockInput = {
  db: Db;
  chapter: number;
  rev: number;
  hseq: number;
  /** The revision's own time (ISO), stored on the version row. */
  at: string;
  /** The block id the paragraph had before the patch — the lineage row that closes. */
  previousBlockId: string;
  /** The block id after the patch — the lineage row that opens. */
  blockId: string;
  blockUid: string;
  ver: number;
  prevVer: number | null;
  textHash: string;
  chars: number;
  /** The version's JSON span list (BOOK-176); `span_id` embeds `blockUid:ver`. */
  spans: string;
  /** ADR-043 D5: the block's full text on a checkpoint version, `''` otherwise. */
  text: string;
  /** The block's whole text after the patch — what the version's delta is computed from. */
  nextText: string;
  cause: WriteCause;
  actor: WriteActor;
  nowMs?: number;
};

/**
 * BOOK-176: one patched paragraph as one version of the chain. The applier owns the span list
 * (its `span_id` is `blockUid:ver:0`, so the caller mints the version number), and this function
 * keeps the chain's other promises: the old lineage row closes, the new one opens, and the
 * version carries the cause, the actor and the JSON spans.
 *
 * It reuses `insertVersion`/`closeLineage`/`openLineage` unchanged, so a patched version and an
 * ingested one are the same row shape — nothing downstream has to know which wrote it.
 */
export function recordPatchedBlock(input: RecordPatchedBlockInput): void {
  const frame: RecordBlocksInput = {
    db: input.db,
    chapter: input.chapter,
    rev: input.rev,
    hseq: input.hseq,
    at: input.at,
    nowMs: input.nowMs ?? Date.now(),
    before: [],
    after: [],
    cause: input.cause,
    actor: input.actor,
  };
  insertVersion(input.db, frame, {
    uid: input.blockUid,
    ver: input.ver,
    blockId: input.blockId,
    textHash: input.textHash,
    chars: input.chars,
    op: 'revised',
    prevVer: input.prevVer,
    replacedBy: null,
    spans: input.spans,
    text: input.text,
    nextText: input.nextText,
  });
  closeLineage(input.db, frame, input.previousBlockId, input.blockId);
  openLineage(input.db, frame, input.blockId, input.chars);
}
