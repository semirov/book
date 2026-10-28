/**
 * Types for `scripts/lib/passProbe.mjs` — the harness's in-page probe and the two pure rules it
 * borrows from the renderer (grapheme diff, line grid). Only the surface a test uses is declared
 * precisely; the CDP calls stay `unknown` and are the script's own business.
 */

export type PassSpanLike = {
  before: string;
  after: string;
  kind: 'replacement' | 'insertion' | 'deletion';
  offset: number;
};

export type LineGrid = { count: number; tops: readonly number[] };

export type LineComparison = {
  same: boolean;
  count: { left: number; right: number };
  maxDeltaPx: number;
  deltaPx: Array<number | null>;
};

export const graphemes: (text: string) => string[];
export function spanOf(before: string, after: string): PassSpanLike;
export const PROBE_SOURCE: string;
export function compareLines(left: LineGrid, right: LineGrid): LineComparison;
export function measure(cdp: unknown, locator: string, hideDoor?: boolean): Promise<Record<string, unknown>>;
export function measureDoorEffect(cdp: unknown, locator: string): Promise<Record<string, unknown>>;
export function waitForState(
  cdp: unknown,
  locator: string,
  predicate: (state: Record<string, unknown>) => boolean,
  options: { timeoutMs: number; everyMs?: number; what: string },
): Promise<Record<string, unknown>>;
