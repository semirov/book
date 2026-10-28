/**
 * The patch protocol (BOOK-173 §1): one JSON object, and the answer's own shape.
 *
 * A patch is a **representation of an applied change**, not a new unit of work: the model does
 * not describe an edit in words, it names a block that exists, quotes the bytes it replaces,
 * and gives the bytes that take their place. The applier (`apply.ts`) can therefore prove the
 * edit instead of trusting it, which is the whole safety story (§7).
 *
 * Parsing is deliberately unforgiving: exactly one JSON object, optionally wrapped in a single
 * ```json fence. Prose around it is `PATCH_UNPARSED`, and there is no "first `{` to last `}`"
 * repair — a guessed patch is worse than a parked pass. Nothing here decides whether the patch
 * is *good*: that is the applier's and the integrity checks' business.
 */

/** One edit: replace `oldText` inside the named block with `newText`, or insert a new block. */
export type PatchEdit = { blockId: string | null; afterBlockId?: string | null; oldText: string; newText: string };

/** A parsed patch answer. `mode` is always `patch` here — `rewrite` is the model declining. */
export type PatchAnswer = { mode: 'patch'; edits: PatchEdit[]; facts: string[]; note: string | null };

/**
 * Every way a patch — or its answer's shape — can be refused. The applier's codes are its own;
 * the parse codes name what never reached the applier.
 */
export type PatchRefusalCode =
  | 'PATCH_UNPARSED'
  | 'PATCH_SHAPE'
  | 'PATCH_TOO_MANY_EDITS'
  | 'PATCH_EDIT_TOO_LARGE'
  | 'PATCH_FACTS_INVALID'
  | 'PATCH_EMPTY'
  | 'PATCH_UNKNOWN_BLOCK'
  | 'PATCH_OLD_TEXT_NOT_FOUND'
  | 'PATCH_OLD_TEXT_AMBIGUOUS'
  | 'PATCH_OLD_TEXT_EMPTY'
  | 'PATCH_OVERLAP'
  | 'PATCH_FRAME_TOUCHED'
  | 'PATCH_BUDGET_EXCEEDED'
  | 'PATCH_TITLE'
  | 'PATCH_LENGTH'
  | 'PATCH_PARAGRAPH_FLOOR'
  | 'PATCH_INVARIANT'
  | 'PATCH_DANGLING_REFERENCE'
  | 'PATCH_FACT_LOST'
  | 'PATCH_NEIGHBOUR_MOVED'
  | `PATCH_REJECTED:${string}`;

export type PatchParse = { ok: true; patch: PatchAnswer } | { ok: false; code: PatchRefusalCode; detail: string };

/** §1's bounds, in one place: the parser refuses what the applier could not honour anyway. */
export const PATCH_MAX_EDITS = 8;
export const PATCH_MAX_OLD_CHARS = 2_000;
export const PATCH_MAX_NEW_CHARS = 4_000;
export const PATCH_MAX_FACTS = 12;
export const PATCH_MAX_FACT_CHARS = 200;
export const PATCH_MAX_NOTE_CHARS = 400;

export type PatchParseOptions = { maxEdits?: number; maxNewChars?: number };

function bad(code: PatchRefusalCode, detail: string): PatchParse {
  return { ok: false, code, detail };
}

/** One surrounding fence is tolerated and stripped; anything else is not a patch answer. */
export function stripPatchFence(raw: string): string {
  const text = (raw ?? '').replace(/^\uFEFF/u, '').trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(text);
  return match?.[1] === undefined ? text : match[1].trim();
}

/**
 * The `mode` the model declared, read before the patch contract is applied: `rewrite` is an
 * answer, not a malformed patch (one step, no retry — §4). `null` when no JSON object states one.
 */
export function declaredPatchMode(raw: string): 'patch' | 'rewrite' | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripPatchFence(raw));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const mode = (parsed as { mode?: unknown }).mode;
  return mode === 'patch' || mode === 'rewrite' ? mode : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The shape of `newText`, then its size: two paragraphs smuggled into one edit and a heading
 * are shape errors (§1), while a text over the bound is a size error with its own code.
 */
function newTextShape(newText: string): string | null {
  if (/\n[^\S\n]*\n/u.test(newText)) return 'newText carries a blank line: one edit is one block';
  if (newText.trimStart().startsWith('#')) return 'newText starts with «#»: a heading is not a block';
  return null;
}

