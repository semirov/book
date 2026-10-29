import { useEffect, useRef, useState } from 'react';

import {
  HEAD_SILENCE_MS,
  headStatusOf,
  type HeadKind,
  type HeadSocket,
  type HeadState,
} from '../lib/headStatus.ts';
import type { Stages } from '../lib/useStages.ts';

/**
 * BOOK-207 / BOOK-218 — the head's one word, drawn from the same facts the pass surfaces read.
 *
 * It is the running head's free space and nothing more: one 12 px mono word in the row that
 * already exists, so `.top-in`'s height and the folio's y do not move by a pixel. The seven words
 * are `HEAD_WORDS` in `@book/shared`; a word with a longer sentence behind it (`главу пишут —
 * начали в 12:10`, `написанное читает редактор`, the no-line sentence) carries it as the line's
 * `title`, so a reader can ask without the head growing a second line.
 *
 * The clock is the page's, but the *end of a silence* needs a moment to happen in: while a pass
 * is live one timeout is armed for `atMs + 90 s`, and it is cleared with the state or the page.
 * No interval, no poll.
 */
export function HeadStatus({
  state,
  stages,
  socket,
  nowMs,
}: {
  state: HeadState;
  /** The page's stage log; absent for a caller that holds none — then nothing is live. */
  stages?: Stages;
  /** The page's socket status (BOOK-218); absent for a caller that holds no line. */
  socket?: HeadSocket;
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

  const status = headStatusOf({ stages, state, socket, nowMs: fixed ? nowMs : clock });

  // The silence has an end, and it is one moment: the head turns `тихо` without waiting for
  // another frame, and one timer is armed at a time.
  useEffect(() => {
    if (fixed || status.atMs === null) return;
    const due = status.atMs + HEAD_SILENCE_MS + 1 - Date.now();
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, due));
    return () => window.clearTimeout(timer);
  }, [fixed, status.kind, status.atMs]);

  // Announced on a state change, never on every render: a status region that spoke every time
  // would read the word out loud again and again.
  const spoken = useRef<HeadKind | null>(null);
  const announce = spoken.current !== null && spoken.current !== status.kind;
  useEffect(() => {
    spoken.current = status.kind;
  }, [status.kind]);

  return (
    <span
      className="head-status"
      data-kind={status.kind}
      role="status"
      aria-live={announce ? 'polite' : 'off'}
      {...(status.detail === null ? {} : { title: status.detail })}
    >
      {/* The nib is the pass's own mark, --live: five pixels on the baseline, no motion. */}
      {status.kind === 'reading' || status.kind === 'drafting' || status.kind === 'gates' ? (
        <span className="head-nib" aria-hidden="true" />
      ) : null}
      <span className="head-status-full">{status.full}</span>
    </span>
  );
}
