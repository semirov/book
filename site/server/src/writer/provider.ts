/**
 * One OpenAI-compatible completion call (BOOK-117, `docs/writer-lane.md` §5–6).
 *
 * The exchange is deliberately plain: `POST` to the pinned endpoint with the pinned wire model,
 * the messages, `max_tokens`, `stream: false` — **no sampling overrides**. A writer pass that
 * let the provider sample differently from the pin would make the money line and the prose
 * irreproducible, and the pin is the only place a model may be named.
 *
 * The shape is the provider's, the retry is ours: transport failures, `429` and `5xx` are
 * retried **once** after a short fixed backoff; every other `4xx` is final — a bad key or a bad
 * request does not become a second request. Error messages carry a code and a status and never
 * the key or the response body.
 *
 * The call reports the model's own `finish_reason` and does not judge it: `length` means the
 * answer was cut at `max_tokens` — a reasoning model spends completion tokens before it writes
 * anything, so a tight cap truncates a chapter silently. That is the model's answer, not a
 * transport fault, so it is not retried here; the gate (`validate.ts`) refuses it.
 *
 * The transport is injected so the tests need no network, and this file lives outside
 * `engine/**`, which is where the architecture rule forbids `fetch` (ADR-012).
 */

import type { PipelineUsage } from './pipeline.ts';

export type WriterMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** `fetch` (or a test double): the only seam the provider has to the outside. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ProviderRequest = {
  endpoint: string;
  apiKey: string;
  apiModel: string;
  messages: WriterMessage[];
  maxTokens: number;
  timeoutMs: number;
};

export type ProviderResult = {
  text: string;
  responseModel: string;
  usage: PipelineUsage;
  latencyMs: number;
  attempts: number;
  /**
   * `choices[0].finish_reason` verbatim (`stop`, `length`, …), `null` when the provider did not
   * report one. `length` is the token cap: the text is a truncated answer, never a chapter.
   */
  finishReason: string | null;
};

export type ProviderDeps = {
  transport?: FetchLike;
  /** Injected so a retry does not sleep in a test. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  backoffMs?: number;
};

export type ProviderCode =
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNREACHABLE'
  | `PROVIDER_HTTP_${number}`
  | 'PROVIDER_SHAPE';

export class ProviderError extends Error {
  readonly code: ProviderCode;
  readonly attempts: number;

  constructor(code: ProviderCode, attempts: number) {
    // The message is the code and nothing else: no key, no response body, no URL.
    super(`provider: ${code}`);
    this.name = 'ProviderError';
    this.code = code;
    this.attempts = attempts;
  }
}

type Attempt =
  | { ok: true; text: string; responseModel: string; usage: PipelineUsage; finishReason: string | null }
  | { ok: false; code: ProviderCode; retryable: boolean };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * `finish_reason`, read as the provider writes it: a non-empty string is the value, anything
 * else (absent, `null`, an empty string, a number) is "the provider said nothing".
 */
function finishReasonOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  return reason.length > 0 ? reason : null;
}

/**
 * The provider's answer, read defensively. A missing `choices[0].message.content` or an absent
 * usage block is a shape failure, not a zero-cost pass: a chapter whose tokens are unknown
 * cannot be charged, and a charge of zero would be a lie in the transcript.
 */
function readAnswer(value: unknown, apiModel: string): Attempt | null {
  const body = record(value);
  if (body === null) return null;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = record(choices[0]);
  const message = record(choice?.message);
  const text = message?.content;
  if (typeof text !== 'string' || text.trim().length === 0) return null;

  const usage = record(body.usage);
  const inTokens = tokenCount(usage?.prompt_tokens);
  const outTokens = tokenCount(usage?.completion_tokens);
  if (inTokens === null || outTokens === null) return null;
  const details = record(usage?.prompt_tokens_details);
  const cached = tokenCount(usage?.prompt_cache_hit_tokens) ?? tokenCount(details?.cached_tokens) ?? 0;
  const cachedIn = Math.min(cached, inTokens);

  const reportedModel = typeof body.model === 'string' ? body.model.trim() : '';
  return {
    ok: true,
    text,
    responseModel: reportedModel.length > 0 ? reportedModel : apiModel,
    usage: { in: inTokens, out: outTokens, cachedIn },
    finishReason: finishReasonOf(choice?.finish_reason),
  };
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function attemptOnce(request: ProviderRequest, deps: Required<ProviderDeps>): Promise<Attempt> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);

  try {
    let response: Response;
    try {
      response = await deps.transport(request.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${request.apiKey}`,
        },
        body: JSON.stringify({
          model: request.apiModel,
          messages: request.messages,
          max_tokens: request.maxTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch {
      // A transport failure and an aborted call are the same fact to the caller, and both are
      // worth one more attempt; only the timeout has its own code.
      return { ok: false, code: timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE', retryable: true };
    }

    if (!response.ok) {
      // Status only. The body is provider text at best and a leaked credential at worst, and
      // nothing here needs it.
      return {
        ok: false,
        code: `PROVIDER_HTTP_${response.status}`,
        retryable: retryableStatus(response.status),
      };
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { ok: false, code: 'PROVIDER_SHAPE', retryable: false };
    }
    const answer = readAnswer(parsed, request.apiModel);
    if (answer === null) return { ok: false, code: 'PROVIDER_SHAPE', retryable: false };
    return answer;
  } finally {
    clearTimeout(timer);
  }
}

/** One call, at most two attempts. The key travels in the header, never in the URL. */
export async function callProvider(request: ProviderRequest, deps: ProviderDeps = {}): Promise<ProviderResult> {
  const transport = deps.transport ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const now = deps.now ?? (() => Date.now());
  const settings: Required<ProviderDeps> = { transport, sleep, now, backoffMs: deps.backoffMs ?? 500 };

  const startedAt = now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const outcome = await attemptOnce(request, settings);
    if (outcome.ok) {
      return {
        text: outcome.text,
        responseModel: outcome.responseModel,
        usage: outcome.usage,
        latencyMs: now() - startedAt,
        attempts,
        finishReason: outcome.finishReason,
      };
    }
    if (!outcome.retryable || attempts >= 2) {
      throw new ProviderError(outcome.code, attempts);
    }
    await settings.sleep(settings.backoffMs);
  }
}
