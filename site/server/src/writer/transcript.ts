/**
 * The pass's receipt (docs/writer-lane.md §5): what was asked, what answered, what it cost.
 * Evidence, not the pass — a transcript that cannot be written never fails a pass, and the
 * prompt is carried as its hash beside the sections' own, so the file is not a second copy of
 * the canon. No key, no address, no reader identity: the body is the caller's.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PipelineUsage } from './pipeline.ts';

/** One model call of a pass, as the receipt records it. */
export type CallKind = 'draft' | 'repair' | 'continue' | 'gate:editor' | 'gate:consultant' | 'gate:rights';

export type CallRecord = {
  kind: CallKind;
  system: string;
  user: string;
  answer: string;
  usage: PipelineUsage;
};
export function writeTranscript(dataDir: string, passId: string, body: unknown): void {
  const dir = join(dataDir, 'writer', 'transcripts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${passId}.json`), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}
