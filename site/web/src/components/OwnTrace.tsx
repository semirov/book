import { formatShare, type MyTraceDto } from '@book/shared';

/**
 * «Ваш след» — the reader's own erosion in the end matter (BOOK-DOC-4).
 *
 * It is not a score: it says how many chapter revisions the reader's surviving characters
 * have lived through and what share of the text is currently theirs, in the same language
 * the authors list speaks. A reader with no trace sees the truthful zero line — never a
 * curve drawn from a number the system did not measure.
 *
 * Hiding is reversible and loses nothing: «скрыть из списка авторов» takes the name out of
 * the list and out of the byline, and «вернуть в список» puts it back. The history and the
 * share stay either way, and the copy says so.
 */

/** Russian plural for «ревизия»: 1 ревизию · 2 ревизии · 5 ревизий. */
export function revisionsWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'ревизию';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'ревизии';
  return 'ревизий';
}

/** The one sentence the reader sees about their own trace. */
export function traceLine(trace: MyTraceDto): string {
  return `пережила ${trace.survivedRevisions} ${revisionsWord(trace.survivedRevisions)}, сейчас ${formatShare(trace.share)}`;
}

export function OwnTrace({
  trace,
  onToggleHidden,
  pending = false,
}: {
  trace: MyTraceDto;
  onToggleHidden?: (hidden: boolean) => void;
  pending?: boolean;
}) {
  return (
    // BOOK-77 (audit F1): the reader's own display name is in here — no clickmap entry for it.
    <section className="own-trace ym-disable-clickmap" aria-label="ваш след">
      <p className="own-trace-title">ваш след</p>
      <p className="own-trace-line">{traceLine(trace)}</p>
      <p className="own-trace-edits">
        {trace.label}
        {trace.edits > 0 ? ` · правок: ${trace.edits}` : ''}
      </p>
      {trace.hidden ? <p className="own-trace-note">вас нет в списке авторов — история и доля сохранены</p> : null}
      {onToggleHidden === undefined ? null : (
        <button
          className="own-trace-toggle"
          type="button"
          disabled={pending}
          onClick={() => onToggleHidden(!trace.hidden)}
        >
          {trace.hidden ? 'вернуть в список' : 'скрыть из списка авторов'}
        </button>
      )}
    </section>
  );
}
