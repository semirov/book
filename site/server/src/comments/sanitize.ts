/**
 * Comment input normalization (ARCHITECTURE.md §12.4) — deterministic and tested.
 *
 * Everything here runs **before storage and before any batch**, so a comment is stored
 * exactly once, in one shape, and a later reader of the database cannot meet a raw byte
 * sequence that the guard never saw. The stored form is the only form.
 *
 * The text is still data: this module never decides whether a comment is allowed.
 */

import {
  COMMENT_AFFIX_MAX_CHARS,
  COMMENT_AUTHOR_MAX_CHARS,
  COMMENT_BOUND,
  COMMENT_QUOTE_MAX_CHARS,
  EDIT_BOUND,
  type TextBound,
} from '@book/shared';

import { sha256Hex } from '../util/hash.ts';

export type SanitizeFailureCode = 'TOO_SHORT' | 'TOO_LONG' | 'INVALID';

export type SanitizedText =
  | { ok: true; text: string; hash: string }
  | { ok: false; code: SanitizeFailureCode; message: string };

/** C0/C1 controls except `\n` (kept so a reader may write two paragraphs). */
const CONTROLS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu;
/** Zero-width joiners, BOM, bidi overrides, tag characters: invisible direction is not text. */
const INVISIBLES = /[\u200B-\u200F\uFEFF\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E007F}]/gu;
/** A tag-shaped run is removed whole; a stray `<` is mapped, never left as an angle. */
const HTML_TAG = /<\/?[A-Za-z!][^>]{0,500}>/gu;
const CODE_FENCE = /`{3,}/gu;

/** NFKC, controls and invisibles out, spaces collapsed, newlines at most doubled. */
export function normalizeText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(INVISIBLES, '')
    .replace(CONTROLS, ' ')
    .replace(CODE_FENCE, '')
    .replace(HTML_TAG, '')
    .replace(/</gu, '‹')
    .replace(/>/gu, '›')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** A comment body: 3–1200 characters after normalization, plus its dedupe hash. */
export function sanitizeBody(raw: string): SanitizedText {
  return sanitizeWithin(raw, COMMENT_BOUND, 'замечание');
}

function sanitizeWithin(raw: unknown, bound: TextBound, noun: string): SanitizedText {
  if (typeof raw !== 'string') return tooShort(bound, noun);
  const text = normalizeText(raw);
  if (text.length < bound.minChars) return tooShort(bound, noun);
  if (text.length > bound.maxChars) {
    return { ok: false, code: 'TOO_LONG', message: `${noun} длиннее ${bound.maxChars} символов` };
  }
  return { ok: true, text, hash: sha256Hex(text) };
}

function tooShort(bound: TextBound, noun: string): SanitizedText {
  return { ok: false, code: 'TOO_SHORT', message: `${noun} короче ${bound.minChars} символов` };
}

/**
 * A reader's suggested wording: the same normalization, but the **edit** bound (BOOK-DOC-4
 * rule 1), not the note bound. It is never applied verbatim — the writer adopts the idea,
 * not the bytes (§6A.2).
 */
export function sanitizeProposed(raw: string | null | undefined): SanitizedText | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return null;
  if (raw.trim().length === 0) return null;
  return sanitizeWithin(raw, EDIT_BOUND, 'правка');
}

/** An anchor quote: normalized and capped, but angle brackets are left alone so it matches. */
export function sanitizeQuote(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .normalize('NFKC')
    .replace(INVISIBLES, '')
    .replace(CONTROLS, ' ')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length === 0) return null;
  return text.slice(0, COMMENT_QUOTE_MAX_CHARS);
}

export function sanitizeAffix(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .normalize('NFKC')
    .replace(INVISIBLES, '')
    .replace(CONTROLS, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length === 0) return null;
  return text.slice(0, COMMENT_AFFIX_MAX_CHARS);
}

/** A display name snapshot: bounded, no controls, no paragraph. */
export function sanitizeAuthor(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(INVISIBLES, '')
    .replace(CONTROLS, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, COMMENT_AUTHOR_MAX_CHARS);
}
