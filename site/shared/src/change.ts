/**
 * The writing engine's vocabulary (ARCHITECTURE.md §6A.2, §6A.7, §6A.8, §6B.3).
 *
 * One source for three consumers — the engine, the site and `bin/engine.mjs` — so a change, a
 * step, a seam or a verdict cannot mean two things in two processes; platform-neutral, no I/O.
 */

import { TOTAL_CHAPTERS } from './book.ts';
import { ATTEMPT_LINE, STOP_REASONS } from './stateWords.ts';
import type { Lane } from './types.ts';

/** The lane's own shapes live in `assignment.ts` (the file-size wall); the surface is here. */
export type { PremiseAssignment, Untrusted, WriterAssignment } from './assignment.ts';

export type ChangeKind = 'reader_edit' | 'accepted_comment' | 'continuity' | 'operator';

export type ChangeStatus =
  | 'pending' // in the lane, waiting its turn
  | 'processing' // holds the lane lease; exactly one at any time
  | 'done' // applied; cascade closed
  | 'stale' // being re-decided against a changed base (transient)
  | 'void' // no longer relevant; dropped with a public reason
  | 'escalated' // needs a decision the engine may not take
  | 'failed'; // repeated interruptions

/** The outcome vocabulary of §6A.7 — never a second word for the same fact. */
export type ChangeOutcome =
  | 'applied'
  | 'adapted'
  | 'dropped'
  | 'superseded'
  | 'budget'
  | 'edge'
  | 'oscillation'
  | 'origin'
  | 'delta'
  | 'finding'
  | 'ending'
  /** BOOK-76: the physics pass stopped the change — the failing claim never entered the book. */
  | 'science'
  /**
   * BOOK-61: Gate B refused the prose a wave wrote («не принято», the rule's fixed sentence).
   * The refusal is about the text, not about the reader's filing — that keeps its own state.
   */
  | 'rights'
  | 'gate_timeout'
  /**
   * BOOK-137: the filing touched the frozen frame and was accepted as **paperwork** — a
   * document, not an edit. The row is `done` with no step and no ripple, and the canon
   * sentence's letters are untouched.
   */
  | 'registered'
  | 'ripple' // BOOK-173: the closure stood — each consequence is its own normal pass; `wide` closes escalated
  | 'no-op'; // BOOK-173 §5: a rewrite that moved no byte — filed, paid for, never applied (BOOK-DOC-65)

export type SeamBoundary = number | 'front' | 'ending';

/** What a step reports: a boundary it believes it broke, with one clause why. */
export type SeamRef = { boundary: SeamBoundary; reason: string };

export type RelevanceGrade = 'fresh' | 'rebased' | 'partial' | 'void' | 'unknown';
export type AnchorState = 'intact' | 'moved' | 'edited' | 'gone';
export type AppliesVerdict = 'yes' | 'partial' | 'no' | 'untestable';

/** Deterministic, model-free evidence about a change whose base moved (§6A.7). */
export type Relevance = {
  grade: RelevanceGrade;
  revAtRecord: number;
  revNow: number;
  anchor: AnchorState;
  /** Does the intent still describe a defect in the current text? Judged by the writer. */
  applies: AppliesVerdict;
  /** Share of base block hashes still present in the current revision. */
  overlap: number;
  /** `revNow` came from a rewrite (most blocks replaced), not a patch. */
  chapterRewritten: boolean;
  evidence: string[];
  decidedBy: 'engine' | 'writer' | null;
  reason: string | null;
};

export type ChangeEvent = {
  id: string; // 'chg_01JB7Z…' (ULID)
  seq: number; // the FIFO ticket, immutable
  kind: ChangeKind;
  chapter: number; // 1..TOTAL_CHAPTERS — the point of change
  anchor: null | { blockIds: string[]; sentenceIds?: string[]; quote: string; prefix: string; suffix: string };
  intent: string; // ≤200 chars, what must become true
  proposedText: string | null;
  source: { commentId: string | null; sessionId: string | null };
  base: { rev: number; sha256: string; blockHashes: string[] };
  scopeHint: 'phrase' | 'chapter';
  status: ChangeStatus;
  relevance: Relevance | null;
  cascadeId: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
};

