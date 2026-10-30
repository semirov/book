/**
 * BOOK-220 §11.2 (BOOK-DOC-84, page 488) — the printing block, in place.
 *
 * The owner's contract, and the whole of it:
 *
 *   • **one caret**, not two: the tree holds at most one `.caret-ink`, standing at the ink's
 *     leading edge; nothing else marks the print;
 *   • **ink downwards, in reading order**, character by character — the paragraph is laid out
 *     once in its final text and the not-yet-written part is *invisible, not absent*: a growing
 *     clip whose L-shaped edge follows the caret reveals everything above the caret's line and
 *     the caret's own line up to its x. No per-character spans, no `textContent` rewrite, and
 *     the DOM's node count does not grow with the text;
 *   • **a deletion's ghost** keeps the removed text's geometry as an absolutely positioned
 *     overlay (one node, `text-indent` places its first line), a 1 px strike in the rule colour,
 *     a 600 ms fade, then gone. Never "delete by not drawing";
 *   • **a replacement** strikes and fades the old text while the new one inks at the same place —
 *     the ghost holds the geometry as an overlay, and the swap moves nothing: an absolutely
 *     positioned node is out of flow, so there is no reflow at the fade's end (or at any point);
 *   • **reduced motion**: the final text at once, the strike for 600 ms, no ink, no caret;
 *   • **mid-print arrival** joins the pass's own timeline (`startAt` is absolute and the clock is
 *     clamped at zero), never a restart.
 *
 * Geometry is read once, before the first frame (`lib/passMeasure.ts`): a frame writes one clip
 * polygon, one caret transform and one ghost opacity through CSSOM, and never reads layout.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { PassSpan } from '../lib/passDiff.ts';
import { geometryOf, measureGraphemes, type PrintGeometry } from '../lib/passMeasure.ts';
import { PRINT, caretIndexAt, planPrint, settleMs, type PrintPlan } from '../lib/printPlan.ts';
import { beginPrint, reportCaret } from '../lib/printFollow.ts';
import { printProbeOn } from '../lib/printProbe.ts';
import { graphemes } from '../lib/reveal.ts';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export type PrintPassProps = {
  blockId: string;
  /** The block's final text — laid out once, never re-set. */
  text: string;
  /** The changed run inside `text` (`passDiff.ts`): what inks, and what is struck. */
  span: PassSpan;
  /** Epoch ms the print belongs to (`chapter:applied.appliedAt`): an absolute clock. */
  startAt: number;
  now?: () => number;
  reduced?: boolean;
  /** The ordinary paragraph's provenance door: inline, so its presence moves no line. */
  prov?: boolean;
  onSettled?: () => void;
};

type Beat = 'hold' | 'type' | 'static' | 'settled';

const clamp01 = (value: number): number => (value <= 0 ? 0 : value >= 1 ? 1 : value);

/** The clip that reveals the block in reading order: full lines above, the caret's line to x. */
export function revealPolygon(width: number, x: number, y: number, linePx: number): string {
  const right = Math.max(0, width);
  const bottom = y + Math.max(1, linePx);
  const cut = Math.min(Math.max(0, x), right);
  return `polygon(0px 0px, ${right}px 0px, ${right}px ${y}px, ${cut}px ${y}px, ${cut}px ${bottom}px, 0px ${bottom}px)`;
}

