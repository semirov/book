import { useEffect, useRef, useState } from 'react';

import {
  HEAD_SILENCE_MS,
  headStatusOf,
  type HeadKind,
  type HeadState,
} from '../lib/headStatus.ts';
import type { Stages } from '../lib/useStages.ts';

/**
 * BOOK-156 #3814 — the head's one line, drawn from the same facts the pass surfaces read.
 *
 * It is the running head's free space and nothing more: one 12 px mono line in the row that
 * already exists, so `.top-in`'s height and the folio's y do not move by a pixel (the box is
 * shorter than the brand's own 16.2 px label line, and `flex: none` keeps it from growing). One
 * line is in the markup; the phone does not paint it at all (BOOK-199: the phone head is the
 * page number and the book's name), so no width is decided in JavaScript and nothing is ever
 * ellipsized.
 *
 * The clock is the page's, but the *end of a silence* needs a moment to happen in: while a pass
 * is live one timeout is armed for `atMs + 90 s`, and it is cleared with the state or the page.
 * No interval, no poll, and nothing ticks while the head shows nothing.
 */
export function HeadStatus({
  state,
  stages,
  nowMs,
}: {
  state: HeadState;
  /** BOOK-167's log; absent for a caller that holds none (`PassRecordPage`) — then nothing is live. */
  stages?: Stages;
  /** A fixed clock for a test; a page hands none in and the component reads its own. */
  nowMs?: number;
}) {
  const fixed = nowMs !== undefined;
  const [clock, setClock] = useState(() => nowMs ?? Date.now());

  // A new stage is a new observation: re-read the clock once per frame. `appendStage` returns the
  // same log object when a frame says nothing new, so a repeated frame costs no render.
  useEffect(() => {
    if (fixed) return;
    setClock(Date.now());
  }, [fixed, stages?.log]);

  const status = headStatusOf({ stages, state, nowMs: fixed ? nowMs : clock });

  // The silence has an end, and it is one moment: the line changes to `книга не пишется` without
  // waiting for another frame, and one timer is armed at a time.
  useEffect(() => {
    if (fixed || status.kind !== 'live' || status.atMs === null) return;
    const due = status.atMs + HEAD_SILENCE_MS + 1 - Date.now();
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, due));
    return () => window.clearTimeout(timer);
  }, [fixed, status.kind, status.atMs]);

  // Announced on a state change, never on every render: the line's time moves with each stage,
  // and a status region that spoke every time would read the clock out loud.
  const spoken = useRef<HeadKind | null>(null);
  const announce = spoken.current !== null && spoken.current !== status.kind;
  useEffect(() => {
    spoken.current = status.kind;
  }, [status.kind]);

  if (status.kind === 'idle' || status.full === null) return null;

  return (
    <span
      className="head-status"
      data-kind={status.kind}
      role="status"
      aria-live={announce ? 'polite' : 'off'}
    >
      {/* The nib is the pass's own mark, --live: five pixels on the baseline, no motion. */}
      {status.kind === 'live' ? <span className="head-nib" aria-hidden="true" /> : null}
      <span className="head-status-full">{status.full}</span>
    </span>
  );
}
