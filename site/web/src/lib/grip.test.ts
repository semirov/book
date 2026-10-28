import { describe, expect, it } from 'vitest';

import { formatTime } from './format.ts';
import {
  GRIP,
  PASS_LABEL,
  PASS_SILENT,
  PASS_WATCHING,
  gripTiming,
  initialGrip,
  isCalm,
  isFling,
  liveChapter,
  nextGrip,
  passDoor,
  passStateOf,
  velocityOf,
  type GripState,
  type PassFacts,
} from './grip.ts';

/**
 * BOOK-156 — the grip's thresholds, without a timer, a DOM or a frame.
 *
 * Every number here is the contract the component and the DOM test obey: 48 px of scroll,
 * 3 200 ms of quiet, 2 400 px/s as a fling, 120 px/s held 100 ms before an entrance, one
 * commit per 320 ms, and the door's three states. A test that needs `vi.advanceTimersByTime`
 * would be testing the harness, not the rule.
 */

const CHANGE = {
  id: 'chg_7',
  decidedAt: '2026-10-25T11:21:00Z',
  enqueuedAt: '2026-10-25T10:40:00Z',
};

const facts = (over: Partial<PassFacts> = {}): PassFacts => ({
  processing: false,
  revising: false,
  historyLive: true,
  change: null,
  ...over,
});

/** A row the reader just opened with a tap on the paper, at t = 0. */
function opened(options: { reduced?: boolean } = {}): GripState {
  const state = nextGrip(initialGrip(options), { type: 'paper', atMs: 0 });
  expect(state.open).toBe(true);
  return state;
}

describe('the grip closes on the first 48 px of scroll, either way', () => {
  it('keeps the row on 47 px and closes it on 48, from both directions', () => {
    for (const dy of [47, -47]) {
      expect(nextGrip(opened(), { type: 'scroll', atMs: 400, dy }).open, `${dy} px`).toBe(true);
    }
    for (const dy of [48, -48]) {
      const next = nextGrip(opened(), { type: 'scroll', atMs: 400, dy });
      expect(next.open, `${dy} px`).toBe(false);
      // A scroll the reader drove is a leave, not a cut: the row falls on the exit curve.
      expect(next.motion).toBe('fall');
    }
  });

  it('adds the travel up across samples — 24 + 24 is one 48', () => {
    const first = nextGrip(opened(), { type: 'scroll', atMs: 400, dy: 24 });
    expect(first.open).toBe(true);
    expect(nextGrip(first, { type: 'scroll', atMs: 500, dy: 24 }).open).toBe(false);
  });

  it('does not close a row that is already closed', () => {
    const closed = initialGrip();
    const next = nextGrip(closed, { type: 'scroll', atMs: 400, dy: 300 });
    expect(next.open).toBe(false);
    expect(next.motion).toBe('none');
  });
});

describe('the dwell is 3 200 ms of quiet', () => {
  it('is open at 3 199 and closed at 3 200', () => {
    const row = opened();
    expect(nextGrip(row, { type: 'timer', atMs: GRIP.dwellMs - 1 }).open).toBe(true);
    expect(nextGrip(row, { type: 'timer', atMs: GRIP.dwellMs }).open).toBe(false);
  });

  it('ignores a timer while nothing is open and nothing waits', () => {
    const next = nextGrip(initialGrip(), { type: 'timer', atMs: 10_000 });
    expect(next.open).toBe(false);
    expect(next.motion).toBe('none');
  });
});

describe('what opens the row, and what never does', () => {
  it('a tap on the paper opens it as a rise', () => {
    expect(nextGrip(initialGrip(), { type: 'paper', atMs: 0 }).motion).toBe('rise');
  });

  it('focus opens it as a 0 ms cut: the ring needs the room now', () => {
    const focused = nextGrip(initialGrip(), { type: 'focus', atMs: 0 });
    expect(focused.open).toBe(true);
    expect(focused.motion).toBe('cut');
  });

  it('blur closes it', () => {
    const focused = nextGrip(initialGrip(), { type: 'focus', atMs: 0 });
    expect(nextGrip(focused, { type: 'blur', atMs: 400 }).open).toBe(false);
  });

  it('a tap on a word is a jump, never an expand', () => {
    const next = nextGrip(initialGrip(), { type: 'tap', atMs: 0 });
    expect(next.open).toBe(false);
    expect(next.motion).toBe('none');
    // And it does not close a row it did not open either: the word means navigation.
    expect(nextGrip(opened(), { type: 'tap', atMs: 400 }).open).toBe(true);
  });

  it('an outside pointerdown closes it — and is the page’s tap, not the row’s', () => {
    expect(nextGrip(opened(), { type: 'outside', atMs: 400 }).open).toBe(false);
  });

  it('does not re-open a row that is already open', () => {
    const next = nextGrip(opened(), { type: 'paper', atMs: 400 });
    expect(next.open).toBe(true);
    expect(next.motion).toBe('none');
  });

  it('a blur with nothing open is a no-op, not a close', () => {
    const next = nextGrip(initialGrip(), { type: 'blur', atMs: 0 });
    expect(next.open).toBe(false);
    expect(next.motion).toBe('none');
  });
});

