/**
 * A span is the atomic unit of the book's storage (BOOK-176, BOOK-DOC-69): one replacement of
 * one stretch of one block, written so that it can be read forwards («what did this change
 * do?») and backwards («put it back»).
 *
 * Offsets are **code points**, not UTF-16 units: a span is read by a person and by a model, and
 * an offset that splits a surrogate pair is a broken quote. Darting between the two is the bug
 * this module exists to prevent, so `sliceCp`/`cpLength` are the only places that touch an index.
 *
 * A span carries its own inverse (`invert`) because the text it replaced is not kept anywhere
 * else: `block_versions` stores hashes, and the undo of an edit must not need a whole snapshot.
 * Applying inverses **in reverse order** is what makes an n-edit revision undoable exactly.
 */

export type SpanCauseKind = 'change' | 'pass' | 'legacy';

export type SpanCause = { kind: SpanCauseKind; id: string | null };

/** One replacement inside `insert`-local code points: the exact inverse of its span. */
export type SpanInvert = {
  from: number;
  to: number;
  insert: string;
  removed: string;
};

export type BlockSpan = {
  span_id: string;
  block_id: string;
  block_uid: string;
  /** Code-point offset in the block's text before the edit. */
  from: number;
  /** Code-point offset in the block's text before the edit, exclusive. */
  to: number;
  insert: string;
  removed: string;
  cause: SpanCause;
  at: string;
  /** null only for a span the ledger cannot undo (a legacy backfill, BOOK-DOC-69). */
  invert: SpanInvert | null;
};

export type MakeSpanInput = {
  blockUid: string;
  ver: number;
  blockId: string;
  from: number;
  oldText: string;
  newText: string;
  cause: SpanCause;
  at: string;
};

/** The text of a string as code points — the unit every offset in this module is in. */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

export function cpLength(text: string): number {
  return Array.from(text).length;
}

/** Code-point slice; `from`/`to` are clamped to the text, so a stale offset cannot throw. */
export function sliceCp(text: string, from: number, to: number): string {
  const cps = codePoints(text);
  return cps.slice(Math.max(0, from), Math.min(cps.length, to)).join('');
}

/** Code-point offset of a UTF-16 index — the bridge to `String.prototype.indexOf`. */
export function cpOffsetOf(text: string, utf16Index: number): number {
  return cpLength(text.slice(0, utf16Index));
}

/**
 * One forward span and its inverse. The inverse is expressed in the coordinates of the text the
 * span produced: it replaces `[from, from + cpLength(newText))` with the old text.
 */
export function makeSpan(input: MakeSpanInput): BlockSpan {
  const from = input.from;
  const to = from + cpLength(input.oldText);
  return {
    span_id: `${input.blockUid}:${String(input.ver)}:0`,
    block_id: input.blockId,
    block_uid: input.blockUid,
    from,
    to,
    insert: input.newText,
    removed: input.oldText,
    cause: input.cause,
    at: input.at,
    invert: {
      from,
      to: from + cpLength(input.newText),
      insert: input.oldText,
      removed: input.newText,
    },
  };
}

/**
 * Undo one replacement on the text it produced. The check on `removed` is deliberate: an
 * inverse that no longer matches the text means the block moved under the span, and silently
 * writing the old text into the wrong place is worse than the refusal.
 */
export function applyInvert(text: string, invert: SpanInvert): string {
  const cps = codePoints(text);
  if (invert.from < 0 || invert.to > cps.length || invert.to < invert.from) {
    throw new SpanMismatchError('invert offsets are outside the block text');
  }
  if (sliceCp(text, invert.from, invert.to) !== invert.removed) {
    throw new SpanMismatchError('invert does not match the block text');
  }
  return `${cps.slice(0, invert.from).join('')}${invert.insert}${cps.slice(invert.to).join('')}`;
}

/** A span the ledger cannot undo faithfully — the caller turns this into `NOT_REVERSIBLE`. */
export class SpanMismatchError extends Error {
  readonly code = 'SPAN_MISMATCH';
  constructor(message: string) {
    super(message);
    this.name = 'SpanMismatchError';
  }
}

/**
 * Undo a version's spans. Reverse order: each later span was written against coordinates that
 * only exist after the earlier ones, so undoing them forwards would edit the wrong place.
 */
export function applyOps(text: string, spans: ReadonlyArray<BlockSpan>): string {
  let current = text;
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index];
    if (span === undefined) continue;
    if (span.invert === null) throw new SpanMismatchError(`span ${span.span_id} has no inverse`);
    current = applyInvert(current, span.invert);
  }
  return current;
}

/**
 * The smallest replacement that turns `current` into `next`, or null when no such non-empty
 * replacement exists. A revert is a patch like any other, and a patch replaces a stretch — so
 * the common head and tail are kept out of it. That is not an optimisation: the applier accepts
 * at most 2 000 replaced code points, and a paragraph the book actually writes is longer.
 *
 * It lives here, with the other code-point arithmetic: an offset that splits a surrogate pair is
 * the bug this module exists to prevent, and a window computed in UTF-16 would reintroduce it.
 */
export function minimalEdit(current: string, next: string): { oldText: string; newText: string } | null {
  const before = Array.from(current);
  const after = Array.from(next);
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
  const cut = (): { oldText: string; newText: string } => ({
    oldText: before.slice(head, before.length - tail).join(''),
    newText: after.slice(head, after.length - tail).join(''),
  });
  let window = cut();
  // A pure insertion has an empty `oldText`; the applier refuses that, so one code point of
  // context joins the patch. The result is still exactly `next`.
  if (window.oldText === '') {
    if (head > 0) head -= 1;
    else if (tail > 0) tail -= 1;
    window = cut();
  }
  return window.oldText === '' ? null : window;
}

/**
 * Replay a version forwards: apply its spans in the order they were written, each against the
 * text its own coordinates belong to. The `removed` check is the promise of the change span — a
 * replay that silently skips a span would make «было / стало» a guess.
 */
export function applyForward(text: string, spans: ReadonlyArray<BlockSpan>): string {
  let current = text;
  for (const span of spans) {
    const cps = codePoints(current);
    if (span.from < 0 || span.to > cps.length || span.to < span.from) {
      throw new SpanMismatchError(`span ${span.span_id} is outside the replayed text`);
    }
    if (sliceCp(current, span.from, span.to) !== span.removed) {
      throw new SpanMismatchError(`span ${span.span_id} does not match the replayed text`);
    }
    current = `${cps.slice(0, span.from).join('')}${span.insert}${cps.slice(span.to).join('')}`;
  }
  return current;
}

/** `spans` is a JSON column: parse it defensively — a malformed row is an empty history. */
export function parseSpans(json: string | null | undefined): BlockSpan[] {
  if (json === null || json === undefined || json.trim() === '' || json.trim() === '[]') return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as BlockSpan[]) : [];
  } catch {
    return [];
  }
}
