/**
 * One triage pulse (BOOK-206, ADR-045 §3): the writer is the only process that holds a key, so
 * the reading happens here — after the engine claimed a filing out of its own ledger, and before
 * the site places the answer.
 *
 * The pulse is deliberately small and boring:
 *
 *   1. engine → `POST /internal/triage/next`: one due filing, or nothing, or `budget`;
 *   2. writer → provider: the auditor's brief, the filing, the world — one `callProvider` with
 *      the pinned endpoint, the pinned wire model, the writer's timeout and `TRIAGE_MAX_TOKENS`;
 *   3. writer → engine: `verdict` with the answer and the money it cost, or `fail` with a code.
 *
 * It never touches `writer_state`: a reader's filing must not spend one of the day's prose
 * passes. It never prints a prompt, a filing or an answer — a code and a count, and nothing else.
 * Money is bounded twice: the writer's own estimate before any call (AC5) and the engine's guard
 * inside the claim.
 */

import { TRIAGE_MAX_TRIES } from '../comments/attempts.ts';
import type { PipelineUsage } from './pipeline.ts';
import { costUsd } from './pipeline.ts';
import { estimateTriageUsd } from './estimate.ts';
import { EngineRefusalError, isEngineTransportCode, type EngineClient, type TriageAskView, type TriageVerdictInput } from './client.ts';
import type { WriterConfig } from './config.ts';
import { ProviderError, type ProviderRequest, type ProviderResult } from './provider.ts';
import { buildTriagePrompt } from './triagePrompt.ts';

/** Two readings a tick, then the lane's own cadence: a burst must not become a busy loop. */
export const TRIAGE_PER_TICK = 2;

/**
 * The largest prompt one triage call is estimated at: the auditor's brief, the world (6 000
 * characters, the engine's own bound) and a filing (40 KB at the door). The estimate is a bound,
 * not the real prompt: it decides whether a call may be bought at all, before anything is read.
 */
export const TRIAGE_PROMPT_CHARS_MAX = 48_000;

export type TriagePulse = {
  /** Calls made, and answers the engine stored. */
  triaged: number;
  /** Calls that ended in `fail` (a refusal is a stored answer; this is a broken call). */
  failed: number;
  /** No money: the engine handed out nothing and no row was touched. */
  budget: boolean;
};

export type TriageDeps = {
  config: WriterConfig;
  bookRoot: string;
  engine: EngineClient;
  provider: (request: ProviderRequest) => Promise<ProviderResult>;
  now?: () => number;
  log?: (line: string) => void;
};

