/**
 * The writer lane's stage event (docs/writer-lane.md §2).
 *
 * A stage is what happened, when, and to which pass — not an animation promised before the
 * work. The summary is one factual line built from values the lane holds; the span is bounded
 * because it is a hint to the reader, and the rest of the chapter is read from the chapter
 * itself. Nothing here names a reader: the actor is a process and, when a model ran, its id.
 */

import { isWidenedCode, widenedWord, type WidenedCode } from './stateWords.ts';

export const PASS_STAGES = [
  'queued',
  'read',
  'verdict',
  'drafting',
  'typing',
  'landed',
  'refused',
  // BOOK-DOC-84 §10.8 — the widening and the revision are states of their own: an iteration is
  // never folded into `verdict`, and the widening is never a sentence on another stage.
  'revising',
  'widening',
] as const;

export type PassStage = (typeof PASS_STAGES)[number];

/** §10.8: five attempts of the surface, then one desperate sixth — everywhere. */
export const MAX_ATTEMPTS = 5;
/** The sixth is the last: deterministic, cheapest, and always labelled. */
export const DESPERATE_ATTEMPT = 6;
/** A gate round's own bound: the call cap (420 s) plus a margin (60 s). */
export const STAGE_DEADLINE_MS = 480_000;
/** §10.8 — a desperate attempt is a dispatch, not work: 180 s. */
export const DESPERATE_DEADLINE_MS = 180_000;
/** A pass iterates at most four times inside five gate cycles (BOOK-DOC-84 §10.7). */
export const MAX_ITERATIONS = 4;
/**
 * §10.8 — a step's wall must fit five attempts of its own bound: 225 minutes (5 × 45), not the
 * 45-minute wall that closed the ladder at its second attempt.
 */
export const STEP_WALL_MS = 225 * 60_000;

/** The three gates the pass names; a stage that is not a gate carries `null`. */
export const GATE_NAMES = ['editor', 'consultant', 'rights'] as const;
export type GateName = (typeof GATE_NAMES)[number];

/** A gate's answer, as the stage carries it — never parsed out of the summary's prose. */
export const STAGE_VERDICTS = ['HOLDS', 'GAP', 'CLEAR', 'REFUSED'] as const;
export type StageVerdictWord = (typeof STAGE_VERDICTS)[number];

/**
 * §10.8/§10.9 — the widening the machine stated. The engine writes the **code**; the sentence is
 * `widenedWord(code)` from `stateWords.ts`, so no call site invents copy.
 */
