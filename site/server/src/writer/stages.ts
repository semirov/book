/**
 * The writer's stages (`docs/writer-lane.md` §1–§2): one line per fact, built from values the
 * pass holds.
 *
 * `stageSeq` is **never** sent: the store assigns `max(stage_seq) + 1` for the pass, because the
 * site emits `typing` into the same pass concurrently and an explicit counter from two producers
 * would collide. The emitter is also the pass's logger — the line it prints is the stage's own
 * summary, so what an operator reads and what the reader's page replays cannot disagree.
 *
 * Summaries are assembled here, and only from numbers and words the pass actually has: no
 * template of nice sentences about work that did not happen. Every helper is pure and bounded
 * well under `STAGE_SUMMARY_MAX_CHARS`.
 */

import { STAGE_SUMMARY_MAX_CHARS, type PassStage, type StageSpan } from '@book/shared';

import type { ModeChoice, ModeReason } from './mode.ts';

/** The one method the emitter needs: the client's `stage` (or a test double). */
export type StageSink = {
  stage(event: Record<string, unknown>): Promise<unknown> | unknown;
};

export type StageEmitInput = {
  stage: PassStage;
  chapter: number;
  passId: string;
  changeId?: string | null;
  summary: string;
  /** The model that did the work, when one ran. */
  model?: string | null;
  span?: readonly StageSpan[] | null;
  tokens?: { in: number; out: number } | null;
  costUsd?: number | null;
  at: number;
};

export type StageEmitResult = { ok: true } | { ok: false; code: string };

/** `12 400` — the book's prose is Russian, and a grouped number is how an operator reads it. */
export function grouped(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');
}

function line(parts: ReadonlyArray<string | null | false>): string {
  const text = parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' · ');
  return text.length <= STAGE_SUMMARY_MAX_CHARS ? text : `${text.slice(0, STAGE_SUMMARY_MAX_CHARS - 1)}…`;
}

