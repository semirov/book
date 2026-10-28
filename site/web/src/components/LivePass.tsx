/**
 * BOOK-121 — one paragraph's live pass, painted where it was written.
 *
 * IFACE — the rAF driver has exactly three exits:
 *   • `settled` — the plan's own end (`frameAt` answers `settled` at `plan.settleMs`), or a mount
 *     that is already past it. The last frame is applied, `onSettled` fires **once**, the carets
 *     leave the tree and the loop stops for good.
 *   • `reduced` — no loop at all: the settled state is painted in the mount pass and `onSettled`
 *     fires at once, so the caller may unmount immediately. No caret element is ever created.
 *   • `unmounted` — the cleanup cancels the frame; a callback already queued does nothing and
 *     never calls `onSettled`.
 *   The caller's part: `onSettled` once per pass, then unmount this renderer.
 *
 * Bounds — one `requestAnimationFrame` chain, stopped by the first settled frame: it never runs
 * past `plan.settleMs` (+ the one frame already scheduled). No `setInterval`, no second timer,
 * no timer theatre: the engine is the clock and the browser's frame is the tick.
 *
 * State ownership — the component owns only its local raster state (how many graphemes are
 * inked, whether the deletion's ghost is still in the flow, the carets' boxes and the beat it
 * prints in `data-pass`). Nothing grows in a store; the geometry is read once and kept in the
 * closure of the loop.
 *
 * Geometry — measured once, before the first frame (`lib/passMeasure.ts`). A frame writes
 * classes, one custom property and two transforms through CSSOM; it never reads layout, so an
 * ink cannot force a reflow. The one exception is a deletion, which reflows once by design: the
 * ghost of the removed text is in the flow until `swapMs` and leaves it then.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { passRunOf, type PassSpan } from '../lib/passDiff.ts';
import { frameAt, PASS, planPass, type PassLayout, type PassPlan } from '../lib/passMotion.ts';
import { layoutOf, measureRun } from '../lib/passMeasure.ts';
import { graphemes } from '../lib/reveal.ts';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** A caret inks in over this long at birth. JS owns it: a CSS transition would replay on every
 * opacity write the fade makes, and under reduced motion there is no caret to transition. */
const CARET_INK_MS = 120;

const clamp01 = (value: number): number => (value <= 0 ? 0 : value >= 1 ? 1 : value);

/** How much of a caret is painted `at` ms after it was born. */
const caretsInk = (at: number, birthMs: number): number => clamp01((at - birthMs) / CARET_INK_MS);

export type LivePassProps = {
  blockId: string;
  /** The block's final text — the text the ink is laid out with, once, and never re-set. */
  text: string;
  /** What the pass replaced, and where that run sits in `text`. */
  span: PassSpan;
  /** Epoch ms of the `typing`/revision event the pass belongs to. */
  startAt: number;
  now?: () => number;
  reduced?: boolean;
  onSettled?: () => void;
  /** The layout the plan was built from, once — the caller can pin what the block measured. */
  onMeasure?: (layout: PassLayout) => void;
};

