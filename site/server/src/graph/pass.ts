/**
 * One question to the model, with the one repair a schema failure earns (BOOK-DOC-77 §2–§3).
 *
 * Both passes ask the same way: the same transport seam, the same single repair, the same account
 * of every call. What differs is only the question. Keeping the loop here means a recall cannot
 * quietly repair twice, and a test double can see the exact text and the exact system message the
 * extractor sent.
 *
 * `response` is the **last** answer the model gave: a refusal stores the text that failed, which
 * is what an operator needs, and a transport failure stores whatever arrived before it. Nothing
 * here decides whether the answer is good — `validate.ts` does.
 *
 * **A cut answer is not a malformed one.** `finish_reason: length` means the provider stopped at
 * the cap: the text ends mid-object, the schema refuses it, and the repair would be cut at the
 * same cap for the same reason — a second payment for one truncation. So a truncated answer is its
 * own refusal, `MODEL_TRUNCATED`, and it earns no repair; only a `stop` that failed the schema does.
 */

import { ModelError, type ModelUsage } from './model.ts';
import { parseAnswer, SCHEMA_INVALID, type GraphAnswer } from './schema.ts';

export type ProviderRequest = { system: string; user: string; maxTokens?: number };

/** What one call cost and what it said. `usage` is the provider's own account, never invented. */
export type ProviderAnswer = {
  text: string;
  model: string;
  usage: ModelUsage;
  latencyMs: number;
  finishReason: string | null;
};

/** The injected transport: `complete()` in production, a fake in every test. */
export type Provider = (request: ProviderRequest) => Promise<ProviderAnswer>;

/** The one line a schema repair adds; the shape itself stays in `schema.ts`. */
export const REPAIR_LINE = 'Return only valid JSON in the given shape; no prose.';

/** `MODEL_TRUNCATED`: the answer was cut at the token cap, so it is not a schema failure. */
export const MODEL_TRUNCATED = 'MODEL_TRUNCATED';

export type AskOutcome =
  | { ok: true; answer: GraphAnswer; usage: ModelUsage; response: string }
  | { ok: false; code: string; usage: ModelUsage; response: string; transport: boolean };

/**
 * Ask one question, repair once on a schema failure, and account for every call. A transport
 * failure is final: re-asking a timeout that already cost a request would pay twice for the same
 * silence, and the caller records the run as `error`. A truncated answer is final for the same
 * reason at the other end of the exchange — the cap that cut it will cut the repair too.
 */
export async function askPass(input: {
  provider: Provider;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<AskOutcome> {
  const usage: ModelUsage = { in: 0, out: 0, cached: 0 };
  let response = '';

  const call = async (userText: string): Promise<{ text: string; finishReason: string | null }> => {
    const result = await input.provider({
      system: input.system,
      user: userText,
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    });
    usage.in += result.usage.in;
    usage.out += result.usage.out;
    usage.cached += result.usage.cached;
    response = result.text;
    return { text: result.text, finishReason: result.finishReason };
  };
  const truncated = (): AskOutcome => ({ ok: false, code: MODEL_TRUNCATED, usage, response, transport: false });

  try {
    const first = await call(input.user);
    if (first.finishReason === 'length') return truncated();
    const parsedFirst = parseAnswer(first.text);
    if (parsedFirst.ok) return { ok: true, answer: parsedFirst.answer, usage, response };
    // One repair: the same question with one line added. Anything more would be a loop that
    // pays for the same failure.
    const second = await call(`${input.user}\n\n${REPAIR_LINE}`);
    if (second.finishReason === 'length') return truncated();
    const parsedSecond = parseAnswer(second.text);
    if (parsedSecond.ok) return { ok: true, answer: parsedSecond.answer, usage, response };
    return { ok: false, code: SCHEMA_INVALID, usage, response, transport: false };
  } catch (error) {
    const code = error instanceof ModelError ? error.code : 'MODEL_ERROR';
    return { ok: false, code, usage, response, transport: true };
  }
}
