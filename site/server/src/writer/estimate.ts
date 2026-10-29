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

import { CHAPTER_CHARS } from '@book/shared';

import { costUsd, type PipelinePricing } from './pipeline.ts';
import { writerRolePrompt } from './prompt.ts';

/** Measured (see the file header): 1 599 characters = 686 completion tokens on the pinned model. */
export const CHARS_PER_TOKEN = 2.3;

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
  /** Rounded **up** to the cent: the check errs on the safe side. */
  usd: number;
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
};

/**
 * BOOK-206: one triage call, priced before it is made. The same `CHARS_PER_TOKEN` and the same
 * rate table as a pass — a triage call is a `pass_spend` row like any other, so it is estimated
 * the same way. `maxOutput` is the call's own cap (`TRIAGE_MAX_TOKENS`), not a guess.
 */
export function estimateTriageUsd(input: {
  pricing: PipelinePricing;
  promptChars: number;
  maxOutput: number;
}): { usd: number; tokensIn: number; tokensOut: number } {
  const tokensIn = Math.ceil(input.promptChars / CHARS_PER_TOKEN);
  const tokensOut = Math.max(0, Math.trunc(input.maxOutput));
  const usd = costUsd(input.pricing, { in: tokensIn, out: tokensOut, cachedIn: 0 });
  return { usd, tokensIn, tokensOut };
}

/**
 * One pass, priced before it runs: writing calls (a draft, its retry, its continuations, plus
 * the revision cycle) at a whole chapter's completion, and the gate calls at the prompt with the
 * landed chapter in it. Prompt tokens are counted per call, because every call carries a prompt.
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

  return {
    usd: Math.ceil(raw * 100) / 100,
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
    },
  };
}
