import type {
  BookAtDto,
  CatalogEntry,
  HistoryChapterDto,
  HistoryTimelineDto,
} from '@book/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getHistoryAt, getHistoryChapter, getHistoryTimeline } from '../api.ts';
import { formatChars } from '../lib/format.ts';
import { compareToNow, momentText } from '../lib/history.ts';
import type { ChapterLoader } from '../lib/place.ts';
import { statusLine } from '../lib/skeleton.ts';
import { MomentControl } from './MomentControl.tsx';
import { SentenceBlock } from './SentenceBlock.tsx';
import { RecordRow } from './RecordRow.tsx';
import { Skeleton } from './Skeleton.tsx';
import { useParagraphChain, type ParagraphChainMode } from '../useParagraphChain.ts';
import { usePending } from '../usePending.ts';

/** A drag idles before it asks (BOOK-DOC-50 §6); a release asks at once. */
const INPUT_IDLE_MS = 120;
/** BOOK-DOC-43 §6: silence is honest for a moment, `момент читается` after this. */
const WAIT_MS = 150;
/** …and past this the surface says the read is slow instead of pretending it is absent. */
const SLOW_MS = 2_000;

/**
 * The moment's read, as one state (BOOK-DOC-50 §6, §7): the past is rendered only when the
 * answer is **for this hseq**; anything else shows the loading form. `id` makes a later
 * request replace an earlier one, so a stale answer can neither paint nor be mistaken.
 */
type MomentState =
  | { phase: 'idle' }
  | { phase: 'loading'; hseq: number; id: number; waiting: boolean; slow: boolean }
  | { phase: 'ready'; id: number; at: BookAtDto }
  | { phase: 'failed'; hseq: number; id: number };

/**
 * The chronicle and its moment control (ARCHITECTURE §11.10, §6F.2, §6F.3, BOOK-DOC-50).
 *
 * Read-only, without exception: no composer, no caret, no queue band. The rail picks a
 * moment and the past renders above the timeline — the cover, page 2, the TOC with the
 * titles *of that moment* and every written chapter behind a tap (the body is fetched per
 * chapter with `chNN@hNNN`, so scrubbing never transfers a book).
 *
 * «⋯ откуда эта фраза» on a paragraph opens its lineage chain: where it was written, what
 * rewrote it, and whose contribution the rewrite ended.
 *
 * BOOK-65: the surface's own subheading is gone with the event list. It promised «каждая
 * перезапись, каждый замер» — machinery the record no longer prints — so keeping it would
 * describe a surface that no longer exists. The replacement words are BOOK-59's, not this
 * change's.
 */
export type ChronicleProps = {
  /** The live catalog: the past is compared against it to say what changed since. */
  catalog: CatalogEntry[];
  frontRev: number;
  /** A new `history:event` frame: refresh the spine. */
  tick: number;
  onOpenChange: (changeId: string) => void;
  /**
   * BOOK-56: `state.history.started` — the log holds its first record, so the chronicle
   * exists from the book's start. Its one starting row is not a history surface and needs
   * no reader change.
   */
  started: boolean;
  /** BOOK-56: `state.history.live`; without a reader change the record list stays empty and the chain off. */
  live: boolean;
  /** BOOK-168 — the page's chapter read for the record's place door; a place it cannot show opens the card. */
  onLoadChapter?: ChapterLoader;
};

