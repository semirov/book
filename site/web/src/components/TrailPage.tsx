import type { CommentDto, MyFilingsDto, MyTraceDto, ViewerDto } from '@book/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getMyFilings, getMyTrace, postAuthorsHide } from '../api.ts';
import { changeNumber } from '../lib/changeStatus.ts';
import { anchorCopy, commentStamp } from '../lib/commentView.ts';
import { GATE_WORDS, filingConsequence, refusalDetail } from '../lib/marginalia.ts';
import type { ChapterLoader } from '../lib/place.ts';
import { traceLine } from '../lib/trace.ts';
import { PlaceLink } from './PlaceLink.tsx';
import { ScreenExit } from './ScreenExit.tsx';

/**
 * BOOK-221 — the trail row's two lines, in the reader's own vocabulary (BOOK-DOC-82).
 *
 * The row used to print our machinery: «замечание №A7K · внесено» and «в очереди на запись».
 * A reader is owed a number («правка 014»), the chapter and the moment, and one sentence that
 * says what became of **their** edit. Every such string lives here and nowhere else:
 * `TRAIL_STATE_WORDS` holds the sentences that need no data, `TRAIL_STATE_LINES` the templates
 * that do (a chapter, a revision, a refused reason, the paperwork's mode), and `trailStateLine`
 * chooses between them.
 *
 * BOOK-218 lands `shared/src/stateWords.ts` with this same vocabulary. When that module is in
 * `main`, this block is deleted and `trailStateLine` becomes one import — the merge is an import
 * swap, so no string is re-typed on either side.
 */
const TRAIL_STATE_WORDS = {
  // BOOK-218 spells these two as a word and its line (`ждёт` · `её ещё не читали`); the trail
  // joins them with the site's ` · ` so the merge stays an import swap.
  waiting: 'ждёт · её ещё не читали',
  reading: 'идёт · её читают',
  accepted: 'принято · впишется, когда машина возьмёт главу',
  landed: 'внесено',
  // A note moved no text (BOOK-190): its terminal is its own, never «внесено · глава N».
  note: 'замечание сохранено',
  registered: 'рассмотрено',
  held: 'проверяется · ждёт человека',
  // BOOK-61 keeps one word per gate in `marginalia.ts` — the law's word and the reading's are
  // different words, and both live there. The trail prints them from that one source instead of
  // spelling a second copy here, so the two refusals can never merge into one sentence.
  refusedRights: GATE_WORDS.rights,
  refusedAuditor: GATE_WORDS.auditor,
  superseded: 'снято · текст успел измениться',
  expired: 'снято · правка не состоялась',
  hidden: 'скрыто',
  premise: 'принято в основу · до первой редакции',
  escalated: 'ждёт решения автора',
  // BOOK-206 — the machine tried and the attempt came back empty. The row still waits, and this
  // is the sentence that says so; `shared`'s own line still names a queue, which BOOK-218 removes.
  attempt: 'попытка не удалась — правка ждёт',
} as const;

/** The sentences that carry a fact; each placeholder is filled once, from the row's own data. */
const TRAIL_STATE_LINES = {
  writing: 'пишется · глава {chapter}',
  landed: 'внесено · глава {chapter} · ревизия {rev}',
  // BOOK-137 — the mode a frame filing was filed as is derived (`filingConsequence`), never
  // assumed: «оформление» is only the default, and «поправка»/«расхождение» are real modes.
  registered: 'рассмотрено · {mode}',
  refused: '{word} · {reason}',
} as const;

/** The states a failed attempt is printed over: a landed or refused row keeps its own sentence. */
const STILL_WAITING: ReadonlySet<CommentDto['status']> = new Set<CommentDto['status']>([
  'new',
  'batched',
  'delivered',
  'accepted',
]);

/** One template, one pass: a placeholder with no value stays as written, never as «undefined». */
function trailLine(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (whole: string, key: string) => values[key] ?? whole);
}

