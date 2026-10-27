import type { HistoryRecordDto } from '@book/shared';
import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';

import { placeFill } from '../lib/cssom.ts';
import { MIDDOT } from '../lib/format.ts';
import { momentLabel, momentParts, stepMoment } from '../lib/history.ts';

/**
 * BOOK-DOC-50 — the chronicle's moment as one control: a dated readout, one rail, two dated
 * ends. Zero unlabelled marks: the rail is position, the record list below is the axis, and
 * every number printed here is a record's own `at` or a count of the rows the reader sees.
 *
 * The rail stays a native `<input type="range">` for keyboard and assistive technology; its
 * only DOM-known value — the traversed part — is written through CSSOM (`placeFill`), so no
 * `style` attribute ever reaches the markup (BOOK-30).
 */
export type MomentControlProps = {
  /** The loaded page, newest first: the readout, the count and both ends read from it. */
  items: HistoryRecordDto[];
  lastHseq: number;
  /** The log holds an older page behind the oldest loaded record (`nextBefore !== null`). */
  more: boolean;
  /** The thumb's hseq, or `null` at the right edge. */
  thumb: number | null;
  /** One frame of a drag or a key: the readout moves, the network does not. */
  onInput: (value: number) => void;
  /** A release, a row click or a key release: this moment is asked for now. */
  onCommit: (value: number) => void;
};

export function MomentControl({ items, lastHseq, more, thumb, onInput, onCommit }: MomentControlProps) {
  const value = thumb ?? lastHseq;
  const label = momentLabel(items, value, lastHseq, more);
  const fill = useRef<HTMLSpanElement | null>(null);
  const percent = lastHseq > 0 ? (value / lastHseq) * 100 : 100;

  // Before paint, so the traversed part never shows unset for a frame.
  useLayoutEffect(() => {
    placeFill(fill.current, percent);
  }, [percent]);

  const newest = items[0];
  const oldest = items.at(-1);
  const rail = items.length >= 2 && lastHseq > 0;

  /** ←/→ walk one record, Home/End take the ends; the readout follows every key. */
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      onInput(stepMoment(items, value, -1));
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      onInput(stepMoment(items, value, 1));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      onInput(oldest?.hseq ?? 0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      onInput(lastHseq);
    }
  };

  const fromInput = (event: { currentTarget: HTMLInputElement }): void => {
    onInput(Number(event.currentTarget.value));
  };
  const fromRelease = (event: { currentTarget: HTMLInputElement }): void => {
    onCommit(Number(event.currentTarget.value));
  };

  return (
    <div className="scrub">
      <div className="scrub-head">
        <span className="scrub-moment">
          {label.text}
          {label.isNow ? <span className="scrub-moment-now">{`${MIDDOT}сейчас`}</span> : null}
        </span>
        <span className="scrub-count">
          запись {label.position} из {items.length}
        </span>
      </div>

      {rail ? (
        <div className="scrub-rail">
          <span className="scrub-track" aria-hidden="true">
            <span className="scrub-fill" ref={fill} />
          </span>
          <input
            className="scrub-range ym-disable-keys"
            type="range"
            min={0}
            max={lastHseq}
            step={1}
            value={value}
            aria-label="перейти к моменту"
            aria-valuetext={`${label.text}${label.isNow ? `${MIDDOT}сейчас` : ''}`}
            // `onInput` is the frame (readout only); `onChange` is React's alias of the same
            // native event on a range and keeps the field controlled. Both are idempotent.
            onInput={fromInput}
            onChange={fromInput}
            onKeyDown={onKeyDown}
            onPointerUp={fromRelease}
            onKeyUp={fromRelease}
            onBlur={fromRelease}
          />
        </div>
      ) : null}

      <div className="chr-ends">
        <div className="chr-end">
          <span className="chr-end-word">начало книги</span>
          <MomentAt iso={oldest?.at} />
        </div>
        <button type="button" className="chr-end chr-end-now" onClick={() => onCommit(lastHseq)}>
          <span className="chr-end-word">сейчас</span>
          <MomentAt iso={newest?.at} prefix="с" />
        </button>
      </div>
    </div>
  );
}

/**
 * A dated moment in the two parts it may wrap between (BOOK-DOC-50 §3): the date (with its
 * one optional word) and the ` · HH:MM` tail. Each part is unbreakable, so a date, a year or
 * a time is never cut in half; the box wraps rather than let either spill out of the sheet.
 */
function MomentAt({ iso, prefix }: { iso: string | null | undefined; prefix?: string }) {
  const { date, clock } = momentParts(iso);
  return (
    <span className="chr-end-at">
      <span className="chr-end-date">{prefix === undefined ? date : `${prefix} ${date}`}</span>
      <span className="chr-end-clock">{clock}</span>
    </span>
  );
}
