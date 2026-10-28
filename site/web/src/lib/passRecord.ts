/**
 * The pass record's pure model (BOOK-166): one page, two states, no clock of its own.
 *
 * The record is what the chronicle row and the foot's door point at. It reads two payloads —
 * the pass's stages (`GET /api/chapters/:n/stages`) and, for a change, the change itself with
 * its chapter and the reader's filing — and says one of three things:
 *
 *   - **live** — the pass is running now: «книга пишется · глава 7 · 11:18», the stage in its
 *     present tense, how long it has been running, and the stage timeline in the present;
 *   - **ended** — the pass is over: «писалась · глава 7 · 11:18», «внесено» / «не принято»,
 *     the duration, the same timeline in the reader's past words, «было» → «стало» and one
 *     cost sentence;
 *   - **absent** — nothing to tell: «пока не писалась» and the way back.
 *
 * The word «проход» is internal: it lives in the hash and in the store, never in a string this
 * module outputs. No model id, no `этап:`, no `цена`, no raw field name, no invented time: a
 * stage that is not stored is not printed, and a duration without two stored moments is null.
 *
 * Everything here is a function of the payloads, so the surface is testable without a browser
 * or a socket. The fetch and its lifecycle are `usePassRecord.ts`'s.
 */

import {
  PASS_RECORD_PREFIX,
  TOTAL_CHAPTERS,
  type ChapterDto,
  type ChangeOutcome,
  type ChangeStatus,
  type PassStage,
  type PassStageEvent,
} from '@book/shared';

import { usdText } from './bookCost.ts';
import { MIDDOT, NBSP, formatNumber, formatTime, plural } from './format.ts';

// ── the door's id ────────────────────────────────────────────────────────────

/**
 * What the record is about: a change (which knows its chapter) or a landed pass with no change
 * row (which carries its chapter in the key, because nothing else can find it).
 */
export type PassRecordKey =
  | { kind: 'change'; changeId: string }
  | { kind: 'pass'; chapter: number; passId: string };

/** `#проход-<changeId>` / `#проход-<chapter>-<passId>` — the one id the row and the door share. */
export function passRecordHash(key: PassRecordKey): string {
  if (key.kind === 'change') return `#${PASS_RECORD_PREFIX}${key.changeId}`;
  return `#${PASS_RECORD_PREFIX}${key.chapter}-${key.passId}`;
}

/**
 * The hash back to its key, or `null` for any other link. A change id is matched first as the
 * bare form; a `<chapter>-<passId>` prefix is the bare pass's form. Change ids are `chg_…` and
 * pass ids `stp_…`, so the two shapes cannot collide in practice; a malformed key is refused
 * rather than guessed, and the page then says it never wrote.
 */
export function parsePassRecordHash(hash: string): PassRecordKey | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* a broken escape sequence is not a record id */
  }
  if (!decoded.startsWith(PASS_RECORD_PREFIX)) return null;
  const rest = decoded.slice(PASS_RECORD_PREFIX.length);
  // A numeric prefix is the bare pass's shape. It must be a whole key: `7-` is nobody's id,
  // and refusing it here keeps a change id from swallowing a malformed pass link.
  if (/^\d{1,2}-/u.test(rest)) {
    const bare = /^(\d{1,2})-([A-Za-z0-9_-]{1,80})$/u.exec(rest);
    if (bare === null) return null;
    const chapter = Number(bare[1]);
    return chapter >= 1 && chapter <= TOTAL_CHAPTERS ? { kind: 'pass', chapter, passId: bare[2]! } : null;
  }
  if (/^[A-Za-z0-9_-]{1,80}$/u.test(rest)) return { kind: 'change', changeId: rest };
  return null;
}

// ── the words ───────────────────────────────────────────────────────────────

/** The head's own words: live, ended, never. */
export const PASS_WRITING = 'книга пишется';
export const PASS_WROTE = 'писалась';
export const PASS_NEVER = 'пока не писалась';
/** The book's one word for what happened to the text. */
export const PASS_LANDED = 'внесено';
export const PASS_REFUSED = 'не принято';
/** The way back when the page knows nothing at all. */
export const PASS_TO_CONTENTS = 'к оглавлению';

/**
 * One verb per stage, in both tenses. The present is what a live pass says («пишется» /
 * «печатается»); the past is what the ended timeline reads (`читал 11:18 · … · внёс 11:24`).
 * A stage word and its time are always separated by a space, never glued.
 */
