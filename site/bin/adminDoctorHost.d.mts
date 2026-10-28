/**
 * Types for `bin/adminDoctorHost.mjs` (BOOK-188), the host half of the preflight — so the tests
 * can read the manuscript rule and the one bounded request directly.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** One answer: the response, or the sentence that says why there is none. */
export type CallResult = { status: number; ok: boolean; body: unknown } | { error: string };

export function callJson(options: {
  fetchImpl: FetchLike;
  url: URL;
  token: string;
  method?: string;
  body?: unknown;
  /** The whole call's budget; default 10 s. */
  timeoutMs?: number;
}): Promise<CallResult>;

/** The manuscript files that hold prose, by file name; a tree without `manuscript/` holds none. */
export function manuscriptProse(repoRoot: string): string[];
