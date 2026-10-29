/**
 * The delta of one block version (ADR-041 §2.2, ADR-043 §4, BOOK-187 AC 10).
 *
 * A version is its predecessor **plus an op list**, and the op list carries only the text that
 * was inserted — never the text that was deleted, and never a second copy of the paragraph. That
 * is the whole point of the shape `[["retain",n],["insert",n,"text"],["delete",n]]`:
 *
 *   · replay — `applyDelta(prevText, ops)` is the next text, and that is asserted on write;
 *   · blame — walking a position back over the ops says which version borned it;
 *   · diff — for a future word-granular presentation, the ops are the exact record.
 *
 * Offsets are **Unicode code points**, 0-based, counted inside one block — the unit the ledger's
 * spans use, the unit SQLite's `substr()` counts and the unit a UI selection gives. Every index
 * here goes through `codePoints`/`cpLength`; a surrogate pair is the one place a diff can be
 * wrong, and it is tested.
 *
 * The diff is a deterministic function of the two texts (no clock, no random, no locale), because
 * a row that could not be reproduced would make «восстановлено по разнице» a guess.
 */

import { codePoints, cpLength, type BlockSpan, sliceCp } from '../ledger/spans.ts';

/** One op of a version delta: keep `n`, insert `n` code points of `text`, drop `n`. */
export type DeltaOp = ['retain', number] | ['insert', number, string] | ['delete', number];

/**
 * The middle-of-the-block diff is a plain Myers walk up to this many code points on both sides;
 * beyond it the middle is recorded as one replacement (`delete` + `insert`). Deterministic in both
 * branches: a paragraph is ~160 code points, so the fallback is the rare, honest answer for a
 * genuinely unrelated rewrite, never the path a normal edit takes.
 */
export const MAX_DIFF_CP = 4_000;

type Move = 'retain' | 'insert' | 'delete';

/** Append one op, coalescing it with the previous one of the same kind. */
function push(ops: DeltaOp[], kind: 'retain' | 'delete', count: number): void;
function push(ops: DeltaOp[], kind: 'insert', count: number, text: string): void;
function push(ops: DeltaOp[], kind: Move, count: number, text?: string): void {
  if (count <= 0) return;
  const last = ops[ops.length - 1];
  if (last !== undefined) {
    if (last[0] === 'retain' && kind === 'retain') {
      ops[ops.length - 1] = ['retain', last[1] + count];
      return;
    }
    if (last[0] === 'delete' && kind === 'delete') {
      ops[ops.length - 1] = ['delete', last[1] + count];
      return;
    }
    if (last[0] === 'insert' && kind === 'insert') {
      ops[ops.length - 1] = ['insert', last[1] + count, last[2] + (text ?? '')];
      return;
    }
  }
  if (kind === 'retain') ops.push(['retain', count]);
  else if (kind === 'delete') ops.push(['delete', count]);
  else ops.push(['insert', count, text ?? '']);
}

