/**
 * BOOK-209 — **a landing is a line, and the line is re-asserted until the page settles.**
 *
 * The owner's three complaints (BOOK-209) have one cause: the page's height changes *after* a
 * jump. A chapter's prose is fetched when the slot comes near the viewport, the printing reveal
 * types the opening in, a font finishes loading, the sticky head wraps — and every one of them
 * moves the text under the reader after the jump has already been performed. So an anchor
 * computed once lands somewhere else, and a stored pixel means nothing once the text moves.
 *
 * The answer is two things and no third:
 *
 *   1. **one line**, measured live: the sticky head's own lower edge plus `LANDING_PX`
 *      (`headerOffset.ts`), the very number `scroll-margin-top` gets — never a literal;
 *   2. **one bounded correction loop**: an instant jump puts the element's top on the line, and
 *      then each frame measures the residual and takes it back with one whole device-pixel
 *      quantum of `scrollBy`, until the residual has been inside half a pixel for six frames
 *      **and** the element's document top has not moved for six frames (the content settled).
 *      Never `smooth`, never a `setTimeout` guess: the frame loop is the contract, and it has a
 *      hard cap (`LANDING_FRAMES`) because a page that never settles must not own the reader's
 *      scroll forever.
 *
 * The loop is cancellable, and cancellation is the reader's: `wheel`, `touchstart`,
 * `pointerdown`, `keydown` (passive where the browser allows it) end it at once, and so does a
 * newer landing — the page has one landing at a time (`beginLanding`/`isCurrent`), and one
 * correction loop at a time as well (`stopActiveLoop`: `landAt` lands under the token already in
 * force, so the generation alone cannot tell two loops apart). Every listener is removed on
 * every exit path.
 *
 * Where there is nothing to correct — a document with no layout (jsdom, a page shorter than the
 * viewport) — the jump still happens and the loop ends immediately: a measurement of nothing is
 * not a smaller truth, and a loop that cannot move the page must not spin.
 */

import { LANDING_PX, HEADER_SELECTOR, offsetTopOfPage } from './headerOffset.ts';

/** A landing's three endings: it arrived, the reader (or a newer landing) took the page, or time ran out. */
export type LandingResult = 'landed' | 'cancelled' | 'capped';

/**
 * The correction is snapped to the engine's **device-pixel grid**: an engine whose scroll
 * offsets are whole pixels ignores a `scrollBy(0.59)`, and the line would keep a sub-pixel
 * error forever. The step is therefore a whole quantum (`anchorHold.ts` states the same rule).
 */
function quantumOf(win: Window): number {
  return Math.max(1 / (win.devicePixelRatio || 1), 1 / 8);
}

/** The residual that counts as arrived: half a CSS pixel. */
export const LANDING_TOLERANCE = 0.5;

/** How many frames the residual and the element's document top must hold still. */
export const SETTLED_FRAMES = 6;

/** The hard bound of a landing: ≈3 s at 60 Hz, a count and not a clock. */
export const LANDING_FRAMES = 180;

/**
 * The reader's own gestures. A landing that is being performed is not a scroll the reader made,
 * so only a gesture ends it — a page that adjusts its own scroll (content above growing, the
 * engine anchoring a block) must not cancel the correction it needs.
 */
const INPUT_EVENTS: readonly [string, AddEventListenerOptions][] = [
  ['wheel', { passive: true }],
  ['touchstart', { passive: true }],
  ['pointerdown', { passive: true }],
  ['keydown', { passive: true, capture: true }],
];

/**
 * The line a landing puts a target on: the sticky head's measured **bottom** plus
 * `LANDING_PX`. Where the head is absent or not laid out (a page without a head, the
 * layout-less test environment) the page's own offset is the same number by another route.
 */
export function landingLine(doc: Document = document): number {
  const head = doc.querySelector(HEADER_SELECTOR);
  if (head !== null) {
    const rect = head.getBoundingClientRect();
    if (Number.isFinite(rect.bottom) && Number.isFinite(rect.height) && rect.height > 0) {
      return rect.bottom + LANDING_PX;
    }
  }
  return offsetTopOfPage(doc);
}

