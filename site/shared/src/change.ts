/**
 * The writing engine's vocabulary (ARCHITECTURE.md §6A.2, §6A.7, §6A.8, §6B.3).
 *
 * One source for three consumers — the engine, the site and `bin/engine.mjs` — so a
 * change, a step, a seam and a verdict cannot mean two things in two processes.
 * Platform-neutral: types and pure helpers only, no I/O.
 */

import type { InterventionKind } from './intervention.ts';
import type { Lane } from './types.ts';

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
  | 'gate_timeout';

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
  chapter: number; // 1..67 — the point of change
  anchor: null | { blockIds: string[]; quote: string; prefix: string; suffix: string };
  intent: string; // ≤600 chars, what must become true
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
  /** n means boundary (n−1 | n); 'front' = front|1; 'ending' = 67|ending. */
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

/**
 * BOOK-7 — a chapter's premise: a reader's intervention on a slot that has no text yet.
 *
 * It is not prose and not a rewrite of a paragraph: it is one goal for the chapter's first
 * edition. `intent` is the change's validated public sentence (no author label, no comment
 * body); `kind` is the world-fact the reader brought, when they declared one.
 */
export type PremiseAssignment = {
  intent: string;
  kind: InterventionKind | null;
};

/**
 * BOOK-7 — the public line for an intervention aimed at a frozen frame slot (ch01's opening
 * sentence, ch67's finale). The frame is never a target, and the reader is told why.
 */
export const PREMISE_FROZEN_REASON = 'фраза этой главы неподвижна — замысел к ней не принимается';

/** What a writer session receives (§6B.2): structure only — no names, no titles, no plot. */
export type WriterAssignment = {
  stepId: string;
  leaseId: string;
  pass: StepPass;
  chapter: number | 'front';
  neighbours: { before: number | null; after: number | null };
  expectation: null | { chars: { min: number; max: number } };
  intent: string | null;
  /** BOOK-16 — which of the four world-facts the intervention brought; null when unknown. */
  interventionKind: InterventionKind | null;
  /**
   * BOOK-7 — set on the first pass of a chapter that carries a reader's premise: the writer
   * takes it or refuses it with one plain reason, never silently ignores it. Null otherwise.
   */
  premise: PremiseAssignment | null;
  seamsIn: SeamRef[];
  cycle: number;
  findings: Finding[] | null;
  relevance: Relevance | null;
  /** The file this step must revise is already landed (a resumed step or a gate phase). */
  landed: boolean;
  verdicts: { editor: boolean; consultant: boolean };
  budget: null | {
    wave: number;
    maxWave: number;
    steps: number;
    maxSteps: number;
    deadline: string;
  };
  changeId: string | null;
  cascadeId: string | null;
};

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
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 67) {
    return value === 1 ? 'front' : value;
  }
  if (typeof value === 'string' && /^\d{1,2}$/u.test(value)) {
    const n = Number(value);
    if (n >= 1 && n <= 67) return n === 1 ? 'front' : n;
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
  if (boundary === 'ending') return chapter === 67;
  return boundary === chapter || boundary === chapter + 1;
}

export function seamReason(raw: unknown, max = 200): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/gu, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

export const INTENT_MAX_CHARS = 600;
export const NOTE_MAX_CHARS = 200;
export const REASON_MAX_CHARS = 200;
