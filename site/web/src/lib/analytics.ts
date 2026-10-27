import { INTERVENTION_KINDS, TOTAL_CHAPTERS } from '@book/shared';
import { useSyncExternalStore } from 'react';

import { getAnalyticsConfig } from '../api.ts';
import { consentState, subscribeConsent } from './consent.ts';

/**
 * BOOK-63 — Yandex Metrika behind the consent gate, and the event taxonomy in one module.
 *
 * The stock snippet cannot ship: its inline `<script>` is blocked by the CSP (no
 * `unsafe-inline`), and its `<noscript>` pixel carries an inline `style`. So the tag is an
 * external file (`tag.js`), loaded **once**, only when a counter is configured **and** the
 * reader has granted consent; then `ym(id, 'init', …)` runs with Webvisor, clickmap, link
 * tracking and accurate bounce — and no `ecommerce`: the book sells nothing.
 *
 * `track` never carries free text. Every event name has a declared parameter shape; a value
 * outside it drops the whole event, and a `code` is normalised to a `UPPER_SNAKE` token (or
 * `UNKNOWN`). A reader's words, a display name, an alias and an identity id therefore have
 * no path into a request — the guarantee is in code, not in the caller's discipline.
 */

/** The only third-party origin the page may use for analytics; the CSP names the same one. */
export const METRIKA_ORIGIN = 'https://mc.yandex.ru';
export const METRIKA_TAG_URL = `${METRIKA_ORIGIN}/metrika/tag.js`;

/**
 * The counter's own configuration (comment #3618): Webvisor and clickmap on, link tracking
 * on, accurate bounce on, `ecommerce` deliberately absent.
 */
export const METRIKA_INIT = {
  ssr: true,
  webvisor: true,
  clickmap: true,
  trackLinks: true,
  accurateTrackBounce: true,
} as const;

export type SeamSurface = 'text' | 'premise' | 'toc';
export type KindChoice = (typeof INTERVENTION_KINDS)[number] | 'note';

/** The product's own acts, named once. An event carries nothing but these parameters. */
export type EventParams = {
  cover_seen: Record<string, never>;
  seam_open: { surface: SeamSurface };
  record_open: Record<string, never>;
  tooltip_seen: Record<string, never>;
  form_open: Record<string, never>;
  kind_pick: { kind: KindChoice };
  submit_intervention: Record<string, never>;
  submit_note: Record<string, never>;
  submit_refused: { code: string };
  receipt_seen: Record<string, never>;
  deep_link_open: { chapter: number };
  rules_open: Record<string, never>;
  privacy_open: Record<string, never>;
  error_shown: { code: string };
};

export type EventName = keyof EventParams;

export const EVENT_NAMES = [
  'cover_seen',
  'seam_open',
  'record_open',
  'tooltip_seen',
  'form_open',
  'kind_pick',
  'submit_intervention',
  'submit_note',
  'submit_refused',
  'receipt_seen',
  'deep_link_open',
  'rules_open',
  'privacy_open',
  'error_shown',
] as const satisfies readonly EventName[];

/**
 * A parameter is a closed set (`enum`), a chapter number, or a code token — never a string
 * the caller may fill with prose. A test reads this table and refuses any other kind.
 */
export type ParamType = 'enum' | 'code' | 'chapter';

export const EVENT_SCHEMA: { readonly [K in EventName]: Readonly<Record<string, ParamType>> } = {
  cover_seen: {},
  seam_open: { surface: 'enum' },
  record_open: {},
  tooltip_seen: {},
  form_open: {},
  kind_pick: { kind: 'enum' },
  submit_intervention: {},
  submit_note: {},
  submit_refused: { code: 'code' },
  receipt_seen: {},
  deep_link_open: { chapter: 'chapter' },
  rules_open: {},
  privacy_open: {},
  error_shown: { code: 'code' },
};

/** The enum values a parameter may take, by parameter name. */
export const PARAM_VALUES: Readonly<Record<string, readonly string[]>> = {
  surface: ['text', 'premise', 'toc'],
  kind: [...INTERVENTION_KINDS, 'note'],
};

/** UPPER_SNAKE, at most 32 characters: the shape every refusal code has. */
const CODE = /^[A-Z][A-Z0-9_]{0,31}$/u;
/** The counter id is numeric; anything else is not a counter and is treated as absent. */
const COUNTER = /^\d{1,20}$/u;

export type YmFunction = (...args: unknown[]) => void;

