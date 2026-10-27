/** Types for `scripts/restart-probe.mjs` — BOOK-119's restart window. */

export type ProbeResult = { status: number; body: Record<string, unknown> | null; at: number; ms: number };
export type Health = 'fast' | 'late' | 'stale' | 'fail';
export type WaitResult = { health: Health; ms: number; polls: number; commit: string | null; at: number };
export type Load = { load: number | null; cores: number | null; perCore: number | null };
export type Exec = (file: string, args: string[], options: { encoding: 'utf8' }) => string | Buffer;

export const POLL_MS: number;
export const DEFAULT_TIMEOUT_MS: number;
export const DEFAULT_GRACE_MS: number;
export const DEFAULT_MAX_PER_CORE: number;
export const ATTEMPT_TIMEOUT_MS: number;

export function probe(url: string, options?: { timeoutMs?: number }): Promise<ProbeResult>;
export function healthy(result: ProbeResult): boolean;
export function commitOf(result: ProbeResult): string | null;
export function sameCommit(reported: string | null, expected: string | null): boolean;
export function waitForHealth(options: {
  url: string;
  since?: number;
  budgetMs?: number;
  graceMs?: number;
  expectCommit?: string | null;
  prevCommit?: string | null;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<WaitResult>;
export function parseLoadavg(text: string): number | null;
export function readLoad(options?: { exec?: Exec }): Load;
export function loadReport(load: Load, maxPerCore?: number): string;
export function main(argv: string[]): Promise<number>;