function editOf(raw: unknown, maxNewChars: number): { ok: true; edit: PatchEdit } | { ok: false; code: PatchRefusalCode; detail: string } {
  if (!isRecord(raw)) return { ok: false, code: 'PATCH_SHAPE', detail: 'an edit is not an object' };
  const blockId = raw.blockId;
  if (blockId !== null && typeof blockId !== 'string') {
    return { ok: false, code: 'PATCH_SHAPE', detail: 'an edit needs `blockId`: an id as printed, or null' };
  }
  if (typeof blockId === 'string' && blockId.trim().length === 0) {
    return { ok: false, code: 'PATCH_SHAPE', detail: 'blockId is empty' };
  }
  const afterBlockId = raw.afterBlockId;
  if (afterBlockId !== undefined && afterBlockId !== null && typeof afterBlockId !== 'string') {
    return { ok: false, code: 'PATCH_SHAPE', detail: 'afterBlockId is neither an id nor null' };
  }
  if (typeof raw.oldText !== 'string') {
    return { ok: false, code: 'PATCH_SHAPE', detail: 'an edit needs `oldText` (the exact bytes it replaces)' };
  }
  if (typeof raw.newText !== 'string') {
    return { ok: false, code: 'PATCH_SHAPE', detail: 'an edit needs `newText` (empty text deletes)' };
  }
  const oldText = raw.oldText;
  const newText = raw.newText;
  if (oldText.length > PATCH_MAX_OLD_CHARS) {
    return {
      ok: false,
      code: 'PATCH_EDIT_TOO_LARGE',
      detail: `oldText is ${String(oldText.length)} characters, at most ${String(PATCH_MAX_OLD_CHARS)} are allowed`,
    };
  }
  const problem = newTextShape(newText);
  if (problem !== null) return { ok: false, code: 'PATCH_SHAPE', detail: problem };
  if (newText.length > maxNewChars) {
    return {
      ok: false,
      code: 'PATCH_EDIT_TOO_LARGE',
      detail: `newText is ${String(newText.length)} characters, at most ${String(maxNewChars)} are allowed`,
    };
  }
  if (blockId === null) {
    if (typeof afterBlockId !== 'string' || afterBlockId.trim().length === 0) {
      return { ok: false, code: 'PATCH_SHAPE', detail: 'an insert needs `afterBlockId`: the block it goes after' };
    }
    if (oldText.length !== 0) {
      return { ok: false, code: 'PATCH_SHAPE', detail: 'an insert has no pre-image: oldText must be empty' };
    }
    return { ok: true, edit: { blockId: null, afterBlockId, oldText, newText } };
  }
  return {
    ok: true,
    edit: typeof afterBlockId === 'string' ? { blockId, afterBlockId, oldText, newText } : { blockId, oldText, newText },
  };
}

/**
 * The answer → a patch, or the code that says why it is not one. Order: parse, shape, bounds,
 * then "does it change a byte at all" — an answer that names no change is a refusal, not a
 * successful no-op (a silent no-op would read as an applied edit downstream).
 */
export function parsePatchAnswer(raw: string, opts: PatchParseOptions = {}): PatchParse {
  const maxEdits = opts.maxEdits ?? PATCH_MAX_EDITS;
  const maxNewChars = opts.maxNewChars ?? PATCH_MAX_NEW_CHARS;
  let payload: unknown;
  try {
    payload = JSON.parse(stripPatchFence(raw));
  } catch {
    return bad('PATCH_UNPARSED', 'the answer is not exactly one JSON object');
  }
  if (!isRecord(payload)) return bad('PATCH_SHAPE', 'the answer is not a JSON object');
  if (payload.mode !== 'patch') {
    return bad('PATCH_SHAPE', '`mode` must be "patch" (an answer that rewrites says "rewrite")');
  }
  if (!Array.isArray(payload.edits)) return bad('PATCH_SHAPE', '`edits` must be an array');
  if (payload.edits.length === 0) return bad('PATCH_EMPTY', 'no edits: a patch that changes nothing is a refusal');
  if (payload.edits.length > maxEdits) {
    return bad('PATCH_TOO_MANY_EDITS', `${String(payload.edits.length)} edits, at most ${String(maxEdits)} are allowed`);
  }
  const edits: PatchEdit[] = [];
  for (const [index, rawEdit] of payload.edits.entries()) {
    const parsed = editOf(rawEdit, maxNewChars);
    if (!parsed.ok) return bad(parsed.code, `edit ${String(index + 1)}: ${parsed.detail}`);
    edits.push(parsed.edit);
  }
  if (!Array.isArray(payload.facts)) return bad('PATCH_SHAPE', '`facts` must be an array (it may be empty)');
  if (payload.facts.length > PATCH_MAX_FACTS) {
    return bad('PATCH_FACTS_INVALID', `${String(payload.facts.length)} facts, at most ${String(PATCH_MAX_FACTS)} are allowed`);
  }
  const facts: string[] = [];
  for (const [index, rawFact] of payload.facts.entries()) {
    if (typeof rawFact !== 'string' || rawFact.trim().length === 0) {
      return bad('PATCH_FACTS_INVALID', `fact ${String(index + 1)} is not a quoted string`);
    }
    if (rawFact.length > PATCH_MAX_FACT_CHARS) {
      return bad('PATCH_FACTS_INVALID', `fact ${String(index + 1)} is longer than ${String(PATCH_MAX_FACT_CHARS)} characters`);
    }
    facts.push(rawFact);
  }
  const rawNote = payload.note;
  if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') {
    return bad('PATCH_SHAPE', '`note` must be a string or absent');
  }
  const note = typeof rawNote === 'string' ? rawNote : null;
  if (note !== null && note.length > PATCH_MAX_NOTE_CHARS) {
    return bad('PATCH_SHAPE', `note is longer than ${String(PATCH_MAX_NOTE_CHARS)} characters`);
  }
  if (!edits.some((edit) => edit.newText !== edit.oldText)) {
    return bad('PATCH_EMPTY', 'every edit replaces its text with itself: no bytes change');
  }
  return { ok: true, patch: { mode: 'patch', edits, facts, note } };
}