export type StepPass = 'draft' | 'change' | 'cascade' | 'front' | 'ending' | 'sweep';

export type StepOutcome =
  | 'rewritten'
  | 'holds'
  | 'published_with_finding'
  | 'evaluated'
  | 'escalated'
  | 'interrupted';

export type GateRole = 'editor' | 'consultant';

export type FindingSeverity = 'blocker' | 'major' | 'minor';

/**
 * The three ways a retroactive cause may be given (BOOK-DOC-4; `style/VOICE.md`
 * §Ретроспектива; `process/ROLE_PROMPTS.md` EDITOR #2). The world issues a document and the
 * document may lie, so a cause that appeared after the event is *paperwork*, never a silent
 * rewrite: **оформление** (the cause existed, now registered), **поправка** (the past
 * reformulated, not denied), **расхождение** (document and scene deliberately do not match —
 * the seam is тоска, not a bug).
 */
export const RETRO_MODES = ['оформление', 'поправка', 'расхождение'] as const;

export type RetroMode = (typeof RETRO_MODES)[number];

/** Untrusted input → one of the three modes, or `null`. An unknown word is dropped, not kept. */
export function normalizeRetroMode(raw: unknown): RetroMode | null {
  return typeof raw === 'string' && (RETRO_MODES as readonly string[]).includes(raw)
    ? (raw as RetroMode)
    : null;
}

/** BOOK-173 — how wide a filing is: a span inside a written chapter, or the chapter itself. */
export type ScopeHint = 'phrase' | 'chapter';

/** A closed set: an unknown value is `null`, never a guess — the width decides the write mode. */
export function normalizeScopeHint(raw: unknown): ScopeHint | null {
  return raw === 'phrase' || raw === 'chapter' ? raw : null;
}

export type Finding = {
  severity: FindingSeverity;
  /** 'глава 9, абзац 14' + a quote of ≤10 words. */
  location: string;
  defect: string;
  /** The minimal fix, described — never written. */
  fix: string;
  /**
   * How a retroactive cause is filed, when one is involved; `null` when the finding names
   * none. Optional on input, always normalised by the engine (`engine/gates.ts`).
   */
  mode?: RetroMode | null;
};

export type GateVerdict = {
  role: GateRole;
  verdict: 'HOLDS' | 'GAP';
  findings: Finding[];
  /** Writer revisions this gate forced (≤ GATE_CYCLES). */
  cycles: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
  at: string;
};

/** One step = one chapter edit plus its two gate verdicts (§6A.8). */
export type Step = {
  seq: number;
  wave: number;
  /** Direction of the ripple; null for draft/front/ending/sweep. */
  wing: 'downward' | 'upward' | null;
  chapter: number | 'front';
  pass: StepPass;
  /** n means boundary (n−1 | n); 'front' = front|1; 'ending' = TOTAL_CHAPTERS|ending. */
  boundary: SeamBoundary;
  outcome: StepOutcome;
  revBefore: number | null;
  revAfter: number | null;
  seamsIn: SeamRef[];
  seamsOut: SeamRef[];
  gates: { editor: GateVerdict | null; consultant: GateVerdict | null };
  blocksTouched: number;
  charsDelta: number;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costRub: number;
  hseqFrom: number | null;
  hseqTo: number | null;
  leaseId: string;
  session: string;
  at: string;
  ms: number;
  note: string | null;
};

export type CascadeStatus = 'open' | 'closed' | 'escalated' | 'aborted';

export type CascadeOutcome =
  | 'local'
  | 'consistent'
  | 'absorbed'
  | 'frontier'
  | 'escalated:budget'
  | 'escalated:oscillation'
  | 'escalated:origin'
  | 'escalated:finding'
  | 'escalated:delta'
  | 'escalated:ending'
  /** BOOK-76: a physics claim that failed the consultant never lands and never ripples on. */
  | 'escalated:science'
  /** BOOK-61: Gate B refused the new prose of a chapter; the step stops and waits for a decision. */
  | 'escalated:rights'
  | 'escalated:gate_timeout';

