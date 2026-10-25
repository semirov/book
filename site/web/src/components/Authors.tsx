import { formatShare, type AuthorsDto } from '@book/shared';

import { formatDate } from '../lib/format.ts';

/**
 * «Авторы» — the end matter, after chapter 67 (§6C.5, §11.8).
 *
 * The author is listed first with the remainder of the text (`1 − Σ shares`), because the
 * copyright line names one person and the site must not imply the book is co-authored in
 * law. A reader's share is «доля в окончательном тексте»: the characters whose *last* cause
 * is that reader's change — the only attribution the system can compute without a theory of
 * influence, and it says so on the page. The writer, the editor and the consultant are not
 * listed: they are the process, not persons (§6C.5 rule 3).
 *
 * No publisher, no ISBN, no year: the imprint is config (§6C.6) and F020 keeps it exact.
 */
export function Authors({
  authors,
  imprint,
  lastRevisionAt,
  onOpenChronicle,
}: {
  authors: AuthorsDto | null;
  imprint: { author: string; copyright: string };
  lastRevisionAt: string | null;
  onOpenChronicle: () => void;
}) {
  const contributors = authors?.contributors ?? [];
  return (
    <section className="page authors" id="авторы" aria-label="авторы">
      <h2 className="authors-title">Авторы</h2>
      <p className="authors-note">
        доля в окончательном тексте: знаки, чья последняя причина — правка читателя; автор — остальное
      </p>
      <ol className="authors-list">
        <li className="authors-row is-author">
          <span className="authors-name">{imprint.author}</span>
          <span className="authors-role">автор</span>
          <span className="authors-share">{authors === null ? '—' : formatShare(authors.author.share)}</span>
        </li>
        {contributors.map((contributor) => (
          <li className="authors-row" key={contributor.identityId}>
            <span className="authors-name">{contributor.label}</span>
            <span className="authors-role">
              {contributor.edits > 0 ? `правок: ${contributor.edits}` : 'читатель'}
            </span>
            <span className="authors-share">{formatShare(contributor.share)}</span>
          </li>
        ))}
      </ol>
      {contributors.length === 0 ? (
        <p className="authors-empty">пока весь текст написан автором: читательских правок в книге нет</p>
      ) : null}
      <button className="authors-link" type="button" onClick={onOpenChronicle}>
        как менялись доли
      </button>
      <p className="copyright authors-copyright">{imprint.copyright}</p>
      {lastRevisionAt === null ? null : (
        <p className="authors-updated">последняя правка — {formatDate(lastRevisionAt)}</p>
      )}
    </section>
  );
}
