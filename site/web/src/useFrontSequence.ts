import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { reducedMotion } from './dom.ts';
import {
  GATE_ATTRIBUTE,
  GATE_DONE,
  GATE_RUN,
  TITLE_CAP_MS,
  TITLE_CPS,
  TITLE_FIRST_INK_MS,
  TITLE_REST_MS,
  TOTAL_MS,
  shouldRun,
} from './lib/frontSequence.ts';
import { blockText, createReveal, revealComplete, tickReveal } from './lib/reveal.ts';
import { resumePending } from './lib/usePosition.ts';

/**
 * BOOK-DOC-49 §2, §3, §5 — the first load: the gate under the sequence and the typed title.
 *
 * `useFrontSequence` is the driver, and it lives in the one place that mounts exactly when the
 * data lands (`Opening`): it knows when `t = 0` is, writes the gate before paint, owns the one
 * timer of the whole budget and ends the run on the reader's first input.
 *
 * `useTitleTyping` is the printing loop, and it lives with the `h1` that draws the graphemes
 * (`TypedTitle` in `TitleSheet.tsx`). The split is not cosmetic: a typing frame re-renders the
 * component that calls the hook and nothing else, so the 278–400 ms of the title cost one `h1`
 * update per frame instead of re-rendering the cover, page 2 and the instrument strip at 60 Hz.
 * There is still one printing engine and one caller of it.
 *
 * The gate is `run` or `done`, never absent once written. `done` is also how a later commit
 * knows this document already spent its sequence: a remount after it inherits the final page,
 * and a remount during it (development's double mount, which never paints) starts the same run
 * again instead of freezing a page whose timer is gone.
 *
 * The layout effect is read on the server too — `Opening` is rendered there by markup tests —
 * so it falls back to `useEffect`, which does nothing without a window.
 */

const usePaintEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The id the title prints under: the engine prints blocks, and the cover has one. */
const TITLE_BLOCK = 'front-title';

export type TitleReveal = {
  /** The graphemes printed so far; the whole title once nothing is printing. */
  text: string;
  /** The caret to draw: blinking while it prints, grey for its 220 ms rest, then gone. */
  caret: 'typing' | 'resting' | null;
};

/** `idle` — this page load runs no sequence (reduced motion, a deep link, a restored scroll). */
export type FrontSequenceStage = 'idle' | 'run' | 'done';

/** The title before its first grapheme: an empty line that only the caret holds open. */
const EMPTY_REVEAL: TitleReveal = { text: '', caret: 'typing' };

/**
 * The run in flight, as a function that ends it; `null` when this document runs no sequence.
 *
 * BOOK-209 — a resume must never land under a running sequence. The skip is decided at mount
 * from the **local** row (`resumePending`), and a second device has no local row: the cover
 * starts, and the place only arrives later, from the server. The position layer therefore ends
 * the sequence through this seam before such a resume lands — the same `settle` the reader's
 * first input and a `front:updated` already use, so there is still one way a run ends.
 */
let settleSequence: (() => void) | null = null;

/** Finish the sequence this document is running, whole: the title printed, the gate `done`. */
export function settleFrontSequence(): void {
  settleSequence?.();
}

