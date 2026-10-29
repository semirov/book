/**
 * Types for `scripts/lib/frame.mjs` (BOOK-107, BOOK-187) — the pure checks the frame smoke runs,
 * imported by `server/test/frameCheck.test.ts`. Only the surface the tests use is declared.
 */

export type FrameCheck = {
  label: string;
  ok: boolean;
  parts: Array<{ label?: string; expected: string; actual: string }>;
};

export type FrameReadout = {
  ch01First: string | null;
  lastFirst: string | null;
  lastLast: string | null;
  lastScanAt: string | null;
};

export type DatabaseFrame = {
  dataDir: string;
  /** True when there is no `book.db` at all: a checkout or CI, nothing to check. */
  absent: boolean;
  readout: FrameReadout | null;
  checks: FrameCheck[];
};

export type ChapterAnswer = { blocks?: Array<{ text?: string }>; error?: string };

export const FRAME: { first: string; last: string };
export const CHAPTER_TIMEOUT_MS: number;
export const TOTAL_TIMEOUT_MS: number;

export function sha256(value: unknown): string;

export function checkFrame(options: {
  dataDir: string;
  DatabaseImpl?: new (file: string, options: { readonly: boolean; fileMustExist: boolean }) => unknown;
}): DatabaseFrame;

export function checkServer(options: {
  baseUrl: string;
  fetchImpl?: (url: string, init: { signal?: AbortSignal }) => Promise<Response>;
  budgetMs?: number;
  now?: () => number;
}): Promise<FrameCheck[]>;
