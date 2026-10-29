/**
 * The pass strip's pure model (owner, 2026-10-28): five public states, no machinery.
 *
 * The strip under the passage a pass is writing says what is happening in the book's own words
 * and nothing else. Its whole vocabulary is five words — `читает · сверяет · пишет · не внесено
 * · внесено` — and one tense change: a landed row whose text is printing says `печатается`.
 * A row exists only because a stored stage arrived: a stage with no event does not exist, and
 * nothing here invents one, times one, or prints a second name for one.
 *
 * The record's page (`passRecord.ts`) owns the same facts for a reader who comes later; this
 * module owns the rail the reader sees while the pass runs. It borrows the record's words for
 * the head (`PASS_WRITING` / `PASS_WROTE`), its duration and token sentences, and the diff's
 * own span (`passDiff.ts`) — a second vocabulary would be a second truth.
 *
 * Everything is a function of the events, so the rail is testable without a browser, a socket
 * or a clock: `nowMs` is handed in, never read.
 */

import { STAGE_SUMMARY_MAX_CHARS, type PassStage, type PassStageEvent } from '@book/shared';

import { usdText } from './bookCost.ts';
import { MIDDOT, formatTime } from './format.ts';
import { passSpanOf, type PassSpan } from './passDiff.ts';
import { PASS_WRITING, PASS_WROTE, durationText, tokensText } from './passRecord.ts';

// ── the five words ──────────────────────────────────────────────────────────

export type RailKey = 'read' | 'verdict' | 'drafting' | 'landed' | 'refused';

/** What a row says happened: done (past), live (now), refused (the pass did not land). */
export type RailState = 'done' | 'live' | 'refused';

/**
 * The strip's vocabulary, one word per public state. `queued` and `read` share `читает`: the
 * public state is «the pass is reading», and the queue's own moment is not a sixth word.
 */
export const RAIL_WORDS: Record<RailKey, string> = {
  read: 'читает',
  verdict: 'сверяет',
  drafting: 'пишет',
  landed: 'внесено',
  refused: 'не внесено',
};

/** A landed row whose text is printing: the same row, the present tense. */
export const RAIL_PRINTING = 'печатается';
/** The live row's one actor-free line — never a model, never a role's private name. */
export const RAIL_BROWSER = 'печатает браузер';
/**
 * No stage was stored for the pass this strip was opened on: the absence, said in words in the
 * strip's own register. A failed read is not a pass in flight, and an empty rail must not claim
 * one (BOOK-199, audit #2).
 */
export const RAIL_ABSENT = 'пока ничего не записано';

export type RailRow = {
  key: RailKey;
  /** The public state word, or `печатается` on a landed row that is printing. */
  word: string;
  /** Epoch ms of the event that put the row there (the earliest, for `читает`). */
  atMs: number;
  state: RailState;
  /** The event's own line, collapsed to one, at most `STAGE_SUMMARY_MAX_CHARS`. */
  summary: string;
  /** 1-based paragraph the row names, or null when no block is derivable. */
  paragraph: number | null;
};

/** A block as the page holds it: only the id is needed to turn one into «абзац 12». */
export type RailBlock = { id: string };

export type RailOptions = {
  /** The chapter's blocks as the page has them; a block id is read against them. */
  blocks?: readonly RailBlock[];
  /** The block the strip was opened on: how a live row names its paragraph. */
  blockId?: string | null;
};

const byStage = (left: PassStageEvent, right: PassStageEvent): number =>
  left.stageSeq - right.stageSeq || left.at - right.at;

const summaryOf = (summary: string): string =>
  summary.replace(/\s+/gu, ' ').trim().slice(0, STAGE_SUMMARY_MAX_CHARS);

/**
 * A block id to a 1-based paragraph: the page's own blocks first, then the `#<digits>` form a
 * fixture may carry. Hashes (`ch08#9c1f0a3b`) name no position, so a page without the blocks
 * answers null rather than guessing.
 */
export function paragraphOf(blockId: string | null, blocks?: readonly RailBlock[]): number | null {
  if (blockId === null) return null;
  if (blocks !== undefined) {
    const index = blocks.findIndex((block) => block.id === blockId);
    if (index >= 0) return index + 1;
  }
  const digits = /#(\d{1,3})$/u.exec(blockId);
  return digits === null ? null : Number(digits[1]);
}

/**
 * One row per public state, in the order the stages came, from the events that exist.
 *
 * `refused` is terminal: it ends the rail, and nothing is added below it. `landed` stops new
 * rows too (the pass is over), but a `typing` after it rewrites that one row's word to
 * `печатается` — the same row, the present tense, exactly as the owner asked.
 */
