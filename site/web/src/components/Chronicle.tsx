import type {
  BookAtDto,
  CatalogEntry,
  ChangeSummaryDto,
  HistoryChapterDto,
  HistoryEventDto,
  HistoryTimelineDto,
} from '@book/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { getHistoryAt, getHistoryChapter, getHistoryTimeline } from '../api.ts';
import { placeTicks } from '../lib/cssom.ts';
import { deedLine, summaryDeed } from '../lib/deed.ts';
import { focusHash } from '../lib/focus.ts';
import { formatChars, formatTime } from '../lib/format.ts';
import {
  HISTORY_FILTERS,
  compareToNow,
  filterEvents,
  groupByDay,
  scrubLabel,
  scrubTicks,
  targetLabel,
  type HistoryFilter,
} from '../lib/history.ts';
import { statusLine } from '../lib/skeleton.ts';
import { useParagraphChain } from '../useParagraphChain.ts';
import { usePending } from '../usePending.ts';
import { ParagraphChain } from './ParagraphChain.tsx';
import { Skeleton } from './Skeleton.tsx';

/**
 * The chronicle and the time-travel scrubber (ARCHITECTURE §11.10, §6F.2, §6F.3).
 *
 * Read-only, without exception: no composer, no caret, no queue band. A tick selects a
 * moment and the past renders above the timeline — the cover, page 2, the TOC with the
 * titles *of that moment* and every written chapter behind a tap (the body is fetched per
 * chapter with `chNN@hNNN`, so scrubbing never transfers a book).
 *
 * «⋯ откуда эта фраза» on a paragraph opens its lineage chain: where it was written, what
 * rewrote it, and whose contribution the rewrite ended.
 */
export type ChronicleProps = {
  /** The live catalog: the past is compared against it to say what changed since. */
  catalog: CatalogEntry[];
  frontRev: number;
  /** A new `history:event` frame: refresh the spine. */
  tick: number;
  /**
   * The public change feed (`GET /api/changes`): the deed line of a decided row is the same
   * five words the card prints. A change outside the feed simply has no line — no data, no claim.
   */
  changes: ChangeSummaryDto[];
  onOpenChange: (changeId: string) => void;
};

