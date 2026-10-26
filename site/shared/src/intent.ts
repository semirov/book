/**
 * `--intent` validation (ARCHITECTURE.md §12.3) — the second injection surface.
 *
 * The triage session turns a comment into a one-sentence goal, and that sentence later
 * reaches a *writer* prompt. So the intent is constrained, not free text: one goal about
 * one chapter, no meta-vocabulary, no other chapter, no shape request, no real person — and,
 * since audit M4, no *new thing* in the chapter: a request may change the prose, never add
 * an entity the chapter does not already have. An intent that fails is refused at the CLI
 * and the comment is rejected with a public reason instead of being queued.
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
  | 'INTENT_NEW_ENTITY'
  | 'INTENT_UNVERIFIABLE';

export type IntentVerdict =
  | { ok: true; intent: string }
  | { ok: false; code: IntentFailureCode; reason: string };

/**
 * What the caller knows about the chapter an intent is about. `vocabulary` is the chapter's
 * own words (the current blocks); without it the new-entity rule cannot judge and is skipped
 * — an unknown chapter must not turn every noun into a violation.
 */
export type IntentContext = { vocabulary?: readonly string[] };

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

/** Verbs that ask for something to be put *into* the text (audit M4). */
const ADD_REQUEST = /^(добав|введ|встав|придум|созда|допиш|напиш|внес|заведи|завест|появ)/u;

/**
 * Stems that name the place, the mechanics or the quantity of prose rather than a thing in
 * the world: «добавь в абзац запятую», «добавь новый знак», «добавь сцену». A noun made of
 * one of these is a request about the text, not a new entity inside the story.
 */
const EDITORIAL_STEMS: readonly string[] = [
  'слов', 'фраз', 'цитат', 'повтор', 'запят', 'точк', 'тире', 'дефис', 'кавыч', 'скобк',
  'пробе', 'многоточ', 'орфог', 'пункт', 'грамм', 'падеж', 'склон', 'спряж', 'удар',
  'перен', 'отступ', 'курси', 'шрифт', 'загол', 'строч', 'строк', 'табул', 'знак',
  'глав', 'абзац', 'сцен', 'эпизод', 'текст', 'фрагм', 'мест', 'момент', 'начал', 'конец',
  'серед', 'страни', 'отрыво', 'кусок', 'диалог', 'ремар', 'описа', 'дета', 'переход',
  'ритм', 'пауз', 'темп', 'интон', 'форм', 'поряд', 'структ',
  'нов', 'втор', 'трет', 'одну', 'одно', 'ещё', 'еще', 'друг', 'этот', 'такой',
  'свой', 'весь', 'все', 'общу', 'прежн', 'прошл', 'следую', 'предыд',
  'правк', 'измен', 'уточн', 'сокра', 'поясн', 'стил', 'тон', 'голос',
  'книг', 'рукопи', 'роман', 'сюжет', 'финал', 'концов', 'мотив', 'логик', 'соглас',
];

/** After one of these the next word is quoted *from* the text, not introduced into it. */
const QUOTED_STEMS: readonly string[] = ['слов', 'фраз', 'цитат', 'упоми', 'назва', 'повтор', 'выраж'];

const PREPOSITIONS = new Set([
  'в', 'во', 'на', 'с', 'со', 'к', 'ко', 'по', 'из', 'от', 'до', 'за', 'для', 'про', 'под',
  'над', 'при', 'у', 'о', 'об', 'обо', 'между', 'через', 'сквозь', 'около', 'после', 'перед',
  'этом', 'этой', 'этого', 'нему', 'ней', 'них', 'него', 'неё', 'нее', 'себе', 'себя',
]);

const WORD = /[а-яёa-z0-9-]+/gu;
const STEM_LENGTH = 4;

function words(text: string): string[] {
  return [...text.normalize('NFKC').toLowerCase().matchAll(WORD)].map((match) => match[0]);
}

function stem(word: string): string {
  return word.slice(0, STEM_LENGTH);
}

function startsWithAny(word: string, stems: readonly string[]): boolean {
  return stems.some((candidate) => word.startsWith(candidate));
}

/**
 * Audit M4: an intent may not ask for a *new thing* in the chapter. `«добавь маяк»`,
 * `«введи второго смотрителя»`, `«чтобы появился метроном»` are canon edits disguised as
 * edits of prose — the owner's world is not a reader's to extend. The rule is vocabulary
 * based: a request verb followed, within a few words, by a noun the chapter does not use.
 *
 * It is deliberately conservative in two ways: the prose-mechanics vocabulary above is
 * exempt, and an empty vocabulary (a chapter the caller cannot read) skips the rule rather
 * than refusing everything. Returns the offending word, or `null`.
 */
export function newEntityViolation(intent: string, vocabulary: readonly string[]): string | null {
  const known = new Set(vocabulary.flatMap((text) => words(text)).map(stem));
  if (known.size === 0) return null;
  const list = words(intent);

  for (let index = 0; index < list.length; index += 1) {
    if (!ADD_REQUEST.test(list[index] ?? '')) continue;
    for (let next = index + 1; next < Math.min(list.length, index + 6); next += 1) {
      const word = list[next] ?? '';
      if (startsWithAny(word, QUOTED_STEMS)) break;
      if (PREPOSITIONS.has(word)) continue;
      if (startsWithAny(word, EDITORIAL_STEMS)) continue;
      if (word.length < STEM_LENGTH) continue;
      if (known.has(stem(word))) break;
      return word;
    }
  }
  return null;
}

export function validateIntent(raw: string, chapter: number, context: IntentContext = {}): IntentVerdict {
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

  if (context.vocabulary !== undefined) {
    const entity = newEntityViolation(intent, context.vocabulary);
    if (entity !== null) {
      return {
        ok: false,
        code: 'INTENT_NEW_ENTITY',
        reason: `интент вводит новое — «${entity}»: правка не добавляет сущностей в главу`,
      };
    }
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