export function railRows(events: readonly PassStageEvent[], options: RailOptions = {}): RailRow[] {
  const ordered = [...events].sort(byStage);
  const rows: Omit<RailRow, 'state'>[] = [];
  let typing: PassStageEvent | null = null;
  let closed = false;

  for (const event of ordered) {
    // `typing` is not a row of its own: it changes the tense of the row the text landed on.
    if (event.stage === 'typing') {
      typing = event;
      continue;
    }
    if (closed) continue;
    switch (event.stage) {
      case 'queued':
      case 'read': {
        const held = rows.find((row) => row.key === 'read');
        if (held === undefined) {
          rows.push({
            key: 'read',
            word: RAIL_WORDS.read,
            atMs: event.at,
            summary: summaryOf(event.summary),
            paragraph: null,
          });
        } else {
          held.atMs = Math.min(held.atMs, event.at);
          // The read stage speaks for the reading row; the queue's line is its fallback.
          if (event.stage === 'read') held.summary = summaryOf(event.summary);
        }
        break;
      }
      case 'verdict':
      case 'drafting': {
        const key: RailKey = event.stage;
        rows.push({
          key,
          word: RAIL_WORDS[key],
          atMs: event.at,
          summary: summaryOf(event.summary),
          paragraph: null,
        });
        break;
      }
      case 'landed': {
        rows.push({
          key: 'landed',
          word: RAIL_WORDS.landed,
          atMs: event.at,
          summary: summaryOf(event.summary),
          paragraph: paragraphOf(event.span?.[0]?.blockId ?? null, options.blocks),
        });
        closed = true;
        break;
      }
      case 'refused': {
        rows.push({
          key: 'refused',
          word: RAIL_WORDS.refused,
          atMs: event.at,
          summary: summaryOf(event.summary),
          paragraph: null,
        });
        closed = true;
        break;
      }
    }
  }

  const landed = rows.find((row) => row.key === 'landed');
  if (landed !== undefined && typing !== null && typing.at >= landed.atMs) {
    landed.word = RAIL_PRINTING;
  }

  return rows.map((row, index) => {
    const terminal = row.key === 'refused' || (row.key === 'landed' && row.word !== RAIL_PRINTING);
    const state: RailState = row.key === 'refused' ? 'refused' : !terminal && index === rows.length - 1 ? 'live' : 'done';
    const paragraph =
      row.paragraph ?? (state === 'live' ? paragraphOf(options.blockId ?? null, options.blocks) : null);
    return { ...row, state, paragraph };
  });
}

/**
 * The last row whose moment has come. A reader who arrives late sees every arrived row with
 * its stored time — the rail is a list of facts, never a replay of the pass.
 */
export function currentRow(
  events: readonly PassStageEvent[],
  nowMs: number,
  options: RailOptions = {},
): RailRow | null {
  let held: RailRow | null = null;
  for (const row of railRows(events, options)) {
    if (row.atMs <= nowMs) held = row;
  }
  return held;
}

/** The latest event of one stage, or null when the pass never reached it. */
export function passStageAt(events: readonly PassStageEvent[], stage: PassStage): PassStageEvent | null {
  let held: PassStageEvent | null = null;
  for (const event of [...events].sort(byStage)) {
    if (event.stage === stage) held = event;
  }
  return held;
}

// ── the handle, the receipt, the sentence ───────────────────────────────────

/**
 * The pass's display handle — `№A7K`, `№K4Q7`: the last four alphanumerics of the id, or the
 * last three when the id is shorter. Uppercase, stable, and derived from the id alone so two
 * renders of one pass never disagree.
 */
export function passShortId(passId: string): string | null {
  // The id's own prefix (`stp_`, `chg_`) names the kind of record, not the pass: the handle is
  // the last four characters of what follows it, or three when there is less to take.
  const alnum = passId.replace(/^[A-Za-z]{2,4}_/u, '').replace(/[^0-9A-Za-z]/gu, '').toUpperCase();
  if (alnum.length === 0) return null;
  return `№${alnum.slice(alnum.length >= 4 ? -4 : -3)}`;
}

/** What a landed pass spent, as the strip prints it; no model and no rate is stored. */
export type PassReceipt = { tokens: number | null; costUsd: number | null; durationMs: number | null };

/**
 * The receipt of a landed pass. The token count and the cost are the landed stage's own; the
 * duration needs two stored moments, so it is null unless the caller hands in the pass's
 * events — a duration is never invented from one timestamp.
 */