export function Chronicle({ catalog, frontRev, tick, onOpenChange, started, live, onLoadChapter }: ChronicleProps) {
  const [timeline, setTimeline] = useState<HistoryTimelineDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [thumb, setThumb] = useState<number | null>(null);
  const [moment, setMoment] = useState<MomentState>({ phase: 'idle' });
  /** The last answer asked for, so a release after a drag does not repeat a request. */
  const requested = useRef<number | null>(null);
  const requestId = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // BOOK-128 #3815 — the phrase's facts are the paragraph's own block, in flow: this surface has
  // no margin channel, and a floating box over a past chapter would be a second surface.
  const sentence = useParagraphChain();

  const refresh = useCallback(async () => {
    // A retry is a wait again (§4, §10): the failure block goes when the request starts, not
    // when it answers, so `повторить` shows the busy claim and the form while it re-reads.
    setFailed(false);
    try {
      const page = await getHistoryTimeline({ limit: 50 });
      setTimeline(page);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, tick]);

  /**
   * BOOK-DOC-43 §4, §6, §10 (BOOK-66) — the timeline's wait: true from the request until it
   * settles, data or failure, so nothing below the rail is printed while nobody knows.
   */
  const waiting = timeline === null && !failed;
  const stage = usePending(waiting);
  const status = statusLine('chronicle', stage);

  const clearIdle = useCallback(() => {
    if (idleTimer.current !== null) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
  }, []);

  /** Ask the server for one moment; a later call replaces an earlier one. */
  const load = useCallback((hseq: number) => {
    if (requested.current === hseq) return;
    requested.current = hseq;
    requestId.current += 1;
    const id = requestId.current;
    setMoment({ phase: 'loading', hseq, id, waiting: false, slow: false });
    void getHistoryAt(hseq).then(
      (at) => {
        if (requestId.current !== id) return;
        // An answer for another moment is not an answer to this one (BOOK-DOC-50 §7): it is
        // the failure state, with its copy and its retry — never a skeleton left standing.
        setMoment(at.hseq === hseq ? { phase: 'ready', id, at } : { phase: 'failed', hseq, id });
      },
      () => {
        if (requestId.current === id) setMoment({ phase: 'failed', hseq, id });
      },
    );
  }, []);

  const lastHseq = timeline?.lastHseq ?? 0;
  const items = timeline?.items ?? [];

  /** The chosen moment, or `null` at the right edge — the one state the control has. */
  const current = thumb !== null && lastHseq > 0 && thumb < lastHseq ? thumb : null;

  const resetToNow = useCallback(() => {
    // A late answer must not paint over «сейчас».
    requestId.current += 1;
    requested.current = null;
    clearIdle();
    setThumb(null);
    setMoment({ phase: 'idle' });
  }, [clearIdle]);

  /** A release or a key release: the moment is asked for now. */
  const commit = useCallback(
    (value: number) => {
      if (lastHseq <= 0 || value >= lastHseq) {
        resetToNow();
        return;
      }
      clearIdle();
      setThumb(value);
      load(value);
    },
    [lastHseq, clearIdle, load, resetToNow],
  );

  /** One frame of a drag or a key: the readout moves locally, the network waits for idle. */
  const move = useCallback(
    (value: number) => {
      if (lastHseq <= 0 || value >= lastHseq) {
        resetToNow();
        return;
      }
      setThumb(value);
      clearIdle();
      idleTimer.current = setTimeout(() => {
        idleTimer.current = null;
        load(value);
      }, INPUT_IDLE_MS);
    },
    [lastHseq, clearIdle, load, resetToNow],
  );

  useEffect(() => clearIdle, [clearIdle]);

  // BOOK-DOC-43 §6 inside the moment slot: 150 ms is a wait, 2 000 ms is a slow read.
  const loadId = moment.phase === 'loading' ? moment.id : 0;
  useEffect(() => {
    if (loadId === 0) return;
    const patch = (next: { waiting?: boolean; slow?: boolean }): void => {
      setMoment((state) => (state.phase === 'loading' && state.id === loadId ? { ...state, ...next } : state));
    };
    const wait = setTimeout(() => patch({ waiting: true }), WAIT_MS);
    const slow = setTimeout(() => patch({ slow: true }), SLOW_MS);
    return () => {
      clearTimeout(wait);
      clearTimeout(slow);
    };
  }, [loadId]);

  const past = moment.phase === 'ready' && moment.at.hseq === current ? moment.at : null;
  const momentFailed = current !== null && moment.phase === 'failed' && moment.hseq === current;
  const asking = moment.phase === 'loading' && moment.hseq === current ? moment : null;
  const difference = useMemo(
    () => (past === null ? null : compareToNow(past, catalog, frontRev)),
    [past, catalog, frontRev],
  );

  const retry = useCallback(() => {
    if (current === null) return;
    requested.current = null;
    load(current);
  }, [current, load]);

  // After every hook: the surface may wake while this mount stays alive — the book's first
  // record, then the first reader change — so the hook order must not depend on it.
  if (!started) return null;

  // The readout keeps its date through a load and a failure: it comes from the log, not
  // from the request. Only the past block below changes its shape.
  const note =
    past !== null
      ? (difference?.notice ?? '')
      : momentFailed
        ? 'момент не прочитался'
        : asking === null
          ? ''
          : asking.slow
            ? 'момент идёт дольше обычного · книга появится здесь же'
            : asking.waiting
              ? 'момент читается'
              : '';

  return (
    // BOOK-77 (audit F1): event summaries carry intent text, and a chapter's past pages carry
    // reader-attributed revision lines — not for the recorder.
    <section
      className="chronicle page sheet ym-hide-content"
      aria-label="хроника книги"
      aria-busy={waiting ? 'true' : undefined}
    >
      <div className="chr-head">
        <h2 className="chr-title">хроника</h2>
      </div>

      {items.length === 0 ? null : (
        <MomentControl
          items={items}
          lastHseq={lastHseq}
          lastAt={timeline?.lastAt ?? null}
          more={timeline !== null && timeline.nextBefore !== null}
          thumb={thumb}
          onInput={move}
          onCommit={commit}
        />
      )}

      {current === null ? null : (
        <div className="past">
          <p className="past-note">
            {note}
            {momentFailed ? (
              <button type="button" className="past-retry" onClick={retry}>
                повторить
              </button>
            ) : null}
          </p>
          {past === null ? (
            // BOOK-66's one form for a wait. A failure prints its line alone: a skeleton that
            // outlived `момент не прочитался` would keep claiming a read that is over.
            asking === null ? null : <Skeleton variant="chronicle" />
          ) : (
            <>
              <div className="past-cover">
                <h3 className="past-title">{past.front?.title ?? 'Книга'}</h3>
                {past.front?.about ? <p className="past-about">{past.front.about}</p> : null}
              </div>
              <ol className="past-toc">
                {past.chapters.map((chapter) => (
                  <li key={chapter.n} className={`past-toc-row${chapter.written ? '' : ' is-empty'}`}>
                    <span className="past-toc-n">{String(chapter.n).padStart(2, '0')}</span>
                    <span className="past-toc-title">
                      {chapter.written ? (chapter.title ?? `глава ${chapter.n}`) : 'ещё не написана'}
                    </span>
                    {chapter.written ? <span className="past-toc-meta">{formatChars(chapter.chars)}</span> : null}
                  </li>
                ))}
              </ol>
              <div className="past-chapters">
                {past.chapters
                  .filter((chapter) => chapter.written)
                  .map((chapter) => (
                    <PastChapter
                      key={`${chapter.n}-${past.hseq}`}
                      n={chapter.n}
                      hseq={past.hseq}
                      title={chapter.title}
                      sentence={sentence}
                      live={live}
                    />
                  ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* §10: an empty list and «пока ничего не записано» are facts about an answer, not a
          wait. Until the timeline lands the slot holds the status and the form, and nothing
          else — the list is not rendered empty and the absence is not printed. */}
      {timeline === null ? (
        status === null ? null : (
          <>
            <p className="chr-empty" role="status" aria-live="polite" aria-atomic="true">
              {status}
            </p>
            <Skeleton variant="chronicle" />
          </>
        )
      ) : (
        <ChronicleRecords timeline={timeline} failed={failed} onOpenChange={onOpenChange} onLoadChapter={onLoadChapter} />
      )}
      {failed ? (
        <div className="state-line">
          <span>хроника не прочиталась</span>
          <button type="button" onClick={() => void refresh()}>
            повторить
          </button>
        </div>
      ) : null}

    </section>
  );
}

/**
 * The record list under the head (BOOK-65, BOOK-56).
 *
 * Three states, and each one says only what the answer holds. Records: one row per change.
 * A begun book with no reader change: the log's first moment is the one record, «начало
 * книги», and one quiet line says there is nothing to rewind yet. An empty log: the record
 * is empty, and that is a fact about an answer, never printed after a failed read.
 */
export function ChronicleRecords({
  timeline,
  failed,
  onOpenChange,
  onLoadChapter,
}: {
  timeline: HistoryTimelineDto;
  /** The last read failed: an absence is not claimed on top of it. */
  failed: boolean;
  onOpenChange: (changeId: string) => void;
  /** BOOK-168: the page's chapter read, handed to every record's place door. */
  onLoadChapter?: ChapterLoader;
}) {
  if (timeline.items.length > 0) {
    return (
      <ol className="chr-timeline">
        {timeline.items.map((record) => (
          // BOOK-65: the key is the change, not its moment — `hseq` moves when any event
          // lands for that change, and a remount would drop keyboard focus on a live tick.
          <RecordRow key={record.changeId} record={record} onOpenChange={onOpenChange} onLoadChapter={onLoadChapter} />
        ))}
      </ol>
    );
  }
  if (timeline.firstAt === null) {
    return failed ? null : <p className="chr-empty">пока ничего не записано</p>;
  }
  // An answer that predates the field carries no `firstAt` at all: the log's first moment is
  // unknown, so no row may claim a date for it. The quiet line needs no date and stands alone.
  const firstAt = timeline.firstAt;
  return (
    <>
      <p className="chr-empty">перематывать пока нечего: книга ещё не правила читателем</p>
      {firstAt ? (
        // The starting record is not a change and must not look like one (BOOK-65): no number,
        // no author, no card — and nothing to scrub, so the row is not a control.
        <ol className="chr-timeline">
          <li className="chr-row">
            <span className="chr-seq">начало книги</span>
            <span className="chr-date">{momentText(firstAt)}</span>
          </li>
        </ol>
      ) : null}
    </>
  );
}

function PastChapter({
  n,
  hseq,
  title,
  sentence,
  live,
}: {
  n: number;
  hseq: number;
  title: string | null;
  sentence: ParagraphChainMode;
  live: boolean;
}) {
  const [chapter, setChapter] = useState<HistoryChapterDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    void getHistoryChapter(n, hseq)
      .then((loaded) => {
        if (!cancelled) setChapter(loaded);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [opened, n, hseq]);

  return (
    <details
      className="past-ch"
      onToggle={(event) => setOpened((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span className="past-ch-n">{String(n).padStart(2, '0')}</span>
        <span className="past-ch-title">{title ?? `глава ${n}`}</span>
      </summary>
      {failed ? <p className="chr-empty">глава не прочиталась</p> : null}
      {chapter === null && !failed ? <p className="chr-empty">глава читается…</p> : null}
      {chapter?.blocks.map((block) => (
        <PastBlock key={block.id} block={block} sentence={sentence} live={live} />
      ))}
    </details>
  );
}

/**
 * One paragraph of a past chapter, with the phrase's own `⋯` — BOOK-128 comment #3815: the facts
 * open in flow under the paragraph (a past chapter has no margin channel), and the door that
 * opened them is where focus comes back.
 */
function PastBlock({
  block,
  sentence,
  live,
}: {
  block: { id: string; text: string };
  sentence: ParagraphChainMode;
  live: boolean;
}) {
  const door = useRef<HTMLButtonElement>(null);
  const open = live && sentence.openId === block.id;
  return (
    <div>
      <p className="p past-p" data-block-id={block.id}>
        {block.text}
        {live ? (
          <button
            type="button"
            className="prov"
            aria-label="откуда эта фраза"
            aria-expanded={open}
            ref={door}
            onClick={() => {
              // The door is the toggle and the only close this layer has.
              if (sentence.openId === block.id) {
                sentence.close();
                door.current?.focus();
                return;
              }
              sentence.open(block.id, door.current?.getBoundingClientRect() ?? new DOMRect());
            }}
          >
            ⋯
          </button>
        ) : null}
      </p>
      {open ? (
        <SentenceBlock
          chain={sentence.chain}
          loading={sentence.loading}
          failed={sentence.failed}
          quote={block.text}
          frame="none"
          place="flow"
          onRetry={sentence.retry}
          onClose={() => {
            sentence.close();
            door.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
