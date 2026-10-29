/**
 * The disposition a filing carries to the page (BOOK-174 §5), and the anchor it is read against.
 *
 * The word is the stored fact; the sentence a reader reads is the stored `reason`, made once by
 * `outcomeLine` (BOOK-218). A row written before v27 keeps `disposition: null` and no reading:
 * the absence is the honest answer, and nothing invents one for a filing nobody read.
 *
 * The place comes from ADR-044, never from a second segmentation: the filing's own
 * `sentence_id` names the sentence, `sentences.idx` is its display order and the live block's
 * `idx` is the paragraph. A sentence whose row is gone is history, not an anchor.
 */

import { normalizeCarrierKind, normalizeDisposition, type CarrierKind, type Disposition } from '@book/shared';

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
  /** The carrier a `through_paper` reading named, so its line can name the place. */
  carrierKind: CarrierKind | null;
};

/** The DTO's two fields: the stored word and place, dropped when this build does not know them. */
export function dispositionFieldsOf(_db: Db, row: DispositionColumns): DispositionFields {
  const disposition = normalizeDisposition(row.disposition);
  return {
    disposition,
    carrierKind: disposition === 'through_paper' ? normalizeCarrierKind(row.carrier_kind) : null,
  };
}
