/**
 * One gate's answer, and the single retry a refused one gets (BOOK-145).
 *
 * `parseGateAnswer` already says which check failed (`GATE_UNPARSED` and the reason inside it);
 * what was missing is that the reason reaches nobody — the lane parked on «ответ модели не прошёл
 * проверку» and the diagnosis was lost. Here every refusal is one structured log line, and the
 * retry is asked with the reason appended, so a formatting mistake does not cost the pass.
 */

import type { BuiltGatePrompt, GateParse, GateRoleName } from './gates.ts';
import { parseGateAnswer } from './gates.ts';
import type { ProviderResult, WriterMessage } from './provider.ts';
import { PassRefusal } from './reasons.ts';

/** A log line is one line: the reason is bounded here once. */
const REASON_CHARS = 200;

export type GateAnswerInput = {
  role: GateRoleName;
  /** The prompt as the gate needs it, with the previous refusal when there is one. */
  build: (refusal: string | null) => BuiltGatePrompt;
  ask: (messages: WriterMessage[]) => Promise<ProviderResult>;
  log: (line: string) => void;
  /** Why the pass is asking again; `null` on the first ask. */
  refusal?: string | null;
};

/** The parsed answer, plus what both attempts spent (the verdict row charges all of it). */
export type GateAnswer = { parsed: Extract<GateParse, { ok: true }>; usage: { in: number; out: number } };

/** One gate: one ask, and one retry that carries the reason the first answer failed. */
export async function askGateAnswer(input: GateAnswerInput): Promise<GateAnswer> {
  const first = await askOnce(input, input.refusal ?? null);
  if (first.parsed.ok) return { parsed: first.parsed, usage: first.usage };
  input.log(
    `[writer] ответ гейта ${input.role} отклонён ${first.parsed.code}: ${first.parsed.reason.slice(0, REASON_CHARS)} — повтор с причиной`,
  );
  const second = await askOnce(input, `${first.parsed.code}: ${first.parsed.reason}`);
  const usage = {
    in: first.usage.in + second.usage.in,
    out: first.usage.out + second.usage.out,
  };
  if (second.parsed.ok) return { parsed: second.parsed, usage };
  input.log(
    `[writer] ответ гейта ${input.role} отклонён снова ${second.parsed.code}: ${second.parsed.reason.slice(0, REASON_CHARS)} — проход остановлен`,
  );
  throw new PassRefusal(`${second.parsed.code}: ${second.parsed.reason}`.slice(0, 300), second.parsed.code);
}

async function askOnce(
  input: GateAnswerInput,
  refusal: string | null,
): Promise<{ parsed: GateParse; usage: { in: number; out: number } }> {
  const prompt = input.build(refusal);
  const answer = await input.ask([
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ]);
  return { parsed: parseGateAnswer(answer.text, input.role), usage: { in: answer.usage.in, out: answer.usage.out } };
}