/** The one sentence a row says about its own state — from the table, never from a state code. */
export function trailStateLine(comment: CommentDto): string {
  // BOOK-206 — the attempt came back empty: a row that still waits says so, instead of letting a
  // failed try read as «её ещё не читали». A landed or refused row decides itself and keeps its
  // own sentence; the failed attempt behind it is not the reader's answer.
  if (comment.attempt === 'failed' && STILL_WAITING.has(comment.status)) return TRAIL_STATE_WORDS.attempt;
  switch (comment.status) {
    case 'applied': {
      // A note moved no text: it never landed a variant, so «внесено · глава N» would be a lie.
      if (comment.interventionKind === null || comment.interventionKind === undefined) {
        return TRAIL_STATE_WORDS.note;
      }
      // The receipt is the chapter it entered and that chapter's revision. With none recorded the
      // word stands alone: a chapter number here would be invented.
      const applied = comment.applied;
      if (applied === null) return TRAIL_STATE_WORDS.landed;
      return trailLine(TRAIL_STATE_LINES.landed, {
        chapter: String(applied.chapter),
        rev: String(applied.rev),
      });
    }
    case 'rejected': {
      const word =
        comment.refusal === 'rights' ? TRAIL_STATE_WORDS.refusedRights : TRAIL_STATE_WORDS.refusedAuditor;
      // `refusalDetail` drops the gate's own word and its colon, so the reason is said once.
      const reason = refusalDetail(comment);
      return reason === null ? word : trailLine(TRAIL_STATE_LINES.refused, { word, reason });
    }
    case 'registered': {
      // BOOK-137 — the paperwork's mode, derived the way every other surface derives it. The
      // helper answers a failed attempt before the mode, and that line still names a queue
      // (BOOK-218 removes it), so such a row keeps the bare word; no mode → the bare word too,
      // never a guessed «оформление».
      const mode = comment.attempt === 'failed' ? '' : filingConsequence(comment);
      return mode.length === 0
        ? TRAIL_STATE_WORDS.registered
        : trailLine(TRAIL_STATE_LINES.registered, { mode });
    }
    case 'quarantined':
      return TRAIL_STATE_WORDS.held;
    case 'superseded':
      return TRAIL_STATE_WORDS.superseded;
    case 'expired':
      return TRAIL_STATE_WORDS.expired;
    case 'hidden':
      return TRAIL_STATE_WORDS.hidden;
    case 'escalated':
      // BOOK-206: a legacy value the boot migration re-opens. It keeps its own honest sentence.
      return TRAIL_STATE_WORDS.escalated;
    case 'batched':
    case 'delivered':
      return TRAIL_STATE_WORDS.reading;
    case 'accepted':
      // A premise has no change of its own yet: it is the chapter's starting point, and it waits
      // for the first edition rather than for a turn. Otherwise the writer is at the chapter
      // (`processing`) or the acceptance waits its turn.
      if (comment.premise) return TRAIL_STATE_WORDS.premise;
      return comment.changeStatus === 'processing'
        ? trailLine(TRAIL_STATE_LINES.writing, { chapter: String(comment.chapter) })
        : TRAIL_STATE_WORDS.accepted;
    default:
      // `new`: filed, not read yet. A premise no change holds says the same in its own words.
      return comment.premise ? TRAIL_STATE_WORDS.premise : TRAIL_STATE_WORDS.waiting;
  }
}

/**
 * `правка 014 · глава 12 · 28.10, 12:04` — the row's number, its chapter and its moment.
 *
 * The number is the linked change's own `seq` (`CommentDto.changeSeq`), printed by
 * `changeNumber`: the schema has no filing sequence, so a filing no change holds is named by its
 * chapter — an ordinal cut out of an id would be a claim no row makes.
 */
export function trailMetaLine(comment: CommentDto): string {
  const head =
    comment.changeSeq === null || comment.changeSeq === undefined
      ? `правка по главе ${String(comment.chapter)}`
      : `правка ${changeNumber(comment.changeSeq)} · глава ${String(comment.chapter)}`;
  return `${head} · ${commentStamp(comment.createdAt)}`;
}

/**
 * BOOK-207 — «ваш след», the reader's own page.
 *
 * A page of the book, not a modal and not a sheet: one `<section class="page sheet sled">` in
 * the same column, reached by `#след` from the foot and left by the one exit at its top
 * (`ScreenExit`, BOOK-221).
 *
 * The page holds two facts: the trace line (`lib/trace.ts` — what changed, when, and what is the
 * reader's now) with its one hide toggle, and the reader's own filings, newest first — the
 * filing's number and moment, its state's own sentence, the quote as a door back to the
 * sentence, and the two lines of how it was read. `показаны последние 50` prints only when the
 * read returned exactly the bound; there is no total, because the page did not read one.
 *
 * States are honest and exclusive: signed out asks for the sign-in, empty says so, a failed
 * read says it could not read and offers `повторить`, and the wait is one status line re-replaced
 * in place. No count, no modal, no floating layer.
 */
