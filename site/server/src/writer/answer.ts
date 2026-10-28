/**
 * One pass's answers, with the one retry a refused answer gets (BOOK-145).
 *
 * The check already names itself (`ANSWER_*`, `TEXT_*`, `MARKDOWN`, …); what was missing is that
 * nobody read it. Every refusal is one structured line in the log — code and reason — and the
 * retry carries the reason back to the model, so the second answer can be the one that passes
 * instead of the pass parking on a diagnosis nobody can act on.
 */

import { CHAPTER_CHARS } from '@book/shared';

import { charsOf, finalize, mergeContinuation, type Answer, type Lane } from './passLane.ts';
import { layeredMessages } from './prompt.ts';
import { buildContinuePrompt, type BuiltPrompt } from './prompt.ts';
import type { ProviderResult, WriterMessage } from './provider.ts';

/** What of a rejected answer a retry is shown: enough to fix, not a second chapter. */
const REJECTED_HEAD_CHARS = 1_500;
/** A refusal line is a log line: the reason is bounded here once. */
const REASON_CHARS = 200;

/** The model's first answer, with one retry that carries the reason it was refused. */
export async function draftAnswer(lane: Lane, built: BuiltPrompt, log: (line: string) => void): Promise<Answer> {
  // BOOK-174/ADR-043: [system = P0][user = P1 + P2] — the cacheable prefix is the first bytes.
  const request: WriterMessage[] = layeredMessages(built);
  const first = await lane.ask('draft', request, 'draft');
  const checked = lane.check(first.text, first.finishReason);
  if (checked.ok) return checked;
  log(`[writer] ответ отклонён ${checked.code}: ${checked.reason.slice(0, REASON_CHARS)} — повтор с причиной`);
  const second = await lane.ask('repair', [
    ...request,
    { role: 'assistant', content: first.text.slice(0, REJECTED_HEAD_CHARS) },
    {
      role: 'user',
      content: `## Отказ\n\nПредыдущий ответ не прошёл проверку: ${checked.reason}.\nВерни главу заново, целиком: первая строка — название, вторая — пустая, дальше проза. Причину отказа учти.`,
    },
  ]);
  const again = lane.check(second.text, second.finishReason);
  if (!again.ok) log(`[writer] ответ отклонён снова ${again.code}: ${again.reason.slice(0, REASON_CHARS)} — проход остановлен`);
  return again;
}

/** Continuations keep writing until the chapter reaches the thin line or the budget stops it. */
export async function continueDraft(
  lane: Lane,
  input: { bookRoot: string; chapter: number; text: string; max: number },
  log: (line: string) => void,
): Promise<string> {
  let text = input.text;
  let continuations = 0;
  while (continuations < input.max && charsOf(input.chapter, text) < CHAPTER_CHARS.min) {
    const continuation = buildContinuePrompt({ bookRoot: input.bookRoot, written: text });
    const more = await lane.ask(
      'continue',
      [
        { role: 'system', content: continuation.system },
        { role: 'user', content: continuation.user },
      ],
      'continue',
    );
    const next = lane.check(mergeContinuation(input.chapter, text, more.text), more.finishReason);
    // A continuation that breaks a rule is dropped: the chapter that validates already stands.
    if (!next.ok) {
      log(`[writer] продолжение отклонено ${next.code}: ${next.reason.slice(0, REASON_CHARS)} — глава остаётся как есть`);
      break;
    }
    if (next.text.length <= text.length) break;
    text = finalize(next.text);
    continuations += 1;
  }
  return text;
}

/** The findings that reach a revision prompt: the prompt is not a transcript. */
const MAX_FINDINGS_IN_PROMPT = 20;
const MAX_FINDINGS_CHARS = 4_000;

/** One revision of a landed text, with the findings as data; `null` when both answers fail. */
export async function reviseAnswer(input: {
  rebuilt: BuiltPrompt;
  findings: Array<{ severity: string; location: string; defect: string; fix: string }>;
  ask: (messages: WriterMessage[]) => Promise<ProviderResult>;
  check: (value: string, finishReason?: string | null) => Answer;
  log: (line: string) => void;
}): Promise<string | null> {
  const rows = input.findings
    .slice(0, MAX_FINDINGS_IN_PROMPT)
    .map((finding) => `${finding.severity} · ${finding.location} · ${finding.defect} · ${finding.fix}`)
    .join('\n')
    .slice(0, MAX_FINDINGS_CHARS);
  const request: WriterMessage[] = [
    { role: 'system', content: input.rebuilt.system },
    {
      role: 'user',
      content: `${input.rebuilt.user}\n\n## Замечания гейтов\n\nВерни главу заново с учётом замечаний; готового текста не цитируй.\n\n${rows}`,
    },
  ];
  const first = await input.ask(request);
  let validated = input.check(first.text, first.finishReason);
  if (!validated.ok) {
    const reason = validated.reason;
    input.log(`[writer] правка отклонена ${validated.code}: ${reason.slice(0, REASON_CHARS)} — повтор с причиной`);
    const second = await input.ask([
      ...request,
      { role: 'assistant', content: first.text.slice(0, REJECTED_HEAD_CHARS) },
      { role: 'user', content: `## Отказ\n\nПредыдущий ответ не прошёл проверку: ${reason}.\nВерни главу заново, целиком.` },
    ]);
    validated = input.check(second.text, second.finishReason);
    if (!validated.ok) {
      input.log(`[writer] правка отклонена снова ${validated.code}: ${validated.reason.slice(0, REASON_CHARS)} — проход остановлен`);
      return null;
    }
  }
  return finalize(validated.text);
}