export type WidenedNote = { code: WidenedCode; sentence: string };

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
  /** 1..TOTAL_CHAPTERS. */
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
  // ── §10.8's ladder fields ─────────────────────────────────────────────────
  // Optional on the wire (PROTOCOL_VERSION 5): a stage row written before the amendment has no
  // number, and a consumer that demands one would have to invent it. The store fills every new
  // row; the server's own writers always send them.
  /** The attempt this stage belongs to (1..6), and the ladder's ceiling. */
  attempt?: number;
  maxAttempts?: number;
  /** The engine's widening for this attempt, `null` before the third failure. */
  widened?: WidenedNote | null;
  /** §10.8: the sixth attempt is the desperate one — deterministic, cheapest, labelled. */
  desperate?: boolean;
  /** The gate this stage belongs to; `null` on every non-gate stage. */
  gate?: GateName | null;
  /** The gate round inside the pass (1..5); `null` off `verdict`. */
  round?: number | null;
  /** `steps.cycle` at the pass's start (0..4) — how many times the text was revised. */
  iteration?: number;
  maxIterations?: number;
  /** The gate's own answer when the stage is a `verdict`; `null` before it or off a gate. */
  verdict?: StageVerdictWord | null;
  /** `at + STAGE_DEADLINE_MS`: an open stage past it has a deadline that passed, not a stop. */
  deadlineAt?: number;
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
  /** §10.8 — the ladder's fields; the store fills `attempt`/`iteration` from its own rows. */
  attempt?: number | null;
  maxAttempts?: number | null;
  widened?: string | null;
  desperate?: boolean;
  gate?: GateName | null;
  round?: number | null;
  iteration?: number | null;
  maxIterations?: number | null;
  verdict?: StageVerdictWord | null;
  deadlineAt?: number | null;
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
  attempt: number;
  maxAttempts: number;
  widened: WidenedNote | null;
  desperate: boolean;
  gate: GateName | null;
  round: number | null;
  iteration: number;
  maxIterations: number;
  verdict: StageVerdictWord | null;
  deadlineAt: number;
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

  // §10.8 — the ladder's fields. `desperate` is the strongest fact: it fixes attempt 6 of 6,
  // so a caller cannot label a desperate attempt as an ordinary one (the invariant is the row).
  const desperate = input.desperate === true;
  const rawAttempt = input.attempt;
  if (rawAttempt !== undefined && rawAttempt !== null && (typeof rawAttempt !== 'number' || !Number.isInteger(rawAttempt))) {
    return refuse('INVALID_STAGE', 'attempt is an integer 1..6');
  }
  const attempt = desperate
    ? DESPERATE_ATTEMPT
    : typeof rawAttempt === 'number' && rawAttempt >= 1 && rawAttempt <= MAX_ATTEMPTS
      ? rawAttempt
      : 1;
  const rawMax = input.maxAttempts;
  if (rawMax !== undefined && rawMax !== null && (typeof rawMax !== 'number' || !Number.isInteger(rawMax))) {
    return refuse('INVALID_STAGE', 'maxAttempts is an integer 5 or 6');
  }
  const maxAttempts = desperate ? DESPERATE_ATTEMPT : Math.max(attempt, typeof rawMax === 'number' ? rawMax : MAX_ATTEMPTS);

  if (input.gate !== undefined && input.gate !== null && !isOneOf(GATE_NAMES, input.gate)) {
    return refuse('UNKNOWN_STAGE', `gate must be one of: ${GATE_NAMES.join(', ')}, or null`);
  }
  const gate = (input.gate ?? null) as GateName | null;

  const rawRound = input.round;
  if (rawRound !== undefined && rawRound !== null) {
    if (typeof rawRound !== 'number' || !Number.isInteger(rawRound) || rawRound < 1 || rawRound > 5) {
      return refuse('INVALID_STAGE', 'round is an integer 1..5, or null');
    }
  }
  const round = typeof rawRound === 'number' ? rawRound : null;

  const rawIteration = input.iteration;
  if (
    rawIteration !== undefined &&
    rawIteration !== null &&
    (typeof rawIteration !== 'number' || !Number.isInteger(rawIteration) || rawIteration < 0 || rawIteration > MAX_ITERATIONS)
  ) {
    return refuse('INVALID_STAGE', `iteration is an integer 0..${String(MAX_ITERATIONS)}`);
  }
  const iteration = typeof rawIteration === 'number' ? rawIteration : 0;

  if (input.verdict !== undefined && input.verdict !== null && !isOneOf(STAGE_VERDICTS, input.verdict)) {
    return refuse('UNKNOWN_STAGE', `verdict must be one of: ${STAGE_VERDICTS.join(', ')}, or null`);
  }
  const verdict = (input.verdict ?? null) as StageVerdictWord | null;

  if (input.widened !== undefined && input.widened !== null && !isWidenedCode(input.widened)) {
    return refuse('INVALID_STAGE', 'widened is one of the four widening codes, or null');
  }
  const widened =
    input.widened === undefined || input.widened === null
      ? null
      : { code: input.widened as WidenedCode, sentence: widenedWord(input.widened) };

  const rawDeadline = input.deadlineAt;
  if (rawDeadline !== undefined && rawDeadline !== null) {
    if (typeof rawDeadline !== 'number' || !Number.isInteger(rawDeadline) || rawDeadline < input.at) {
      return refuse('INVALID_STAGE', 'deadlineAt is the stage’s ms epoch bound, at or after `at`');
    }
  }
  const deadlineAt = typeof rawDeadline === 'number' ? rawDeadline : input.at + STAGE_DEADLINE_MS;

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
      attempt,
      maxAttempts,
      widened,
      desperate,
      gate,
      round,
      iteration,
      maxIterations: MAX_ITERATIONS,
      verdict,
      deadlineAt,
    },
  };
}
