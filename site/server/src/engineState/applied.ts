/**
 * BOOK-DOC-84 D1 — the write as a frame: `chapter:applied`.
 *
 * The pass's text write is the one fact whose timestamp means «the text became live then», so
 * it is published at the moment the revision row is created, with a bounded block delta, the
 * write's own wall clock in ms, and the span of every changed block. The print is clocked from
 * `appliedAt`; `landed` stays the pass's accounting stage and starts no animation.
 *
 * Everything here is derived from rows the engine already writes: the `revisions` row of `rev`
 * and of `rev − 1`, and the two content-addressed snapshots those rows name. Rev 1 has no
 * pre-image — a create is `before: ''` — and a snapshot that cannot be read is **not** guessed
 * at: the answer is `patchTruncated: true, span: null`, and the page prints nothing.
 *
 * The site only reads (§4.2): no write, no lease, no gate fact. `chars` is the written length of
 * *this* revision; `blocksTouched` is the revision's own counters.
 */

import { directionOf, type Lane, type PatchOp, type StageSpan } from '@book/shared';
import { STAGE_SPAN_MAX_BLOCKS, STAGE_SPAN_MAX_CHARS } from '@book/shared';

import type { Db } from '../db/db.ts';
import type { BlockRow } from '../db/repo/chapters.ts';
import { parseChapter, type ParsedChapter } from '../ingest/parseChapter.ts';
import { PATCH_MAX_BYTES, patchBlocks, patchSize } from '../ingest/patchBlocks.ts';
import { readSnapshot } from '../versions/snapshots.ts';

export type RevisionKind = 'create' | 'edit' | 'rewrite' | 'polish' | 'restore';

/** One `revisions` row, narrowed to what the frame may carry. */
type RevisionRow = {
  chapter: number;
  rev: number;
  at: string;
  kind: RevisionKind;
  cause_kind: string;
  change_id: string | null;
  cascade_id: string | null;
  step_id: string | null;
  added: number;
  changed: number;
  removed: number;
  snapshot: string;
  attributed: number;
  hseq: number | null;
};

/** The frame's own shape, before it is put on the wire (§2.1 #6). */
export type AppliedRead = {
  n: number;
  rev: number;
  hseq: number | null;
  /** ms epoch of the write (`revisions.at`), never `landed.at`. */
  appliedAt: number;
  createdAt: string;
  kind: RevisionKind;
  cause: {
    stepId: string | null;
    changeId: string | null;
    cascadeId: string | null;
    lane: Lane | null;
    direction: 'forward' | 'backward' | null;
  };
  patch: PatchOp[];
  patchTruncated: boolean;
  span: StageSpan[] | null;
  chars: number;
  delta: number;
  blocksTouched: number;
  attributed: boolean;
};

export type AppliedOptions = {
  db: Db;
  dataDir: string;
  chapter: number;
  rev: number;
};

/** The empty text a create started from: no title, no block, no characters. */
function EMPTY_CHAPTER(chapter: number): ParsedChapter {
  return { n: chapter, title: null, titleProblems: [], text: '', body: '', sha256: '', chars: 0, blocks: [], basis: false };
}

function revisionRow(db: Db, chapter: number, rev: number): RevisionRow | undefined {
  return db.prepare('SELECT * FROM revisions WHERE chapter = ? AND rev = ?').get(chapter, rev) as
    | RevisionRow
    | undefined;
}

/** One revision's text, parsed; `null` when the snapshot is not readable (retention, a bad path). */
function chapterOf(dataDir: string, row: RevisionRow | undefined): ParsedChapter | null {
  if (row === undefined) return null;
  const text = readSnapshot(dataDir, row.snapshot);
  if (text === null) return null;
  return parseChapter(row.chapter, text);
}

/**
 * The span of the write: every changed block's words, in document order, bounded per side and
 * in count. A `remove` has no new text — `after` is `''`, which is what left the page.
 */
