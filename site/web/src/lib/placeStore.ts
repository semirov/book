/**
 * BOOK-209 — **the remembered place, in one validated row.**
 *
 * `localStorage` holds exactly one row under `book.place.v1`; the server holds the same row per
 * identity (`/api/me/place`), and the hook decides which of the two is newer. The row is
 * validated on the way in **and** on the way out: a malformed row, a row from an older key, a
 * chapter outside the book, a key that is not a key and a date that is not a full instant all
 * read as **absent** — a stale row must never place the reader somewhere they were not, and an
 * old one is not worth a migration.
 *
 * Every access is inside `try`/`catch`: a private-mode browser throws on `localStorage` itself,
 * a full store throws on `setItem`, and neither is a reason to break the page. A place is a
 * convenience — the reader's scroll position is already theirs.
 */

import { TOTAL_CHAPTERS } from '@book/shared';

import { SENTENCE_ID_PATTERN, type Place } from './position.ts';

/** The one storage key. A new shape means a new key, never a guess at the old one. */
export const PLACE_KEY = 'book.place.v1';

/** `YYYY-MM-DDTHH:MM:SS[.sss](Z|±HH:MM)` — the server's own rule: a full instant with a zone. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;

/** A place is one screen's measurement; anything further is a broken client or a hostile row. */
const DELTA_MAX = 10_000;

/**
 * Is this value a place? The same four fields the server checks, checked the same way, so the
 * store cannot hold a row the wire would refuse and the page cannot restore one.
 */
export function isPlace(value: unknown): value is Place {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const { chapter, sentenceId, deltaPx, at } = row;
  if (typeof chapter !== 'number' || !Number.isInteger(chapter)) return false;
  if (chapter < 1 || chapter > TOTAL_CHAPTERS) return false;
  if (typeof sentenceId !== 'string' || !SENTENCE_ID_PATTERN.test(sentenceId)) return false;
  if (typeof deltaPx !== 'number' || !Number.isFinite(deltaPx) || Math.abs(deltaPx) > DELTA_MAX) return false;
  if (typeof at !== 'string' || !ISO_INSTANT.test(at) || Number.isNaN(Date.parse(at))) return false;
  return true;
}

/** The browser's store, or `null` where reading it throws (private mode) or there is none. */
function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The remembered place, or `null` — an absent, old or malformed row is the same answer. */
export function readPlace(): Place | null {
  const store = storage();
  if (store === null) return null;
  try {
    const raw = store.getItem(PLACE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPlace(parsed)) return null;
    return { chapter: parsed.chapter, sentenceId: parsed.sentenceId, deltaPx: parsed.deltaPx, at: parsed.at };
  } catch {
    return null;
  }
}

/**
 * Remember a place. The write is not throttled here — that is the hook's business, because it
 * is the hook that knows when a scroll is a scroll. A row this module would refuse to read is
 * refused on the way in as well.
 */
export function writePlace(place: Place): void {
  if (!isPlace(place)) return;
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(PLACE_KEY, JSON.stringify(place));
  } catch {
    /* a full or forbidden store keeps the page working and loses only this convenience */
  }
}

/** Forget the place (a reader who asked to; a row this page decided is not theirs any more). */
export function clearPlace(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(PLACE_KEY);
  } catch {
    /* nothing to undo */
  }
}

/**
 * The newer of two places, by `at`: the local row and the reader's own server row. An equal
 * instant keeps the server's — the row that travelled is the one another device last wrote.
 */
export function newerPlace(a: Place | null, b: Place | null): Place | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b.at) >= Date.parse(a.at) ? b : a;
}
