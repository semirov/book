/**
 * The bodies the control app shares between its doors (`control.ts`, `writerDoors.ts`).
 *
 * They live here so the two files that parse them read one definition: the writer's lane needs
 * `id`/`session` on every door, and a second copy of a bound is how a route and a schema drift.
 */

import { TOTAL_CHAPTERS } from '@book/shared';
import { z } from 'zod';

export const session = z.string().min(1).max(64);
export const id = z.string().min(1).max(80);

/** The most chapters one `/internal/text` call may ask for: the chapter, its two neighbours, and room. */
export const TEXT_CHAPTERS_MAX = 8;

/** The chapters a prompt may quote, by number: 1..8 of them, each a real chapter. */
export const textBody = z.object({
  chapters: z.array(z.number().int().min(1).max(TOTAL_CHAPTERS)).min(1).max(TEXT_CHAPTERS_MAX),
});

/** `--revert`: the revision to bring back; omitted means the one before the current. */
export const restoreBody = z.object({
  chapter: z.number().int().min(1).max(TOTAL_CHAPTERS),
  rev: z.number().int().min(0).max(1_000_000).optional(),
});

/** BOOK-173: a ripple chapter's door — the change that stood the closure, and one chapter of it. */
export const rippleBody = z.object({
  chapter: z.number().int().min(1).max(TOTAL_CHAPTERS),
  session,
  changeId: id,
});

/**
 * BOOK-173 §2: one entry per block a patch named, as the **character edit** the ingest needs to
 * keep sentence ids across the write (`sentences/transform.ts`). A shape check only: whether the
 * edit is consistent with the text is the ingest's question, and it answers by refusing to publish.
 */
export const sentenceEdit = z.object({
  blockId: z.string().min(1).max(120),
  newBlockId: z.string().min(1).max(120),
  oldText: z.string().min(1).max(20_000),
  newText: z.string().max(40_000),
  from: z.number().int().min(0),
  oldFragment: z.string().max(2_000),
  newFragment: z.string().max(4_000),
});