export const STAGE_WORDS: Record<PassStage, { present: string; past: string }> = {
  queued: { present: 'ждёт', past: 'ждал' },
  read: { present: 'читает', past: 'читал' },
  verdict: { present: 'сверяет', past: 'сверял' },
  drafting: { present: 'пишется', past: 'писал' },
  typing: { present: 'печатается', past: 'печатал' },
  landed: { present: PASS_LANDED, past: 'внёс' },
  refused: { present: PASS_REFUSED, past: 'не принял' },
};

// ── the input and the view ──────────────────────────────────────────────────

/** The change facts the page may read: status, its real moments and its own token count. */
export type PassRecordChange = {
  chapter: number;
  status: ChangeStatus;
  outcome: ChangeOutcome | null;
  startedAt: string | null;
  enqueuedAt: string;
  decidedAt: string | null;
  cost: { tokensIn: number; tokensOut: number } | null;
};

export type PassRecordInput = {
  key: PassRecordKey;
  /** The chapter's stages; the model picks the pass (by change or by pass id). */
  stages: readonly PassStageEvent[];
  /** The change behind a `change` key; `null` for a bare pass or an unknown id. */
  change: PassRecordChange | null;
  /** The chapter as it is now — its title line and the paragraphs the span may name. */
  chapter: Pick<ChapterDto, 'title' | 'blocks'> | null;
  /** The filing's own paragraph index (0-based), when the change came from a reader. */
  anchorIndex: number | null;
  /** The clock the live duration is read against, taken once when the answer landed. */
  nowMs: number;
};

export type PassRecordStep = {
  word: string;
  /** `11:18` — the stored moment of the stage, whole. */
  time: string;
  /** The stage the pass is on now (live only). */
  current: boolean;
};

export type PassRecordView = {
  phase: 'live' | 'ended' | 'absent';
  /** The heading: `книга пишется · глава 7 · 11:18`, `писалась · глава 7 · 11:18`, «пока не писалась». */
  head: string;
  chapter: number | null;
  chapterTitle: string | null;
  /** Live: the stage being written now (`пишется` / `печатается`). Ended: null. */
  stageWord: string | null;
  /** Ended: the book's word for the outcome (`внесено` / `не принято`). Live: null. */
  finalWord: string | null;
  /** Live: `с начала 2 мин 14 с`. Ended: null. */
  since: string | null;
  /** Ended: `2 мин 56 с`. Live: null. */
  duration: string | null;
  /** 1-based paragraph of the block the pass wrote, or null when it cannot be named. */
  paragraph: number | null;
  timeline: PassRecordStep[];
  span: { before: string; after: string } | null;
  /** `126 099 токенов · 0,08 $`, `… · цена не задана`, or null with nothing measured. */
  cost: string | null;
  /** `#pass` while live, `#ch-7` when the block is gone, `#toc` when nothing is known. */
  href: string;
  /** `к абзацу 12 →`, `к главе 7 · абзац 12 →`, `к оглавлению`. */
  link: string;
};

// ── the helpers ─────────────────────────────────────────────────────────────

const byStage = (left: PassStageEvent, right: PassStageEvent): number =>
  left.stageSeq - right.stageSeq || left.at - right.at;

const isTerminal = (stage: PassStage): boolean => stage === 'landed' || stage === 'refused';

/**
 * The pass the page is about. A bare pass knows its id; a change may have several passes
 * (a retry is a second pass under the same change), so the landed one wins and, among equals,
 * the latest start — the act that wrote what the reader can still read.
 */
function stagesOf(stages: readonly PassStageEvent[], key: PassRecordKey): PassStageEvent[] {
  if (key.kind === 'pass') return stages.filter((stage) => stage.passId === key.passId).sort(byStage);
  const own = stages.filter((stage) => stage.changeId === key.changeId);
  if (own.length === 0) return [];
  const groups = new Map<string, PassStageEvent[]>();
  for (const stage of own) {
    const held = groups.get(stage.passId);
    if (held === undefined) groups.set(stage.passId, [stage]);
    else held.push(stage);
  }
  const all = [...groups.values()].map((group) => group.sort(byStage));
  const landed = all.filter((group) => group.some((stage) => stage.stage === 'landed'));
  const pool = landed.length > 0 ? landed : all;
  pool.sort((left, right) => (right[0]?.at ?? 0) - (left[0]?.at ?? 0));
  return pool[0] ?? [];
}

/**
 * The first changed pair of the landed stage, with the record's own rule: an empty side or an
 * unchanged pair is no span at all, so the page never prints «было» → «было».
 */
