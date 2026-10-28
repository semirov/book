/**
 * The applier (BOOK-176, BOOK-DOC-69/ADR-043): one patch of one chapter, applied as a transaction
 * that either lands whole or leaves nothing behind.
 *
 * This is the single public write path of the ledger, and its checks live in `patchCheck.ts` —
 * they run entirely **before** the transaction, so a refusal costs no writes, no file and no
 * revision. What an accepted patch does, in one `db.transaction`: it rewrites the edited blocks
 * (`id`, `text`, `hash`; the id is content-derived, so a paragraph may hand it to another one and
 * the rename goes through a temporary prefix in two passes); it bumps the chapter's `rev`, sha,
 * chars, block count and `updated_at`; it drops and re-binds the mentions and literals of every
 * edited block (they are live-only, ADR-043 D3); it records whether the new text left a
 * fact-shaped carrier unbound (L8 warning, never a refusal in this stage) and republishes the
 * chapter's gap (D9); it writes one `block_versions` row per edited block carrying **one span** and
 * a checkpoint text every eighth version (D5); and it appends the `chapter.revised` event and the
 * `edit` revision, both naming the cause. No chapter snapshot is written: the block checkpoint is
 * the boundary.
 */

import type { Db } from '../db/db.ts';
import { getChapterRow, listBlocks, type BlockRow } from '../db/repo/chapters.ts';
import { insertRevision } from '../db/repo/revisions.ts';
import { checkpointText, newBlockUid, readLiveUids, recordPatchedBlock } from '../history/blocks.ts';
import { appendEvent } from '../history/log.ts';
import { blockId, normalizeForHash } from '../ingest/parseChapter.ts';
import { sha256Hex } from '../util/hash.ts';
import { toIso } from '../util/time.ts';
import { countUnboundFactShaped, unboundFactShaped } from './factShaped.ts';
import { insertSpanMentions, type BoundBlock } from './mentions.ts';
import {
  actorFor,
  blockHashOf,
  canonicalChapterText,
  frameRefusal,
  MAX_EDITS,
  refuse,
  resolveEdits,
  shapeRefusal,
  writeCauseOf,
  type ApplyPatchInput,
  type ApplyPatchResult,
  type PatchEdit,
} from './patchCheck.ts';
import {
  applyOps,
  makeSpan,
  minimalEdit,
  parseSpans,
  SpanMismatchError,
  type BlockSpan,
  type SpanCause,
} from './spans.ts';

export type {
  ApplyPatchInput,
  ApplyPatchResult,
  ApplyRefusalCode,
  Patch,
  PatchCause,
  PatchEdit,
} from './patchCheck.ts';

/** The temporary id prefix of the two-pass rename; a block id never starts with `~`. */
const TEMP_PREFIX = '~tmp~';