export function TrailPage({
  viewer,
  onLoadChapter,
}: {
  viewer: ViewerDto;
  onLoadChapter?: ChapterLoader;
}) {
  const head = useRef<HTMLHeadingElement>(null);
  const [trace, setTrace] = useState<MyTraceDto | null>(null);
  const [filings, setFilings] = useState<MyFilingsDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [hidePending, setHidePending] = useState(false);

  const load = useCallback(async () => {
    if (!viewer.signedIn) return;
    setFailed(false);
    setTrace(null);
    setFilings(null);
    try {
      const [ownTrace, ownFilings] = await Promise.all([getMyTrace(), getMyFilings()]);
      setTrace(ownTrace);
      setFilings(ownFilings);
    } catch {
      setFailed(true);
    }
  }, [viewer.signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The mode opens at the page's top: the book tree leaves, the document shrinks, and a reader
   * who tapped `след` past the first screenful would otherwise land at the trail's bottom on the
   * browser's clamped offset. The head then takes focus without a second scroll.
   */
  useEffect(() => {
    if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'auto' });
    head.current?.focus({ preventScroll: true });
  }, []);

  const toggleHidden = async (hidden: boolean): Promise<void> => {
    setHidePending(true);
    try {
      const result = await postAuthorsHide(hidden);
      setTrace((current) => (current === null ? current : { ...current, hidden: result.hidden }));
    } catch {
      /* the flag did not change: the button stays as it was, nothing claims success */
    } finally {
      setHidePending(false);
    }
  };

  const waiting = viewer.signedIn && !failed && (trace === null || filings === null);

  /**
   * The exit's enhancement, never its handler: the browser makes the mode change on its own
   * (`#toc` is a real href), and the contents are landed once they exist — a bounded wait of 20
   * frames, never a claim that it moved. Nothing here prevents the navigation or sets the hash.
   */
  const exit = (): void => {
    if (typeof window.requestAnimationFrame !== 'function') return;
    let frames = 0;
    const land = (): void => {
      const toc = document.getElementById('toc');
      if (toc !== null) {
        toc.scrollIntoView({ block: 'start', behavior: 'auto' });
        return;
      }
      frames += 1;
      if (frames < 20) window.requestAnimationFrame(land);
    };
    window.requestAnimationFrame(land);
  };

  return (
    <section className="page sheet sled ym-hide-content ym-disable-clickmap" aria-label="ваш след">
      <ScreenExit onFollow={exit} />

      <h2 className="sled-head" tabIndex={-1} ref={head}>
        ваш след
      </h2>

      {!viewer.signedIn ? (
        <>
          <p className="sled-line">войдите, чтобы увидеть свой след</p>
          <p className="sled-signed-out">
            <a href="/auth/yandex/start">войти через Яндекс</a>
          </p>
        </>
      ) : failed ? (
        <>
          <p className="sled-line" role="status">
            след не прочитался
          </p>
          <p className="sled-retry">
            <button type="button" onClick={() => void load()}>
              повторить
            </button>
          </p>
        </>
      ) : waiting ? (
        <p className="sled-line" role="status" aria-live="polite">
          след читается
        </p>
      ) : (
        <>
          {trace === null ? null : (
            <>
              <p className="sled-trace">{traceLine(trace)}</p>
              <p className="sled-toggle-line">
                {trace.isAuthor ? null : (
                  <button
                    type="button"
                    className="sled-toggle"
                    disabled={hidePending}
                    onClick={() => void toggleHidden(!trace.hidden)}
                  >
                    {trace.hidden ? 'вернуть в список' : 'скрыть из списка авторов'}
                  </button>
                )}
              </p>
            </>
          )}

          {filings === null || filings.items.length === 0 ? (
            <p className="sled-line">вы ещё ничего не написали</p>
          ) : (
            <>
              {filings.items.length === 50 ? <p className="sled-bound">показаны последние 50</p> : null}
              <ul className="sled-rows">
                {filings.items.map((comment) => {
                  const quote = anchorCopy(comment);
                  return (
                    <li className="sled-row" key={comment.id} data-comment-id={comment.id}>
                      <p className="sled-meta">{trailMetaLine(comment)}</p>
                      {quote === null ? null : (
                        <p className="sled-quote">
                          <PlaceLink place={comment} {...(onLoadChapter === undefined ? {} : { onLoadChapter })}>
                            «{quote}»
                          </PlaceLink>
                        </p>
                      )}
                      <p className="sled-state">{trailStateLine(comment)}</p>
                      {comment.report === null || comment.report === undefined ? null : (
                        <>
                          <p className="sled-detail">{comment.report.line1}</p>
                          <p className="sled-detail">{comment.report.line2}</p>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
