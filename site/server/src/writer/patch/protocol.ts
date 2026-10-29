/**
 * The patch protocol (BOOK-173 §1, BOOK-176): the answer's shape, in the ledger's own words.
 *
 * A patch is a **representation of an applied change**, not a new unit of work. On `main` the one
 * write path is the ledger applier (`ledger/patchCheck.ts` + `ledger/applier.ts`), and this file
 * speaks its language: `PatchEdit` is re-exported from `patchCheck`, and every bound (eight
 * edits, `MAX_OLD_CP`/`MAX_NEW_CP` in code points) is enforced by calling `shapeRefusal` itself
 * rather than restating the numbers. The writer adds two fields the ledger does not need —
 * `facts[]` and `note` — and two refusals of its own, both about the *answer*: it is not one JSON
 * object (`PATCH_UNPARSED`), or a field is of the wrong shape (`PATCH_SHAPE`).
 *
 * Parsing is deliberately unforgiving: exactly one JSON object, optionally wrapped in a single
 * ```json fence. Prose around it is `PATCH_UNPARSED`, and there is no "first `{` to last `}`"
 * repair — a guessed patch is worse than a parked pass.
 */

import { cpLength } from '../../ledger/spans.ts';
import {
  MAX_EDITS,
  MAX_NEW_CP,
  MAX_OLD_CP,
  shapeRefusal,
  type ApplyRefusalCode,
  type PatchEdit,
} from '../../ledger/patchCheck.ts';

export type { PatchEdit } from '../../ledger/patchCheck.ts';

/** The ledger's codes this module can speak, pinned by the type so a rename breaks here first. */
type InLedger<T extends ApplyRefusalCode> = T;
export type LedgerRefusal = InLedger<'PATCH_INVALID'>;

/** A parsed patch answer. `mode` is always `patch` here — `rewrite` is the model declining. */
export type PatchAnswer = { mode: 'patch'; edits: PatchEdit[]; facts: string[]; note: string | null };

/**
 * Every way a patch — or its answer's shape — can be refused. The ledger's words come first
 * (`PATCH_INVALID` and, from the applier, the resolution and frame codes); the rest are the
 * writer's own, because the ledger applier never sees a model answer, a fact or a budget.
 */
export type PatchRefusalCode =
  | ApplyRefusalCode
  | 'PATCH_UNPARSED'
  | 'PATCH_SHAPE'
  | 'PATCH_FACTS_INVALID'
  | 'PATCH_LENGTH'
  | 'PATCH_PARAGRAPH_FLOOR'
  | 'PATCH_INVARIANT'
  | 'PATCH_BUDGET_EXCEEDED'
  | 'PATCH_DANGLING_REFERENCE'
  | 'PATCH_FACT_LOST'
  | 'PATCH_NEIGHBOUR_MOVED'
  | `PATCH_REJECTED:${string}`;

export type PatchParse = { ok: true; patch: PatchAnswer } | { ok: false; code: PatchRefusalCode; detail: string };

/** The writer's own bounds; the edit/old/new bounds are the ledger's (`patchCheck.ts`). */
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

/** A block's own shape: one paragraph, no heading, no blank line — one edit is one block. */
function newTextShape(newText: string): string | null {
  if (/\n[^\S\n]*\n/u.test(newText)) return 'newText carries a blank line: one edit is one block';
  if (newText.trimStart().startsWith('#')) return 'newText starts with «#»: a heading is not a block';
  return null;
}

function editOf(raw: unknown): { ok: true; edit: PatchEdit } | { ok: false; code: PatchRefusalCode; detail: string } {
  if (!isRecord(raw)) return { ok: false, code: 'PATCH_SHAPE', detail: 'an edit is not an object' };
  // The ledger names a block by id; there is no insert and no delete (a new paragraph is a
  // rewrite, and an emptied block is `EMPTY_BLOCK` — one vocabulary, one applier).
  if (typeof raw.blockId !== 'string' || raw.blockId.trim().length === 0) {
    return { ok: false, code: 'PATCH_SHAPE', detail: 'an edit needs `blockId`: the id as printed' };
  }
  if (typeof raw.oldText !== 'string') {
    return { ok: false, code: 'PATCH_SHAPE', detail: 'an edit needs `oldText` (the exact bytes it replaces)' };
  }
  if (typeof raw.newText !== 'string') {
    return { ok: false, code: 'PATCH_SHAPE', detail: 'an edit needs `newText` (the replacement bytes)' };
  }
  const problem = newTextShape(raw.newText);
  if (problem !== null) return { ok: false, code: 'PATCH_SHAPE', detail: problem };
  return { ok: true, edit: { blockId: raw.blockId, oldText: raw.oldText, newText: raw.newText } };
}

/**
 * The answer → a patch, or the code that says why it is not one. Order: parse, shape, the
 * ledger's own `shapeRefusal` for the bounds, then "does it change a byte at all" — an answer
 * that names no change is a refusal, not a successful no-op (a silent no-op would read as an
 * applied edit downstream).
 */
export function parsePatchAnswer(raw: string, opts: PatchParseOptions = {}): PatchParse {
  const maxEdits = Math.min(opts.maxEdits ?? MAX_EDITS, MAX_EDITS);
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
  if (payload.edits.length > maxEdits) {
    return bad('PATCH_INVALID', `${String(payload.edits.length)} edits, at most ${String(maxEdits)} are allowed`);
  }
  const edits: PatchEdit[] = [];
  for (const [index, rawEdit] of payload.edits.entries()) {
    const parsed = editOf(rawEdit);
    if (!parsed.ok) return bad(parsed.code, `edit ${String(index + 1)}: ${parsed.detail}`);
    if (opts.maxNewChars !== undefined && cpLength(parsed.edit.newText) > opts.maxNewChars) {
      return bad('PATCH_INVALID', `edit ${String(index + 1)}: newText is longer than ${String(opts.maxNewChars)}`);
    }
    edits.push(parsed.edit);
  }
  // The ledger's own pre-flight, not a second copy of its numbers: no edits, too many, an empty
  // oldText, a text over `MAX_OLD_CP`/`MAX_NEW_CP` — all `PATCH_INVALID` there, all here.
  const shape = shapeRefusal({ mode: 'patch', edits });
  if (shape !== null && !shape.ok) {
    return bad('PATCH_INVALID', shape.detail ?? shape.code);
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
    return bad('PATCH_INVALID', 'every edit replaces its text with itself: no bytes change');
  }
  return { ok: true, patch: { mode: 'patch', edits, facts, note } };
}

/** The bounds the answer must respect, exported for the prompt text (`patch/prompt.ts`). */
export const PATCH_BOUNDS = { maxEdits: MAX_EDITS, maxOldCp: MAX_OLD_CP, maxNewCp: MAX_NEW_CP } as const;
