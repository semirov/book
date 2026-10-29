import type { CommentDto } from '@book/shared';

/**
 * BOOK-128 comment #3900 §2 — the rows whose component cannot be mounted from a fixture.
 *
 * These audited lines live inside machinery that is not a pure function of props: the seam
 * strip reads its draft and the page's one panel (`Seam`), the record's head is drawn by
 * `Record`, which needs the paragraph and its chain read (`ProseParagraph`), and the chronicle's
 * two rows read the book's history page. The pass record scrolls to its own heading on mount
 * and the chapter's failed row needs the article's store (`ChapterArticle`).
 * Here their markup is copied **verbatim** from the component that draws it, class for class, so
 * the same stylesheets lay it out on the same classes; the report names this as a gap rather
 * than pretending the mount happened.
 *
 * The head row is a copy for the same reason: `Header` resolves its chapter slot from the
 * reading position, so the four registers of one 44 px row only co-exist when a chapter is
 * under the reader. `Header` itself is mounted above this block as well.
 */

export const SEAM_QUOTE = '«нужен»';

/** `Seam.tsx`, the open strip: `data-state="strip"`, one `.seam-row` of four registers. */
export function SeamStripRow() {
  return (
    <div className="seam ym-hide-content" role="group" aria-label="место вмешательства · глава 67" data-state="strip" data-open="false">
      <div className="seam-row">
        <span className="seam-word">{SEAM_QUOTE}</span>
        <button type="button" className="seam-prov" data-door="prov">
          откуда это слово
        </button>
        <button type="button" className="seam-cta">
          вмешаться
        </button>
        <button type="button" className="seam-close" aria-label="закрыть место вмешательства">
          ✕
        </button>
      </div>
    </div>
  );
}

/** `Seam.tsx`, the collapsed line under a card: one `.seam-prov-line`. */
export function SeamProvLine() {
  return (
    <div className="seam ym-hide-content" role="group" aria-label="место вмешательства · глава 67" data-state="card" data-open="false">
      <span className="seam-announce" role="status" aria-live="polite" />
      <span className="seam-prov-line">
        <span className="seam-prov-word">{SEAM_QUOTE}</span>
        <span className="seam-prov-trail">{' · глава 67 · замечание №A7K'}</span>
      </span>
    </div>
  );
}

/** `Seam.tsx`, the filing rows under the strip: one `.seam-filing-line` per filing. */
export function SeamFilingRow({ comment }: { comment: CommentDto }) {
  return (
    <button type="button" className="seam-filing" data-status={comment.status}>
      <span className="seam-filing-line ink-quiet">
        <span className="seam-filing-n">правка 12</span>
        <span className="seam-filing-word">ждёт</span>
        <span>{comment.author}</span>
        <span className="seam-filing-stamp">28.10, 14:42</span>
      </span>
      <span className="seam-filing-quote">«Её освещал яркий свет, и на столе лежал лист бумаги.»</span>
    </button>
  );
}

/** `Record.tsx`, opened: the sheet, the head's own line and the head row of three registers. */
export function RecordHead() {
  return (
    <div className="rec" data-acc="open" role="region" aria-label="запись о фразе">
      <div className="rec-clip">
        <div className="rec-inner">
          <div className="rec-gap" aria-hidden="true" />
          <div className="rec-sheet">
            <blockquote className="rec-quote">«Её освещал яркий свет, и на столе лежал лист бумаги.»</blockquote>
            <p className="rec-what">правка 12 · ваша · 28.10, 14:42</p>
            <div className="rec-head">
              <span className="rec-state" data-ink="quiet">
                <span>ждёт</span>
              </span>
              <button type="button" className="rec-cta">
                вмешаться
              </button>
              <button type="button" className="rec-close" aria-label="закрыть">
                ✕
              </button>
            </div>
            <p className="rec-state-line">решения ещё нет</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** `Chronicle.tsx` — the chapters the past holds, one row each. */
export function PastTocRow() {
  return (
    <ol className="past-toc">
      <li className="past-toc-row">
        <span className="past-toc-facts">
          <span className="past-toc-n">07</span>
          <span className="past-toc-meta">24 434 зн.</span>
        </span>
        <span className="past-toc-title">Ночная смена</span>
      </li>
      <li className="past-toc-row is-empty">
        <span className="past-toc-facts">
          <span className="past-toc-n">08</span>
        </span>
        <span className="past-toc-title">ещё не написана</span>
      </li>
    </ol>
  );
}

/** `ChroniclePast.tsx` — one chapter of the past, closed: its summary row. */
export function PastChapterSummary() {
  return (
    <details className="past-ch">
      <summary>
        <span className="past-ch-n">07</span>
        <span className="past-ch-title">Ночная смена</span>
      </summary>
      <p className="chr-empty">записей нет</p>
    </details>
  );
}

/**
 * `ChapterArticle.tsx` — a failed read: the sentence and its one retry. Copied verbatim, because
 * the component needs the paragraph store; the two-line shape is the only thing measured here
 * (BOOK-197: the retry is a mark and takes its own line).
 */
export function ChFailRow() {
  return (
    <div className="ch-fail">
      <span>глава не загрузилась</span>
      <button type="button">повторить</button>
    </div>
  );
}

/** `Chronicle.tsx` — the page's one heading, in its own head row. */
export function ChrTitle() {
  return (
    <div className="chronicle">
      <div className="chr-head">
        <h2 className="chr-title">хроника</h2>
      </div>
    </div>
  );
}

/** `Header.tsx` — the head row as it stands when a chapter is under the reader. */
export function HeadRow() {
  return (
    <header className="top">
      <div className="page sheet top-in">
        <div className="top-row">
          <span className="brand">Бланк</span>
          <span className="top-chapter" data-n={7}>
            <span className="top-chapter-n">7</span>
            <span className="top-chapter-w">Ночная смена</span>
          </span>
          <span className="head-status" data-kind="live" role="status">
            <span className="head-nib" aria-hidden="true" />
            <span className="head-status-full">сейчас пишется</span>
          </span>
          <span className="folio" data-page={142} aria-hidden="true">
            142
          </span>
        </div>
      </div>
    </header>
  );
}