describe('the fling gate', () => {
  it('reads speed from a scroll sample and never divides by zero', () => {
    expect(velocityOf(300, 100)).toBe(3_000);
    expect(velocityOf(-48, 400)).toBe(-120);
    expect(Number.isFinite(velocityOf(1, 0))).toBe(true);
    expect(isFling(2_400)).toBe(true);
    expect(isFling(-2_400)).toBe(true);
    expect(isFling(2_399)).toBe(false);
    expect(isCalm(119.9)).toBe(true);
    expect(isCalm(-119.9)).toBe(true);
    expect(isCalm(120)).toBe(false);
  });

  it('applies a state as a cut at 2 400 px/s', () => {
    // 47 px at a reader's pace, then 300 px in 100 ms = 3 000 px/s: fast enough that a
    // 160 ms slide would be a smear.
    const walked = nextGrip(opened(), { type: 'scroll', atMs: 400, dy: 47 });
    expect(walked.open).toBe(true);
    const next = nextGrip(walked, { type: 'scroll', atMs: 500, dy: 300 });
    expect(next.open).toBe(false);
    expect(next.motion).toBe('cut');
  });

  it('waits for |v| < 120 px/s held for 100 ms before an entrance', () => {
    const walked = nextGrip(opened(), { type: 'scroll', atMs: 400, dy: 47 });
    const flung = nextGrip(walked, { type: 'scroll', atMs: 500, dy: 300 });
    expect(flung.motion).toBe('cut');

    // The tap arrives while momentum is still running: remembered, not applied.
    const waiting = nextGrip(flung, { type: 'paper', atMs: 900 });
    expect(waiting.open).toBe(false);
    expect(waiting.target).toBe(true);

    // 20 px/s for 50 ms: still not 100.
    const calm = nextGrip(waiting, { type: 'scroll', atMs: 950, dy: 1 });
    expect(calm.open).toBe(false);
    expect(calm.calmMs).toBe(50);
    // 99 ms of stillness is not the 100 the rule asks for.
    expect(nextGrip(calm, { type: 'timer', atMs: 999 }).open).toBe(false);

    const entered = nextGrip(calm, { type: 'timer', atMs: 1_000 });
    expect(entered.open).toBe(true);
    expect(entered.motion).toBe('rise');
    expect(entered.flung).toBe(false);
  });

  it('does not treat a slow scroll as a fling', () => {
    const slow = nextGrip(opened(), { type: 'scroll', atMs: 400, dy: 1 });
    expect(slow.flung).toBe(false);
  });

  it('reads a stale sample as stillness: after a flick, one quiet timer lands the entrance', () => {
    // 300 px in 100 ms is 3 000 px/s: a flick.
    const flung = nextGrip(initialGrip(), { type: 'scroll', atMs: 100, dy: 300 });
    expect(flung.flung).toBe(true);
    // The tap arrives while the last sample still says «moving»: remembered, not applied.
    const waiting = nextGrip(flung, { type: 'paper', atMs: 500 });
    expect(waiting.open).toBe(false);
    expect(waiting.target).toBe(true);
    expect(waiting.flung).toBe(true);
    // 99 ms of quiet is short of the window; 100 ms is the whole of it — and the stale
    // 3 000 px/s is not evidence of a page still moving (BOOK-156 fix B1).
    expect(nextGrip(waiting, { type: 'timer', atMs: 599 }).open).toBe(false);
    const entered = nextGrip(waiting, { type: 'timer', atMs: 600 });
    expect(entered.open).toBe(true);
    expect(entered.motion).toBe('rise');
    expect(entered.velocity).toBe(0);
    expect(entered.flung).toBe(false);
  });

  it('commits once per 320 ms', () => {
    const row = opened();
    // 100 ms after the open: the close is suppressed, so a jittering finger cannot strobe.
    const early = nextGrip(row, { type: 'outside', atMs: 100 });
    expect(early.open).toBe(true);
    expect(early.motion).toBe('none');
    const late = nextGrip(early, { type: 'outside', atMs: GRIP.commitGapMs });
    expect(late.open).toBe(false);
  });

  it('suppresses an opening inside the same lockout', () => {
    const closed = nextGrip(opened(), { type: 'outside', atMs: 400 });
    expect(closed.open).toBe(false);
    expect(nextGrip(closed, { type: 'paper', atMs: 500 }).open).toBe(false);
    expect(nextGrip(closed, { type: 'paper', atMs: 720 }).open).toBe(true);
  });
});