function firstSpan(stage: PassStageEvent | null): { before: string; after: string } | null {
  if (stage?.span === null || stage?.span === undefined) return null;
  for (const entry of stage.span) {
    const before = entry.before.trim();
    const after = entry.after.trim();
    if (before.length === 0 || after.length === 0 || before === after) continue;
    return { before, after };
  }
  return null;
}

/**
 * The paragraph the pass wrote: the landed span's own words matched against the chapter as it
 * is now (the block id is content-derived, so the text is the stable side), or — for a live
 * change, whose span does not exist yet — the paragraph the reader's filing pointed at.
 */
function paragraphOf(
  span: { before: string; after: string } | null,
  chapter: Pick<ChapterDto, 'blocks'> | null,
  anchorIndex: number | null,
): number | null {
  if (span !== null && chapter !== null) {
    const index = chapter.blocks.findIndex((block) => block.text.trim() === span.after);
    if (index >= 0) return index + 1;
  }
  return anchorIndex === null ? null : anchorIndex + 1;
}

/** `45 000` → `45 с`; `134 000` → `2 мин 14 с`; `176 000` → `2 мин 56 с`. */
export function durationText(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const total = Math.round(ms / 1_000);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours}${NBSP}ч ${minutes}${NBSP}мин` : `${hours}${NBSP}ч`;
  if (minutes > 0) return seconds > 0 ? `${minutes}${NBSP}мин ${seconds}${NBSP}с` : `${minutes}${NBSP}мин`;
  return `${seconds}${NBSP}с`;
}

/** The tokens as the book counts them — a number, a non-breaking space and its noun. */
export function tokensText(tokens: number | null): string | null {
  if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) return null;
  return `${formatNumber(tokens)}${NBSP}${plural(tokens, 'токен', 'токена', 'токенов')}`;
}

/**
 * One cost sentence with nouns: `126 099 токенов · 0,08 $`, or `… · цена не задана` when the
 * pass spent tokens but no rate measured them. No number, no sentence — never «0 $».
 */
export function costSentence(tokens: number | null, usd: number | null): string | null {
  const count = tokensText(tokens);
  if (count === null && usd === null) return null;
  const money = usdText(usd);
  return count === null ? money : `${count}${MIDDOT}${money}`;
}

const timeOf = (at: number): string => formatTime(new Date(at).toISOString());

/** The head's tail: the pass's first stored moment, or nothing when no stage was stored. */
function headOf(phase: 'live' | 'ended', chapter: number, startAt: number | null): string {
  const lead = phase === 'live' ? PASS_WRITING : PASS_WROTE;
  const place = `глава ${chapter}`;
  return startAt === null ? `${lead}${MIDDOT}${place}` : `${lead}${MIDDOT}${place}${MIDDOT}${timeOf(startAt)}`;
}

function linkOf(phase: 'live' | 'ended', chapter: number, paragraph: number | null): string {
  if (phase === 'live') {
    return paragraph === null ? `к главе ${chapter} →` : `к абзацу ${paragraph} →`;
  }
  return paragraph === null ? `к главе ${chapter} →` : `к главе ${chapter}${MIDDOT}абзац ${paragraph} →`;
}

function absentView(chapter: number | null, chapterTitle: string | null): PassRecordView {
  return {
    phase: 'absent',
    head: PASS_NEVER,
    chapter,
    chapterTitle,
    stageWord: null,
    finalWord: null,
    since: null,
    duration: null,
    paragraph: null,
    timeline: [],
    span: null,
    cost: null,
    // Nothing was written, so there is no chapter or block to land on: the way out is the
    // book's own contents, the one target that exists on every page.
    href: '#toc',
    link: PASS_TO_CONTENTS,
  };
}

/** The book's word for a change with no stage to read it from. */
function finalWordOf(change: Pick<PassRecordChange, 'status' | 'outcome'>): string {
  const landed =
    change.status === 'done' &&
    (change.outcome === 'applied' || change.outcome === 'adapted' || change.outcome === 'finding');
  return landed ? PASS_LANDED : PASS_REFUSED;
}

function changeTokens(change: PassRecordChange | null): number | null {
  if (change?.cost === null || change?.cost === undefined) return null;
  return change.cost.tokensIn + change.cost.tokensOut;
}

/**
 * The page when the chapter holds no stage for this pass. The change's own row is the truth
 * that is left: its status, its word, its real `startedAt`/`decidedAt` and its tokens. The
 * steps are not turned into a timeline — a cascade step is not a stage, and inventing stage
 * words for it would be a record nobody wrote.
 */
function changeFallback(change: PassRecordChange, input: PassRecordInput): PassRecordView {
  const chapter = change.chapter;
  const title = input.chapter?.title ?? null;
  const started = change.startedAt ?? change.enqueuedAt;
  const startMs = Date.parse(started);
  const paragraph = input.anchorIndex === null ? null : input.anchorIndex + 1;

  if (change.status === 'processing') {
    const since = Number.isFinite(startMs) ? durationText(input.nowMs - startMs) : null;
    return {
      phase: 'live',
      head: headOf('live', chapter, Number.isFinite(startMs) ? startMs : null),
      chapter,
      chapterTitle: title,
      stageWord: STAGE_WORDS.drafting.present,
      finalWord: null,
      since: since === null ? null : `с начала ${since}`,
      duration: null,
      paragraph,
      timeline: [],
      span: null,
      cost: null,
      href: '#pass',
      link: linkOf('live', chapter, paragraph),
    };
  }

  const endMs = Date.parse(change.decidedAt ?? started);
  const duration = Number.isFinite(startMs) && Number.isFinite(endMs) ? durationText(endMs - startMs) : null;
  return {
    phase: 'ended',
    head: headOf('ended', chapter, Number.isFinite(startMs) ? startMs : null),
    chapter,
    chapterTitle: title,
    stageWord: null,
    finalWord: finalWordOf(change),
    since: null,
    duration,
    paragraph,
    timeline: [],
    span: null,
    cost: costSentence(changeTokens(change), null),
    href: `#ch-${chapter}`,
    link: linkOf('ended', chapter, paragraph),
  };
}