/** Apply one patch. See the file header for the order of writes inside the transaction. */
export function applyPatch(input: ApplyPatchInput): ApplyPatchResult {
  const { db, chapter, patch, cause } = input;
  const nowMs = input.nowMs ?? Date.now();
  const at = toIso(nowMs);

  const invalid = shapeRefusal(patch);
  if (invalid !== null) return invalid;
  const chapterRow = getChapterRow(db, chapter);
  if (chapterRow === undefined) return refuse('CHAPTER_NOT_FOUND', `chapter ${String(chapter)} is not in the book`);
  const blocks = listBlocks(db, chapter);
  const resolved = resolveEdits(blocks, patch.edits);
  if (!Array.isArray(resolved)) return resolved;

  const newTextOf = new Map<string, string>(resolved.map((edit) => [edit.block.id, edit.newText]));
  const hashOf = new Map<string, string>();
  const idOf = new Map<string, string>();
  const seenNormalised = new Map<string, number>();
  for (const block of blocks) {
    // The stored hash is the projection's own promise: it is the hash of the block's text. A
    // chapter whose hashes drifted is a broken projection, and patching it would write history
    // about a text that never existed — untouched blocks are checked for exactly that reason.
    const currentHash = blockHashOf(block.text);
    if (currentHash !== block.hash) {
      return refuse('HASH_MISMATCH', 'stored hash does not match the block text', block.id);
    }
    const text = newTextOf.get(block.id) ?? block.text;
    const normalised = normalizeForHash(text);
    const duplicate = seenNormalised.get(normalised) ?? 0;
    seenNormalised.set(normalised, duplicate + 1);
    hashOf.set(block.id, blockHashOf(text));
    idOf.set(block.id, newTextOf.has(block.id) ? blockId(chapter, normalised, duplicate) : block.id);
  }
  // An untouched block keeps the id it was published with, so an edit that makes a paragraph
  // byte-identical to a later one can land on that paragraph's id — an id the ledger cannot
  // renumber without rewriting somebody else's anchors. Refused, not mangled.
  const finalIds = new Set<string>();
  for (const block of blocks) {
    const id = idOf.get(block.id) ?? block.id;
    if (finalIds.has(id)) return refuse('PATCH_INVALID', 'the edit would give two blocks one identity', block.id);
    finalIds.add(id);
  }

  const frameProblem = frameRefusal(chapter, blocks, resolved, newTextOf);
  if (frameProblem !== null) return frameProblem;

  const changeId = cause.changeId ?? null;
  const stepId = cause.stepId ?? null;
  const spanCause: SpanCause = {
    kind: changeId !== null ? 'change' : stepId !== null ? 'pass' : 'legacy',
    id: changeId ?? stepId,
  };
  const resolvedBy = changeId ?? stepId;
  const causeForChain = writeCauseOf(cause);
  const actor = actorFor(cause);
  const live = readLiveUids(db, chapter);

  const run = db.transaction((): ApplyPatchResult => {
    const rev = chapterRow.rev + 1;
    // Two passes: every block of the chapter takes a temporary id first, so a paragraph that
    // hands its id to its neighbour cannot collide halfway through the rename. The order is the
    // blocks' own order, so the outcome does not depend on the order of the edits.
    db.prepare('UPDATE blocks SET id = ? || id WHERE chapter = ?').run(TEMP_PREFIX, chapter);
    const write = db.prepare('UPDATE blocks SET id = ?, text = ?, hash = ? WHERE id = ?');
    const texts: string[] = [];
    for (const block of blocks) {
      const text = newTextOf.get(block.id) ?? block.text;
      write.run(idOf.get(block.id) ?? block.id, text, hashOf.get(block.id) ?? block.hash, TEMP_PREFIX + block.id);
      texts.push(text);
    }
    const canonical = canonicalChapterText(chapterRow.title, texts);
    const sha256 = sha256Hex(canonical);
    db.prepare(
      `UPDATE chapters SET rev = ?, sha256 = ?, chars = ?, block_count = ?, updated_at = ? WHERE n = ?`,
    ).run(
      rev,
      sha256,
      texts.reduce((sum, text) => sum + text.length, 0),
      texts.length,
      at,
      chapter,
    );
    // ADR-043 D3: mentions are live-only. The rows of every edited block go before the new ones
    // are bound — a mention describes the text that stands, never a version that is gone.
    const dropMentions = db.prepare('DELETE FROM mentions WHERE block_id = ?');
    const dropLiterals = db.prepare('DELETE FROM literals WHERE block_id = ?');
    for (const edit of resolved) {
      const newId = idOf.get(edit.block.id) ?? edit.block.id;
      dropMentions.run(edit.block.id);
      dropMentions.run(newId);
      dropLiterals.run(edit.block.id);
      dropLiterals.run(newId);
    }

    // The spans are built before the rows that name them: `span_id` is `uid:ver:0`, and the
    // mentions of the inserted text are written against it.
    const spans: BlockSpan[] = [];
    for (const edit of resolved) {
      const known = live.get(edit.block.id);
      const uid = known?.block_uid ?? newBlockUid(nowMs);
      spans.push(
        makeSpan({
          blockUid: uid,
          ver: (known?.ver ?? 0) + 1,
          blockId: idOf.get(edit.block.id) ?? edit.block.id,
          from: edit.from,
          oldText: edit.edit.oldText,
          newText: edit.edit.newText,
          cause: spanCause,
          at,
        }),
      );
    }
    // ADR-043 D3: binding reads the block's live text, and the span just written names the edit
    // that re-bound it. `editedTexts` is the same list the gap is measured from, so the two
    // cannot disagree about what the block says.
    const editedTexts = resolved.map((edit, index) => ({
      id: idOf.get(edit.block.id) ?? edit.block.id,
      text: edit.newText,
      spanId: spans[index]?.span_id ?? '',
    }));
    const boundBlocks: BoundBlock[] = editedTexts.map((entry) => ({
      spanId: entry.spanId,
      blockId: entry.id,
      text: entry.text,
    }));
    const bound = insertSpanMentions(db, { chapter, blocks: boundBlocks, resolvedBy });

    // ADR-043 L8/D9: a fact-shaped carrier in changed text without a fact mention is a warning,
    // never a refusal (the land refuses in stage 2; this stage records what it sees). The chapter
    // keeps its whole gap as a published number.
    const editedGap = unboundFactShaped(db, chapter, editedTexts);
    const ledgerGap = countUnboundFactShaped(db, chapter);
    const warning =
      editedGap.count === 0
        ? null
        : JSON.stringify({
            code: 'FACT_SHAPED_UNBOUND',
            count: editedGap.count,
            samples: editedGap.samples,
          });
    db.prepare('UPDATE chapters SET ledger_gap = ? WHERE n = ?').run(ledgerGap, chapter);

    const hseq = appendEvent(
      db,
      {
        kind: 'chapter.revised',
        chapter,
        rev,
        changeId,
        cascadeId: cause.cascadeId ?? null,
        stepId,
        authorKind: actor.kind,
        identityId: actor.identityId,
        authorLabel: actor.label,
        payload: {
          blocks: texts.length,
          spans: spans.length,
          mentions: bound.mentions,
          literals: bound.literals,
          sha256,
        },
      },
      nowMs,
    );
    insertRevision(db, {
      chapter,
      rev,
      at,
      kind: 'edit',
      causeKind: cause.kind,
      changeId,
      cascadeId: cause.cascadeId ?? null,
      stepId,
      added: 0,
      changed: resolved.length,
      removed: 0,
      // ADR-043 D5: no chapter snapshot per revision — the block checkpoint is the boundary, and
      // a second copy of the whole chapter is the cost this design exists to avoid.
      snapshot: '',
      // There is no lease to discover here: the caller asserts the cause, so the write is
      // attributed by construction (unlike an observed file write, F015).
      attributed: true,
      hseq,
      logNote: warning ?? cause.label ?? null,
    });
    resolved.forEach((edit, index) => {
      const span = spans[index];
      if (span === undefined) return;
      const known = live.get(edit.block.id);
      const ver = (known?.ver ?? 0) + 1;
      recordPatchedBlock({
        db,
        chapter,
        rev,
        hseq,
        at,
        previousBlockId: edit.block.id,
        blockId: span.block_id,
        blockUid: span.block_uid,
        ver,
        prevVer: known?.ver ?? null,
        textHash: hashOf.get(edit.block.id) ?? edit.block.hash,
        chars: (newTextOf.get(edit.block.id) ?? edit.block.text).length,
        spans: JSON.stringify([span]),
        text: checkpointText(ver, newTextOf.get(edit.block.id) ?? edit.block.text),
        cause: causeForChain,
        actor,
        nowMs,
      });
    });

    return {
      ok: true,
      chapter,
      rev,
      hseq,
      spans: spans.length,
      mentions: bound.mentions,
      literals: bound.literals,
      blocksChanged: resolved.length,
      warnings: warning === null ? 0 : 1,
      ledgerGap,
    };
  });

  return run();
}

