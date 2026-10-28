/**
 * Types for `scripts/lib/frame.mjs` (BOOK-107) — the pure checks the frame smoke runs, imported
 * by `server/test/frameCheck.test.ts`. Only the surface the tests use is declared.
 */

export type FrameCheck = {
  label: string;
  ok: boolean;
  parts: Array<{ label?: string; expected: string; actual: string }>;
};

export type DataDirFrame = {
  dataDir: string;
  ch01First: string | null;
  lastFirst: string | null;
  lastLast: string | null;
  lastScanAt: string | null;
  check: FrameCheck;
};

export type ChapterAnswer = { blocks?: Array<{ text?: string }>; error?: string };

export const FRAME: { first: string; last: string };
export const CHAPTER_TIMEOUT_MS: number;
export const TOTAL_TIMEOUT_MS: number;

export function flat(value: unknown): string;
export function startsWithFrame(text: unknown, frame?: string): boolean;
export function endsWithFrame(text: unknown, frame?: string): boolean;

export function checkManuscript(options: {
  repoRoot: string;
  readFile?: (path: string, encoding: 'utf8') => string;
  fileExists?: (path: string) => boolean;
}): FrameCheck[];

export function checkServer(options: {
  baseUrl: string;
  fetchImpl?: (url: string, init: { signal?: AbortSignal }) => Promise<Response>;
  budgetMs?: number;
  now?: () => number;
}): Promise<FrameCheck[]>;

export function readDataDirFrame(options: { dataDir: string }): DataDirFrame;