/** The JSON body of an answer; anything that is not one object is a shape failure, not a guess. */
function parseAnswer(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The one code a broken call reports: a provider's own, a shape failure, or a conflict. */
function failureCodeOf(error: unknown): string {
  if (error instanceof ProviderError) return error.code;
  if (error instanceof EngineRefusalError) return error.code;
  return 'PROVIDER_SHAPE';
}

/**
 * The day's money, before any call: the estimate of one triage call against the engine's own
 * snapshot. The guard **inside the claim** is the authority; this is only the writer's own early
 * refusal, so an engine that cannot answer skips the pre-check (`return true`) and the claim
 * then decides — a failed read is never treated as an approval, and never as a stop.
 */
async function budgetAllows(deps: TriageDeps, log: (line: string) => void): Promise<boolean> {
  const estimate = estimateTriageUsd({
    pricing: deps.config.pipeline.pricing,
    promptChars: TRIAGE_PROMPT_CHARS_MAX,
    maxOutput: deps.config.triageTokens,
  });
  try {
    const view = await deps.engine.state();
    if (view.budget === null) return true;
    if (view.budget.state === 'stop' || view.budget.state === 'pause') {
      log(`[writer] триаж ждёт денег: ${view.budget.line}`);
      return false;
    }
    if (view.budget.day.spentUsd + estimate.usd > view.budget.day.capUsd) {
      log('[writer] триаж ждёт денег: дневной предел близко');
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * One call's money from the book's one rate table. BOOK-219: when the provider reported no usage
 * the writer read the counts off the text, and `estimated` travels with them — the engine books
 * the row as `pipeline-estimated` instead of letting an estimate pass for a measurement.
 */
function spendOf(deps: TriageDeps, usage: PipelineUsage): TriageVerdictInput['spend'] {
  return {
    model: deps.config.apiModel,
    tokensIn: Math.max(0, Math.trunc(usage.in)),
    tokensOut: Math.max(0, Math.trunc(usage.out)),
    usd: costUsd(deps.config.pipeline.pricing, usage),
    ...(usage.estimated === true ? { estimated: true } : {}),
  };
}

async function readOne(deps: TriageDeps, ask: TriageAskView): Promise<boolean> {
  const log = deps.log ?? (() => {});
  const prompt = buildTriagePrompt({ bookRoot: deps.bookRoot, ask });
  /** Report a broken call. `spend` is present only when the provider answered with usage. */
  const fail = async (code: string, detail?: string, spend?: PipelineUsage): Promise<boolean> => {
    log(`[writer] триаж ${ask.commentId} #${String(ask.attempt)}: ${code}`);
    try {
      const result = await deps.engine.failTriage({
        commentId: ask.commentId,
        n: ask.attempt,
        code,
        ...(detail === undefined ? {} : { detail }),
        // AC5: a call that failed the post-check or the recorded-verdict guard still cost money.
        ...(spend === undefined ? {} : { spend: spendOf(deps, spend) }),
      });
      // §10.8: five bought calls are the ceiling; the sixth is deterministic (no model call) and
      // the site settles it. This line is the operator's copy, never «видимый дефект».
      if (result.cap) {
        log(
          result.desperate === true
            ? `[writer] триаж ${ask.commentId}: ${String(TRIAGE_MAX_TRIES)} попытки не дали ответа — шестая, последняя, без звонка модели`
            : `[writer] триаж ${ask.commentId}: ${String(TRIAGE_MAX_TRIES)} попытки — заявка отклонена`,
        );
      }
    } catch (error) {
      log(`[writer] триаж: отказ не записан (${failureCodeOf(error)})`);
    }
    return false;
  };

  let result: ProviderResult;
  try {
    result = await deps.provider({
      endpoint: deps.config.endpoint,
      apiKey: deps.config.apiKey,
      apiModel: deps.config.apiModel,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      maxTokens: deps.config.triageTokens,
      timeoutMs: deps.config.timeoutMs,
    });
  } catch (error) {
    return fail(failureCodeOf(error));
  }

  const answer = parseAnswer(result.text);
  if (answer === null) return fail('PROVIDER_SHAPE', undefined, result.usage);
  // A recording filing is never re-judged: the stored verdict travels back with the answer, and
  // a model that changes it is a failed call, not a second judgement.
  if (ask.recordedVerdict !== null && answer.verdict !== ask.recordedVerdict) {
    return fail('VERDICT_CONFLICT', 'the recorded verdict was changed', result.usage);
  }

  const usage: PipelineUsage = result.usage;
  const spend = spendOf(deps, usage);
  try {
    const stored = await deps.engine.verdictTriage({
      commentId: ask.commentId,
      n: ask.attempt,
      verdict: answer,
      spend,
    });
    log(
      stored.stored
        ? `[writer] триаж ${ask.commentId} #${String(ask.attempt)}: ${String(answer.verdict)} записан`
        : `[writer] триаж ${ask.commentId} #${String(ask.attempt)}: уже был ответ`,
    );
    return stored.stored;
  } catch (error) {
    // A transport failure may have stored the answer already: only a refusal is a failed call.
    if (error instanceof EngineRefusalError && !isEngineTransportCode(error.code)) {
      // The answer reached the engine and was refused (a malformed reading, a locked verdict):
      // the call is still priced, so its money goes to the ledger with the failure.
      return fail(error.code, error.message, result.usage);
    }
    log(`[writer] триаж ${ask.commentId}: движок не ответил (${failureCodeOf(error)})`);
    return false;
  }
}

/**
 * One pulse: up to `TRIAGE_PER_TICK` readings, then back to the loop. An empty queue costs one
 * loopback request and no money.
 */
export async function runTriage(deps: TriageDeps): Promise<TriagePulse> {
  const log = deps.log ?? (() => {});
  const pulse: TriagePulse = { triaged: 0, failed: 0, budget: false };
  if (!(await budgetAllows(deps, log))) {
    pulse.budget = true;
    return pulse;
  }
  for (let index = 0; index < TRIAGE_PER_TICK; index += 1) {
    let next;
    try {
      next = await deps.engine.nextTriage(deps.config.session);
    } catch (error) {
      log(`[writer] триаж не спрошен: ${failureCodeOf(error)}`);
      return pulse;
    }
    if (next.reason === 'budget') {
      pulse.budget = true;
      return pulse;
    }
    if (next.assignment === null) return pulse;
    const stored = await readOne(deps, next.assignment);
    if (stored) pulse.triaged += 1;
    else pulse.failed += 1;
  }
  return pulse;
}