describe('the third item’s three states', () => {
  it('is live while a pass runs, pointed at #pass and with no meta', () => {
    const door = passDoor(facts({ processing: true, change: CHANGE }));
    expect(door.state).toBe('live');
    expect(door.href).toBe('#pass');
    expect(door.meta).toBeNull();
    expect(door.name).toContain(PASS_LABEL);
    // The live block's own ochre rule counts as a pass too.
    expect(passStateOf(facts({ revising: true, change: CHANGE }))).toBe('live');
  });

  it('is a record when nothing runs and a change is behind: #правка-<id> and its time', () => {
    const door = passDoor(facts({ change: CHANGE }));
    expect(door.state).toBe('record');
    expect(door.href).toBe('#правка-chg_7');
    // The site's one clock (Europe/Moscow), never a relative phrase.
    expect(door.meta).toBe('проход был 14:21');
    expect(door.meta).toBe(`проход был ${formatTime(CHANGE.decidedAt)}`);
    expect(door.name).toContain(PASS_LABEL);
    // `decidedAt ?? enqueuedAt`: a change still in the queue points at its own filing time.
    const queued = passDoor(facts({ change: { ...CHANGE, decidedAt: null } }));
    expect(queued.meta).toBe('проход был 13:40');
  });

  it('is silent with no target and «не пишется» — a word, not a disabled button', () => {
    const door = passDoor(facts());
    expect(door.state).toBe('silent');
    expect(door.href).toBeNull();
    expect(door.meta).toBe(PASS_SILENT);
    expect(door.name).toContain(PASS_LABEL);
    expect(door.name).toContain(PASS_SILENT);
  });

  it('is absent before the first pass ever, even with a change on the page', () => {
    const door = passDoor(facts({ historyLive: false, change: CHANGE }));
    expect(door.state).toBe('absent');
    expect(door.href).toBeNull();
    expect(door.meta).toBeNull();
  });

  it('says «вернуться к месту чтения» while the reader is inside the pass', () => {
    const door = passDoor({ ...facts({ processing: true }), watching: true });
    expect(door.label).toBe(PASS_LABEL);
    expect(door.name).toBe(PASS_WATCHING);
    expect(door.name).toContain(PASS_LABEL);
  });

  it('keeps one label in every state', () => {
    for (const door of [
      passDoor(facts({ processing: true })),
      passDoor(facts({ change: CHANGE })),
      passDoor(facts()),
      passDoor(facts({ historyLive: false })),
    ]) {
      expect(door.label).toBe(PASS_LABEL);
      expect(door.name).toContain(PASS_LABEL);
    }
  });
});

describe('the door’s chapter', () => {
  it('takes the first active block’s chapter, else the processing change’s, else nothing', () => {
    expect(liveChapter(12, {})).toBe(12);
    expect(liveChapter(null, { 7: { active: true } })).toBe(7);
    // A live block wins: a cascade step can revise a chapter while the queue reports nothing.
    expect(liveChapter(12, { 7: { active: true } })).toBe(7);
    // The first active one, in chapter order — an inactive entry is not a pass.
    expect(liveChapter(null, { 3: { active: false }, 9: { active: true }, 11: { active: true } })).toBe(9);
    expect(liveChapter(null, { 3: { active: false } })).toBeNull();
    expect(liveChapter(null, {})).toBeNull();
  });
});

describe('reduced motion is the same page with every duration at zero', () => {
  it('zeroes the enter, the exit, the tick, the commit and the settle, but never the dwell', () => {
    expect(gripTiming(true)).toEqual({
      enterMs: 0,
      exitMs: 0,
      tickMs: 0,
      commitMs: 0,
      settleMs: 0,
      dwellMs: 3200,
    });
    expect(gripTiming(false)).toEqual({
      enterMs: 220,
      exitMs: 160,
      tickMs: 120,
      commitMs: 120,
      settleMs: 600,
      dwellMs: 3200,
    });
  });

  it('reaches the same states, with the settled frame at t = 0', () => {
    for (const reduced of [false, true]) {
      const row = opened({ reduced });
      expect(row.reduced).toBe(reduced);
      expect(nextGrip(row, { type: 'scroll', atMs: 400, dy: 48 }).open, `scroll ${reduced}`).toBe(false);
      expect(nextGrip(row, { type: 'blur', atMs: 400 }).open, `blur ${reduced}`).toBe(false);
      expect(nextGrip(initialGrip({ reduced }), { type: 'tap', atMs: 0 }).open).toBe(false);
    }
    // Nothing rises or falls under reduced motion: every commit is a cut, and a fling never
    // defers an entrance (there is no momentum to wait for).
    const row = opened({ reduced: true });
    expect(row.motion).toBe('cut');
    const afterFling = nextGrip(row, { type: 'scroll', atMs: 100, dy: 300 });
    expect(afterFling.motion).toBe('cut');
    const paper = nextGrip(afterFling, { type: 'paper', atMs: 200 });
    expect(paper.open).toBe(true);
    expect(paper.motion).toBe('cut');
  });

  it('does not shorten the dwell under reduced motion — a dwell is not motion', () => {
    const row = opened({ reduced: true });
    expect(gripTiming(row.reduced).dwellMs).toBe(GRIP.dwellMs);
    expect(nextGrip(row, { type: 'timer', atMs: GRIP.dwellMs - 1 }).open).toBe(true);
    expect(nextGrip(row, { type: 'timer', atMs: GRIP.dwellMs }).open).toBe(false);
  });
});
