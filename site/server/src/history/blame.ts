/**
 * «Кто это написал» — the origin of one character (ADR-041 §2.2, ADR-043 §4, BOOK-187 AC 10).
 *
 * `git blame` on a working tree answers one question: which commit, and when, brought this
 * character to where it stands. Nothing in the book's history was ever a commit, and the answer
 * here is not a commit either — it is the **version** whose insert op put the character into the
 * paragraph, and the revision and change that version belongs to.
 *
 * The walk starts at the live version of the block and goes back over `block_deltas`:
 *
 *   · a position inside an `insert` op was born at that `to_ver` — the answer;
 *   · a position inside a `retain` op existed before this version: shift it into the previous
 *     text's coordinates (past the deletes, which occupy no position in the new text) and go on;
 *   · a version with no delta is the end of what the ledger knows: the block was introduced
 *     there (its text is a fact of that revision), or an older install left no record of the step.
 *
 * `exact` is the honesty bit of ADR-041 §2.2. A `patch` delta came with the exact span of the
 * edit, so a character inside its insert really was written by that pass (`exact = 1`; the panel
 * says «правка · №12, 28.10.2026, 13:40»). A `diff` delta is an alignment this system computed
 * over a whole-body rewrite that never declared where the change was: the origin is a best
 * reconstruction, and the panel says «восстановлено по разнице» (`exact = 0`).
 *
 * Offsets are code points (the unit the deltas are written in, and the unit a selection gives),
 * and every miss is a named reason, never an exception: a paragraph with no deltas, a position
 * past the end of the text, a block that has left the chapter.
 */

import type { Db } from '../db/db.ts';
import { cpLength } from '../ledger/spans.ts';
import { parseDeltaOps, type DeltaOp } from './delta.ts';

export type BlamePoint = {
  chapter: number;
  blockUid: string;
  /** The code-point offset inside the block, echoed back so a caller can quote the answer. */
  pos: number;
  /** The revision that wrote the character, and its moment. */
  rev: number;
  at: string;
  changeId: string | null;
  stepId: string | null;
  /** 1 — a real edit; 0 — recovered from a rewrite's computed diff (ADR-041 §2.2). */
  exact: 0 | 1;
};

/** Why there is no answer. Never thrown: the panel prints the reason, it does not crash. */
export type BlameReason =
  | 'no-block'
  | 'not-live'
  | 'no-deltas'
  | 'pos-out-of-range'
  | 'chain-broken'
  | 'chain-too-long';

export type BlameAnswer = { blame: BlamePoint | null; reason: BlameReason | null };

type VersionRow = {
  ver: number;
  rev: number;
  at: string;
  op: string;
  block_id: string;
  change_id: string | null;
  step_id: string | null;
};

type DeltaRow = { from_ver: number; to_ver: number; ops: string; source: string };

/** The chain is finite by construction; the guard only stops a corrupted row from looping. */
const MAX_STEPS = 1_000;

/**
 * Where a position of the next text came from in the previous one: a retained offset, an insert
 * (born at this version), or nothing at all (the ops do not cover the position — a broken row).
 */
export function mapBack(
  ops: ReadonlyArray<DeltaOp>,
  pos: number,
): { kind: 'retain'; pos: number } | { kind: 'insert' } | null {
  let next = 0;
  let prev = 0;
  for (const op of ops) {
    if (op[0] === 'retain') {
      if (pos < next + op[1]) return { kind: 'retain', pos: prev + (pos - next) };
      next += op[1];
      prev += op[1];
      continue;
    }
    if (op[0] === 'insert') {
      if (pos < next + op[1]) return { kind: 'insert' };
      next += op[1];
      continue;
    }
    prev += op[1];
  }
  return null;
}

export function blame(db: Db, chapter: number, blockUid: string, pos: number): BlameAnswer {
  const versions = db
    .prepare(
      `SELECT ver, rev, at, op, block_id, change_id, step_id FROM block_versions
        WHERE block_uid = ? AND chapter = ? ORDER BY ver`,
    )
    .all(blockUid, chapter) as VersionRow[];
  const latest = versions[versions.length - 1];
  if (latest === undefined) return { blame: null, reason: 'no-block' };
  // An erased paragraph is not one a reader can point at: there is no live text to offset into.
  if (latest.op === 'erased') return { blame: null, reason: 'not-live' };

  const block = db.prepare('SELECT text FROM blocks WHERE id = ? AND chapter = ?').get(latest.block_id, chapter) as
    | { text: string }
    | undefined;
  if (block === undefined) return { blame: null, reason: 'not-live' };
  const length = cpLength(block.text);
  if (!Number.isInteger(pos) || pos < 0 || pos >= length) return { blame: null, reason: 'pos-out-of-range' };

  const deltas = new Map<number, DeltaRow>();
  for (const row of db
    .prepare('SELECT from_ver, to_ver, ops, source FROM block_deltas WHERE block_uid = ?')
    .all(blockUid) as DeltaRow[]) {
    deltas.set(row.to_ver, row);
  }
  if (deltas.size === 0) return { blame: null, reason: 'no-deltas' };

  const byVer = new Map(versions.map((row) => [row.ver, row]));
  let ver = latest.ver;
  let offset = pos;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const row = byVer.get(ver);
    if (row === undefined) return { blame: null, reason: 'chain-broken' };
    const delta = deltas.get(ver);
    // The end of the ledger: the block came into being at this version (its text is a fact of the
    // pass that wrote it), or an older install recorded no step for it — then the origin is a
    // reconstruction and says so.
    if (delta === undefined) {
      return { blame: point(chapter, blockUid, pos, row, row.op === 'introduced' ? 1 : 0), reason: null };
    }
    const mapped = mapBack(parseDeltaOps(delta.ops), offset);
    if (mapped === null) return { blame: null, reason: 'pos-out-of-range' };
    if (mapped.kind === 'insert') {
      return { blame: point(chapter, blockUid, pos, row, delta.source === 'patch' ? 1 : 0), reason: null };
    }
    offset = mapped.pos;
    ver = delta.from_ver;
  }
  return { blame: null, reason: 'chain-too-long' };
}

function point(chapter: number, blockUid: string, pos: number, row: VersionRow, exact: 0 | 1): BlamePoint {
  return {
    chapter,
    blockUid,
    pos,
    rev: row.rev,
    at: row.at,
    changeId: row.change_id,
    stepId: row.step_id,
    exact,
  };
}