/**
 * The page has one landing at a time (owner, 2026-10-28): a click, a hash, a back/forward, a
 * resume and a programmatic chapter jump are all landings, and the newest one owns the page.
 * Every landing takes a token when it starts and drops its remaining acts (`isCurrent`) when a
 * newer one has started — otherwise two jumps fight for the scroll.
 */
let landingGeneration = 0;

/** Take the page for a new landing: every older landing becomes stale. */
export function beginLanding(): number {
  landingGeneration += 1;
  return landingGeneration;
}

/** Is this landing still the newest one? A stale landing must not scroll. */
export function isCurrent(token: number): boolean {
  return token === landingGeneration;
}

/**
 * The generation in force right now, for a caller that lands **inside** a landing it already
 * began (`landAt`): the correction must stop when a newer landing starts, and it must not take
 * the page from the act that is still finishing its own wait.
 */
export function landingToken(): number {
  return landingGeneration;
}

/** How many correction loops are running: a caller can tell a reader's scroll from its own. */
let running = 0;

export function landingActive(): boolean {
  return running > 0;
}

/**
 * The one correction loop that owns the scroll, and how to finish it.
 *
 * `beginLanding`/`isCurrent` answer *which landing is newest*; this answers *which loop is
 * running*, and the two are not the same question. `landAt` lands under the token already in
 * force (`landingToken`), so a click on a door and a resume that share a token would be two
 * loops side by side, each correcting every frame against a different target. A loop that starts
 * while another is running therefore finishes the older one first — as `'cancelled'`, with its
 * listener set and its frame removed — and only then takes the page.
 */
let activeLoop: ((result: LandingResult) => void) | null = null;

/** Finish the loop that owns the scroll; `'cancelled'` is the only ending an evicted loop can have. */
function stopActiveLoop(): void {
  const held = activeLoop;
  activeLoop = null;
  held?.('cancelled');
}

/** The document's scrollable height — 0 in a document that has no layout (jsdom). */
function scrollHeightOf(doc: Document): number {
  return Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
}

/** Is there anything to correct? A page that fits the viewport cannot be scrolled into place. */
function scrollable(doc: Document, win: Window): boolean {
  const height = scrollHeightOf(doc);
  return Number.isFinite(height) && height > (win.innerHeight || 0);
}

export type LandOptions = {
  /** How far below the line the element's top belongs; `0` — the line itself. */
  deltaPx?: number;
  doc?: Document;
  win?: Window;
  /** The loop's hard bound in frames; `LANDING_FRAMES` by default. */
  frames?: number;
};

export type FollowInput = LandOptions;

/**
 * Hold an element on the line, frame by frame, under a landing token that is already issued.
 * This is the half `place.ts` re-uses after its own jump (a fragment, a door) so there is one
 * correction loop on the page, not one per surface.
 */
