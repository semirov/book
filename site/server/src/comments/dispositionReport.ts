/**
 * The disposition a filing carries to the page (BOOK-174 §5).
 *
 * One place builds the reader's three lines from the five stored columns, so the panel, the
 * thread and the reader's own record cannot disagree about how a filing was read. A row written
 * before v24 keeps `disposition: null` and no report at all: the absence is the honest answer,
 * and nothing invents a reading for a filing nobody read this way.
 */

import {
  chainReport,
  normalizeCarrierKind,
  normalizeDisposition,
  normalizeDispositionLock,
  type Disposition,
  type DispositionReport,
} from '@book/shared';

/** The stored chain, structurally: any row that carries the five columns may be asked. */
export type DispositionColumns = {
  chapter: number;
  disposition: string | null;
  lock: string | null;
  carrier_kind: string | null;
  quote_kept: string | null;
  sentence_id: string | null;
};

export type DispositionFields = {
  disposition: Disposition | null;
  report: DispositionReport | null;
};

/** The DTO's two fields: the stored word (dropped when this build does not know it) + report. */
export function dispositionFieldsOf(row: DispositionColumns): DispositionFields {
  const disposition = normalizeDisposition(row.disposition);
  if (disposition === null) return { disposition: null, report: null };
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
      row.chapter,
    ),
  };
}
