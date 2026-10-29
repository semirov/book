/**
 * BOOK-DOC-84 §11.1 — the clauses of the head's line, one builder per frame family.
 *
 * Split from `nowState.ts` at the file bound, not at a layer: this file turns a fact into the
 * line's parts (and never decides which fact wins — the derivation does that), so every word,
 * noun and counter still comes from `shared/src/stateWords.ts` and the clause grammar lives in
 * one place. The filing's number is its change's own `seq`; a number no frame carries prints the
 * noun alone, because an invented number is a lie.
 */

import {
  aheadDigitsWord,
  chapterAccusativeWord,
  chapterWord,
  clockWord,
  editionWord,
  filingWord,
  gateRoundWord,
  headAttemptWord,
  headFixWord,
  MACHINE,
  NOW_VERBS,
  type LinePart,
  type PassStageEvent,
} from '@book/shared';

import { openPassesOf, type ClientState } from './clientState.ts';
import { LINGER_MS, type Draft, type NowDoor } from './nowState.ts';

/** A number the sequence carries, or `null` — never a default. */
export function numberOr(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A filing's number: its change's own `seq`. The change is named by the frame that knows it
 * (a pass's `changeId`, a decision's `id`), or looked up on the viewer's own filing rows; when no
 * row carries one the noun stands alone («правка»), because a number nobody wrote is a lie.
 */
function filingSeq(state: ClientState, commentId: string | null, changeId: string | null): number | null {
  const id =
    changeId ??
    (commentId === null
      ? null
      : (state.filingUpdates[commentId]?.changeId ?? state.filingChange[commentId] ?? null));
  if (id !== null) {
    const known = numberOr(state.changeSeq[id]);
    if (known !== null) return known;
  }
  if (commentId === null) return null;
  const row = state.filings.find((filing) => filing.commentId === commentId);
  return row === undefined || row.changeId === null ? null : numberOr(state.changeSeq[row.changeId]);
}

/** The newest stage event the page heard for one pass (§2.2's log, newest `stageSeq`). */
function newestStage(state: ClientState, passId: string): PassStageEvent | null {
  let newest: PassStageEvent | null = null;
  for (const events of Object.values(state.stages)) {
    for (const event of events) {
      if (event.passId !== passId) continue;
      if (newest === null || event.stageSeq > newest.stageSeq) newest = event;
    }
  }
  return newest;
}

/** A filing's number as a clause of its own (`правка 012`), droppable whole on the phone. */
function filingPart(seq: number | null): LinePart {
  return { text: filingWord(seq), drop: 'filing' };
}

/** The wait is one clause: `правка 012 ждёт`, `правка 012 ждёт: впереди 2` (§11.1). */
function waitingPart(seq: number | null, ahead: number | null): LinePart {
  const place = ahead === null || ahead <= 0 ? '' : `: ${aheadDigitsWord(ahead)}`;
  return { text: `${filingWord(seq)} ${NOW_VERBS.waiting}${place}` };
}

/** The number inside a verb phrase (`читает правку 012`): the phone hides it, alone. */
function insideFiling(seq: number | null): Pick<LinePart, 'tail'> {
  if (seq === null) return {};
  return { tail: { text: ` ${String(seq).padStart(3, '0')}`, drop: 'filing' } };
}

/** The clock, always the frame's own moment, always droppable (§11.1's phone step). */
export function clockPart(at: number | null): LinePart[] {
  return at === null ? [] : [{ text: clockWord(at), drop: 'time' }];
}

/** The reading, by its phase (§10.1): a claim reads, a widening widens, a failure waits. */
export function fromReading(
  state: ClientState,
  nowMs: number,
): Draft | null {
  const reading = state.reading;
  if (reading === null) return null;
  const seq = filingSeq(state, reading.commentId, null);
  const door: NowDoor = { commentId: reading.commentId, chapter: reading.chapter };
  const attempt = headAttemptWord(reading.attempt, reading.maxAttempts);

  if (reading.phase === 'widened') {
    return {
      kind: 'approach',
      parts: [
        { text: `${MACHINE} ${NOW_VERBS.approach}`, ...insideFiling(seq) },
        { text: attempt },
        ...clockPart(reading.since),
      ],
      door,
      at: reading.since,
      untilMs: reading.deadlineAt,
    };
  }

  if (reading.phase === 'claimed') {
    // A claim past its own lease is not work: the wait is the honest word (a stale claim never
    // reads as «машина читает»). Nothing else changes — the deadline invents no failure.
    const stale = reading.deadlineAt !== null && nowMs > reading.deadlineAt;
    if (stale) {
      return {
        kind: 'waiting',
        parts: [waitingPart(seq, null), ...clockPart(reading.since)],
        door,
        at: reading.since,
        untilMs: null,
      };
    }
    return {
      kind: 'reading',
      parts: [
        { text: `${MACHINE} ${NOW_VERBS.reading} правку`, ...insideFiling(seq) },
        { text: attempt },
        ...clockPart(reading.since),
      ],
      door,
      at: reading.since,
      untilMs: reading.deadlineAt,
    };
  }

  if (reading.phase === 'failed') {
    // A failure with a try left is a retry — a wait with its hour. The last try is the one that
    // ends the ladder: `не дошло`, with the engine's own class and no invented sentence.
    if (reading.attempt >= reading.maxAttempts) {
      const reason = (reading.reason ?? '').trim();
      return {
        kind: 'defect',
        parts: [
          { text: reason.length === 0 ? NOW_VERBS.notDelivered : `${NOW_VERBS.notDelivered}: ${reason}` },
          filingPart(seq),
          ...clockPart(reading.since),
        ],
        door,
        at: reading.since,
        untilMs: reading.since + LINGER_MS,
      };
    }
    return {
      kind: 'waiting',
      parts: [waitingPart(seq, null), { text: attempt }, ...clockPart(reading.since)],
      door,
      at: reading.since,
      untilMs: reading.retryAt,
    };
  }

  // `read`: the reading answered and the change is next — the queue's own frame narrates it.
  return null;
}

/** A change that was accepted and is still in line: `правка 012 ждёт: впереди 2` (§11.1). */
export function fromQueue(state: ClientState): Draft | null {
  const queued = Object.entries(state.lines)
    .filter(([, line]) => line.kind === 'queued')
    .sort((left, right) => {
      const first = left[1].kind === 'queued' ? left[1].at : 0;
      const second = right[1].kind === 'queued' ? right[1].at : 0;
      return second - first;
    })[0];
  if (queued === undefined) return null;
  const [changeId, line] = queued;
  if (line.kind !== 'queued') return null;
  const commentId = line.commentId ?? null;
  const seq = filingSeq(state, commentId, changeId);
  const chapter = numberOr(line.chapter);
  const door: NowDoor | null =
    chapter === null ? null : commentId === null ? { chapter } : { commentId, chapter };
  return {
    kind: 'waiting',
    parts: [waitingPart(seq, line.ahead), ...clockPart(line.at)],
    door,
    at: line.at,
    untilMs: null,
  };
}

/** The newest open pass, by its own stage (§10.8's ladder names the counters). */
export function fromPass(state: ClientState): Draft | null {
  const open = openPassesOf(state)[0];
  if (open === undefined) return null;
  const claim = state.accepted[open.passId];
  const stage = newestStage(state, open.passId);
  const name = stage?.stage ?? open.stage;
  if (name === 'landed' || name === 'refused') return null;

  const chapter = typeof open.chapter === 'number' ? open.chapter : null;
  const changeId = open.changeId ?? claim?.premiseChangeId ?? null;
  const commentId = null;
  const seq = filingSeq(state, commentId, changeId);
  const at = stage?.at ?? open.since;
  const attempt = headAttemptWord(
    numberOr(stage?.attempt) ?? numberOr(claim?.attempt) ?? numberOr(open.attempt) ?? 1,
    numberOr(stage?.maxAttempts) ?? numberOr(claim?.maxAttempts) ?? numberOr(open.maxAttempts) ?? 5,
  );
  const door: NowDoor | null = chapter === null ? null : { chapter };
  const chapterPart: LinePart[] = chapter === null ? [] : [{ text: chapterWord(chapter) }];
  const attemptPart: LinePart = { text: attempt };
  const chained = door !== null && changeId !== null ? filingPart(seq) : null;

  switch (name) {
    case 'queued':
      return {
        kind: 'waiting',
        parts: [waitingPart(seq, numberOr(claim?.ahead)), ...clockPart(at)],
        door,
        at,
        untilMs: null,
      };
    case 'read':
      return {
        kind: 'reading',
        parts: [
          { text: `${MACHINE} ${NOW_VERBS.reading} правку`, ...insideFiling(seq) },
          attemptPart,
          ...clockPart(at),
        ],
        door: chapter === null ? null : { chapter },
        at,
        untilMs: stage?.deadlineAt ?? open.deadlineAt,
      };
    case 'drafting':
    case 'typing':
      return {
        kind: 'writing',
        parts: [
          { text: `${MACHINE} ${NOW_VERBS.writing} ${chapter === null ? 'главу' : chapterAccusativeWord(chapter)}` },
          ...(chained === null ? [] : [chained]),
          attemptPart,
          ...clockPart(at),
        ],
        door,
        at,
        untilMs: stage?.deadlineAt ?? open.deadlineAt,
      };
    case 'widening':
      return {
        kind: 'approach',
        parts: [
          { text: `${MACHINE} ${NOW_VERBS.approach}`, ...insideFiling(seq) },
          ...(chapter === null ? [] : chapterPart),
          attemptPart,
          ...clockPart(at),
        ],
        door,
        at,
        untilMs: stage?.deadlineAt ?? open.deadlineAt,
      };
    case 'verdict': {
      const gate = gateRoundWord(
        stage?.gate ?? open.gate ?? null,
        numberOr(stage?.round) ?? numberOr(open.round),
      );
      return {
        kind: 'checking',
        parts: [
          { text: `${MACHINE} ${NOW_VERBS.checking} ${chapter === null ? 'главу' : chapterAccusativeWord(chapter)}` },
          ...(chained === null ? [] : [chained]),
          ...(gate.length === 0 ? [] : [{ text: gate, drop: 'gate' as const }]),
          ...clockPart(at),
        ],
        door,
        at,
        untilMs: stage?.deadlineAt ?? open.deadlineAt,
      };
    }
    case 'revising': {
      const fix = headFixWord(
        numberOr(stage?.iteration) ?? numberOr(open.iteration) ?? 1,
        numberOr(stage?.maxIterations) ?? 4,
      );
      return {
        kind: 'fixing',
        parts: [
          { text: `${MACHINE} ${NOW_VERBS.fixing}` },
          ...(chained === null ? [] : [chained]),
          { text: fix },
          ...clockPart(at),
        ],
        door,
        at,
        untilMs: stage?.deadlineAt ?? open.deadlineAt,
      };
    }
    default:
      return null;
  }
}

/** `внесено · глава 1, редакция 13 · 17:12` — the one outcome the book announces. */
export function fromApplied(state: ClientState): Draft | null {
  const applied = state.applied;
  if (applied === null) return null;
  return {
    kind: 'applied',
    parts: [
      { text: NOW_VERBS.landed },
      { text: editionWord(applied.n, applied.rev) },
      ...clockPart(applied.appliedAt),
    ],
    door: { chapter: applied.n },
    at: applied.appliedAt,
    untilMs: applied.appliedAt + LINGER_MS,
  };
}

/**
 * A defect: the pass did not close its own step (`closeFailed`). It never reads as work and never
 * as a landing — the engine's own sentence, shortened at a word, is the reason.
 */
export function fromClose(state: ClientState): Draft | null {
  const closed = Object.values(state.passes)
    .filter((entry) => entry.closeFailed)
    .sort((left, right) => right.at - left.at)[0];
  if (closed === undefined) return null;
  const reason = shortReason(closed.sentence);
  const chapter = closed.chapter;
  return {
    kind: 'defect',
    parts: [
      { text: reason.length === 0 ? NOW_VERBS.notDelivered : `${NOW_VERBS.notDelivered}: ${reason}` },
      ...(chapter === null ? [] : [{ text: chapterWord(chapter) }]),
      ...clockPart(closed.at),
    ],
    door: chapter === null ? null : { chapter },
    at: closed.at,
    untilMs: closed.at + LINGER_MS,
  };
}

/** The engine's sentence, cut at a word — never mid-word, never a second sentence of our own. */
export function shortReason(sentence: string, max = 32): string {
  const line = sentence.replace(/\s+/gu, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}

/** The statuses that are a no the filing's own row carries (`CommentStatus`'s refusals). */
const REFUSED_STATUSES: ReadonlySet<string> = new Set(['rejected', 'quarantined']);

/** A filing the book answered with a no: the refusal's word, the filing's number, the clock. */
export function fromRefusal(state: ClientState): Draft | null {
  const refused = Object.values(state.decisions)
    .filter((decision) => REFUSED_STATUSES.has(decision.status))
    .sort((left, right) => Date.parse(right.decidedAt) - Date.parse(left.decidedAt))[0];
  if (refused === undefined) return null;
  const at = Date.parse(refused.decidedAt);
  if (!Number.isFinite(at)) return null;
  const reason = (refused.reason ?? '').trim();
  const seq = filingSeq(state, refused.id, refused.changeId);
  return {
    kind: 'refused',
    parts: [
      { text: reason.length === 0 ? NOW_VERBS.refused : `${NOW_VERBS.refused}: ${shortReason(reason)}` },
      filingPart(seq),
      ...clockPart(at),
    ],
    door: { commentId: refused.id, chapter: refused.chapter },
    at,
    untilMs: at + LINGER_MS,
  };
}

/** A change the writer could not bring in (`failed`): the same `не дошло`, no invented reason. */
export function fromChangeFailure(state: ClientState): Draft | null {
  const failed = Object.entries(state.lines)
    .filter(([, line]) => line.kind === 'decided' && line.payload.outcome === 'failed')
    .map(([changeId, line]) => ({ changeId, line }))
    .filter((entry) => entry.line.kind === 'decided')
    .sort((left, right) => (right.line.kind === 'decided' ? right.line.payload.at : 0) - (left.line.kind === 'decided' ? left.line.payload.at : 0))[0];
  if (failed === undefined || failed.line.kind !== 'decided') return null;
  const { payload } = failed.line;
  const reason = (payload.reason ?? '').trim();
  const chapter = payload.chapters[0] ?? null;
  const door: NowDoor | null =
    payload.commentId !== null && chapter !== null
      ? { commentId: payload.commentId, chapter }
      : chapter === null
        ? null
        : { chapter };
  return {
    kind: 'defect',
    parts: [
      { text: reason.length === 0 ? NOW_VERBS.notDelivered : `${NOW_VERBS.notDelivered}: ${shortReason(reason)}` },
      filingPart(filingSeq(state, payload.commentId, failed.changeId)),
      ...clockPart(payload.at),
    ],
    door,
    at: payload.at,
    untilMs: payload.at + LINGER_MS,
  };
}
