/**
 * Types for `scripts/lib/sw.mjs` (BOOK-157) — the pure service-worker logic the build and
 * `server/test/pwa.test.ts` share. Only the surface those callers use is declared.
 */

export type ShellRules = {
  passthrough: readonly string[];
  cacheFirst: readonly string[];
  networkFirst: readonly string[];
};

export type RequestKind = 'document' | 'passthrough' | 'asset' | 'unhashed';

export type BuildIdentity = { commit?: string; stamp?: string; builtAt?: string };

export const CACHE_PREFIX: string;
export const RULES: ShellRules;

/** The sentence the offline document prints — the same words as `Offline.tsx`. */
export const OFFLINE_SENTENCE: string;

export function classifyWith(rules: ShellRules, url: string, mode?: string): RequestKind;
export function classify(url: string, mode?: string): RequestKind;
export function cacheNameOf(info: BuildIdentity): string;
export function precacheList(paths: readonly string[]): string[];
export function offlineDocument(parts: { js: string; css?: string | null }): string;
export function swSource(options: {
  cacheName: string;
  precache: readonly string[];
  offline: string;
}): string;
export function precacheFromSource(source: string): string[] | null;
export function cacheNameFromSource(source: string): string | null;
