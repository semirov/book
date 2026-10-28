/**
 * The writer lane's stage event (docs/writer-lane.md §2).
 *
 * A stage is what happened, when, and to which pass — not an animation promised before the
 * work. The summary is one factual line built from values the lane holds; the span is bounded
 * because it is a hint to the reader, and the rest of the chapter is read from the chapter
 * itself. Nothing here names a reader: the actor is a process and, when a model ran, its id.
 */

export const PASS_STAGES = ['queued', 'read', 'verdict', 'drafting', 'typing', 'landed', 'refused'] as const;

export type PassStage = (typeof PASS_STAGES)[number];

/** Who did the work: the engine's scheduler, the writer, the site, or a gate. */
export const STAGE_ACTOR_PROCESSES = ['engine', 'writer', 'site', 'auditor'] as const;

export type StageActor = {
  process: (typeof STAGE_ACTOR_PROCESSES)[number];
  model: string | null;
};

export type StageSpan = {
  /** null: the chapter is created from an empty slot. */
  blockId: string | null;
  /** The words being replaced ('' when the block is new). */
  before: string;
  /** The words that replace them. */
  after: string;
  /** before/after were cut at the bound; the client reads the rest from the chapter. */
  truncated: boolean;
};

export type PassStageEvent = {
  /** The engine's step id — one pass, one id. */
  passId: string;
  /** 1..67. */
  chapter: number;
  /** Monotonic inside the pass, from 1. */
  stageSeq: number;
  stage: PassStage;
  /** ms epoch, when the work happened. */
  at: number;
  actor: StageActor;
  changeId: string | null;
  /** ≤200 chars, one factual line, built from values the lane holds. */
  summary: string;
  /** On `landed`; null elsewhere. */
  span: StageSpan[] | null;
  /** On `drafting` (one model call's own usage) and `landed` (the whole pass); null elsewhere. */
  tokens: { in: number; out: number } | null;
  /** On `landed`: this pass, from pipeline.json rates. */
  costUsd: number | null;
};

export const STAGE_SUMMARY_MAX_CHARS = 200;
/** Each side of a span is cut here, then `truncated: true`. */
export const STAGE_SPAN_MAX_CHARS = 2_000;
/** A landed stage replaces a handful of blocks; a whole chapter is not a span. */
export const STAGE_SPAN_MAX_BLOCKS = 64;
/** `at` is a real ms epoch: 1 January 2100. A larger number cannot be an observation. */
export const STAGE_AT_MAX_MS = 4_102_444_800_000;

/** What the lane may hand to the store: the chapter and the pass's change are its own. */
export type StageSpanInput = {
  blockId?: string | null;
  before: string;
  after: string;
  /** A caller that already cut the text says so; the bound below is never relaxed. */
  truncated?: boolean;
};

export type StageInput = {
  passId: string;
  stageSeq?: number | null;
  stage: string;
  at: number;
  actor: { process: string; model?: string | null };
  changeId?: string | null;
  summary: string;
  span?: readonly StageSpanInput[] | null;
  tokens?: { in: number; out: number } | null;
  costUsd?: number | null;
};

/** A validated input: the vocabulary is narrowed, the bounds are already applied. */
export type NormalizedStage = {
  passId: string;
  /** null = the store assigns `max(stage_seq) + 1` for the pass. */
  stageSeq: number | null;
  stage: PassStage;
  at: number;
  actor: StageActor;
  changeId: string | null;
  summary: string;
  span: StageSpan[] | null;
  tokens: { in: number; out: number } | null;
  costUsd: number | null;
};

export type StageRefusalCode = 'INVALID_STAGE' | 'UNKNOWN_STAGE' | 'UNKNOWN_ACTOR';

export type StageVerdict =
  | { ok: true; value: NormalizedStage }
  | { ok: false; code: StageRefusalCode; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuse(code: StageRefusalCode, reason: string): StageVerdict {
  return { ok: false, code, reason };
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/** One factual line: line breaks and runs of spaces collapse, then the bound applies. */
function normalizeSummary(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const line = value.replace(/\s+/gu, ' ').trim();
  if (line.length === 0) return null;
  return line.slice(0, STAGE_SUMMARY_MAX_CHARS);
}

function normalizeSpan(raw: unknown): { ok: true; span: StageSpan[] | null } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, span: null };
  if (!Array.isArray(raw)) return { ok: false, reason: 'span must be an array of blocks or null' };
  // An empty span is "nothing was replaced"; the event says so with null, not with [].
  if (raw.length === 0) return { ok: true, span: null };
  if (raw.length > STAGE_SPAN_MAX_BLOCKS) {
    return { ok: false, reason: `span holds ${raw.length} blocks, at most ${STAGE_SPAN_MAX_BLOCKS}` };
  }
  const span: StageSpan[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.before !== 'string' || typeof entry.after !== 'string') {
      return { ok: false, reason: 'a span entry carries before/after strings' };
    }
    const before = entry.before.slice(0, STAGE_SPAN_MAX_CHARS);
    const after = entry.after.slice(0, STAGE_SPAN_MAX_CHARS);
    const cut = before.length < entry.before.length || after.length < entry.after.length;
    span.push({
      blockId: typeof entry.blockId === 'string' && entry.blockId.length > 0 ? entry.blockId.slice(0, 120) : null,
      before,
      after,
      truncated: cut || entry.truncated === true,
    });
  }
  return { ok: true, span };
}

