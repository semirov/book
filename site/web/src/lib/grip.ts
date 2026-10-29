/**
 * BOOK-156 — the grip's clock, as pure state.
 *
 * The grip is the page's foot: one 24 px band, one hairline, three words (BOOK-156 #3801).
 * Everything that has a number in it lives here, so the thresholds are tested without a DOM,
 * a timer or a frame (BOOK-116 §8's shape, reused by #3797):
 *
 *   - the row opens on a tap on the paper or on focus, and closes after `dwellMs` without
 *     activity, on the first 48 px of scroll either way, on blur, or on an outside
 *     pointerdown (which the page keeps — the tap goes on to the prose);
 *   - a fling (`|v| ≥ 2400 px/s`) applies a state as a cut, and an entrance waits until
 *     `|v| < 120 px/s` has held for 100 ms: a band rising under a travelling thumb is a trap
 *     (#3797 §1). One commit per 320 ms, so a jittering finger cannot strobe the row;
 *   - `prefers-reduced-motion: reduce` zeroes every duration and never defers an entrance —
 *     the honesty is in the states, not in the transitions (#3797 §5). The dwell is not a
 *     transition: 3 200 ms of quiet stay 3 200 ms.
 *
 * BOOK-207 removed the door half: the third item is a plain `след` link, and no state table,
 * no watch and no veil remain.
 */

export const GRIP = {
  /** --dur-ui: arriving may take a beat. */
  enterMs: 220,
  /** Leaving is a favour to the reader: shorter, and without hesitating (--ease-in). */
  exitMs: 160,
  /** --dur-tick: the row's own state-change length (the sheet reads it too). */
  tickMs: 120,
  /** The door commits its cut here, measured from the tap. */
  commitMs: 120,
  /** The quiet window's end: nothing of the door's own starts between 240 and 600. */
  settleMs: 600,
  dwellMs: 3200,
  closeScrollPx: 48,
  flingPxPerSec: 2400,
  settlePxPerSec: 120,
  holdMs: 100,
  commitGapMs: 320,
} as const;

// ── the row's clock ──────────────────────────────────────────────────────────

export type GripMotion = 'none' | 'rise' | 'fall' | 'cut';

export type GripState = {
  open: boolean;
  /** Where the row is heading; differs from `open` only while a post-fling entrance waits. */
  target: boolean;
  reduced: boolean;
  /** The last commit's clock: the 320 ms lockout reads it. */
  committedAt: number;
  /** When the row opened — the dwell clock. */
  openedAt: number;
  /** Scroll travelled since the row's state last changed, in either direction. */
  scrolled: number;
  /** The last scroll sample: velocity is `dy / (atMs − lastAt)`. */
  lastAt: number;
  velocity: number;
  /** How long `|v|` has stayed under the settle threshold. */
  calmMs: number;
  /** A fling has been seen since the last entrance: entries wait for the momentum to stop. */
  flung: boolean;
  /** What the last decision was: a rise, a fall, or a cut with no envelope at all. */
  motion: GripMotion;
};

export type GripEvent =
  | { type: 'paper'; atMs: number }
  | { type: 'tap'; atMs: number }
  | { type: 'focus'; atMs: number }
  | { type: 'blur'; atMs: number }
  | { type: 'outside'; atMs: number }
  | { type: 'timer'; atMs: number }
  | { type: 'scroll'; atMs: number; dy: number };

/** Every duration the row uses; all zero under reduced motion — except the dwell, which is the
 *  reader's quiet time and not a transition (BOOK-156 fix). */
export type GripTiming = {
  enterMs: number;
  exitMs: number;
  tickMs: number;
  commitMs: number;
  settleMs: number;
  dwellMs: number;
};

export function gripTiming(reduced: boolean): GripTiming {
  if (reduced) return { enterMs: 0, exitMs: 0, tickMs: 0, commitMs: 0, settleMs: 0, dwellMs: GRIP.dwellMs };
  return {
    enterMs: GRIP.enterMs,
    exitMs: GRIP.exitMs,
    tickMs: GRIP.tickMs,
    commitMs: GRIP.commitMs,
    settleMs: GRIP.settleMs,
    dwellMs: GRIP.dwellMs,
  };
}

export function initialGrip(options: { reduced?: boolean } = {}): GripState {
  return {
    open: false,
    target: false,
    reduced: options.reduced === true,
    committedAt: Number.NEGATIVE_INFINITY,
    openedAt: 0,
    scrolled: 0,
    lastAt: 0,
    velocity: 0,
    calmMs: 0,
    flung: false,
    motion: 'none',
  };
}

const canCommit = (state: GripState, atMs: number): boolean =>
  state.reduced || atMs - state.committedAt >= GRIP.commitGapMs;

/** The scroll sample's speed, in px/s. `dt` is floored at 1 ms, so a pair inside one
 *  millisecond is finite (and therefore a fling, not a NaN). */