export function receiptOf(
  landed: PassStageEvent | null,
  events: readonly PassStageEvent[] = [],
): PassReceipt {
  const tokens = landed?.tokens === null || landed?.tokens === undefined
    ? null
    : landed.tokens.in + landed.tokens.out;
  const costUsd = typeof landed?.costUsd === 'number' ? landed.costUsd : null;
  const startAt = events.length === 0 ? null : Math.min(...events.map((event) => event.at));
  const durationMs =
    landed !== null && startAt !== null && landed.at >= startAt ? landed.at - startAt : null;
  return { tokens, costUsd, durationMs };
}

/**
 * The receipt's one line: `126 099 токенов · 0,08 $`, or the tokens alone when no rate measured
 * the pass. There is no «цена не задана» here: the strip states what was spent, and a pass
 * with no price simply does not name a price.
 */
export function receiptTextOf(receipt: PassReceipt): string | null {
  const count = tokensText(receipt.tokens);
  const priced =
    receipt.costUsd !== null && Number.isFinite(receipt.costUsd) && receipt.costUsd >= 0
      ? usdText(receipt.costUsd)
      : null;
  if (count === null) return priced;
  return priced === null ? count : `${count}${MIDDOT}${priced}`;
}

/**
 * The live row's fact lines: the event's one line, wrapped at `width` characters, at most
 * `max` of them. Bounded because the row is 100 px tall and the rail never grows past itself.
 */
export function factLines(text: string, width = 40, max = 3): string[] {
  const words = text
    .replace(/\s+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (candidate.length <= width) {
      line = candidate;
      continue;
    }
    if (line !== '') lines.push(line);
    if (lines.length === max) return lines;
    line = word.length <= width ? word : word.slice(0, width);
  }
  if (line !== '' && lines.length < max) lines.push(line);
  return lines;
}

const timeOf = (at: number): string => formatTime(new Date(at).toISOString());

// ── the strip ───────────────────────────────────────────────────────────────

export type PassStripInput = {
  chapter: number;
  /** One pass's events (`eventsOfPass`): the rail never mixes two passes into one story. */
  events: readonly PassStageEvent[];
  nowMs: number;
  blocks?: readonly RailBlock[];
  blockId?: string | null;
};

export type PassStripModel = {
  /** `absent`: no stage was stored, so there is no pass to be live or ended (BOOK-199). */
  phase: 'live' | 'ended' | 'absent';
  /**
   * `книга пишется · глава 7 · 11:18`, `писалась · глава 7 · 11:18`, or
   * `пока ничего не записано · глава 7` when the read came back empty: the absence in words,
   * never a live claim.
   */
  heading: string;
  /** Live: the current stage's word. Ended: the pass's duration. */
  right: string | null;
  rows: RailRow[];
  receipt: PassReceipt;
  /** The pass was refused: the rail ends in a dash and has nothing below it. */
  refused: boolean;
};

export function passStripModel(input: PassStripInput): PassStripModel {
  const ordered = [...input.events].sort(byStage);
  const rows = railRows(ordered, { blocks: input.blocks, blockId: input.blockId });
  const first = ordered[0] ?? null;
  const place = `глава ${input.chapter}`;
  // No stored stage, no pass: the strip says the absence instead of borrowing the live words.
  // The rail stays empty and no time is invented — there is no event whose moment it could be.
  if (first === null) {
    return {
      phase: 'absent',
      heading: `${RAIL_ABSENT}${MIDDOT}${place}`,
      right: null,
      rows,
      receipt: receiptOf(null),
      refused: false,
    };
  }
  // The strip is live while its last row is: reading, weighing, writing, or a landing whose
  // text the browser is printing. A pass that landed and settled — or was refused — is past.
  const phase: 'live' | 'ended' =
    rows.length === 0 || rows[rows.length - 1]?.state === 'live' ? 'live' : 'ended';
  const lead = phase === 'live' ? PASS_WRITING : PASS_WROTE;
  const heading = `${lead}${MIDDOT}${place}${MIDDOT}${timeOf(first.at)}`;
  const terminal = [...ordered].reverse().find((event) => event.stage === 'landed' || event.stage === 'refused') ?? null;
  const landed = passStageAt(ordered, 'landed');
  const durationMs =
    terminal !== null && first !== null && terminal.at >= first.at ? terminal.at - first.at : null;
  return {
    phase,
    heading,
    // A past pass states how long it ran; a live one states the stage it is on.
    right: phase === 'live' ? (currentRow(ordered, input.nowMs, { blocks: input.blocks, blockId: input.blockId })?.word ?? null) : durationText(durationMs),
    rows,
    receipt: receiptOf(landed, ordered),
    refused: terminal?.stage === 'refused',
  };
}