export function Chronicle({ catalog, frontRev, tick, changes, onOpenChange }: ChronicleProps) {
  const [timeline, setTimeline] = useState<HistoryTimelineDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [moment, setMoment] = useState<number | null>(null);
  const [past, setPast] = useState<BookAtDto | null>(null);
  /** §10 — a failed `getHistoryAt` used to leave «момент читается…» for ever (BOOK-66). */
  const [momentFailed, setMomentFailed] = useState(false);
  const [momentAttempt, setMomentAttempt] = useState(0);
  const {
    chain,
    loading: chainLoading,
    failed: chainFailed,
    active: chainActive,
    anchor: chainAnchor,
    open: openChain,
    retry: retryChain,
    close: closeChain,
  } = useParagraphChain();

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
   * settles, data or failure, so nothing below the scrubber is printed while nobody knows.
   */
  const waiting = timeline === null && !failed;
  const stage = usePending(waiting);
  const status = statusLine('chronicle', stage);

  useEffect(() => {
    if (moment === null) {
      setPast(null);
      setMomentFailed(false);
      return;
    }
    let cancelled = false;
    // A new moment (or a retry) starts from nothing: the previous moment's past is not
    // this moment, and a stale picture must not answer for a failed read.
    setPast(null);
    setMomentFailed(false);
    void getHistoryAt(moment)
      .then((at) => {
        if (!cancelled) setPast(at);
      })
      .catch(() => {
        // The wait is over: the line below says it failed, and `повторить` re-requests it.
        if (!cancelled) setMomentFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [moment, momentAttempt]);

  const items = timeline?.items ?? [];
  const visible = useMemo(() => filterEvents(items, filter), [items, filter]);
  const groups = useMemo(() => groupByDay(visible), [visible]);
  const lastHseq = timeline?.lastHseq ?? 0;
  const ticks = useMemo(() => scrubTicks(items, lastHseq), [items, lastHseq]);
  const tickBox = useRef<HTMLDivElement | null>(null);

  // BOOK-30: the tick offsets are CSSOM writes (`placeTicks`), not style attributes. The
  // layout effect runs before paint, so a tick never shows at `left:auto` for a frame.
  useLayoutEffect(() => {
    const box = tickBox.current;
    if (box === null) return;
    placeTicks(box.querySelectorAll('i'), ticks);
  }, [ticks]);
  const difference = useMemo(() => (past === null ? null : compareToNow(past, catalog, frontRev)), [past, catalog, frontRev]);
  /** The deed line per change, derived once from the public feed (one copy source: `lib/deed.ts`). */
  const deeds = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of changes) map.set(entry.id, deedLine(summaryDeed(entry)));
    return map;
  }, [changes]);

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
        <p className="chr-sub">
          книга рассказывает, как её писали: каждая правка, каждая перезапись, каждый замер.
        </p>
      </div>

      <div className="chr-filters" role="group" aria-label="что показывать">
        {HISTORY_FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`chr-filter${filter === entry.id ? ' is-on' : ''}`}
            aria-pressed={filter === entry.id}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="scrub" aria-label="перейти к моменту">
        <input
          className="scrub-range ym-disable-keys"
          type="range"
          min={0}
          max={Math.max(1, lastHseq)}
          step={1}
          value={moment ?? lastHseq}
          aria-valuetext={scrubLabel(moment ?? lastHseq, lastHseq, past?.at ?? null)}
          onChange={(event) => {
            const value = Number(event.target.value);
            setMoment(value >= lastHseq ? null : value);
          }}
        />
        <div className="scrub-ticks" aria-hidden="true" ref={tickBox}>
          {ticks.map((position, index) => (
            <i key={`${position}-${index}`} />
          ))}
        </div>
        <div className="scrub-row">
          <span className="scrub-label">{scrubLabel(moment ?? lastHseq, lastHseq, past?.at ?? null)}</span>
          <button type="button" className="scrub-now" onClick={() => setMoment(null)}>
            сейчас
          </button>
        </div>
      </div>

      {moment === null ? null : (
        <div className="past">
          <p className="past-note">
            {/* §10: the loading line goes with the failure — nothing claims to still be reading. */}
            {momentFailed ? null : (difference?.notice ?? 'момент читается')}
            <button type="button" className="past-now" onClick={() => setMoment(null)}>
              вернуться к «сейчас»
            </button>
          </p>
          {past === null ? (
            momentFailed ? (
              <div className="state-line">
                <span>момент не прочитался</span>
                <button type="button" onClick={() => setMomentAttempt((attempt) => attempt + 1)}>
                  повторить
                </button>
              </div>
            ) : (
              <p className="chr-empty">момент читается…</p>
            )
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
                      onProvenance={(blockId, button) => openChain(blockId, button.getBoundingClientRect())}
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
        <>
          <ol className="chr-timeline">
            {groups.map((group) => (
              <li key={group.day} className="chr-day">
                <h3 className="chr-day-label">{group.label}</h3>
                <ol>
                  {group.items.map((event) => (
                    <TimelineRow
                      key={event.hseq}
                      event={event}
                      deed={event.changeId === null ? null : (deeds.get(event.changeId) ?? null)}
                      onPick={() => setMoment(event.hseq)}
                      onOpenChange={onOpenChange}
                    />
                  ))}
                </ol>
              </li>
            ))}
          </ol>
          {visible.length === 0 && !failed ? <p className="chr-empty">пока ничего не записано</p> : null}
        </>
      )}
      {failed ? (
        <div className="state-line">
          <span>хроника не прочиталась</span>
          <button type="button" onClick={() => void refresh()}>
            повторить
          </button>
        </div>
      ) : null}

      {/* The panel stays mounted for the whole open cycle: a failure must keep its retry. */}
      {chainActive ? (
        <ParagraphChain
          chain={chain}
          loading={chainLoading}
          failed={chainFailed}
          onClose={closeChain}
          onRetry={retryChain}
          anchor={chainAnchor}
        />
      ) : null}
    </section>
  );
}

/** One log row. Exported so its markup can be asserted without a browser or a socket. */
export function TimelineRow({
  event,
  deed,
  onPick,
  onOpenChange,
}: {
  event: HistoryEventDto;
  deed: string | null;
  onPick: () => void;
  onOpenChange: (changeId: string) => void;
}) {
  const decided = event.kind === 'change.decided' || event.kind === 'cascade.closed';
  return (
    // BOOK-77 (audit F1): the row is masked on its own, so it holds even when it is rendered
    // outside the chronicle — the summary (and the button's aria-label) is reader-derived.
    <li className="chr-row ym-hide-content">
      <button type="button" className="chr-row-main" onClick={onPick} aria-label={`${event.summary} — книга на этот момент`}>
        <span className="chr-time">{formatTime(event.at)}</span>
        <span className="chr-target">{targetLabel(event)}</span>
        <span className="chr-summary">{event.summary}</span>
        {deed !== null && decided ? <span className="chr-deed">{deed}</span> : null}
      </button>
      {event.changeId === null ? null : (
        <>
          <button type="button" className="chr-change" onClick={() => onOpenChange(event.changeId ?? '')}>
            правка
          </button>
          <a className="chr-change" href={focusHash(event.changeId)}>
            прицел
          </a>
        </>
      )}
    </li>
  );
}

function PastChapter({
  n,
  hseq,
  title,
  onProvenance,
}: {
  n: number;
  hseq: number;
  title: string | null;
  onProvenance: (blockId: string, anchor: HTMLElement) => void;
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
        <p className="p past-p" key={block.id} data-block-id={block.id}>
          {block.text}
          <button
            type="button"
            className="prov"
            aria-label="откуда эта фраза"
            onClick={(event) => onProvenance(block.id, event.currentTarget)}
          >
            ⋯
          </button>
        </p>
      ))}
    </details>
  );
}
