/**
 * The disposition a filing carries to the page (BOOK-174 §5), and the anchor it is read against.
 *
 * One place builds the reader's three lines from the stored chain, so the panel, the thread and
 * the reader's own record cannot disagree about how a filing was read. A row written before v27
 * keeps `disposition: null` and no report at all: the absence is the honest answer, and nothing
 * invents a reading for a filing nobody read this way.
 *
 * The place comes from ADR-044, never from a second segmentation: the filing's own
 * `sentence_id` names the sentence, `sentences.idx` is its display order and the live block's
 * `idx` is the paragraph. A sentence whose row is gone is history, not an anchor — the report
 * then names the chapter and the paragraph only.
 */

import {
  chainReport,
  normalizeCarrierKind,
  normalizeDisposition,
  normalizeDispositionLock,
  type Disposition,
  type DispositionReport,
} from '@book/shared';

import type { Db } from '../db/db.ts';
import { readBlock } from './repo.ts';
import { findLiveSentence } from '../sentences/store.ts';

/** The stored chain, structurally: any row that carries the four columns may be asked. */
export type DispositionColumns = {
  chapter: number;
  block_id: string | null;
  block_idx: number | null;
  sentence_id: string | null;
  disposition: string | null;
  lock: string | null;
  carrier_kind: string | null;
  quote_kept: string | null;
};

export type CommentAnchorFacts = {
  /** The paragraph the reading stands in — the live sentence's block, else the filed one. */
  blockIndex: number | null;
  /** The live sentence's display index; null when the filing kept (or lost) its block anchor. */
  sentenceIndex: number | null;
  /** The live text the filing concerns: the sentence's block, else the filed block. */
  blockText: string | null;
};

/** Where a filing stands in the book now — one resolution, shared by the DTO and the chooser. */
export function dispositionAnchorOf(db: Db, row: Pick<DispositionColumns, 'block_id' | 'block_idx' | 'sentence_id'>): CommentAnchorFacts {
  const filed = row.block_id === null ? undefined : readBlock(db, row.block_id);
  const sentence = row.sentence_id === null ? null : findLiveSentence(db, row.sentence_id);
  const owner = sentence === null ? undefined : readBlock(db, sentence.block_id);
  const block = owner ?? filed;
  return {
    blockIndex: block?.idx ?? row.block_idx,
    sentenceIndex: sentence === null ? null : sentence.idx,
    blockText: block?.text ?? null,
  };
}

export type DispositionFields = {
  disposition: Disposition | null;
  report: DispositionReport | null;
};

/** The DTO's two fields: the stored word (dropped when this build does not know it) + report. */
export function dispositionFieldsOf(db: Db, row: DispositionColumns): DispositionFields {
  const disposition = normalizeDisposition(row.disposition);
  if (disposition === null) return { disposition: null, report: null };
  const anchor = dispositionAnchorOf(db, row);
  return {
    disposition,
    report: chainReport(
      {
        disposition,
        lock: normalizeDispositionLock(row.lock),
        carrierKind: normalizeCarrierKind(row.carrier_kind),
        quoteKept: row.quote_kept,
        sentenceId: row.sentence_id,
      },
      { chapter: row.chapter, blockIndex: anchor.blockIndex, sentenceIndex: anchor.sentenceIndex },
      // «Exactly one sentence» is the stored anchor: the `as_said` plan existed when the filing
      // carried one, and a sentence that has since closed is not a second opinion about it.
      row.sentence_id !== null,
    ),
  };
}
