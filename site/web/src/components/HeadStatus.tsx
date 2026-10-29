import type { LivePass } from '@book/shared';
import { useEffect, useRef, useState } from 'react';

import { headStatusOf, type HeadEngine, type HeadKind, type HeadLane } from '../lib/headStatus.ts';

/**
 * BOOK-207 / BOOK-DOC-84 D3 — the head's one word, drawn from the facts the frames carry.
 *
 * It is the running head's free space and nothing more: one 12 px mono word in the row that
 * already exists, so `.top-in`'s height and the folio's y do not move by a pixel (the box is
 * shorter than the brand's own 16.2 px label line, and `flex: none` keeps it from growing).
 * The phone prints the word 12 px after the brand and keeps the folio on its right end.
 *
 * The word is the stage's own (`lib/headStatus.ts`): «сейчас читает» / «сейчас пишется» /
 * «сейчас проверяют» / «сейчас записывает» / «сейчас тихо». No open pass prints nothing at all.
 *
 * The clock is the page's; only the *end* of a word needs a moment to happen in, so one timeout
 * is armed at `status.untilMs` (a pass's deadline, or the two-second write word) and cleared
 * with the state or the page. No interval, no poll, and nothing ticks while the head is idle.
 */
export function HeadStatus({
  passes,
  engine,
  lane,
  appliedAt,
  closedAt,
  nowMs,
}: {
  /** BOOK-DOC-84 §2.2 — the open passes, newest first. */
  passes?: readonly LivePass[];
  /** The engine's own line; `down`/`absent` makes the head quiet whatever a stage says. */
  engine?: HeadEngine;
  /** BOOK-220 M2 — the lane's day: its cap is the one sentence the head owes the reader. */
  lane?: HeadLane;
  /** The write's own clock (`chapter:applied` / `live.applied`). */
  appliedAt?: number | null;
  /** The newest `pass:closed`. */
  closedAt?: number | null;
  /** A fixed clock for a test; a page hands none in and the component reads its own. */
  nowMs?: number;
}) {
  const fixed = nowMs !== undefined;
  const [clock, setClock] = useState(() => nowMs ?? Date.now());

  // A new frame is a new observation: re-read the clock once per frame. The reducer returns the
  // same list object for a duplicate, so a repeated frame costs no render.
  useEffect(() => {
    if (fixed) return;
    setClock(Date.now());
  }, [fixed, passes, engine, lane, appliedAt, closedAt]);

  const status = headStatusOf({
    passes,
    engine,
    lane,
    appliedAt,
    closedAt,
    nowMs: fixed ? nowMs : clock,
  });

  // Every word has an end, and it is one moment: the deadline, or the write's two seconds.
  useEffect(() => {
    if (fixed || status.untilMs === null) return;
    const due = status.untilMs + 1 - Date.now();
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, due));
    return () => window.clearTimeout(timer);
  }, [fixed, status.kind, status.untilMs]);

  // Announced on a state change, never on every render: a status region that spoke every time
  // would read the word out loud again and again.
  const spoken = useRef<HeadKind | null>(null);
  const announce = spoken.current !== null && spoken.current !== status.kind;
  useEffect(() => {
    spoken.current = status.kind;
  }, [status.kind]);

  if (status.full === null && status.note === null) return null;

  return (
    <span
      className="head-status"
      data-kind={status.kind}
      role="status"
      aria-live={announce ? 'polite' : 'off'}
    >
      {/* The nib is the pass's own mark, --live: five pixels on the baseline, no motion. The
          quiet word carries no nib: nothing is being written. */}
      {status.kind === 'quiet' || status.full === null ? null : <span className="head-nib" aria-hidden="true" />}
      {status.full === null ? null : <span className="head-status-full">{status.full}</span>}
      {/* BOOK-220 M2 — the bound's own sentence, in the same line and the same register: the
          stage's word stays what the book is doing, this says when it stops. */}
      {status.note === null ? null : (
        <>
          {status.full === null ? null : <span className="head-sep" aria-hidden="true">·</span>}
          <span className="head-note">{status.note}</span>
        </>
      )}
    </span>
  );
}