export function followLine(element: Element, token: number, input: FollowInput = {}): Promise<LandingResult> {
  const doc = input.doc ?? document;
  const win = input.win ?? doc.defaultView ?? window;
  const delta = input.deltaPx ?? 0;
  const cap = Math.max(1, Math.round(input.frames ?? LANDING_FRAMES));
  // A landing a newer one already replaced claims nothing — and must not take the scroll from
  // the loop that does own it.
  if (!isCurrent(token)) return Promise.resolve('cancelled');
  // One loop at a time, even under one token: `landAt` lands under the token in force, so the
  // generation alone cannot tell two loops apart (BOOK-209, requirement 3's resume).
  stopActiveLoop();
  if (typeof win.requestAnimationFrame !== 'function' || !scrollable(doc, win)) {
    return Promise.resolve('landed');
  }
  const quantum = quantumOf(win);

  return new Promise<LandingResult>((resolve) => {
    let frame = 0;
    let spent = 0;
    let still = 0;
    let stillDoc = 0;
    let docTop = Number.NaN;
    let done = false;
    running += 1;

    const detach = (): void => {
      for (const [name, options] of INPUT_EVENTS) win.removeEventListener(name, onInput, options);
    };
    const finish = (result: LandingResult): void => {
      if (done) return;
      done = true;
      if (activeLoop === finish) activeLoop = null;
      running = Math.max(0, running - 1);
      if (frame !== 0) win.cancelAnimationFrame(frame);
      frame = 0;
      detach();
      resolve(result);
    };
    activeLoop = finish;
    // The reader's own gesture wins over a correction it did not ask for.
    const onInput = (): void => finish('cancelled');

    /**
     * Nothing can be done in this direction: the page stands at its own end (or its own top).
     * The end is the one measured **this frame** — a stale maximum is what declares a landing
     * arrived 11 838 px short of the paragraph it was asked for.
     */
    const blocked = (residual: number, maxScroll: number): boolean => {
      if (residual > 0) return win.scrollY >= maxScroll - LANDING_TOLERANCE;
      return win.scrollY <= LANDING_TOLERANCE;
    };

    const tick = (): void => {
      frame = 0;
      if (!isCurrent(token)) {
        finish('cancelled');
        return;
      }
      if (spent >= cap) {
        finish('capped');
        return;
      }
      spent += 1;
      // The document's end is measured every frame, never once before the loop: the premise of
      // the whole landing is that the page **grows** after the jump (lazy prose, the printing
      // reveal, a font). A jump clamped at the then-bottom is not an arrival, and a landing
      // blocked at the end the page has *now* is.
      const maxScroll = Math.max(0, scrollHeightOf(doc) - (win.innerHeight || 0));
      // The line is re-measured every frame: a head that wrapped, or a font that finished
      // loading, moves the landing edge as well as the text.
      const line = landingLine(doc) + delta;
      const connected = element.isConnected;
      const boxTop = connected ? element.getBoundingClientRect().top : 0;
      const moved = !Number.isFinite(docTop) || Math.abs(boxTop + win.scrollY - docTop) > LANDING_TOLERANCE;
      docTop = boxTop + win.scrollY;
      stillDoc = moved ? 0 : stillDoc + 1;

      let residual = connected ? element.getBoundingClientRect().top - line : 0;
      // Up to three rounds in the same task, one quantum each, then a fresh measurement: a
      // single step can land on the other side of the target, and the contract is the residual.
      for (let round = 0; round < 3 && Math.abs(residual) > LANDING_TOLERANCE; round += 1) {
        if (blocked(residual, maxScroll)) break;
        const step =
          Math.abs(residual) >= quantum ? Math.round(residual / quantum) * quantum : Math.sign(residual) * quantum;
        win.scrollBy({ top: step, behavior: 'auto' });
        residual = connected ? element.getBoundingClientRect().top - line : 0;
      }
      // A page standing at its own end cannot be corrected further: that is a settled line, not
      // a loop that must burn its whole budget. The end is the current one, so a landing the
      // jump clamped at a stale bottom keeps correcting until the page stops growing.
      const settled = Math.abs(residual) <= LANDING_TOLERANCE || blocked(residual, maxScroll);
      still = settled ? still + 1 : 0;
      if (still >= SETTLED_FRAMES && stillDoc >= SETTLED_FRAMES) {
        finish('landed');
        return;
      }
      frame = win.requestAnimationFrame(tick);
    };

    for (const [name, options] of INPUT_EVENTS) win.addEventListener(name, onInput, options);
    frame = win.requestAnimationFrame(tick);
  });
}

/**
 * Land one element: one instant jump that puts its top on the line (`+ deltaPx`), then the
 * bounded correction above. Returns how the landing ended — a caller that was cancelled or
 * capped must not claim it arrived.
 */
export function landOn(element: Element, options: LandOptions = {}): Promise<LandingResult> {
  const doc = options.doc ?? document;
  const win = options.win ?? doc.defaultView ?? window;
  const delta = options.deltaPx ?? 0;
  const token = beginLanding();
  const line = landingLine(doc) + delta;
  const rect = element.getBoundingClientRect();
  if (!Number.isFinite(rect.top)) return Promise.resolve('landed');
  win.scrollTo({ top: Math.max(0, win.scrollY + rect.top - line), behavior: 'auto' });
  return followLine(element, token, { ...options, doc, win });
}

/**
 * Land a chapter's mouth: the `<article id="ch-N">` is what carries the chapter, and its `.ch-h`
 * heading is the element that must reach the line. `false` when the chapter is not on this page
 * — the caller then keeps the browser's own `#ch-N` jump instead of swallowing the click.
 */
export function landChapter(n: number, doc: Document = document): boolean {
  const article = doc.getElementById(`ch-${String(n)}`);
  if (article === null) return false;
  const heading = article.querySelector('.ch-h');
  void landOn(heading ?? article, { doc });
  return true;
}
