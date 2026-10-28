/**
 * What one pass may cost, before it spends anything (`docs/writer-lane.md` §6, BOOK-117).
 *
 * The engine's guard (`server/src/budget.ts`) is the second, independent check. This module is
 * the writer's own answer to "may this pass be opened at all?": the money is estimated first and
 * the pass is refused before spending, so a cap is never discovered after the money is gone.
 *
 * It prices **one** pass. The number of passes the contour may need is the queue's business and
 * is never multiplied here — one pass, one estimate, one decision.
 *
 * `CHARS_PER_TOKEN` is measured, not assumed: on 2026-10-27 the pinned model answered a
 * 1 599-character Russian draft with 686 completion tokens (2.33 characters per token). 2.3 is
 * the round number on the safe side — fewer characters per token means more tokens for the same
 * characters, so an estimate errs high and never promises a pass that costs more than it says.
 *
 * The prompt size is either the built prompt (`system.length + user.length`) or, while the pass
 * has not asked the engine for a job yet, the canon the writer reads plus a neighbours allowance
 * of two full chapters (`2 × CHAPTER_CHARS.max`), so an unbuilt estimate never under-shoots a
 * built one. The one input it cannot see is the pass's own intent and premise, which is why the
 * pass re-estimates from the real prompt before the first model call (`pass.ts`): an estimate
 * that turns out low stops the pass while the money is still unspent.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHAPTER_CHARS, type BudgetDto } from '@book/shared';

import { formatUsd } from '../budget.ts';

import { costUsd, type PipelinePricing } from './pipeline.ts';
import { writerRolePrompt } from './prompt.ts';
import type { WriteMode } from './mode.ts';

/** Measured (see the file header): 1 599 characters = 686 completion tokens on the pinned model. */
export const CHARS_PER_TOKEN = 2.3;

/**
 * BOOK-173 §4 — the patch's own arithmetic. A patch is small in *characters* only: measured
 * gate answers (1 027-char verdict → 10 161 out; 740 → 19 097) show the model bills thought,
 * not prose, so the patch price carries a reasoning allowance and is never the guard.
 */
export const PATCH_CHARS_PER_TOKEN = 2.6;
export const PATCH_NEW_CHARS_PER_EDIT = 300;
export const REASONING_ALLOWANCE = 8_000;

/** Two written neighbours at most, each `CHAPTER_CHARS.max`. */
const NEIGHBOUR_ALLOWANCE = 2 * CHAPTER_CHARS.max;

/** Each writing call aims above the floor: a chapter under `min` is thin, and a cut answer retries. */
const DRAFT_OVERSHOOT = 1.15;

/** One gate answer is a verdict with findings, never prose: 400 completion tokens is generous. */
const GATE_OUT_TOKENS = 400;
/** Editor and consultant, asked once per revision. */
const GATE_CALLS = 2;
/** The revision cycle a pass may need: one more draft and both gates again. */
const REVISION_WRITING_CALLS = 1;
const REVISION_GATE_CALLS = 2;

/** The canon files the writer's prompt quotes whole (`prompt.ts` `CANON_FILES`). */
const CANON_FILES = ['concept/CONCEPT.md', 'concept/CLIMAX.md', 'style/VOICE.md', 'outline/PLAN.md'] as const;

function readCanon(bookRoot: string, file: string): string {
  try {
    return readFileSync(join(bookRoot, file), 'utf8');
  } catch {
    // An unreadable canon is the prompt build's refusal, not a silently cheaper estimate.
    throw new Error(`оценка не собрана: нет файла ${file}`);
  }
}

/**
 * The canon as the writer reads it: the four files whole plus §1 of `process/ROLE_PROMPTS.md`
 * (the role fence `prompt.ts` extracts), because that is what the system message carries.
 */
export function canonChars(bookRoot: string): number {
  const role = writerRolePrompt(readCanon(bookRoot, 'process/ROLE_PROMPTS.md'));
  return CANON_FILES.reduce((sum, file) => sum + readCanon(bookRoot, file).length, role.length);
}

/** One pass's estimate: the money, the calls it assumes, and the assumptions it was built on. */
export type PassEstimate = {
  /** The **guard** — the rewrite figure, rounded up to the cent: the check errs on the safe side. */
  usd: number;
  /** Today's arithmetic, kept as the upper bound the caps are checked against. */
  usdRewrite: number;
  /** The patch figure, for the money line only: never a guard, never a cap decision. */
  usdPatch: number;
  /** The mode the writer will run in, when the assignment is already known. */
  mode: WriteMode | null;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  assumptions: Record<string, number>;
};

export type EstimateInput = {
  /** The pinned model's rates — `pipeline.pricing`, never a second price table. */
  pricing: PipelinePricing;
  /** The built prompt's characters: `system.length + user.length`. */
  promptChars?: number;
  /** The book, when the prompt is not built yet: the canon is read from here. */
  bookRoot?: string;
  /** Continuation calls the run may make (`WRITER_CONTINUE_MAX`). */
  continueMax?: number;
  /** BOOK-173: the chosen write mode, once the assignment is known. */
  mode?: WriteMode | null;
  /** Patch assumptions: edits per answer and characters per edit (`WRITER_PATCH_MAX_EDITS`). */
  patchEdits?: number;
  patchNewChars?: number;
  /** `WRITER_REASONING_ALLOWANCE`: completion tokens a patch call bills before its JSON. */
  reasoningAllowance?: number;
};