export function useFrontSequence(motionToken: number): FrontSequenceStage {
  const [stage, setStage] = useState<FrontSequenceStage>('idle');
  /** The one way to finish the run from outside the loop; `null` when there is nothing to finish. */
  const settleRef = useRef<(() => void) | null>(null);
  /** The token the hook mounted with: any other token is a `front:updated` (§2d). */
  const mountToken = useRef(motionToken);

  usePaintEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const root = document.documentElement;
    const ran = root.getAttribute(GATE_ATTRIBUTE) === GATE_DONE;
    if (!shouldRun({ hash: window.location.hash, scrollY: window.scrollY, reduced: reducedMotion(), ran, restore: resumePending() })) {
      return;
    }

    // §2: written in the layout effect of the data commit, so the first painted frame is already
    // the empty title line with its caret, and every block is still waiting for its turn.
    root.setAttribute(GATE_ATTRIBUTE, GATE_RUN);
    setStage('run');

    let endTimer = 0;
    let settled = false;

    const stop = (): void => {
      window.clearTimeout(endTimer);
    };

    // §5: the first input ends the sequence in one frame; no reverse animation, no second run.
    const onInput = (): void => {
      settle();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') settle();
    };
    const once: AddEventListenerOptions = { passive: true, once: true };
    const detach = (): void => {
      window.removeEventListener('scroll', onInput);
      window.removeEventListener('pointerdown', onInput);
      window.removeEventListener('keydown', onInput);
      document.removeEventListener('visibilitychange', onVisibility);
    };

    const settle = (): void => {
      if (settled) return;
      settled = true;
      stop();
      // Nothing of the driver outlives its own end: no timer, no listener. The title's loop is
      // the `h1`'s, and it stops when `running` does — the stage change below is its signal.
      detach();
      root.setAttribute(GATE_ATTRIBUTE, GATE_DONE);
      setStage('done');
    };
    settleRef.current = settle;
    settleSequence = settle;

    // §2: one timer for the whole budget. Whatever the run did, the gate is `done` at 1 920 ms
    // and the page is final — the title's own loop can never leave a block waiting.
    endTimer = window.setTimeout(settle, TOTAL_MS);
    window.addEventListener('scroll', onInput, once);
    window.addEventListener('pointerdown', onInput, once);
    window.addEventListener('keydown', onInput, once);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      detach();
      settleRef.current = null;
      if (settleSequence === settle) settleSequence = null;
    };
  }, []);

  // §2d: a `front:updated` reaches the cover as a new motion token. The sequence finishes
  // first — the title whole, the gate `done` — and only then does the ripple key the `h1`, so a
  // remount can never strand a half-typed caret.
  usePaintEffect(() => {
    if (motionToken === mountToken.current) return;
    settleRef.current?.();
  }, [motionToken]);

  return stage;
}

/**
 * §3 — the title's printing loop, owned by the `h1` that renders it.
 *
 * `null` means the title is not printing and the caller shows the server's word whole; every
 * other value is a prefix plus the caret phase. The loop starts only while the driver says
 * `running`, so the gate still opens the run and the sequence's timer still ends it.
 */
export function useTitleTyping(title: string, running: boolean): TitleReveal | null {
  const [printed, setPrinted] = useState<TitleReveal | null>(null);

  usePaintEffect(() => {
    if (!running) return;
    const full = title;
    let state = createReveal([{ id: TITLE_BLOCK, text: full }], {
      reducedMotion: reducedMotion(),
      // §3 — the sheet's own parameters, not a branch in the engine: 18 cps, a fixed table (no
      // jitter), the first grapheme one interval in, and the 400 ms plateau for longer titles.
      cps: TITLE_CPS,
      jitter: 0,
      holdMs: TITLE_FIRST_INK_MS,
      capBlockMs: TITLE_CAP_MS,
    });

    let frame = 0;
    let restTimer = 0;

    const stop = (): void => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
      window.clearTimeout(restTimer);
    };

    // §5: the engine's own reduced-motion branch returns `active: -1`; a finished queue starts
    // no loop, so the JS path cannot type under still paper even if the gate were written.
    if (!revealComplete(state)) {
      // The loop's own clock: the first frame only fixes the origin, so nothing here measures
      // wall time from a mount that may have been suspended.
      let last: number | null = null;
      const step = (now: number): void => {
        const delta = last === null ? 0 : now - last;
        last = now;
        state = tickReveal(state, delta);
        if (revealComplete(state)) {
          // §3: the caret stays after the last grapheme, greys for 220 ms, then leaves — at 498
          // for «Бланк» (277.8 ms of typing + 220), and adopted by nothing.
          setPrinted({ text: full, caret: 'resting' });
          restTimer = window.setTimeout(() => setPrinted({ text: full, caret: null }), TITLE_REST_MS);
          return;
        }
        setPrinted({ text: blockText(state, TITLE_BLOCK, full), caret: 'typing' });
        frame = window.requestAnimationFrame(step);
      };
      frame = window.requestAnimationFrame(step);
    }

    return stop;
  }, [running, title]);

  if (!running) return null;
  return printed ?? EMPTY_REVEAL;
}