export function velocityOf(dy: number, dtMs: number): number {
  return (dy / Math.max(1, dtMs)) * 1000;
}

/** 2 400 px/s: fast enough that an envelope would read as a smear. */
export const isFling = (velocity: number): boolean => Math.abs(velocity) >= GRIP.flingPxPerSec;

/** Under 120 px/s: the momentum is spent, and an entrance may land after `holdMs` of it. */
export const isCalm = (velocity: number): boolean => Math.abs(velocity) < GRIP.settlePxPerSec;

/** One commit, with the row's clocks reset: the 48 px and the 3 200 ms start again. */
function commit(state: GripState, open: boolean, atMs: number, motion: GripMotion): GripState {
  return {
    ...state,
    open,
    target: open,
    openedAt: open ? atMs : state.openedAt,
    committedAt: atMs,
    scrolled: 0,
    motion: state.reduced ? 'cut' : motion,
  };
}

/** The row opens — as a rise, as a keyboard cut, or, after a fling, not yet. */
function openRow(state: GripState, atMs: number, motion: GripMotion): GripState {
  if (state.open) return { ...state, motion: 'none' };
  if (!canCommit(state, atMs)) return { ...state, motion: 'none' };
  if (state.reduced) return commit(state, true, atMs, 'cut');
  // A band rising under a travelling thumb is a trap (#3797 §1): the target is remembered and
  // the entrance lands on the first frame where the momentum has been still for 100 ms.
  if (state.flung || !isCalm(state.velocity)) {
    return { ...state, target: true, calmMs: 0, lastAt: atMs, motion: 'none' };
  }
  return commit(state, true, atMs, motion);
}

/** The deferred entrance: momentum has stopped and stayed stopped. */
function maybeEnter(state: GripState, atMs: number): GripState {
  if (state.open || !state.target) return state;
  if (!state.reduced && state.calmMs < GRIP.holdMs) return state;
  if (!canCommit(state, atMs)) return state;
  return { ...commit(state, true, atMs, 'rise'), flung: false };
}

function closeRow(state: GripState, atMs: number, motion: GripMotion): GripState {
  if (!state.open) return { ...state, target: false, motion: 'none' };
  if (!canCommit(state, atMs)) return { ...state, motion: 'none' };
  return commit(state, false, atMs, motion);
}

function onScroll(state: GripState, atMs: number, dy: number): GripState {
  const dt = Math.max(1, atMs - state.lastAt);
  const velocity = velocityOf(dy, dt);
  const fast = isFling(velocity);
  const calm = isCalm(velocity);
  let next: GripState = {
    ...state,
    lastAt: atMs,
    velocity,
    calmMs: calm ? state.calmMs + dt : 0,
    flung: fast || state.flung,
    scrolled: state.open ? state.scrolled + Math.abs(dy) : state.scrolled,
    motion: 'none',
  };
  if (next.open && next.scrolled >= GRIP.closeScrollPx) {
    // A 160 ms slide inside a 3 000 px/s fling is a smear: the state applies as a cut.
    next = closeRow(next, atMs, fast ? 'cut' : 'fall');
  }
  return maybeEnter(next, atMs);
}

export function nextGrip(state: GripState, event: GripEvent): GripState {
  switch (event.type) {
    case 'paper':
      return openRow(state, event.atMs, 'rise');
    case 'focus':
      // A keyboard reader who tabs in gets the 44 px row at once: the ring needs the room now.
      return openRow(state, event.atMs, 'cut');
    case 'tap':
      // A tap on a word is a jump. The row is not a menu and a word never expands it.
      return { ...state, motion: 'none' };
    case 'blur':
    case 'outside':
      // An outside pointerdown is not swallowed: the row closes and the tap goes on to the prose.
      return closeRow(state, event.atMs, 'fall');
    case 'scroll':
      return onScroll(state, event.atMs, event.dy);
    case 'timer': {
      if (!state.open) {
        if (!state.target) return { ...state, motion: 'none' };
        const quiet = Math.max(0, event.atMs - state.lastAt);
        if (quiet >= GRIP.holdMs) {
          // A stale sample is stillness (BOOK-156 fix B1): nothing has moved for the whole
          // quiet window, so the last velocity is no evidence of momentum — it is cleared
          // before the decision, or a deferred entrance would wait for a scroll that never
          // comes. `flung` stays sticky until the entrance actually lands.
          return maybeEnter(
            { ...state, lastAt: event.atMs, velocity: 0, calmMs: state.calmMs + quiet },
            event.atMs,
          );
        }
        const calm = isCalm(state.velocity);
        return maybeEnter({ ...state, lastAt: event.atMs, calmMs: calm ? state.calmMs + quiet : 0 }, event.atMs);
      }
      const { dwellMs } = gripTiming(state.reduced);
      if (event.atMs - state.openedAt < dwellMs) return { ...state, motion: 'none' };
      return closeRow(state, event.atMs, 'fall');
    }
  }
}