/**
 * One pass, priced before it runs: writing calls (a draft, its retry, its continuations, plus
 * the revision cycle) at a whole chapter's completion, and the gate calls at the prompt with the
 * landed chapter in it. Prompt tokens are counted per call, because every call carries a prompt.
 *
 * Two prices, one guard. `usdRewrite` is the upper bound and `usdPatch` the display figure; the
 * cap line reads `usd` (= `usdRewrite`), so an in-pass escalation to a rewrite can never cross
 * an unforeseen cap.
 */
export function estimatePassUsd(input: EstimateInput): PassEstimate {
  const continueMax = input.continueMax ?? 0;
  let promptChars = input.promptChars;
  if (promptChars === undefined) {
    if (input.bookRoot === undefined) throw new Error('оценка не собрана: нет ни промпта, ни книги');
    promptChars = canonChars(input.bookRoot) + NEIGHBOUR_ALLOWANCE;
  }

  const writingCalls = 1 + continueMax + REVISION_WRITING_CALLS;
  const gateCalls = GATE_CALLS + REVISION_GATE_CALLS;
  const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const gateTokens = Math.ceil((promptChars + CHAPTER_CHARS.target) / CHARS_PER_TOKEN);
  const outPerWriting = Math.ceil((CHAPTER_CHARS.min * DRAFT_OVERSHOOT) / CHARS_PER_TOKEN);

  const tokensIn = writingCalls * promptTokens + gateCalls * gateTokens;
  const tokensOut = writingCalls * outPerWriting + gateCalls * GATE_OUT_TOKENS;
  const raw = costUsd(input.pricing, { in: tokensIn, out: tokensOut, cachedIn: 0 });

  // The patch: one call, the chapter in the prompt, reasoning before the JSON.
  const patchEdits = input.patchEdits ?? 8;
  const patchNewChars = input.patchNewChars ?? PATCH_NEW_CHARS_PER_EDIT;
  const reasoningAllowance = input.reasoningAllowance ?? REASONING_ALLOWANCE;
  const patchTokensIn = Math.ceil(promptChars / PATCH_CHARS_PER_TOKEN);
  const patchTokensOut = Math.ceil((patchEdits * patchNewChars) / PATCH_CHARS_PER_TOKEN) + reasoningAllowance;
  const patchRaw = costUsd(input.pricing, { in: patchTokensIn, out: patchTokensOut, cachedIn: 0 });

  const usdRewrite = Math.ceil(raw * 100) / 100;
  return {
    usd: usdRewrite,
    usdRewrite,
    usdPatch: Math.round(patchRaw * 10_000) / 10_000,
    mode: input.mode ?? null,
    calls: writingCalls + gateCalls,
    tokensIn,
    tokensOut,
    assumptions: {
      charsPerToken: CHARS_PER_TOKEN,
      promptChars,
      continueMax,
      writingCalls,
      gateCalls,
      promptTokens,
      gateTokensIn: gateTokens,
      outPerWritingCall: outPerWriting,
      patchCharsPerToken: PATCH_CHARS_PER_TOKEN,
      patchEdits,
      patchNewChars,
      reasoningAllowance,
      patchTokensIn,
      patchTokensOut,
    },
  };
}

/** Money with four decimals and a comma: `$0,0412` — the estimate line's own number. */
function usd4(value: number): string {
  return value.toFixed(4).replace('.', ',');
}

/** The pause sentence (§6), in the engine's own words: a day's cap lifts at 00:00 UTC. */
function pauseLine(capUsd: number): string {
  return `пауза · дневной потолок ${formatUsd(capUsd)} $ · возобновится в 00:00 UTC`;
}

/** The stop sentence (§6): the book's cap ends the book, not a day of it. */
function stopLine(capUsd: number): string {
  return `остановлено · потолок книги ${formatUsd(capUsd)} $`;
}

/**
 * The estimate against both caps (`pass.ts` §6 before BOOK-173 kept this there). The book's cap
 * wins, as it does in `budget.ts`: a pass that would spend the book's last dollars is stopped,
 * not paused. The engine's own line is used when it already stated one, so a pause reads the
 * same on every surface.
 */
export function capLine(budget: BudgetDto, usd: number): string | null {
  if (budget.book.spentUsd + usd > budget.book.capUsd) {
    return budget.state === 'stop' ? budget.line : stopLine(budget.book.capUsd);
  }
  if (budget.day.spentUsd + usd > budget.day.capUsd) {
    return budget.state === 'pause' ? budget.line : pauseLine(budget.day.capUsd);
  }
  return null;
}

/**
 * `[writer] оценка прохода $0,0412 · перепись $0,0412 / правка $0,0093 · режим: … (день …, книга …)`
 * — one line. The guard is always the rewrite figure; the patch figure is display only.
 */
export function estimateLine(estimate: PassEstimate, budget: BudgetDto): string {
  const day = `${formatUsd(budget.day.spentUsd)} / ${formatUsd(budget.day.capUsd)}`;
  const book = `${formatUsd(budget.book.spentUsd)} / ${formatUsd(budget.book.capUsd)}`;
  const mode = estimate.mode === null ? 'режим: ещё не выбран' : `режим: ${estimate.mode === 'patch' ? 'правка' : 'перепись'}`;
  return `[writer] оценка прохода $${usd4(estimate.usd)} · перепись $${usd4(estimate.usdRewrite)} / правка $${usd4(estimate.usdPatch)} · ${mode} (день ${day}, книга ${book})`;
}
