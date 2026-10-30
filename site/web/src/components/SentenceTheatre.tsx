import type { PassStageEvent } from '@book/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { reducedMotion } from '../dom.ts';
import type { SentenceFilings } from '../lib/filings.ts';
import { readingOf, useFilingLive } from '../lib/filingLive.ts';
import { arrivalRuns, changedLines, measure, type Geometry } from '../lib/theatreLines.ts';
import { useTheatreStage } from '../lib/theatreStage.tsx';
import {
  decisionOf,
  failureOf,
  inkedAt,
  performedFiling,
  writtenRunOf,
  sweepOf,
  tallyMs,
  theatreOf,
  type Act,
} from '../lib/theatre.ts';

/** Measure before paint in the browser; do nothing during a server render (tests). */
const useMeasuredLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** §9.1 — the reduced-motion span mark is held exactly as long as the reading would run. */
const SPAN_HOLD_MS = 2_000;

export type SentenceTheatreProps = {
  /** The sentence's filings: the same group the numeral and the note are drawn from. */
  filings: SentenceFilings;
  /** The page's stage log, when no `TheatreStageProvider` stands above. */
  stages?: readonly PassStageEvent[] | null;
  /** A dead transport: every moving mark stops; no per-sentence mark is added. */
  transportDown?: boolean;
  now?: () => number;
  reduced?: boolean;
};

const clamp01 = (value: number): number => (value <= 0 ? 0 : value >= 1 ? 1 : value);
/**
 * BOOK-227 / BOOK-DOC-86 — the theatre of one filing, in the DOM.
 *
 * One overlay per performed sentence, absolutely positioned inside the paragraph. Its nodes are
 * the sentence's **lines** (≤ 10), never its words and never its graphemes: 1 host + L rules + 1
 * nib + 1 spine + 1 foot + 1 rule-end + 1 note rule + ≤ 3 tallies = **≤ 19 nodes**, and the
 * chapter's length adds none (§9.13). The one rAF chain is the arrival's fill; it stops at
 * `sweepMs` or on unmount (§9.11), and every other act is a birth the sheet owns.
 */
