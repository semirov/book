import { formatFileSize } from '../lib/format.ts';

/**
 * BOOK-60 / BOOK-138 — the download: one anchor, on two surfaces.
 *
 * Reading is never gated, so the file is an `<a href download>`, never a button that shouts, a
 * fetch-and-blob or a script: a click is the browser's own download, and the name it saves —
 * «Бланк.fb2» — is stated by the response (`content-disposition`), not by this markup. The same
 * component sits in the end matter and in one footer row, so the two can never name two files.
 *
 * The label states the file's real size — the byte length `/api/front` measured from the bytes
 * `/book.fb2` sends — and nothing else: the edition number lives in the file (`document-info/
 * version`) and on the ETag, and the export date is the click's own moment, so neither is
 * printed here.
 *
 * A number the page does not have is not printed at all: the label is the verb alone. That
 * covers an absent field, a value that is not a number, and `0`: a file is never zero bytes, so
 * a zero is a broken payload, not a measurement, and printing «0 КБ» would state a size the
 * book cannot have. (`formatFileSize` still answers `0 КБ` for a direct call — the rule is the
 * label's, not the formatter's.)
 */
export function ExportLink({ exportBytes = null }: { exportBytes?: number | null }) {
  const measured = typeof exportBytes === 'number' && Number.isFinite(exportBytes) && exportBytes > 0;
  const size = measured ? formatFileSize(exportBytes) : null;
  return (
    <a className="export-link" href="/book.fb2" download="">
      {size === null ? 'скачать fb2' : `скачать fb2 · ${size}`}
    </a>
  );
}
