import type { LinePart } from '@book/shared';
import { useEffect, useRef, useState } from 'react';

import type { ClientState } from '../lib/clientState.ts';
import type { Place } from '../lib/place.ts';
import { nowStateOf, type NowDoor, type NowState } from '../lib/nowState.ts';
import { connectionWordOf, type ConnectionState } from '../lib/socketStatus.ts';
import { PlaceLink } from './PlaceLink.tsx';

/**
 * BOOK-DOC-84 §11.1 — **the head's status line**, one row of its own under the brand row.
 *
 * It is not a badge beside the title and it is not a second row of the running head: the line
 * spans the page column as a block in the head's flow (`.head-line`, static, after `.top-row`),
 * so it adds to the sticky head's measured height and never overlays the running head or the
 * prose. Idle prints **nothing at all**, no word, no placeholder, no reserved space. It appears
 * on the first work frame, updates on every frame, and rests `LINGER_MS` after a terminal
 * frame, then it is gone.
 *
 * Two facts share the row, and neither invents the other: the **connection** (`lib/socketStatus.ts`
 * maps it to one word, or to no word at all) and the **frames** (`lib/nowState.ts`). The
 * connection outranks the frames while it has something true to say — a state derived from a
 * dead socket is a stale claim — and it says nothing while `connecting` or after a single failed
 * attempt, so the handshake a healthy page starts with is not called a lost connection.
 *
 * The whole line is the door: one real `<a>` to the chapter being written, or to the filing's
 * place (the record opens on its sentence). `связи нет`, the full hall and an idle page are not
 * links. The line's words are `lib/nowState.ts`'s and `lib/socketStatus.ts`'s — this file draws
 * them and never spells one.
 *
 * Authors get one more line under it: the queue ahead and the last price (`live.lastCost`).
 * At the phone's step it joins the status line's second row, so the head is two rows there and
 * never three; the id and the clock are the parts the step drops first.
 */
export function HeadLine({
  client,
  connection = null,
  nowMs,
}: {
  /** The page's folded frames — the one source of every fact on this line. */
  client?: ClientState | null;
  /**
   * What the socket is doing, and how many consecutive attempts have failed. `null` where the
   * caller has no socket of its own (a test's head, a surface that draws no line): the frames
   * speak then. The page always hands its own state in (`App.tsx`).
   */
  connection?: ConnectionState | null;
  /** A fixed clock for a test; a page hands none in and the line reads its own. */
  nowMs?: number;
}) {
  const fixed = nowMs !== undefined;
  const [clock, setClock] = useState(() => nowMs ?? Date.now());
  const word = connection === null ? null : connectionWordOf(connection);
  // Only an open socket lets the frames speak: a state derived from a dead one is a stale claim.
  const framesSpeak = connection === null || connection.status === 'open';

  // A new frame is a new observation: re-read the clock once per frame. A duplicate frame is the
  // same state object, so a re-delivery costs no render.
  useEffect(() => {
    if (fixed) return;
    setClock(Date.now());
  }, [fixed, client, connection?.status, connection?.attempts]);

  const state: NowState | null =
    word !== null || !framesSpeak || client === null || client === undefined
      ? null
      : nowStateOf({ state: client, nowMs: fixed ? nowMs : clock });

  // One timer, at the one moment this state stops being true (a claim's deadline, a resting
  // ending). No interval, no poll, and nothing ticks while the line is idle or has no end.
  const until = state?.untilMs ?? null;
  useEffect(() => {
    if (fixed || until === null) return;
    const due = until + 1 - Date.now();
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, due));
    return () => window.clearTimeout(timer);
  }, [fixed, until, state?.kind]);

  // Announced on a state change, never on every render: a region that spoke on every frame would
  // read the whole line out loud again and again.
  const shown = word?.kind ?? state?.kind ?? null;
  const spoken = useRef<string | null>(null);
  const announce = spoken.current !== null && spoken.current !== shown;
  useEffect(() => {
    spoken.current = shown;
  }, [shown]);

  if (word !== null) {
    return (
      <div className="head-line" data-kind={word.kind} role="status" aria-live={announce ? 'polite' : 'off'}>
        <span className="head-line-text">{word.text}</span>
      </div>
    );
  }
  if (state === null || state.line === null) return null;

  return (
    <div className="head-line" data-kind={state.kind} role="status" aria-live={announce ? 'polite' : 'off'}>
      <Line state={state} />
      {state.author === null ? null : (
        <span className="head-line-author">
          {/* On the phone the author's line is the second row of the same line, so it takes the
              line's own separator; alone on its own row (above 767) it does not. */}
          <span className="head-line-sep head-line-author-sep" aria-hidden="true">{' ·\u00a0'}</span>
          {state.author}
        </span>
      )}
    </div>
  );
}

/** The line itself: the parts, and the door when the state has a place to open. */
function Line({ state }: { state: NowState }) {
  const parts = <Parts parts={state.parts} />;
  if (state.door === null) return <span className="head-line-text">{parts}</span>;
  return (
    <PlaceLink place={placeOf(state.door)} className="head-line-text">
      {parts}
    </PlaceLink>
  );
}

/** The head's own place shapes are `place.ts`'s: a chapter, or a filing read by its id. */
function placeOf(door: NowDoor): Place {
  return 'commentId' in door ? { commentId: door.commentId, chapter: door.chapter } : { chapter: door.chapter };
}

/** The parts, with the separator bound to the following part so a break never leaves it alone. */
function Parts({ parts }: { parts: readonly LinePart[] }) {
  return (
    <>
      {parts.map((part, index) => (
        <span
          // The parts are positional: the same state always builds the same list.
          key={index}
          className={part.drop === undefined ? 'head-line-part' : `head-line-part hl-${part.drop}`}
        >
          {index === 0 ? null : (
            // The separator before the part, joined to it by a no-break space: a wrapped line
            // never leaves a `·` alone at the end of a row.
            <span className="head-line-sep" aria-hidden="true">{' ·\u00a0'}</span>
          )}
          {part.text}
          {part.tail === undefined ? null : <span className={`hl-${part.tail.drop}`}>{part.tail.text}</span>}
        </span>
      ))}
    </>
  );
}