export function SentenceTheatre({
  filings,
  stages,
  transportDown,
  now = Date.now,
  reduced,
}: SentenceTheatreProps) {
  const host = useRef<HTMLSpanElement | null>(null);
  const nib = useRef<HTMLSpanElement | null>(null);
  const spine = useRef<HTMLSpanElement | null>(null);
  const foot = useRef<HTMLSpanElement | null>(null);
  const ruleEnd = useRef<HTMLSpanElement | null>(null);
  const noteRule = useRef<HTMLSpanElement | null>(null);
  const endTicks = useRef<(HTMLSpanElement | null)[]>([]);
  const lineNodes = useRef<(HTMLSpanElement | null)[]>([]);
  const tallyNodes = useRef<(HTMLSpanElement | null)[]>([]);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [settled, setSettled] = useState(false);

  // The chapter's log comes from the page (`TheatreStageProvider`); the props are its fallback.
  const scope = useTheatreStage();
  const log = stages !== undefined ? stages : (scope?.stages ?? null);
  const down = transportDown ?? scope?.transport === 'down';

  const row = performedFiling(filings);
  // BOOK-220 §11.3 — the read's own frame, as the page publishes it: only a `claimed` phase
  // starts the arrival, and a frame that named another filing starts nothing here.
  const facts = useFilingLive();
  const reading = readingOf(facts, row?.id ?? null);
  const act: Act | null = theatreOf({
    filings,
    reading,
    stages: log,
    decision: row === null ? null : decisionOf(row),
    processing: row?.changeStatus === 'processing',
    failed: row === null ? null : failureOf(row),
    applied: scope?.applied ?? null,
    transport: down ? 'down' : 'up',
    now: now(),
  });
  const actRef = useRef<Act | null>(act);
  actRef.current = act;
  const previousKind = useRef<string | null>(null);

  // jsdom has no media queries: a surface without one has motion, never a crash.
  const queried = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && reducedMotion();
  const still = reduced ?? queried;
  const kind = act?.kind ?? null;
  const since = act?.since ?? 0;
  const deadlineAt = act !== null && act.kind === 'thinking' ? act.deadlineAt : null;
  const outcome = act?.kind === 'verdict' ? act.outcome : null;
  const cause = act?.kind === 'failed' ? act.cause : null;

  /** The cite carries the act's shape; `citedClass` stays its source. */
  useMeasuredLayout(() => {
    const sentence = host.current?.closest<HTMLElement>('[data-s]') ?? null;
    if (sentence === null || kind === null) return;
    sentence.dataset.theatre = kind;
    if (outcome === null) delete sentence.dataset.outcome;
    else sentence.dataset.outcome = outcome;
    if (cause === null) delete sentence.dataset.cause;
    else sentence.dataset.cause = cause;
    return () => {
      delete sentence.dataset.theatre;
      delete sentence.dataset.outcome;
      delete sentence.dataset.cause;
    };
  }, [kind, since, outcome, cause, filings.quote]);

  // One measurement per act — never per frame.
  useMeasuredLayout(() => {
    setGeometry(act === null ? null : measure(host.current));
  }, [kind, since, filings.quote]);

  useEffect(() => setSettled(false), [kind, since]);

  const wantsLines = kind === 'arrival' || kind === 'landing' || (cause === 'fault' && kind === 'failed');
  const lines = wantsLines && geometry !== null && !settled ? geometry.lines : [];

  /** Where every static mark stands: one write per act. */
  useMeasuredLayout(() => {
    if (geometry === null) return;
    const first = geometry.lines[0];
    lineNodes.current.forEach((node, index) => {
      const line = geometry.lines[index];
      if (node === null || line === undefined) return;
      node.style.left = `${line.left.toFixed(2)}px`;
      node.style.top = `${line.top.toFixed(2)}px`;
      node.style.width = `${Math.max(line.width, 1).toFixed(2)}px`;
      // The fill's effect owns an arrival's clip. Every other act **states** the un-clipped rule:
      // removing the property falls back to the sheet's `inset(0 100% 0 0)`, i.e. a rule that is
      // measured but never painted — the landing lifted nothing and our fault showed only its foot.
      node.style.clipPath = kind === 'arrival' ? 'inset(0 100% 0 0)' : 'inset(0 0 0 0)';
    });
    const lastWord = geometry.words[geometry.words.length - 1];
    const lastTop = lastWord === undefined ? 0 : (geometry.ruleTops[lastWord.endLine] ?? 0);
    const startTick = endTicks.current[0];
    const endTick = endTicks.current[1];
    if (startTick !== null && startTick !== undefined && first !== undefined) {
      startTick.style.transform = `translate3d(${first.left.toFixed(2)}px, ${((geometry.ruleTops[0] ?? 0) - 4).toFixed(2)}px, 0)`;
    }
    if (endTick !== null && endTick !== undefined && lastWord !== undefined) {
      endTick.style.transform = `translate3d(${lastWord.right.toFixed(2)}px, ${(lastTop - 4).toFixed(2)}px, 0)`;
    }
    // The note hangs at the anchored line's top: its hairline withdraws from there (§9.7).
    if (noteRule.current !== null && first !== undefined) noteRule.current.style.top = `${first.top.toFixed(2)}px`;
    // Our fault ends the rule short: the tail carries no rule and the 2 × 4 foot stands under
    // **the rule's** end — the edge the clip leaves, not the word's own end (§9.8). Painted, not
    // animated: we do not know how far the read got.
    const lastNode = lineNodes.current[geometry.lines.length - 1];
    const lastLine = geometry.lines[geometry.lines.length - 1];
    // The last word may be hyphenated at the break: its tail is then all the last line carries,
    // and the tail is exactly what goes unruled — the line is left whole only when the word's
    // head stands on it.
    const kept =
      kind === 'failed' && cause === 'fault' && lastLine !== undefined && lastWord !== undefined
        ? lastWord.line === geometry.lines.length - 1
          ? Math.max(0, Math.min(lastLine.width, lastWord.left - lastLine.left))
          : 0
        : null;
    if (kept !== null && lastNode != null && lastLine !== undefined) {
      lastNode.style.clipPath = `inset(0 ${(lastLine.width - kept).toFixed(2)}px 0 0)`;
    }
    if (ruleEnd.current !== null && lastLine !== undefined && kept !== null) {
      ruleEnd.current.style.transform = `translate3d(${(lastLine.left + kept - 1).toFixed(2)}px, ${(lastTop + 3).toFixed(2)}px, 0)`;
    }
  }, [geometry, kind, cause, settled, lines.length]);

  /** The nib: the arrival's press, the verdict's and the thinking hand's stub. */
  useMeasuredLayout(() => {
    const element = nib.current;
    if (element === null) return;
    const lastWord = geometry?.words[geometry.words.length - 1];
    const lastTop = lastWord === undefined ? 0 : (geometry?.ruleTops[lastWord.endLine] ?? 0);
    element.dataset.shape = 'nib';
    element.style.opacity = '0';
    if (kind === 'arrival') {
      element.style.opacity = '1';
      return;
    }
    if ((kind === 'verdict' && outcome === 'accepted') || kind === 'thinking') {
      if (lastWord === undefined) return;
      element.dataset.shape = 'stub';
      element.style.transform = `translate3d(${(lastWord.right + 1).toFixed(2)}px, ${(lastTop - 6).toFixed(2)}px, 0)`;
      element.style.width = '2px';
      element.style.opacity = '1';
    }
  }, [kind, since, outcome, geometry]);

  /** The births after the first paint: the spine holds, the tallies rule. */
  useMeasuredLayout(() => {
    const was = previousKind.current;
    previousKind.current = kind;
    // A pass holds the block from the draft call to the first gate — thinking, the check; a
    // failure that interrupts it keeps the stroke it was given (§9.2, §9.5).
    const holds = kind === 'thinking' || kind === 'checking' || kind === 'writing';
    const open = holds || (kind === 'failed' && (was === 'thinking' || was === 'checking'));
    const stroke = spine.current;
    if (stroke !== null) stroke.dataset.open = open ? 'true' : 'false';
    if (still) return;
    const raf = requestAnimationFrame(() => {
      // The hand becomes the gate: the first tally inks and the spine withdraws, one frame.
      for (const node of tallyNodes.current) {
        if (node !== null) node.dataset.ink = '';
      }
      if (kind === 'checking' && stroke !== null) stroke.dataset.open = 'false';
      if (kind === 'landing' && noteRule.current !== null) noteRule.current.dataset.withdraw = '';
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [kind, since, still]);

  /* -------------------------------------------------- the arrival's clock ---- */
  useMeasuredLayout(() => {
    const current = actRef.current;
    if (current === null || current.kind !== 'arrival' || geometry === null) return;
    const { runs, visible } = arrivalRuns(geometry);
    const sweep = sweepOf(visible.length);
    const startedAt = current.since;
    const sentence = host.current?.closest<HTMLElement>('[data-s]') ?? null;
    const element = nib.current;

    /** Paint `k` words: one clip per line, one transform and width on the nib (§9.1). */
    const shown: number[] = [];
    const paint = (k: number): void => {
      runs.forEach((run, index) => {
        const node = lineNodes.current[index];
        if (node === null || node === undefined) return;
        const inked = Math.max(0, Math.min(run.words.length, k - run.first));
        const last = inked === 0 ? undefined : run.words[inked - 1];
        const edge = last === undefined ? run.left : last.left + last.width;
        // A line whose words are all inked is whole: a ragged last line is never left short.
        const whole = inked >= run.words.length;
        const cut = !run.visible || whole ? 0 : run.width * (1 - clamp01((edge - run.left) / Math.max(run.width, 1)));
        // One write per line, and only when its edge moved: one clip and one nib write a frame.
        if (shown[index] === cut) return;
        shown[index] = cut;
        node.style.clipPath = `inset(0 ${cut.toFixed(2)}px 0 0)`;
      });
      const word = visible[Math.min(k, visible.length) - 1];
      if (element !== null && word !== undefined) {
        element.style.transform = `translate3d(${word.left.toFixed(2)}px, ${(geometry.ruleTops[word.line] ?? 0).toFixed(2)}px, 0)`;
        element.style.width = `${word.width.toFixed(2)}px`;
      }
    };

    const quiet = (): void => {
      if (sentence !== null) delete sentence.dataset.theatre;
      // The nib is the pen's press, and the press ends with the fill: a 2 px bar left parked
      // under the last word would keep claiming a read that is over (§9.1 — the rule is solid).
      if (element !== null) {
        element.dataset.shape = 'nib';
        element.style.opacity = '0';
        element.style.width = '0px';
      }
      setSettled(true);
    };

    if (still) {
      // No movement: the span mark at once, held min(sweepMs, 2 000) ms, then the plain cite.
      paint(visible.length);
      const timer = setTimeout(quiet, Math.min(sweep, SPAN_HOLD_MS));
      return () => {
        clearTimeout(timer);
      };
    }

    const elapsed = Math.max(0, now() - startedAt);
    // No visible line, or the reader arrived after the fill: the fact happened unwatched, so the
    // rule is solid in the frame that arrives (§9.1).
    if (visible.length === 0 || elapsed >= sweep) {
      quiet();
      return;
    }

    let handle = 0;
    let dead = false;
    const tick = (): void => {
      if (dead) return;
      const at = Math.max(0, now() - startedAt);
      paint(inkedAt(at, sweep, visible.length));
      if (at >= sweep) {
        quiet();
        return;
      }
      handle = requestAnimationFrame(tick);
    };
    paint(inkedAt(elapsed, sweep, visible.length));
    handle = requestAnimationFrame(tick);
    return () => {
      dead = true;
      if (handle !== 0) cancelAnimationFrame(handle);
    };
  }, [kind, since, geometry, still, now]);

  /** §9.7 — the landing's rule lifts 120 ms after the sink, one rAF. */
  useMeasuredLayout(() => {
    if (kind !== 'landing' || geometry === null) return;
    const nodes = lineNodes.current.filter((node): node is HTMLSpanElement => node !== null);
    const lift = (): void => {
      for (const node of nodes) node.dataset.lift = '';
    };
    if (still) {
      lift();
      return;
    }
    const raf = requestAnimationFrame(lift);
    return () => {
      cancelAnimationFrame(raf);
      for (const node of nodes) delete node.dataset.lift;
    };
  }, [kind, since, geometry, still]);

  /** §9.2 — the deadline's one mark: a 4 × 3 foot, once; any change cancels it. */
  useEffect(() => {
    if (deadlineAt === null || actRef.current?.kind !== 'thinking') return;
    const timer = setTimeout(() => {
      if (foot.current !== null) foot.current.dataset.open = 'true';
    }, Math.max(0, deadlineAt - now()));
    return () => clearTimeout(timer);
  }, [deadlineAt, since, now]);

  if (act === null) return null;

  const lineCount = geometry?.lines.length ?? 0;
  const firstTop = geometry?.lines[0]?.top ?? 0;
  /**
   * §9.5 / BOOK-233 item 1 — a tally is as tall as the **changed** lines: the write's span names
   * the run, this sentence's one measurement says which lines its words stand on, and the
   * sentence's own count is the fallback when the run cannot be placed here.
   */
  const changedRun = writtenRunOf(scope?.applied ?? null, filings.blockId);
  const changed = geometry === null ? null : changedLines(geometry.words, geometry.text, changedRun);
  const tallyLines = changed ?? lineCount;
  const tallyHeight = geometry === null ? 0 : tallyLines * geometry.linePx + 8;
  const tallies = act.kind === 'checking' ? Math.min(act.tallies, 3) : 0;
  const spineOpen = still && (kind === 'thinking' || cause === 'fault');

  return (
    <span
      className="theatre"
      data-act={kind ?? undefined}
      data-outcome={outcome ?? undefined}
      data-cause={cause ?? undefined}
      data-still={still ? '' : undefined}
      aria-hidden="true"
      ref={host}
    >
      {lines.map((_, index) => (
        <span
          key={index}
          className="theatre-line"
          ref={(node) => {
            lineNodes.current[index] = node;
          }}
        />
      ))}
      {act.kind === 'arrival' && still ? (
        <>
          <span
            className="theatre-end"
            data-end="start"
            ref={(node) => {
              endTicks.current[0] = node;
            }}
          />
          <span
            className="theatre-end"
            data-end="end"
            ref={(node) => {
              endTicks.current[1] = node;
            }}
          />
        </>
      ) : null}
      <span className="theatre-nib" data-shape="nib" ref={nib} />
      <span className="theatre-spine" data-open={spineOpen ? 'true' : 'false'} ref={spine} />
      <span className="theatre-foot" data-open="false" ref={foot} />
      {tallies > 0
        ? [...Array(tallies)].map((_, index) => (
            <span
              key={`tally-${String(index)}`}
              className="theatre-tally"
              data-gate={index}
              {...(still ? { 'data-ink': '' } : {})}
              ref={(node) => {
                tallyNodes.current[index] = node;
                if (node === null) return;
                node.style.top = `${(firstTop - 4).toFixed(2)}px`;
                node.style.height = `${tallyHeight.toFixed(2)}px`;
                // The tally's duration is its height's: one line box per 120 ms (§9.6).
                node.style.transitionDuration = `${tallyMs(tallyLines)}ms`;
              }}
            />
          ))
        : null}
      {kind === 'landing' ? <span className="theatre-note-rule" ref={noteRule} /> : null}
      {cause === 'fault' ? (
        <span
          className="theatre-rule-end"
          ref={(node) => {
            ruleEnd.current = node;
          }}
        />
      ) : null}
    </span>
  );
}