function money(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/** The role as the reader's page names it, in Russian. */
function roleName(role: 'editor' | 'consultant'): string {
  return role === 'editor' ? 'редактор' : 'консультант';
}

/**
 * BOOK-173 §4: the mode is one fact on the `read` line. The reason is a closed word, not a
 * sentence: the reader sees whether the pass patched or rewrote, and why it chose that.
 */
const MODE_REASONS: Record<ModeReason, string> = {
  'slot-empty': 'слот пуст',
  'chapter-scope': 'заявка про главу',
  'phrase-scope': 'заявка про фразу',
  // BOOK-173 §3: the filing is anchored on a sentence the book still holds — the unit rule's door.
  'sentence-anchor': 'заявка привязана к предложению',
  'no-scope': 'заявка не про фразу',
  model: 'просит модель',
  revision: 'замечания гейта',
};

/**
 * BOOK-173 §5: the one factual line a no-op pass owes. It is the change card's word and the lane
 * log's line — the same sentence, because two words for one fact is how a record starts lying.
 */
export const NO_OP_LINE = 'перепись не изменила ни одного байта';

export function modeLine(choice: ModeChoice): string {
  return `режим: ${choice.mode === 'patch' ? 'правка' : 'перепись'} (${MODE_REASONS[choice.reason]})`;
}

export const stageSummary = {
  queued: (input: {
    chapter: number;
    pass: string;
    premise?: string | null;
    intent?: string | null;
  }): string => {
    // The intervention is quoted as the intent the change carries — never a reader's name.
    const task =
      input.premise !== null && input.premise !== undefined
        ? `замысел: ${input.premise}`
        : input.intent !== null && input.intent !== undefined
          ? `правка: ${input.intent}`
          : null;
    return line([`проход открыт: глава ${String(input.chapter)}, задание ${input.pass}`, task]);
  },

  read: (input: { sections: number; chars: number; neighbours: readonly number[]; mode?: ModeChoice | null }): string =>
    line([
      `промпт собран: ${String(input.sections)} разделов, ${grouped(input.chars)} знаков`,
      input.neighbours.length === 0
        ? 'написанных соседей нет'
        : `соседи: ${input.neighbours.map((n) => String(n)).join(', ')}`,
      input.mode === undefined || input.mode === null ? null : modeLine(input.mode),
    ]),

  draftingStarted: (input: { call: number; chars: number; purpose: 'draft' | 'repair' | 'continue' }): string =>
    line([
      input.purpose === 'draft'
        ? `запрос к модели №${String(input.call)}`
        : input.purpose === 'repair'
          ? `повторный запрос №${String(input.call)} с причиной отказа`
          : `продолжение №${String(input.call)}`,
      `${grouped(input.chars)} знаков промпта`,
    ]),

  draftingReturned: (input: { chars: number; tokensIn: number; tokensOut: number }): string =>
    line([
      `ответ: ${grouped(input.chars)} знаков`,
      `${grouped(input.tokensIn)} → ${grouped(input.tokensOut)} токенов`,
    ]),

  verdict: (input: {
    role: 'editor' | 'consultant';
    verdict: 'HOLDS' | 'GAP';
    findings: number;
    blockers: number;
  }): string =>
    line([
      `${roleName(input.role)}: ${input.verdict}`,
      input.findings === 0 ? 'замечаний нет' : `замечаний ${String(input.findings)}`,
      input.blockers === 0 ? null : `блокеров ${String(input.blockers)}`,
    ]),

  /**
   * Gate B's one line. A clean scan says so plainly («скан чистый, модель не звана»): the record
   * must show that the rights question was answered, not that it was skipped.
   */
  rightsVerdict: (input: { verdict: 'CLEAR' | 'REFUSED'; rule: string | null; scanned: boolean }): string =>
    line([
      `права: ${input.verdict}`,
      input.rule === null ? null : input.rule,
      input.scanned ? 'скан нашёл фрагмент' : 'скан чистый, модель не звана',
    ]),

  landed: (input: {
    chapter: number;
    chars: number;
    blocks: number;
    tokensIn: number;
    tokensOut: number;
    /** BOOK-173: the share of the input the provider served from its cache. */
    tokensCachedIn?: number;
    costUsd: number;
  }): string =>
    line([
      `глава ${String(input.chapter)}: ${grouped(input.chars)} знаков, ${String(input.blocks)} абзацев`,
      `${grouped(input.tokensIn)} → ${grouped(input.tokensOut)} токенов`,
      input.tokensCachedIn === undefined || input.tokensCachedIn === 0
        ? null
        : `кэш ${grouped(input.tokensCachedIn)}`,
      money(input.costUsd),
    ]),

  refused: (input: { reason: string }): string => line([`проход остановлен: ${input.reason}`]),
};

/**
 * Emit one stage. A stage is observability, not a fact the pass depends on: a refused or
 * unreachable stage is reported to the caller (`ok: false`) and the pass decides to log it,
 * never to abort the writing over a missing animation.
 */
export async function emitStage(sink: StageSink, input: StageEmitInput): Promise<StageEmitResult> {
  try {
    await sink.stage({
      passId: input.passId,
      stage: input.stage,
      at: input.at,
      // Exactly one producer per stage, one actor: the writer, with its model when one ran.
      actor: { process: 'writer', model: input.model ?? null },
      changeId: input.changeId ?? null,
      summary: input.summary,
      span: input.span === null || input.span === undefined ? null : [...input.span],
      tokens: input.tokens ?? null,
      costUsd: input.costUsd ?? null,
    });
    return { ok: true };
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'STAGE_FAILED';
    return { ok: false, code };
  }
}

/** One log line per stage, and it carries the stage's own summary — never the prompt. */
export function stageLogLine(at: number, stage: PassStage, summary: string): string {
  return `[writer] ${new Date(at).toISOString()} ${stage} ${summary}`;
}
