/**
 * The pass's receipt (docs/writer-lane.md §5): what was asked, what answered, what it cost.
 * Evidence, not the pass — a transcript that cannot be written never fails a pass, and the
 * prompt is carried as its hash beside the sections' own, so the file is not a second copy of
 * the canon. No key, no address, no reader identity: the body is the caller's.
 *
 * BOOK-173 §5: every call also carries its cache split (`cachedIn`, inside `usage.in`) and the
 * prefix it was sent under, so the pass proves whether the cache-first layout hit at all.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PipelineUsage } from './pipeline.ts';

/** One model call of a pass, as the receipt records it. */
export type CallKind =
  | 'draft'
  | 'repair'
  | 'continue'
  | 'gate:editor'
  | 'gate:consultant'
  | 'gate:rights'
  | 'judge'
  /** BOOK-DOC-80: the local judge — a bounded question about the changed span, not a writing turn. */
  | 'tier1';

export type CallRecord = {
  kind: CallKind;
  system: string;
  user: string;
  answer: string;
  usage: PipelineUsage;
  /** BOOK-173: the input the provider served from its cache, and the prefix it was sent under. */
  cachedIn: number;
  prefixSha256: string;
};

/** BOOK-173's additions to the receipt's body: the mode chosen and the patch that was applied. */
export type PatchReceipt = {
  edits: number;
  changedChars: number;
  fraction: number;
  facts: number;
  note: string | null;
  dangling: 'no-predecessor' | null;
};

export function writeTranscript(dataDir: string, passId: string, body: unknown): void {
  const dir = join(dataDir, 'writer', 'transcripts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${passId}.json`), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}