/**
 * BOOK-59 (BOOK-DOC-4 rule 3): a change makes **one wave** — it reaches the neighbouring
 * chapters forward and forward-back once, in both wings. A second wave does not happen by
 * itself: the bound stops the ripple and the public reason asks for the owner's decision
 * (§6A.6, R3/R3b). One source, because the config default, the `hello` limit and the public
 * rules page must promise one number.
 */
export const CASCADE_MAX_WAVE = 1;

/** The bounds frozen at cascade open (§6A.6, §6D.2). */
export type CascadeBudget = {
  maxWave: number;
  maxChapters: number;
  maxSteps: number;
  maxRewritesPerChapter: number;
  upwardLagWaves: number;
  maxWallMs: number;
  maxTokens: number;
  maxDeltaRatio: number;
};

export type Cascade = {
  id: string;
  changeId: string;
  status: CascadeStatus;
  outcome: CascadeOutcome | null;
  wave: number;
  depthForward: number;
  depthBackward: number;
  stepCount: number;
  tokens: number;
  budget: CascadeBudget;
  openedAt: string;
  closedAt: string | null;
};

/** BOOK-7 — the public line for an intervention aimed at a frozen frame slot (ch01's opening
 * sentence, ch42's finale). The frame is never a target, and the reader is told why.
 */
export const PREMISE_FROZEN_REASON = 'фраза этой главы неподвижна — замысел к ней не принимается';

export type Lease = {
  id: string;
  stepId: string;
  changeId: string | null;
  cascadeId: string | null;
  lane: Lane | null;
  chapter: number | 'front';
  kind: StepPass;
  session: string;
  expectedRev: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt: string | null;
  releaseReason: 'done' | 'holds' | 'expired' | 'escalated' | 'failed' | null;
};

/** Everything `trace` prints: the step, both verdicts, and the cascade rollup (§6A.8). */
export type StepTrace = {
  step: {
    stepId: string;
    cascadeId: string | null;
    seq: number;
    wave: number;
    lane: Lane | null;
    pass: StepPass;
    chapter: number | null;
    boundary: string;
    state: 'open' | 'closed';
    outcome: StepOutcome | null;
    revBefore: number | null;
    revAfter: number | null;
    cycle: number;
    landedAt: string | null;
    seamsIn: SeamRef[];
    seamsOut: SeamRef[];
    blocksTouched: number | null;
    charsDelta: number | null;
    model: string | null;
    tokensIn: number;
    tokensOut: number;
    session: string | null;
    leaseId: string | null;
    at: string;
    closedAt: string | null;
    note: string | null;
  };
  gates: Array<{
    role: GateRole;
    verdict: 'HOLDS' | 'GAP';
    findings: Finding[];
    cycles: number;
    model: string;
    tokensIn: number;
    tokensOut: number;
    at: string;
    late: boolean;
  }>;
  /**
   * BOOK-61 — Gate B's answer on this step, when the scan flagged and a session answered.
   * `null` when the gate was not required. It is kept apart from `gates` because its enum is
   * its own (`CLEAR`/`REFUSED`), and its rule is a rule id, not a finding.
   */
  rights: { verdict: 'CLEAR' | 'REFUSED'; rule: string | null; at: string } | null;
};

export type ChangeTrace = {
  change: {
    id: string;
    seq: number;
    kind: ChangeKind;
    chapter: number;
    intent: string;
    status: ChangeStatus;
    outcome: ChangeOutcome | null;
    reason: string | null;
    /** BOOK-7 — a chapter-level premise, not a rewrite: no lane claim and no ripple. */
    premise: boolean;
    relevance: Relevance | null;
    cascadeId: string | null;
    enqueuedAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    attempts: number;
    model: string | null;
    tokensIn: number;
    tokensOut: number;
  };
  cascade: null | {
    id: string;
    status: CascadeStatus;
    outcome: CascadeOutcome | null;
    wave: number;
    depthForward: number;
    depthBackward: number;
    steps: StepTrace[];
  };
};

// ── seam helpers ─────────────────────────────────────────────────────────────

