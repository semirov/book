/**
 * BOOK-60 / BOOK-DOC-41 §6 — the quiet download at the foot of the book.
 *
 * Reading is never gated, so the link sits in the end matter as an `<a>`, never as a button
 * that shouts. The line under it names the file and the edition **before** the click: the
 * export date cannot honestly be printed here (it is the click's moment, and it lives in the
 * file and in `x-export-date`), so the line says where the date is. When `revision` is absent
 * (a payload from before BOOK-60, or an old fixture) the link stays and the line is omitted —
 * a number is never invented.
 */
export function ExportLink({ revision }: { revision?: number | null }) {
  const named = typeof revision === 'number';
  return (
    <div className="authors-export">
      <a className="authors-export-link" href="/book.fb2">скачать в fb2</a>
      {named ? (
        <p className="authors-export-line">
          blank-{revision}.fb2 · ревизия {revision} · дата выгрузки — в файле
        </p>
      ) : null}
    </div>
  );
}