// ── the model ───────────────────────────────────────────────────────────────

/**
 * The page's one state from the two payloads. The order is deliberate: a pass that has stored
 * a stage is told from its stages; a change with no stage is told from its own row; a key the
 * server does not know is «пока не писалась» — never a fabricated pass.
 */
export function passRecordView(input: PassRecordInput): PassRecordView {
  const stageList = stagesOf(input.stages, input.key);
  const chapter =
    input.key.kind === 'pass'
      ? input.key.chapter
      : (input.change?.chapter ?? stageList[0]?.chapter ?? null);
  if (stageList.length === 0) {
    if (input.change === null) return absentView(chapter, input.chapter?.title ?? null);
    const pending = input.change.status === 'pending' || input.change.status === 'stale';
    return pending ? absentView(chapter, input.chapter?.title ?? null) : changeFallback(input.change, input);
  }
  if (chapter === null) return absentView(null, input.chapter?.title ?? null);

  const ordered = stageList;
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const ended = ordered.some((stage) => isTerminal(stage.stage));
  const landed = [...ordered].reverse().find((stage) => stage.stage === 'landed') ?? null;
  const terminal = [...ordered].reverse().find((stage) => isTerminal(stage.stage)) ?? null;
  const span = ended ? firstSpan(landed) : null;
  const paragraph = paragraphOf(span, input.chapter, input.anchorIndex);
  /**
   * The reader's past is `читал · сверял · писал · внёс` (owner's words). `typing` is the print
   * delay of the landing — the browser painting text the pass already stored — so it is no step
   * of an ended pass and never stretches its duration. A live pass keeps it: the row is the
   * present tense of what is happening now.
   */
  const steps = ended ? ordered.filter((stage) => stage.stage !== 'typing') : ordered;
  const endAt = terminal?.at ?? last.at;
  // The pass's own tokens are the landed stage's; a change's cost covers every step it took,
  // so it is only read when no stage exists at all (`changeFallback`).
  const tokens = landed?.tokens === null || landed?.tokens === undefined
    ? null
    : landed.tokens.in + landed.tokens.out;
  const usd = landed?.costUsd ?? null;
  const since = ended ? null : durationText(input.nowMs - first.at);

  return {
    phase: ended ? 'ended' : 'live',
    head: headOf(ended ? 'ended' : 'live', chapter, first.at),
    chapter,
    chapterTitle: input.chapter?.title ?? null,
    stageWord: ended ? null : STAGE_WORDS[last.stage].present,
    finalWord: ended ? (terminal?.stage === 'landed' ? PASS_LANDED : PASS_REFUSED) : null,
    since: since === null ? null : `с начала ${since}`,
    duration: ended ? durationText(endAt - first.at) : null,
    paragraph,
    timeline: steps.map((stage, index) => ({
      word: ended ? STAGE_WORDS[stage.stage].past : STAGE_WORDS[stage.stage].present,
      time: timeOf(stage.at),
      current: !ended && index === steps.length - 1,
    })),
    span,
    cost: costSentence(tokens, usd),
    href: ended ? `#ch-${chapter}` : '#pass',
    link: linkOf(ended ? 'ended' : 'live', chapter, paragraph),
  };
}
