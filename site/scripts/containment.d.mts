/** Types for `scripts/containment.mjs` — the F023 guard, used by `scripts/arch.mjs` and its test. */

export type Canary = { file: string; text: string };
export type DistHit = { shipped: string; canary: Canary };
export type F023Problem = { file: string; message: string };

export const SUPPORT_DIRS: readonly string[];
export const PROMPT_FILES: readonly string[];
export const GUARDED_DIRS: readonly string[];
export const CANARY_MIN_CHARS: number;

export function walkAll(dir: string, out?: string[]): string[];
export function collectCanaries(bookRoot: string, dirs?: readonly string[]): Canary[];
export function distHits(input: { distDir: string; canaries: readonly Canary[] }): DistHit[];
export function f023Problems(input: { bookRoot: string; distDir: string }): F023Problem[];