function spanOf(before: ReadonlyMap<string, string>, patch: readonly PatchOp[]): StageSpan[] | null {
  if (patch.length === 0) return null;
  const span: StageSpan[] = [];
  for (const [index, op] of patch.entries()) {
    if (index >= STAGE_SPAN_MAX_BLOCKS) break;
    const old = op.op === 'insert' ? '' : (before.get(op.id) ?? '');
    const next = op.op === 'remove' ? '' : (op.text ?? '');
    const beforeText = old.slice(0, STAGE_SPAN_MAX_CHARS);
    const afterText = next.slice(0, STAGE_SPAN_MAX_CHARS);
    // A span cut at its own bound names itself; the page reads the rest from the chapter.
    const truncated = beforeText.length < old.length || afterText.length < next.length;
    span.push({
      blockId: op.op === 'remove' ? op.id : (op.newId ?? op.id),
      before: beforeText,
      after: afterText,
      truncated,
    });
  }
  return span.length === 0 ? null : span;
}

/** A parsed block as the patcher reads it: a `BlockRow` whose row-only columns are its own. */
function blockRows(chapter: ParsedChapter): BlockRow[] {
  return chapter.blocks.map((block) => ({
    id: block.id,
    chapter: chapter.n,
    idx: block.i,
    text: block.text,
    hash: block.hash,
    first_rev: 0,
    last_rev: 0,
  }));
}

/** The lane a write belongs to: the step's own (`steps.lane`), else the chapter's direction. */
function laneOf(db: Db, row: RevisionRow, chapter: number): Lane | null {
  if (row.step_id !== null) {
    const step = db.prepare('SELECT lane FROM steps WHERE step_id = ?').get(row.step_id) as
      | { lane: Lane | null }
      | undefined;
    if (step !== undefined && step.lane !== null) return step.lane;
  }
  return directionOf(chapter);
}

/**
 * Read one write. Returns `null` when the revision row itself is missing — nothing to frame.
 *
 * The contract on a broken pre-image is the design's, not a variant: `patchTruncated: true` and
 * `span: null` (the page prints nothing), because a guessed delta would be a lie about the words.
 */
export function readApplied(options: AppliedOptions): AppliedRead | null {
  const { db, dataDir, chapter, rev } = options;
  const row = revisionRow(db, chapter, rev);
  if (row === undefined) return null;

  // Rev 1 has no pre-image, and that is not a missing one: a create is `before: ''` (§2.2).
  const before = rev > 1 ? chapterOf(dataDir, revisionRow(db, chapter, rev - 1)) : EMPTY_CHAPTER(chapter);
  const after = chapterOf(dataDir, row);
  const chapterRow = db.prepare('SELECT rev, chars FROM chapters WHERE n = ?').get(chapter) as
    | { rev: number; chars: number }
    | undefined;

  let patch: PatchOp[] = [];
  let patchTruncated = before === null || after === null;
  let span: StageSpan[] | null = null;
  let chars = after?.chars ?? 0;
  let delta = 0;

  if (before !== null && after !== null) {
    patch = patchBlocks(blockRows(before), after.blocks);
    const changed = before.blocks.length !== after.blocks.length || before.blocks.some((block, i) => block.hash !== after.blocks[i]?.hash);
    if (patchSize(patch) > PATCH_MAX_BYTES) {
      // §10.3: a patch larger than the bound is not framed; the client refetches instead.
      patch = [];
      patchTruncated = true;
    } else if (changed && patch.length === 0) {
      // A malformed script is worse than a refetch: no patch, no span, nothing printed.
      patchTruncated = true;
    }
    if (!patchTruncated) {
      span = spanOf(new Map(before.blocks.map((block) => [block.id, block.text])), patch);
    }
    delta = after.chars - before.chars;
  } else if (chapterRow !== undefined && chapterRow.rev === rev && after === null) {
    // The snapshots are gone (retention): the row still says how long the chapter is, and the
    // frame is flagged truncated, so nothing prints from an unreadable pre-image.
    chars = chapterRow.chars;
  }

  return {
    n: row.chapter,
    rev: row.rev,
    hseq: row.hseq,
    appliedAt: Date.parse(row.at),
    createdAt: row.at,
    kind: row.kind,
    cause: {
      stepId: row.step_id,
      changeId: row.change_id,
      cascadeId: row.cascade_id,
      lane: laneOf(db, row, chapter),
      direction: directionOf(chapter),
    },
    patch,
    patchTruncated,
    span,
    chars,
    delta,
    blocksTouched: row.added + row.changed + row.removed,
    attributed: row.attributed === 1,
  };
}
