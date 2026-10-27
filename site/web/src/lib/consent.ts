import { useSyncExternalStore } from 'react';

/**
 * BOOK-63 — the analytics consent gate.
 *
 * The legal verdict (comment #3619, 152-ФЗ ст. 9 after 156-ФЗ) is that analytics cookies
 * need a **separate, active, informed** choice — not a notice and not «продолжая
 * пользоваться». So this module holds one state with three values:
 *
 * - `unset` — no choice has been recorded (or the stored one was made against an older
 *   version of the copy): nothing loads, and the banner is the one place to decide;
 * - `granted` — the reader pressed «Разрешить»: the loader may run;
 * - `denied` — the reader pressed «Только необходимое», or the browser says Do Not Track:
 *   nothing is requested, and the choice is remembered.
 *
 * The record carries the **version of the copy** the reader agreed to and the date, so a
 * rewritten paragraph can invalidate an old "yes" instead of inheriting it. `doNotTrack`
 * wins over a stored `granted`: a browser-level refusal is not ours to override.
 */

/** Bump whenever the consent copy or the list of what leaves the page changes. */
export const CONSENT_VERSION = '2026-10-27.1';

/**
 * The consent line (comment #3619) — verbatim. It is the same sentence on the strip, in
 * /privacy and wherever the choice is changed, so the three cannot drift.
 */
export const CONSENT_COPY =
  'Яндекс Метрика включается, только если вы разрешите: она видит IP, устройство и адрес страницы. Текст и имя в неё не попадают.';

export type ConsentChoice = 'granted' | 'denied';
export type ConsentState = 'unset' | ConsentChoice;

export type ConsentRecord = {
  state: ConsentChoice;
  version: string;
  /** ISO 8601, the moment the choice was made. */
  date: string;
};

/** One key, one record; `localStorage`, never a cookie — the choice is not a tracker. */
export const CONSENT_STORAGE_KEY = 'book.consent.metrika';

const listeners = new Set<() => void>();
/** `undefined` = not read yet; `null` = read, and nothing usable is stored. */
let cached: ConsentRecord | null | undefined;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // A blocked storage (private mode, a hardened browser) is a page session, not an error.
    return null;
  }
}

/** The stored record, or `null` when it is absent, unreadable, or from another copy version. */
export function readConsent(): ConsentRecord | null {
  if (cached !== undefined) return cached;
  const store = storage();
  if (store === null) {
    cached = null;
    return null;
  }
  try {
    const raw = store.getItem(CONSENT_STORAGE_KEY);
    cached = raw === null ? null : parseRecord(raw);
  } catch {
    cached = null;
  }
  return cached;
}

function parseRecord(raw: string): ConsentRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<ConsentRecord> | null;
    if (value === null || typeof value !== 'object') return null;
    if (value.version !== CONSENT_VERSION) return null;
    if (value.state !== 'granted' && value.state !== 'denied') return null;
    if (typeof value.date !== 'string' || value.date.length === 0) return null;
    return { state: value.state, version: value.version, date: value.date };
  } catch {
    return null;
  }
}

/** `navigator.doNotTrack === '1'` is a refusal the page must honour, not ask again. */
export function doNotTrack(): boolean {
  return typeof navigator !== 'undefined' && navigator.doNotTrack === '1';
}

/** What the page may do right now: DNT forces `denied`, whatever is stored. */
export function consentState(): ConsentState {
  if (doNotTrack()) return 'denied';
  return readConsent()?.state ?? 'unset';
}

/** Record the reader's choice; analytics re-evaluates the script from this notification. */
export function setConsent(choice: ConsentChoice, now: Date = new Date()): void {
  const record: ConsentRecord = { state: choice, version: CONSENT_VERSION, date: now.toISOString() };
  cached = record;
  try {
    storage()?.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // The page keeps the choice in memory even when it cannot persist it.
  }
  emit();
}

/**
 * «изменить» — back to the undecided state, so the banner (and the question) returns.
 *
 * The notification is what stops a live counter: `analytics.ts` revokes on anything that is
 * not a `granted` state — cookies, `ym` calls and one reload (BOOK-77, audit F2) — so this
 * function cannot leave a tag recording behind a choice the reader took back.
 */
export function resetConsent(): void {
  cached = null;
  try {
    storage()?.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    // Same as above: forgetting in memory is the part that matters here.
  }
  emit();
}

export function subscribeConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** The reactive form; the server snapshot is `unset`, the only honest answer without a browser. */
export function useConsent(): ConsentState {
  return useSyncExternalStore(subscribeConsent, consentState, () => 'unset');
}