export function LivePass({
  blockId,
  text,
  span,
  startAt,
  now: readNow = Date.now,
  reduced = false,
  onSettled,
  onMeasure,
}: LivePassProps) {
  const blockRef = useRef<HTMLParagraphElement | null>(null);
  const runRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const washRef = useRef<HTMLSpanElement | null>(null);
  const readRef = useRef<HTMLSpanElement | null>(null);
  const writeRef = useRef<HTMLSpanElement | null>(null);
  const doneRef = useRef(false);

  const run = useMemo(() => passRunOf(text, span), [text, span]);
  /** A span that does not describe this text: the block is shown settled, never painted as a guess. */
  const broken = run === null;

  const [carets, setCarets] = useState(!reduced && !broken);
  const [ghost, setGhost] = useState(true);
  const [beat, setBeat] = useState(reduced || broken ? 'static' : 'paint');

  // One pass per mount: the caller keys the block by the pass it belongs to. The effect reads the
  // props it was mounted with and stops on its own; a new `startAt` is a new renderer.
  useMeasuredLayout(() => {
    /** The one exit every path funnels into: paint what is final, tell the caller once. */
    const finish = (): void => {
      if (doneRef.current) return;
      doneRef.current = true;
      setCarets(false);
      setGhost(false);
      setBeat('settled');
      onSettled?.();
    };

    const wash = washRef.current;
    const ink = runRefs.current;
    const showWash = (opacity: number): void => {
      // The wash only: the run's ink is the graphemes' own colour and never fades with the box.
      wash?.style.setProperty('--pass-wash', `${Math.round(clamp01(opacity) * 100)}%`);
    };
    const settleNow = (): void => {
      showWash(0);
      for (const node of ink) node?.classList.remove('is-pending');
      finish();
    };

    const block = blockRef.current;
    const nodes = ink.filter((node): node is HTMLSpanElement => node !== null);
    const measured = block === null || broken ? null : measureRun(block, nodes);
    const geometry = measured === null ? null : layoutOf(measured, span.kind);

    let plan: PassPlan | null = null;
    if (geometry !== null) {
      const layout: PassLayout = {
        linePx: geometry.linePx,
        blockLines: geometry.blockLines,
        runLines: geometry.runLines,
        spanStartLine: geometry.spanStartLine,
        spanLines: geometry.spanLines,
      };
      try {
        plan = planPass({
          kind: span.kind,
          before: span.before,
          after: span.after,
          layout,
          cps: PASS.cps[(typeof window !== 'undefined' && window.innerWidth < 600) ? 'phone' : 'desktop'],
          reducedMotion: reduced,
        });
      } catch {
        // A layout the engine refuses is not painted: the block stands settled.
        plan = null;
      }
      if (plan !== null) onMeasure?.(layout);
    }

    // The negative exits: no plan, no frame source, or a reader who arrived after the pass.
    if (plan === null || geometry === null || typeof requestAnimationFrame !== 'function') {
      settleNow();
      return;
    }

    const elapsed = Math.max(0, readNow() - startAt);
    if (reduced || elapsed >= plan.settleMs) {
      settleNow();
      return;
    }

    const { lefts, widths, linePx } = geometry;
    const redBirthMs = plan.kind === 'insertion' ? 0 : plan.splitMs;
    const origin = performance.now();
    let inked = 0;
    let shownWash = -1;
    let shownBeat = '';
    let ghostGone = false;
    let dead = false;
    let handle = 0;

    // The run is laid out *inked*; the first frame takes the ink away from all of it, and the
    // engine gives it back one grapheme at a time. Nothing is inserted or removed after this.
    for (const node of ink) node?.classList.add('is-pending');

    /** The run's x for a grapheme column: a column past the last one is the run's end. */
    const runX = (column: number): number => {
      if (lefts.length === 0) return 0;
      if (column >= 0 && column < lefts.length) return lefts[column] ?? 0;
      return (lefts[lefts.length - 1] ?? 0) + (widths[widths.length - 1] ?? 0);
    };

    const placeCaret = (element: HTMLSpanElement | null, line: number, column: number, opacity: number): void => {
      if (element === null) return;
      element.style.transform = `translate3d(${runX(column).toFixed(2)}px, ${(line * linePx).toFixed(2)}px, 0)`;
      element.style.opacity = opacity.toFixed(3);
    };

    /** Apply one instant. `true` means the pass is over and the loop must not schedule again. */
    const paint = (at: number): boolean => {
      const frame = frameAt(plan, at);

      // The ink gate: only graphemes whose index crosses `revealed` are touched, never all of them.
      while (inked < frame.revealed) {
        ink[inked]?.classList.remove('is-pending');
        inked += 1;
      }
      while (inked > frame.revealed) {
        inked -= 1;
        ink[inked]?.classList.add('is-pending');
      }

      const percent = Math.round((frame.selected ? frame.selectionOpacity : 0) * 100);
      if (percent !== shownWash) {
        showWash(percent / 100);
        shownWash = percent;
      }

      if (frame.blue !== null) {
        placeCaret(readRef.current, frame.blue.line, frame.blue.col, frame.blue.opacity * caretsInk(at, plan.blue.startMs));
      }
      if (frame.red !== null) {
        placeCaret(writeRef.current, frame.red.line, frame.red.col, frame.red.opacity * caretsInk(at, redBirthMs));
      }

      // The beat is the one thing a reader's machine can see as an attribute; it changes a
      // handful of times per pass, never per frame.
      if (shownBeat !== frame.beat) {
        shownBeat = frame.beat;
        setBeat(frame.beat);
      }
      // The deletion's one reflow: the ghost leaves the flow at the swap, and only once.
      if (span.kind === 'deletion' && frame.swapped && !ghostGone) {
        ghostGone = true;
        setGhost(false);
      }

      if (frame.settled) {
        finish();
        return true;
      }
      return false;
    };

    const tick = (): void => {
      if (dead) return;
      if (paint(elapsed + (performance.now() - origin))) return;
      handle = requestAnimationFrame(tick);
    };

    if (!paint(elapsed)) handle = requestAnimationFrame(tick);

    return () => {
      dead = true;
      if (handle !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
    };
  }, []);

  /** The run the ink is laid out with: the new text, or the ghost of the old one. */
  const clusters = useMemo(
    () => graphemes(span.kind === 'deletion' ? span.before : (run?.run ?? '')),
    [span, run],
  );

  const graphemeSpans = clusters.map((cluster, index) => (
    <span
      key={index}
      className="pg"
      data-i={index}
      ref={(node) => {
        runRefs.current[index] = node;
      }}
    >
      {cluster}
    </span>
  ));

  return (
    <p className="p p-pass" data-block-id={blockId} data-pass={beat} ref={blockRef}>
      {/*
        The painted copy: laid out once with the final text, never re-set — the ink is a colour
        on a grapheme that is already there. Hidden from assistive technology as a whole, so the
        sentence below is the only thing a screen reader reads.
      */}
      <span className="pass-visual" aria-hidden="true">
        {run === null ? text : run.prefix}
        {run === null ? null : span.kind === 'deletion' ? (
          ghost ? (
            <span className="pass-span pass-span-gone" aria-hidden="true" ref={washRef}>
              {graphemeSpans}
            </span>
          ) : null
        ) : (
          <span className="pass-span" aria-hidden="true" ref={washRef}>
            {graphemeSpans}
          </span>
        )}
        {run === null ? null : run.suffix}
      </span>
      {/* One announcement: the whole final block, at once, never character by character. */}
      <span className="visually-hidden">{text}</span>
      {carets ? (
        <>
          <span className="caret-read" aria-hidden="true" ref={readRef} />
          <span className="caret-write" aria-hidden="true" ref={writeRef} />
        </>
      ) : null}
    </p>
  );
}