export function PrintPass({
  blockId,
  text,
  span,
  startAt,
  now: readNow = Date.now,
  reduced = false,
  prov = false,
  onSettled,
}: PrintPassProps) {
  const blockRef = useRef<HTMLParagraphElement | null>(null);
  const copyRef = useRef<HTMLSpanElement | null>(null);
  const caretRef = useRef<HTMLSpanElement | null>(null);
  const ghostRef = useRef<HTMLSpanElement | null>(null);
  const doneRef = useRef(false);

  const finals = useMemo(() => graphemes(text), [text]);
  /** The run that inks: the new text of a replacement or an insertion, nothing for a deletion. */
  const ink = useMemo(() => (span.kind === 'deletion' ? [] : graphemes(span.after)), [span]);
  /** The ghost's text is the run that leaves; an insertion leaves nothing behind. */
  const ghostText = span.kind === 'insertion' ? null : span.before;

  const [beat, setBeat] = useState<Beat>(reduced ? 'static' : 'hold');
  const [ghost, setGhost] = useState(ghostText !== null);
  const [broken, setBroken] = useState(false);
  // A deletion has no ink: nothing leads it, so no caret is ever painted for one.
  const [caret, setCaret] = useState(!reduced && span.kind !== 'deletion');

  useMeasuredLayout(() => {
    const finish = (): void => {
      if (doneRef.current) return;
      doneRef.current = true;
      const copy = copyRef.current;
      if (copy !== null) copy.style.clipPath = 'none';
      if (caretRef.current !== null) caretRef.current.style.opacity = '0';
      setCaret(false);
      setGhost(false);
      setBeat('settled');
      onSettled?.();
    };

    const block = blockRef.current;
    const copy = copyRef.current;
    const node = copy?.firstChild ?? null;
    if (block === null || copy === null || !(node instanceof Text)) {
      setBroken(true);
      finish();
      return;
    }

    /** Character offsets of the run inside the copy's one text node. */
    const startOffset = finals.slice(0, Math.min(span.offset, finals.length)).join('').length;
    const anchorAtEnd = span.kind === 'deletion' && span.offset >= finals.length && finals.length > 0;
    const anchorIndex = anchorAtEnd ? finals.length - 1 : Math.min(span.offset, Math.max(0, finals.length - 1));
    const measured = measureGraphemes(
      block,
      copy,
      node,
      ink.length > 0 ? ink : finals.slice(anchorIndex, anchorIndex + 1),
      ink.length > 0 ? startOffset : finals.slice(0, anchorIndex).join('').length,
    );
    const geometry: PrintGeometry | null = measured === null ? null : geometryOf(measured);

    let plan: PrintPlan | null = null;
    if (geometry !== null) {
      try {
        plan = planPrint({
          kind: span.kind,
          before: span.before,
          after: span.after,
          cps: window.innerWidth < 600 ? PRINT.cps.phone : PRINT.cps.desktop,
          seed: `${blockId}:${String(startAt)}`,
          reducedMotion: reduced,
        });
      } catch {
        // A layout the engine refuses is not painted: the block stands settled.
        plan = null;
      }
    }
    if (plan === null || geometry === null) {
      setBroken(true);
      finish();
      return;
    }

    block.dataset.revealed = '0';
    // The harness's one window onto the clock: the plan's own ink times, so a sampler can ask
    // "what should be revealed now?" instead of trusting the DOM's own number. A reader's page
    // publishes nothing — the seam exists only behind the harness's own `?probe=print` flag.
    const probe = printProbeOn();
    const debug = window as unknown as {
      __print?: { blockId: string; startAt: number; inkTimes: number[]; total: number; at: number };
    };
    if (probe) {
      debug.__print = { blockId, startAt, inkTimes: [...plan.inkTimes], total: plan.graphemes.length, at: 0 };
    }
    // The copy's own document top, read once: the follow control never re-reads layout.
    const copyDocTop = copy.getBoundingClientRect().top + window.scrollY;

    /** The ghost's place: the run's first line and x, in the copy's coordinates. */
    const ghostLine = (geometry.runLines[0] ?? 0) * geometry.linePx;
    const ghostX = anchorAtEnd ? (geometry.lefts[0] ?? 0) + (geometry.widths[0] ?? 0) : (geometry.lefts[0] ?? 0);
    const fadeMs = Math.max(1, plan.strikeMs);
    /** The ghost's opacity at `at`: solid until the fade starts (a deletion fades at once). */
    const ghostOpacity = (at: number): number => clamp01(1 - at / fadeMs);

    if (reduced) {
      // The final text at once, the strike for its 600 ms, no ink, no caret element at all.
      copy.style.clipPath = 'none';
      setCaret(false);
      if (ghostText === null || plan.strikeMs === 0) {
        finish();
        return;
      }
      const timer = window.setTimeout(finish, plan.strikeMs);
      return () => window.clearTimeout(timer);
    }

    const stopPrinting = beginPrint();
    const elapsed = Math.max(0, readNow() - startAt);
    const settleAt = settleMs(plan);

    const placeCaret = (index: number): void => {
      const element = caretRef.current;
      if (element === null) return;
      const last = geometry.lefts.length - 1;
      const line = index < geometry.runLines.length ? (geometry.runLines[index] ?? 0) : (geometry.runLines[last] ?? 0);
      const x =
        index < geometry.lefts.length
          ? (geometry.lefts[index] ?? 0)
          : (geometry.lefts[last] ?? 0) + (geometry.widths[last] ?? 0);
      element.style.transform = `translate3d(${x.toFixed(2)}px, ${(line * geometry.linePx).toFixed(2)}px, 0)`;
      element.style.opacity = '1';
    };

    const placeGhost = (): void => {
      const element = ghostRef.current;
      if (element === null) return;
      element.style.top = `${ghostLine.toFixed(2)}px`;
      element.style.width = `${geometry.copyWidth.toFixed(2)}px`;
      element.style.textIndent = `${ghostX.toFixed(2)}px`;
    };

    let shownRevealed = -1;
    let shownBeat: Beat | null = null;
    let dead = false;
    let handle = 0;

    const paint = (at: number): boolean => {
      if (probe && debug.__print !== undefined) debug.__print.at = at;
      const revealed = caretIndexAt(plan, at);
      if (revealed !== shownRevealed) {
        shownRevealed = revealed;
        if (revealed >= plan.graphemes.length) {
          copy.style.clipPath = 'none';
        } else {
          const line = geometry.runLines[revealed] ?? 0;
          const x = geometry.lefts[revealed] ?? 0;
          copy.style.clipPath = revealPolygon(geometry.copyWidth, x, line * geometry.linePx, geometry.linePx);
        }
        block.dataset.revealed = String(revealed);
        placeCaret(revealed);
      }
      // The follow's one write per frame: the caret's centre as the reader sees it, from the
      // one measurement (never a layout read), whether or not the ink moved this frame.
      const line = geometry.runLines[Math.min(revealed, Math.max(0, geometry.runLines.length - 1))] ?? 0;
      reportCaret(copyDocTop + line * geometry.linePx + geometry.linePx / 2, window.innerHeight, window.scrollY);
      if (ghostRef.current !== null && plan.strikeMs > 0) {
        ghostRef.current.style.opacity = ghostOpacity(at).toFixed(3);
      }
      const next: Beat = revealed <= 0 && at < plan.holdMs ? 'hold' : 'type';
      if (shownBeat !== next) {
        shownBeat = next;
        setBeat(next);
      }
      if (at >= plan.strikeMs && ghostRef.current !== null) setGhost(false);
      if (at >= settleAt) {
        stopPrinting();
        finish();
        return true;
      }
      return false;
    };

    if (elapsed >= settleAt) {
      // A reader who arrived after the print: the block is final, nothing replays.
      copy.style.clipPath = 'none';
      finish();
      return;
    }

    placeGhost();
    const origin = performance.now();
    if (!paint(elapsed)) {
      const tick = (): void => {
        if (dead) return;
        if (paint(elapsed + (performance.now() - origin))) return;
        handle = requestAnimationFrame(tick);
      };
      handle = requestAnimationFrame(tick);
    }

    return () => {
      dead = true;
      if (probe && debug.__print !== undefined) delete debug.__print;
      stopPrinting();
      if (handle !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
    };
  }, []);

  return (
    <p
      className="p p-pass"
      data-block-id={blockId}
      data-pass={broken ? 'settled' : beat}
      ref={blockRef}
    >
      <span className="pass-visual" aria-hidden="true">
        {/*
          The painted copy: the whole final text, laid out once. The clip is a CSSOM write on
          this one box — no character is a node, and nothing is re-set after the first frame.
        */}
        <span className="pass-copy" ref={copyRef}>
          {text}
          {prov ? (
            <button type="button" className="prov" aria-hidden="true" tabIndex={-1}>
              ⋯
            </button>
          ) : null}
        </span>
        {ghost && ghostText !== null ? (
          <span className="pass-ghost" ref={ghostRef} aria-hidden="true">
            {ghostText}
          </span>
        ) : null}
        {caret ? <span className="caret-ink" aria-hidden="true" ref={caretRef} /> : null}
      </span>
      {/* One announcement: the whole final block, at once, never character by character. */}
      <span className="visually-hidden">{text}</span>
    </p>
  );
}