/**
 * `n` means the boundary (n−1 | n). Boundary 1 and the sentinel `'front'` are the same
 * seam (the first sheet touches chapter 1), so `1` normalises to `'front'` — one seam,
 * one name, in every table and every report.
 */
export function normalizeSeamBoundary(value: unknown): SeamBoundary | null {
  if (value === 'front' || value === 'ending') return value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= TOTAL_CHAPTERS) {
    return value === 1 ? 'front' : value;
  }
  if (typeof value === 'string' && /^\d{1,2}$/u.test(value)) {
    const n = Number(value);
    if (n >= 1 && n <= TOTAL_CHAPTERS) return n === 1 ? 'front' : n;
  }
  return null;
}

/**
 * A step may only report a seam it could have touched: its own lower boundary, its own
 * upper boundary, or a sentinel that belongs to its edge of the book. Anything else is
 * a claim about a chapter the step did not read, and the engine refuses it (§6A.6 C2).
 */
export function seamTouchesChapter(boundary: SeamBoundary, chapter: number): boolean {
  if (boundary === 'front') return chapter === 1;
  if (boundary === 'ending') return chapter === TOTAL_CHAPTERS;
  return boundary === chapter || boundary === chapter + 1;
}

export function seamReason(raw: unknown, max = 200): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/gu, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── the reader's line for a failed attempt ──────────────────────────────────

/**
 * A failed attempt is **not** a filing's state: the lane tried the filing, the machine answered
 * off-shape or did not answer at all, and the filing is still waiting for its turn — so the
 * reader is told that in one sentence, and the engine's own word for the failure stays on the
 * server. BOOK-218: the sentence lives in `stateWords.ts`. The cap is not a queue place at all:
 * it has its own line, `READING_RESCHEDULED_LINE`, with the hour in it.
 */
export const READING_RESCHEDULED_LINE = 'чтение не состоялось — следующая попытка после 00:00 UTC';

/**
 * An internal code: upper-case runs joined by underscores (`PROVIDER_SHAPE`), or one of the two
 * lowercase handles the engine writes (`provider_shape`, `engine_timeout`). A lowercase snake
 * word is **not** a code by shape alone — «глава про west_wing» is a human sentence — so only
 * the known handles and the upper-case shape are refused. A sentence with capitals and no
 * underscore («Gate-Timeout», «глава 65 не готова») is a sentence.
 */
const INTERNAL_CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b(?:provider_shape|engine_timeout)\b/u;

/** Does this text carry an internal code? One predicate, so the sanitizer and the DTO agree. */
export function holdsInternalCode(raw: unknown): boolean {
  return typeof raw === 'string' && INTERNAL_CODE.test(raw);
}

/**
 * Any stored reason as the reader may see it: `null` when there is none, the sentence itself
 * when it is one, and the fixed failure line when the text carries an internal code. Never a
 * code, never an empty string — the UI branches on `attempt`, not on a missing sentence.
 */
export function readerReason(raw: unknown): string | null {
  const text = seamReason(raw);
  if (text.length === 0) return null;
  if (!holdsInternalCode(text)) return text;
  if (/provider_shape/iu.test(text)) return STOP_REASONS.shape;
  if (/ENGINE_TIMEOUT/iu.test(text)) return STOP_REASONS.engineDown;
  if (/timeout/iu.test(text)) return STOP_REASONS.modelTimeout;
  return ATTEMPT_LINE;
}

export function parseSeams(raw: unknown): SeamRef[] {
  if (!Array.isArray(raw)) return [];
  const out: SeamRef[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const boundary = normalizeSeamBoundary((item as { boundary?: unknown }).boundary);
    if (boundary === null) continue;
    out.push({ boundary, reason: seamReason((item as { reason?: unknown }).reason) });
  }
  return out;
}

/** BOOK-44 — one goal, not a paragraph: the bound of a public reason (`COMMENT_REASON_MAX_CHARS`). */
export const INTENT_MAX_CHARS = 200;
export const NOTE_MAX_CHARS = 200;
export const REASON_MAX_CHARS = 200;
