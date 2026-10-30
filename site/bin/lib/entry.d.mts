/**
 * Types for `bin/lib/entry.mjs` (BOOK-236), so a test can drive the entry guard directly —
 * including the branch a spawned process cannot reach (a path whose realpath throws).
 */

export declare function entryState(
  argv1: string | undefined,
  moduleUrl: string,
): 'entry' | 'imported' | 'unknown';
