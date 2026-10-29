/**
 * One pass's answers, with the one retry a refused answer gets (BOOK-145, BOOK-173 §5).
 *
 * The check already names itself (`ANSWER_*`, `TEXT_*`, `MARKDOWN`, …); what was missing is that
 * nobody read it. Every refusal is one structured line in the log — code and reason — and the
 * retry carries the reason back to the model, so the second answer can be the one that passes
 * instead of the pass parking on a diagnosis nobody can act on.
 *
 * BOOK-173: a pass is **one session**. The draft opens the message array (stable prefix + tail)
 * and every later turn — the repair, then each continuation — appends to it, so the prefix the
 * provider charged for stays byte-identical (`session.ts`). `buildContinuePrompt` is retired for
 * that reason: the model already wrote that prose in this conversation.
 */

import { finalize, isThin, mergeContinuation } from './prose.ts';
import type { Answer, Lane } from './passLane.ts';
import type { BuiltPrompt } from './prompt.ts';
import type { ProviderResult, WriterMessage } from './provider.ts';
import { continuationInstruction, headOf, openSession, type Session } from './session.ts';

/** A refusal line is a log line: the reason is bounded here once. */
const REASON_CHARS = 200;

/** The draft's own retry text: the same sentence a reader of the log can act on. */
function draftRetry(reason: string): string {
  return `## Отказ\n\nПредыдущий ответ не прошёл проверку: ${reason}.\nВерни главу заново, целиком: первая строка — название, вторая — пустая, дальше проза. Причину отказа учти.`;
}

export type DraftRun = { answer: Answer; session: Session };

/** The model's first answer, one retry with the reason, and the session both turns live in. */
export async function draftAnswer(lane: Lane, built: BuiltPrompt, log: (line: string) => void): Promise<DraftRun> {
  const session = openSession({ system: built.system, user: built.user });
  const first = await lane.ask('draft', session.messages(), 'draft');
  const checked = lane.check(first.text, first.finishReason);
  if (checked.ok) return { answer: checked, session };
  log(`[writer] ответ отклонён ${checked.code}: ${checked.reason.slice(0, REASON_CHARS)} — повтор с причиной`);
  const turn = session.append({ kind: 'repair', assistant: headOf(first.text), user: draftRetry(checked.reason) });
  if (!turn.ok) throw new Error(`${turn.code}: ${turn.detail}`);
  const second = await lane.ask('repair', turn.messages, 'repair');
  const again = lane.check(second.text, second.finishReason);
  if (!again.ok) log(`[writer] ответ отклонён снова ${again.code}: ${again.reason.slice(0, REASON_CHARS)} — проход остановлен`);
  return { answer: again, session };
}

/** Continuations keep writing until the chapter reaches the thin line or the budget stops it. */
export async function continueDraft(
  lane: Lane,
  input: { chapter: number; text: string; max: number; session: Session },
  log: (line: string) => void,
): Promise<string> {
  let text = input.text;
  let continuations = 0;
  while (continuations < input.max && isThin(input.chapter, text)) {
    const turn = input.session.append({ kind: 'continue', assistant: text, user: continuationInstruction() });
    if (!turn.ok) break;
    const more = await lane.ask('continue', turn.messages, 'continue');
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
      { role: 'assistant', content: first.text.slice(0, 1_500) },
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