function normalizeTokens(raw: unknown): { in: number; out: number } | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return undefined;
  const { in: tokensIn, out: tokensOut } = raw;
  if (
    typeof tokensIn !== 'number' ||
    typeof tokensOut !== 'number' ||
    !Number.isInteger(tokensIn) ||
    !Number.isInteger(tokensOut) ||
    tokensIn < 0 ||
    tokensOut < 0
  ) {
    return undefined;
  }
  return { in: tokensIn, out: tokensOut };
}

/**
 * The one validator: the HTTP route and the store both run it, so a summary/span bound or the
 * stage vocabulary cannot drift between "what the lane sends" and "what the table holds".
 * Bounds are applied (a long summary is cut, a long span side is cut and flagged), while an
 * unknown stage, actor or an unusable shape is refused with a code the caller can branch on.
 */
export function normalizeStageEvent(input: unknown): StageVerdict {
  if (!isRecord(input)) return refuse('INVALID_STAGE', 'a stage is an object');
  const passId = typeof input.passId === 'string' ? input.passId.trim() : '';
  if (passId.length === 0 || passId.length > 80) {
    return refuse('INVALID_STAGE', 'passId is required and at most 80 characters');
  }

  if (!isOneOf(PASS_STAGES, input.stage)) {
    return refuse('UNKNOWN_STAGE', `stage must be one of: ${PASS_STAGES.join(', ')}`);
  }
  const stage = input.stage;

  if (typeof input.at !== 'number' || !Number.isInteger(input.at) || input.at < 0 || input.at > STAGE_AT_MAX_MS) {
    return refuse('INVALID_STAGE', 'at is the ms epoch of the work, an integer between 0 and 2100-01-01');
  }

  const stageSeq =
    input.stageSeq === undefined || input.stageSeq === null
      ? null
      : typeof input.stageSeq === 'number' && Number.isInteger(input.stageSeq) && input.stageSeq >= 1
        ? input.stageSeq
        : undefined;
  if (stageSeq === undefined) return refuse('INVALID_STAGE', 'stageSeq is a positive integer when given');

  if (!isRecord(input.actor) || !isOneOf(STAGE_ACTOR_PROCESSES, input.actor.process)) {
    return refuse('UNKNOWN_ACTOR', `actor.process must be one of: ${STAGE_ACTOR_PROCESSES.join(', ')}`);
  }
  const modelValue = input.actor.model;
  if (modelValue !== undefined && modelValue !== null && typeof modelValue !== 'string') {
    return refuse('INVALID_STAGE', 'actor.model is a string or null');
  }
  const model =
    typeof modelValue === 'string' && modelValue.trim().length > 0 ? modelValue.trim().slice(0, 120) : null;

  const summary = normalizeSummary(input.summary);
  if (summary === null) return refuse('INVALID_STAGE', 'summary is one non-empty factual line');

  const span = normalizeSpan(input.span);
  if (!span.ok) return refuse('INVALID_STAGE', span.reason);

  const tokens = normalizeTokens(input.tokens);
  if (tokens === undefined) return refuse('INVALID_STAGE', 'tokens carries two non-negative integers, in and out');

  const rawCost = input.costUsd;
  if (rawCost !== undefined && rawCost !== null && (typeof rawCost !== 'number' || !Number.isFinite(rawCost) || rawCost < 0)) {
    return refuse('INVALID_STAGE', 'costUsd is a non-negative number or null');
  }

  const rawChange = input.changeId;
  if (rawChange !== undefined && rawChange !== null && (typeof rawChange !== 'string' || rawChange.length > 80)) {
    return refuse('INVALID_STAGE', 'changeId is a string of at most 80 characters, or null');
  }

  return {
    ok: true,
    value: {
      passId,
      stageSeq,
      stage,
      at: input.at,
      actor: { process: input.actor.process, model },
      changeId: typeof rawChange === 'string' && rawChange.length > 0 ? rawChange : null,
      summary,
      span: span.span,
      tokens,
      costUsd: typeof rawCost === 'number' ? rawCost : null,
    },
  };
}