let counter: string | null = null;
let tag: Promise<void> | null = null;
let initialised = false;
let active = false;
const configListeners = new Set<() => void>();
const seen = new Set<string>();

function ymFunction(): YmFunction | null {
  const scope = globalThis as { ym?: YmFunction };
  return typeof scope.ym === 'function' ? scope.ym : null;
}

function callYm(...args: unknown[]): void {
  ymFunction()?.(...args);
}

function emitConfig(): void {
  for (const listener of [...configListeners]) listener();
}

/**
 * Set the counter id from the served constant (`GET /api/analytics`). `null` or a non-numeric
 * value means the deployment has no counter: nothing is requested, whatever the consent says.
 */
export function configureCounter(value: string | null | undefined): void {
  const next = typeof value === 'string' && COUNTER.test(value.trim()) ? value.trim() : null;
  if (next === counter) return;
  counter = next;
  emitConfig();
  applyConsent();
}

export function counterId(): string | null {
  return counter;
}

/** Re-evaluate the script against the consent state and the configured counter. */
export function applyConsent(): void {
  active = counter !== null && consentState() === 'granted';
  if (!active) return;
  void loadTag().catch(() => {
    // A blocked or unreachable tag is silence, not an error on the page: nothing to show.
    active = false;
  });
}

function loadTag(): Promise<void> {
  if (tag !== null) return tag;
  const id = counter;
  if (id === null) return Promise.resolve();
  tag = new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('metrika needs a document'));
      return;
    }
    const element = document.createElement('script');
    element.src = `${METRIKA_TAG_URL}?id=${id}`;
    element.async = true;
    element.onload = () => {
      initialised = true;
      callYm(id, 'init', METRIKA_INIT);
      resolve();
    };
    element.onerror = () => {
      tag = null;
      reject(new Error('metrika tag failed'));
    };
    document.head.appendChild(element);
  });
  return tag;
}

/** Normalise a refusal code; anything else (prose included) becomes `UNKNOWN`. */
export function eventCode(value: unknown): string {
  return typeof value === 'string' && CODE.test(value) ? value : 'UNKNOWN';
}

/**
 * The one place a payload is built. Returns `null` when a declared value is outside its
 * shape: the event is then not sent at all, because a wrong enum is a bug, not a reason to
 * ship whatever string arrived.
 */
function buildPayload(name: EventName, raw: Record<string, unknown>): Record<string, string | number> | null {
  const schema = EVENT_SCHEMA[name];
  const payload: Record<string, string | number> = {};
  for (const [key, type] of Object.entries(schema)) {
    const value = raw[key];
    if (type === 'code') {
      payload[key] = eventCode(value);
      continue;
    }
    if (type === 'chapter') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > TOTAL_CHAPTERS) return null;
      payload[key] = value;
      continue;
    }
    const allowed = PARAM_VALUES[key];
    if (allowed === undefined || typeof value !== 'string' || !allowed.includes(value)) return null;
    payload[key] = value;
  }
  return payload;
}

/** The act itself: a no-op unless a counter is configured, consent is granted and the tag is ready. */
export function track<K extends EventName>(name: K, params: EventParams[K] = {} as EventParams[K]): void {
  const id = counter;
  if (id === null || !active || !initialised) return;
  const payload = buildPayload(name, params as Record<string, unknown>);
  if (payload === null) return;
  callYm(id, 'reachGoal', name, payload);
}

/** An event that is one fact per session, not one per act (`tooltip_seen`). */
export function trackOnce<K extends EventName>(key: string, name: K, params: EventParams[K] = {} as EventParams[K]): void {
  if (seen.has(key)) return;
  seen.add(key);
  track(name, params);
}

/**
 * Boot: ask the site for its counter, then let the gate decide. `/privacy` and the book share
 * this one call, so the choice made in one place is the same choice in the other.
 */
export async function bootAnalytics(fetcher: typeof getAnalyticsConfig = getAnalyticsConfig): Promise<void> {
  try {
    const config = await fetcher();
    configureCounter(config.counter);
  } catch {
    configureCounter(null);
  }
}

subscribeConsent(applyConsent);

export function subscribeCounter(listener: () => void): () => void {
  configListeners.add(listener);
  return () => configListeners.delete(listener);
}

/** Does this deployment have a counter at all? Without one there is nothing to ask about. */
export function counterConfigured(): boolean {
  return counter !== null;
}

export function useCounterConfigured(): boolean {
  return useSyncExternalStore(subscribeCounter, counterConfigured, () => false);
}