// ── one pass out of a chapter's log ─────────────────────────────────────────

/** The chapter's log, narrowed to one pass, in stage order. */
export function eventsOfPass(events: readonly PassStageEvent[], passId: string): PassStageEvent[] {
  return events.filter((event) => event.passId === passId).sort(byStage);
}

/** The pass the chapter's latest event belongs to — the one a reader is looking at. */
export function latestPassId(events: readonly PassStageEvent[]): string | null {
  const latest = [...events].sort((left, right) => left.at - right.at || left.stageSeq - right.stageSeq).at(-1);
  return latest?.passId ?? null;
}

/**
 * Two lists of one chapter's stages as one: the stored answer first, the frames that arrived
 * after it on top of it, deduped by `passId` + `stageSeq`. Live always wins — a frame is newer
 * than the answer it answers.
 */
export function mergeStages(
  stored: readonly PassStageEvent[],
  live: readonly PassStageEvent[],
): PassStageEvent[] {
  const merged = new Map<string, PassStageEvent>();
  for (const event of stored) merged.set(`${event.passId}:${event.stageSeq}`, event);
  for (const event of live) merged.set(`${event.passId}:${event.stageSeq}`, event);
  return [...merged.values()].sort(byStage);
}

// ── the live block ──────────────────────────────────────────────────────────

/** What a running pass puts on the page: one block, replaced, from the moment of its event. */
export type LivePassSpec = {
  /**
   * The pass's own id — the renderer's identity. One pass is one renderer: the stages that
   * follow the landing (`typing`) say when the browser prints, never that a second pass began.
   */
  key: string;
  before: string;
  after: string;
  startAt: number;
  /** The block the pass named — the pre-revision id, which is what the page still holds. */
  blockId: string | null;
  /** The stage's side was cut at the bound: the span is not the whole paragraph. */
  truncated: boolean;
};

/**
 * The pass the page is printing, from the stages it holds: the newest pass that reached the
 * text, its landed span, and the moment the browser started printing (`typing`), falling back
 * to the landing itself. No span, no spec — a pass that only read has no text to paint.
 *
 * A revision without a `pass:stage` therefore never reaches this function: the page keeps its
 * ordinary revision behaviour and never re-types old text.
 */
export function livePassOf(events: readonly PassStageEvent[]): LivePassSpec | null {
  const ordered = [...events].sort(byStage);
  const trigger = [...ordered].reverse().find((event) => event.stage === 'typing' || event.stage === 'landed');
  if (trigger === undefined) return null;
  const own = eventsOfPass(ordered, trigger.passId);
  const landed = [...own].reverse().find((event) => event.stage === 'landed' && (event.span?.length ?? 0) > 0);
  if (landed === undefined || landed.span === null) return null;
  // The words the pass wrote. An entry whose `after` is empty only removed text: the deletion
  // is the span the renderer paints as a ghost, so it is the fallback, not a skip.
  const entry =
    landed.span.find((item) => item.after.trim().length > 0) ??
    landed.span.find((item) => item.before.trim().length > 0);
  if (entry === undefined) return null;
  const typing = [...own].reverse().find((event) => event.stage === 'typing');
  const started = typing !== undefined && typing.at >= landed.at;
  return {
    // Keyed by the pass, never by a stage: `typing` arrives after `landed` (the tailer publishes
    // in seq order), and a re-keyed renderer would blank and re-type a paragraph already inked.
    key: landed.passId,
    before: entry.before,
    after: entry.after,
    startAt: started ? typing!.at : landed.at,
    blockId: entry.blockId,
    truncated: entry.truncated,
  };
}

/**
 * The words this block of the page is being written into, or null when the block is not the
 * one the pass touched.
 *
 * Two shapes are honest. Before the chapter refetches, the page still holds the block the pass
 * named by id, and the span's `after` is the text to paint. After the refetch, that block is
 * gone and its successor has the new text; the successor is matched by the text itself. A
 * truncated span is not used as a paragraph body: the rest of it lives in the chapter, and the
 * page waits for the chapter instead of printing a cut sentence.
 */
export function liveRunOf(
  spec: LivePassSpec,
  block: { id: string; text: string },
): { text: string; span: PassSpan } | null {
  const named = spec.blockId !== null && block.id === spec.blockId;
  if (named) {
    if (spec.truncated) return null;
    const span = passSpanOf(spec.before, spec.after);
    return span === null ? null : { text: spec.after, span };
  }
  if (block.text.trim() !== spec.after.trim()) return null;
  const span = passSpanOf(spec.before, block.text);
  return span === null ? null : { text: block.text, span };
}
