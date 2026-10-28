/**
 * One pass = one session (BOOK-173 §5): **our** message array, appended to and never rebuilt.
 *
 * The provider is stateless and has no conversation id, so the only thing that makes a session
 * a session is that the same array keeps growing. Its first message is the stable prefix
 * (canon → role → protocol), and the cache hits only while that prefix is byte-identical; a
 * rebuilt prompt would silently resend it as new text. The assertion is what turns "the prefix
 * cannot move by construction" into a fact: any caller that hands a different system message is
 * refused, with the line an operator can find.
 */

import type { WriterMessage } from './provider.ts';
import { sha256Hex } from '../util/hash.ts';

export type TurnKind = 'repair' | 'continue' | 'revision';

/** What a rejected answer may show of itself in the retry: enough to fix, not a second chapter. */
export const REJECTED_HEAD_CHARS = 1_500;

export type Session = {
  readonly system: string;
  readonly prefixSha256: string;
  /** The conversation as it stands, oldest first — the exact array a call sends. */
  messages(): WriterMessage[];
  /** Append the model's answer and our next instruction, as one turn. */
  append(input: { assistant: string; user: string; kind: TurnKind; system?: string }): SessionTurn;
  /** Characters sent by call 1 and by the last call: the tail's growth, not a token count. */
  chars(): { opened: number; current: number };
};

export type SessionTurn = { ok: true; messages: WriterMessage[] } | { ok: false; code: 'PREFIX_MOVED'; detail: string };

export type SessionInput = { system: string; user: string; log?: (line: string) => void };

function charsOf(messages: readonly WriterMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

export function openSession(input: SessionInput): Session {
  const conversation: WriterMessage[] = [
    { role: 'system', content: input.system },
    { role: 'user', content: input.user },
  ];
  const prefixSha256 = sha256Hex(input.system);
  const opened = charsOf(conversation);

  return {
    system: input.system,
    prefixSha256,
    messages: () => conversation.slice(),
    chars: () => ({ opened, current: charsOf(conversation) }),
    append: (turn) => {
      // The prefix is the session's identity: a turn that carries another system message is a
      // different session, and continuing this one with it would send the canon twice.
      if (turn.system !== undefined && sha256Hex(turn.system) !== prefixSha256) {
        const detail = `session prefix ${prefixSha256.slice(0, 12)} ≠ ${sha256Hex(turn.system).slice(0, 12)}`;
        input.log?.(`[writer] префикс сдвинут — вызов отклонён: ${detail}`);
        return { ok: false, code: 'PREFIX_MOVED', detail };
      }
      conversation.push({ role: 'assistant', content: turn.assistant });
      conversation.push({ role: 'user', content: turn.user });
      return { ok: true, messages: conversation.slice() };
    },
  };
}

/** What a rejected answer may show of itself in the retry: enough to fix, not a second chapter. */
export function headOf(text: string, limit = REJECTED_HEAD_CHARS): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

/** The turn's own instruction text: a refusal names the code, and shows only what it must. */
export function repairInstruction(code: string, reason: string, tail: string): string {
  const parts = ['## Отказ', '', `Предыдущий ответ не прошёл проверку: ${code}: ${reason}.`, ''];
  if (tail.length > 0) {
    parts.push('Что уже написано перед этим местом (только для контекста):', '', tail, '');
  }
  parts.push('Верни ответ заново, учтя причину отказа, и больше ничего.');
  return parts.join('\n');
}

/** The continuation turn: the model already wrote that prose in this conversation. */
export function continuationInstruction(): string {
  return [
    '## Продолжение',
    '',
    'Продолжи прозу ровно с того места, где она остановилась.',
    'Названия нет, уже написанное не повторяй, комментариев не добавляй.',
  ].join('\n');
}
