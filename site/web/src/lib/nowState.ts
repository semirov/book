/**
 * BOOK-DOC-84 §11.1/§11.4 — **one derived state** over the frames.
 *
 * The head's line, the record's sentence and the trail's row are the same fact in three voices,
 * so they are derived once, here, and never re-derived by a surface: `parts` is the whole state,
 * `line` is those parts with the frame's own clock, `sentence` is the same parts without it.
 *
 * What the derivation reads, and only this: the frames the page has folded (`ClientState`) and
 * their own timestamps. It invents no progress:
 *
 *   • a claim whose **own** `deadlineAt` has passed is not work — it reads as the wait, never as
 *     «машина читает» (a stale claim is the lie this rule exists for);
 *   • a deadline that passes changes no word of its own: nothing becomes `не дошло` because a
 *     clock moved, only because a frame said so;
 *   • the three endings (landed, refused, not delivered) rest for `LINGER_MS` from their own
 *     `at`, then the line is gone — no timer invents a word, one timer only ends this one.
 *
 * Precedence is **newest frame wins** among the work states, and a work state always outranks a
 * resting ending: a new pass starts while the previous `внесено` is still on screen, and the line
 * must be the new work. Nothing active and nothing resting is idle — no line, no placeholder.
 */

import { aheadDigitsWord, aheadWord, headLineWord, moneyWord, NOW_VERBS, type LinePart } from '@book/shared';

import type { ClientState } from './clientState.ts';
import {
  clockPart,
  fromApplied,
  fromChangeFailure,
  fromClose,
  fromPass,
  fromQueue,
  fromReading,
  fromRefusal,
  numberOr,
} from './nowDrafts.ts';

export { shortReason } from './nowDrafts.ts';

/** §11.1 — a terminal line rests four seconds after its own frame, then it is gone. */
export const LINGER_MS = 4_000;

/** The phone's step (§11.1): the filing's id and the clock go first, then the gate's word. */
export const PHONE_DROPS = ['filing', 'time', 'gate'] as const;

export type NowKind =
  | 'idle'
  | 'offline'
  | 'reading'
  | 'approach'
  | 'waiting'
  | 'writing'
  | 'checking'
  | 'fixing'
  | 'applied'
  | 'refused'
  | 'defect';

/** The endings that rest `LINGER_MS` and then vanish. */
const TERMINAL: ReadonlySet<NowKind> = new Set<NowKind>(['applied', 'refused', 'defect']);

/** Where the whole line takes the reader: a chapter, or a filing's place (the record opens). */
export type NowDoor = { commentId: string; chapter: number } | { chapter: number };

export type NowState = {
  kind: NowKind;
  /** The state, as the line's parts — the one shape three surfaces read. */
  parts: readonly LinePart[];
  /** The head's line (`части · 17:04`), or `null` when the head prints nothing at all. */
  line: string | null;
  /** The same facts without the clock: the record's sentence and the trail's row. */
  sentence: string | null;
  /** The whole line's target; `null` for idle and for `нет связи` (neither is a link). */
  door: NowDoor | null;
  /** The frame's own moment — what the line's clock prints. */
  at: number | null;
  /** When this state stops being true with no new frame (a deadline, a resting ending). */
  untilMs: number | null;
  terminal: boolean;
  /** The author's own line (`впереди 2 · 0,05 $`), or `null` for a reader. */
  author: string | null;
};

export type NowInput = {
  /** The page's folded frames. */
  state: ClientState;
  /** The moment the socket went down, `null` while the page can see the machine. */
  offlineAt?: number | null;
  /** The page's clock: it decides two things only — a stale claim and a finished linger. */
  nowMs: number;
};

/** One clause set of the line: what a family of frames says, before precedence picks one. */
export type Draft = {
  kind: NowKind;
  parts: LinePart[];
  door: NowDoor | null;
  at: number | null;
  untilMs: number | null;
};

const IDLE: NowState = {
  kind: 'idle',
  parts: [],
  line: null,
  sentence: null,
  door: null,
  at: null,
  untilMs: null,
  terminal: false,
  author: null,
};

/** The newest frame wins: a work state outranks a resting ending with an older moment. */
function newest(drafts: readonly (Draft | null)[]): Draft | null {
  let best: Draft | null = null;
  for (const draft of drafts) {
    if (draft === null) continue;
    if (best === null || (draft.at ?? 0) >= (best.at ?? 0)) best = draft;
  }
  return best;
}

/** The author's own line: the queue ahead and the last closed unit's price (§11.1). */
function authorLine(state: ClientState): string | null {
  if (state.viewer.isAuthor !== true) return null;
  const live = state.live;
  if (live === null) return null;
  const ahead = numberOr(live.queue.depth);
  const cost = live.lastCost ?? null;
  const parts = [
    // No place in the queue is «следом», not «впереди 0»: a count of nothing is not a count.
    ...(ahead === null ? [] : [ahead === 0 ? aheadWord(0) : aheadDigitsWord(ahead)]),
    ...(cost === null ? [] : [moneyWord(cost.usd, cost.estimated)]),
  ];
  return parts.length === 0 ? null : headLineWord(parts.map((text) => ({ text })));
}

/** The one derived state of the head, the record and the trail (§11.1/§11.4). */
export function nowStateOf({ state, offlineAt = null, nowMs }: NowInput): NowState {
  const author = authorLine(state);
  // The page cannot see the machine: that is the whole line, and it is not a link (§11.1).
  if (offlineAt !== null) {
    const parts: LinePart[] = [{ text: NOW_VERBS.offline }, ...clockPart(offlineAt)];
    return {
      kind: 'offline',
      parts,
      line: headLineWord(parts),
      sentence: headLineWord([{ text: NOW_VERBS.offline }]),
      door: null,
      at: offlineAt,
      untilMs: null,
      terminal: false,
      author,
    };
  }

  // One rule, one order: the newest frame wins, and a work state takes the tie over an ending
  // (a pass's own `landed` and the write it carries are the same moment).
  const draft = newest([
    fromApplied(state),
    fromClose(state),
    fromRefusal(state),
    fromChangeFailure(state),
    fromReading(state, nowMs),
    fromPass(state),
    fromQueue(state),
  ]);
  // A resting ending answers the newest ending's own frame and then stops answering: an older
  // work fact never comes back behind it (a landed write does not walk back into «ждёт»).
  if (draft === null) return { ...IDLE, author };
  if (TERMINAL.has(draft.kind) && draft.at !== null && nowMs >= draft.at + LINGER_MS) {
    return { ...IDLE, author };
  }

  const withoutClock = draft.parts.filter((part) => part.drop !== 'time');
  return {
    kind: draft.kind,
    parts: draft.parts,
    line: headLineWord(draft.parts),
    sentence: headLineWord(withoutClock),
    door: draft.door,
    at: draft.at,
    untilMs: draft.untilMs,
    terminal: TERMINAL.has(draft.kind),
    author,
  };
}
