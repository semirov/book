import type { DispositionReport } from '@book/shared';

/**
 * BOOK-174 §5 — the three lines of a reading, on the filing's own record.
 *
 *   прочитано как сказано
 *   потому что рядом нет предложения, которое от этого станет ложным
 *   где это в книге: глава 12 · абзац 4 · предложение 2
 *
 * The lines are the server's (`shared/src/disposition.ts`): this component prints them and
 * adds no label of its own, because a label would be a fourth word about the same fact. The
 * first line heads the block — it is the reading's name — and the two below it are its why and
 * its place. Nothing here is a toast: the report lives on the record and survives a reload.
 */
export function DispositionLines({ report }: { report: DispositionReport }) {
  return (
    <section className="filing-resolution">
      <p className="filing-resolution-head">{report.line1}</p>
      <p className="filing-resolution-why">{report.line2}</p>
      <p className="filing-resolution-place">{report.line3}</p>
    </section>
  );
}
