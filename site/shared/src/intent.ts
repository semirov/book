/**
 * `--intent` validation (ARCHITECTURE.md §12.3) — the second injection surface.
 *
 * The triage session turns a comment into a one-sentence goal, and that sentence later
 * reaches a *writer* prompt. So the intent is constrained, not free text: one goal about
 * one chapter, no meta-vocabulary, no other chapter, no shape request, no real person. An
 * intent that fails is refused at the CLI and the comment is rejected with a public reason
 * instead of being queued.
 *
 * The same function runs in three places — `feedback.mjs decide`, the decisions tailer on
 * the site, and the tests — so there is exactly one definition of a valid intent.
 */

import { INTENT_MAX_CHARS } from './change.ts';
import { COMMENT_REASON_MAX_CHARS, INTENT_MIN_CHARS } from './comment.ts';
import { intentMetaViolation } from './injection.ts';

export type IntentFailureCode =
  | 'ENDING_FROZEN'
  | 'INTENT_TOO_SHORT'
  | 'INTENT_TOO_LONG'
  | 'INTENT_OTHER_CHAPTER'
  | 'INTENT_SHAPE'
  | 'INTENT_UNVERIFIABLE';

export type IntentVerdict =
  | { ok: true; intent: string }
  | { ok: false; code: IntentFailureCode; reason: string };

const OTHER_CHAPTER_WORDS =
  /(друг(ой|ая|ую|их)|соседн(ей|яя|юю|их)|предыдущ(ей|ая|ую|их)|следующ(ей|ая|ую|их)|все\s+глав|всех\s+глав|по\s+всем\s+глав|весь\s+текст|всему\s+тексту|вся\s+книга|всю\s+книгу|всей\s+книге|all\s+chapters|every\s+chapter)/u;

/** Every explicit chapter number in the sentence: «в главе 9», «глава 9», «ch9», «#9». */
export function chapterMentions(text: string): number[] {
  const found: number[] = [];
  const patterns = [
    /глав[а-яё]{0,3}\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})/gu,
    /глав[а-яё]{0,3}\s*(\d{1,2})/gu,
    /\bch\s*(\d{1,2})\b/giu,
    /#(\d{1,2})\b/gu,
    /\bchapter\s*(\d{1,2})\b/giu,
    /(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*глав/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      for (const group of match.slice(1)) {
        if (group === undefined) continue;
        const value = Number.parseInt(group, 10);
        if (Number.isInteger(value)) found.push(value);
      }
    }
  }
  return [...new Set(found)];
}

/** Collapse whitespace; the writer receives one sentence, not a layout. */
export function normalizeIntent(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function validateIntent(raw: string, chapter: number): IntentVerdict {
  if (chapter === 67) {
    return { ok: false, code: 'ENDING_FROZEN', reason: 'финал заморожен: правка читателя в главу 67 не входит' };
  }

  const intent = normalizeIntent(raw);
  if (intent.length < INTENT_MIN_CHARS) {
    return { ok: false, code: 'INTENT_TOO_SHORT', reason: `интент короче ${INTENT_MIN_CHARS} символов` };
  }
  if (intent.length > INTENT_MAX_CHARS) {
    return { ok: false, code: 'INTENT_TOO_LONG', reason: `интент длиннее ${INTENT_MAX_CHARS} символов` };
  }

  // One goal clause + at most one constraint; three full stops is a prompt, not a goal.
  const sentences = intent.split(/(?<=[.!?…])\s+/u).filter((part) => part.trim().length > 0);
  if (sentences.length > 2) {
    return { ok: false, code: 'INTENT_SHAPE', reason: 'интент: одна цель и не больше одного уточнения' };
  }

  const meta = intentMetaViolation(intent);
  if (meta !== null) {
    return { ok: false, code: 'INTENT_SHAPE', reason: meta.reason };
  }

  if (OTHER_CHAPTER_WORDS.test(intent.normalize('NFKC').toLowerCase())) {
    return { ok: false, code: 'INTENT_OTHER_CHAPTER', reason: 'интент: правка называет не только свою главу' };
  }

  const mentions = chapterMentions(intent);
  const foreign = mentions.filter((value) => value !== chapter);
  if (foreign.length > 0) {
    return {
      ok: false,
      code: 'INTENT_OTHER_CHAPTER',
      reason: `интент называет другую главу (${foreign.join(', ')})`,
    };
  }

  return { ok: true, intent };
}

/** A public decision reason: one concrete line, Russian, ≤200 characters (§12.3). */
export function validateReason(raw: string): { ok: true; reason: string } | { ok: false; reason: string } {
  const reason = raw.replace(/\s+/gu, ' ').trim();
  if (reason.length === 0) return { ok: false, reason: 'причина пустая' };
  if (reason.length > COMMENT_REASON_MAX_CHARS) {
    return { ok: false, reason: `причина длиннее ${COMMENT_REASON_MAX_CHARS} символов` };
  }
  return { ok: true, reason };
}