/**
 * Undo one revision: read the spans it wrote, apply their inverses in reverse order, and hand
 * the result back to `applyPatch` as an operator's patch. The revert is therefore a revision
 * like any other — it has a cause, a span and an inverse of its own, and it can be reverted.
 */
export function revertRevision(input: {
  db: Db;
  dataDir: string;
  chapter: number;
  rev: number;
  nowMs?: number;
}): ApplyPatchResult {
  const rows = input.db
    .prepare(`SELECT block_id, spans FROM block_versions WHERE chapter = ? AND rev = ? ORDER BY block_uid, ver`)
    .all(input.chapter, input.rev) as Array<{ block_id: string; spans: string | null }>;
  const targets = rows
    .map((row) => ({ blockId: row.block_id, spans: parseSpans(row.spans) }))
    .filter((target) => target.spans.length > 0);
  if (targets.length === 0) return refuse('NOTHING_TO_REVERT', `revision ${String(input.rev)} wrote no spans`);

  const edits: PatchEdit[] = [];
  for (const target of targets) {
    const current = input.db.prepare('SELECT * FROM blocks WHERE id = ?').get(target.blockId) as
      | BlockRow
      | undefined;
    if (current === undefined) return refuse('NOT_REVERSIBLE', 'the block has left the chapter', target.blockId);
    if (target.spans.some((span) => span.invert === null)) {
      return refuse('NOT_REVERSIBLE', 'a span carries no inverse', target.blockId);
    }
    let reverted: string;
    try {
      reverted = applyOps(current.text, target.spans);
    } catch (error) {
      if (error instanceof SpanMismatchError) return refuse('NOT_REVERSIBLE', error.message, target.blockId);
      throw error;
    }
    const window = minimalEdit(current.text, reverted);
    if (window === null) return refuse('NOT_REVERSIBLE', 'nothing to replace', target.blockId);
    if (window.oldText === window.newText) continue;
    edits.push({ blockId: current.id, oldText: window.oldText, newText: window.newText });
  }
  if (edits.length === 0) return refuse('NOTHING_TO_REVERT', 'the text already matches');
  if (edits.length > MAX_EDITS) return refuse('PATCH_INVALID', `revision ${String(input.rev)} touches too many blocks`);

  return applyPatch({
    db: input.db,
    dataDir: input.dataDir,
    chapter: input.chapter,
    patch: { mode: 'patch', edits },
    cause: { kind: 'operator', label: `revert rev ${String(input.rev)}` },
    nowMs: input.nowMs,
  });
}