/** Read a delta op list written by `diffOps`/`opsOfSpan`; a malformed row is an empty list. */
export function parseDeltaOps(json: string | null | undefined): DeltaOp[] {
  if (json === null || json === undefined || json.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ops: DeltaOp[] = [];
  for (const raw of parsed as unknown[]) {
    if (!Array.isArray(raw) || typeof raw[1] !== 'number') return [];
    const count = raw[1];
    const kind = raw[0];
    if (kind === 'retain' || kind === 'delete') ops.push([kind, count]);
    else if (kind === 'insert' && typeof raw[2] === 'string') ops.push(['insert', count, raw[2]]);
    else return [];
  }
  return ops;
}

export function serializeDeltaOps(ops: ReadonlyArray<DeltaOp>): string {
  return JSON.stringify(ops);
}

/**
 * The next text from the previous text and the ops. Retain and delete move the read cursor,
 * insert appends; every offset is a code point, so an astral character is one step, not two.
 * A cursor that runs past the text is clamped (the same defensive rule as `sliceCp`) — the writer
 * verifies `applyDelta(prev, ops) === next` before a row exists, so a clamp is never silent.
 */
export function applyDelta(text: string, ops: ReadonlyArray<DeltaOp>): string {
  const cps = codePoints(text);
  let at = 0;
  let out = '';
  for (const op of ops) {
    if (op[0] === 'retain') {
      out += cps.slice(at, at + op[1]).join('');
      at += op[1];
      continue;
    }
    if (op[0] === 'delete') {
      at += op[1];
      continue;
    }
    out += op[2];
  }
  return out;
}

/** The code points an op list consumes from the previous text and produces for the next one. */
export function deltaLengths(ops: ReadonlyArray<DeltaOp>): { oldLen: number; newLen: number } {
  let oldLen = 0;
  let newLen = 0;
  for (const op of ops) {
    if (op[0] === 'retain') {
      oldLen += op[1];
      newLen += op[1];
    } else if (op[0] === 'delete') oldLen += op[1];
    else newLen += op[1];
  }
  return { oldLen, newLen };
}

/**
 * The ops of the version delta, from the previous text to the next one.
 *
 * Common head and tail are kept out of the walk (they are the same characters in both texts, and
 * the Myers walk would spend its first steps re-proving it), the middle is diffed, the runs are
 * coalesced. Nothing about the result depends on anything but the two arguments.
 */
export function diffOps(prev: string, next: string): DeltaOp[] {
  const before = codePoints(prev);
  const after = codePoints(next);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midBefore = before.slice(head, before.length - tail);
  const midAfter = after.slice(head, after.length - tail);
  const ops: DeltaOp[] = [];
  push(ops, 'retain', head);
  if (midBefore.length + midAfter.length > MAX_DIFF_CP) {
    push(ops, 'insert', midAfter.length, midAfter.join(''));
    push(ops, 'delete', midBefore.length);
  } else {
    appendMoves(ops, midBefore, midAfter, myersMoves(midBefore, midAfter));
  }
  push(ops, 'retain', tail);
  return ops;
}

/**
 * The ops of a version whose exact span the caller supplied (a real patch). The span names the
 * stretch it replaced (`from`, `removed`) and the text that took its place (`insert`), so the op
 * list is that span written out — no diff is computed, and the row says `source = 'patch'`.
 */
export function opsOfSpan(prevText: string, span: BlockSpan): DeltaOp[] {
  const removedLen = cpLength(span.removed);
  const insertedLen = cpLength(span.insert);
  const rest = cpLength(prevText) - span.from - removedLen;
  const ops: DeltaOp[] = [];
  push(ops, 'retain', span.from);
  push(ops, 'insert', insertedLen, span.insert);
  push(ops, 'delete', removedLen);
  push(ops, 'retain', rest);
  return ops;
}

/** Does the span name the stretch of `text` it claims to have replaced? */
export function spanFits(text: string, span: BlockSpan): boolean {
  const removedLen = cpLength(span.removed);
  if (span.from < 0 || span.from + removedLen > cpLength(text)) return false;
  return sliceCp(text, span.from, span.from + removedLen) === span.removed;
}

/** One move list → ops, taking the inserted characters from `after` in order. */
function appendMoves(ops: DeltaOp[], before: ReadonlyArray<string>, after: ReadonlyArray<string>, moves: Move[]): void {
  let oldAt = 0;
  let newAt = 0;
  for (const move of moves) {
    if (move === 'retain') {
      push(ops, 'retain', 1);
      oldAt += 1;
      newAt += 1;
    } else if (move === 'delete') {
      push(ops, 'delete', 1);
      oldAt += 1;
    } else {
      push(ops, 'insert', 1, after[newAt] ?? '');
      newAt += 1;
    }
  }
  // The walk must consume both sides exactly; a shorter list would silently drop text.
  if (oldAt !== before.length || newAt !== after.length) {
    throw new Error(`diff consumed ${String(oldAt)}/${String(before.length)} and ${String(newAt)}/${String(after.length)}`);
  }
}

/**
 * The Myers shortest-edit-script walk over two code-point arrays, as a move list.
 *
 * `trace[d]` is the frontier **before** step d, so the backtrack reads the predecessor of the
 * final snake from it and walks down to d = 0. The frontier is an `Int32Array` indexed by
 * `offset + k`; absent diagonals hold -1, and the algorithm only ever reads a diagonal that an
 * earlier step has set, so -1 is never compared as a real endpoint.
 */
function myersMoves(before: ReadonlyArray<string>, after: ReadonlyArray<string>): Move[] {
  const n = before.length;
  const m = after.length;
  if (n === 0) return new Array<Move>(m).fill('insert');
  if (m === 0) return new Array<Move>(n).fill('delete');

  const max = n + m;
  const offset = max + 1;
  const frontier = new Int32Array(2 * max + 3).fill(-1);
  frontier[offset + 1] = 0;
  const trace: Int32Array[] = [];
  let found = -1;

  for (let d = 0; d <= max && found < 0; d += 1) {
    trace.push(frontier.slice());
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && frontier[offset + k - 1]! < frontier[offset + k + 1]!);
      let x = down ? frontier[offset + k + 1]! : frontier[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }

  const moves: Move[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d -= 1) {
    const step = trace[d];
    if (step === undefined) break;
    const k = x - y;
    const down = k === -d || (k !== d && step[offset + k - 1]! < step[offset + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = step[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      moves.push('retain');
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) {
        moves.push('insert');
        y -= 1;
      } else {
        moves.push('delete');
        x -= 1;
      }
    }
  }
  return moves.reverse();
}
