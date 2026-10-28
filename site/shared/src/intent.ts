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
 * BOOK-16 makes the intervention's kind part of the judgement: a goal that declares a kind
 * must be a world-fact, not a correction of the writing (`proseCorrectionViolation`).
 *
 * BOOK-44 adds the second half of that: a second-person order about *how to write* («пиши
 * короче», «не упоминай», «сократи», «перепиши») is refused unconditionally, with or without
 * a kind, and the intent itself is capped at 200 characters — one goal, not a paragraph.
 *
 * The same function runs in four places — `feedback.mjs decide`, the decisions tailer on the
 * site, the engine's `/internal/changes` route, and the tests — so there is exactly one
 * definition of a valid intent. Each of them passes the kind it read from the stored comment.
 */

import { INTENT_MAX_CHARS } from './change.ts';
import { COMMENT_REASON_MAX_CHARS, INTENT_MIN_CHARS } from './comment.ts';
import { intentMetaViolation } from './injection.ts';
import { splitSentences } from './sentences.ts';
import type { InterventionKind } from './intervention.ts';

export type IntentFailureCode =
  | 'INTENT_TOO_SHORT'
  | 'INTENT_TOO_LONG'
  | 'INTENT_OTHER_CHAPTER'
  | 'INTENT_SHAPE'
  | 'INTENT_WRITING_ORDER'
  | 'INTENT_NEW_ENTITY'
  | 'INTENT_PROSE_CORRECTION'
  | 'INTENT_UNVERIFIABLE';

export type IntentVerdict =
  | { ok: true; intent: string }
  | { ok: false; code: IntentFailureCode; reason: string };

/**
 * What the caller knows about the chapter an intent is about. `vocabulary` is the chapter's
 * own words (the current blocks); without it the new-entity rule cannot judge and is skipped
 * — an unknown chapter must not turn every noun into a violation.
 *
 * `kind` is the intervention's declared kind (BOOK-16). With a kind declared, an intent whose
 * request object is prose mechanics («повтор», «запятая») is a prose correction dressed as a
 * world-fact, and is refused; without a kind the older rules apply unchanged, so a pre-BOOK-16
 * row still decides exactly as it did.
 */
export type IntentContext = { vocabulary?: readonly string[]; kind?: InterventionKind | null };

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
 * Verbs that ask for the **writing** to be changed rather than the world: «исправь»,
 * «поправь», «перепиши», «сократи», «убери», «удали», «сотри» — and the additive ones, since
 * a correction may be additive too («добавь запятую», «вставь пробел»). The verb alone
 * decides nothing: the object has to be prose mechanics (`PROSE_MECHANICS`), so «добавь
 * документ» and «добавь повторный допрос» stay world-facts. `newEntityViolation` keeps its
 * own `ADD_REQUEST` untouched.
 */
const CORRECTION_REQUEST =
  /^(испра|поправ|перепиш|переписа|замен|сокра|почист|выровн|перестав|сдвин|убр|убир|убер|удал|стер|стира|сотр|добав|встав|введ)/u;

/**
 * BOOK-16 — the vocabulary of a prose correction: punctuation, spelling, repetition, rhythm,
 * intonation, style, bureaucratic register.
 *
 * These are **anchored word forms, not stems**. A prefix would refuse a genuine world-fact:
 * «повторный допрос», «повторяющийся сон», «ритмичный стук», «падежная форма имени» all begin
 * with a mechanics stem and are all facts about the world (review BOOK-16). Each pattern
 * therefore spells out the noun's own inflections and nothing beyond them; the list is
 * deliberately narrow, because a false hit here refuses a legitimate intervention while a miss
 * only leaves the judgement to the auditor.
 */
const PROSE_MECHANICS: readonly RegExp[] = [
  /^запят(ая|ой|ую|ые|ых|ым|ыми)$/u,
  /^пунктуац/u,
  /^тире$/u,
  /^дефис(а|у|ом|е|ы|ов|ам|ами|ах)?$/u,
  /^кавычк(а|и|е|у|ой|ами|ах|ам)?$/u,
  /^скобк(а|и|е|у|ой|ами|ах|ам)?$/u,
  /^пробел(а|у|ом|е|ы|ов|ам|ами|ах)?$/u,
  /^многоточ(ие|ия|ию|ием|ий|иям|иями|иях)?$/u,
  /^орфограф/u,
  /^падеж(а|у|ом|е|ей|и|ам|ами|ах)?$/u,
  /^спряж(ение|ения|ению|ением|ении|ений)?$/u,
  /^повтор(ы|ов|а|у|ом|е|ам|ами|ах)?$/u,
  /^ритм(а|у|ом|е|ы|ов|ам|ами|ах)?$/u,
  /^интонац/u,
  /^стилист/u,
  /^тавтолог/u,
  /^канцеляр/u,
];

/** Is this word the *writing* (a repeat, a comma, a rhythm) rather than something in the world? */
function isProseMechanic(word: string): boolean {
  return PROSE_MECHANICS.some((pattern) => pattern.test(word));
}

/**
 * One scan shared by both rules below: a request verb, then the first substantive word it
 * governs. `judge` says whether that word is exempt (`skip`), ends the search (`stop` — the
 * request already names something else) or is the violation (`hit`).
 *
 * `stopOnQuote` is what separates the two rules: for the new-entity rule a word that names a
 * quote from the text ends the search («добавь слово…» is not a new entity), while for the
 * prose-correction rule that very word is the violation («убери повтор»).
 */
function scanRequest(
  intent: string,
  request: RegExp,
  judge: (word: string) => 'skip' | 'stop' | 'hit',
  stopOnQuote = true,
): string | null {
  const list = words(intent);
  for (let index = 0; index < list.length; index += 1) {
    if (!request.test(list[index] ?? '')) continue;
    for (let next = index + 1; next < Math.min(list.length, index + 6); next += 1) {
      const word = list[next] ?? '';
      if (stopOnQuote && startsWithAny(word, QUOTED_STEMS)) break;
      if (PREPOSITIONS.has(word)) continue;
      if (word.length < STEM_LENGTH) continue;
      const verdict = judge(word);
      if (verdict === 'skip') continue;
      if (verdict === 'hit') return word;
      break;
    }
  }
  return null;
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
  return scanRequest(intent, ADD_REQUEST, (word) => {
    if (startsWithAny(word, EDITORIAL_STEMS)) return 'skip';
    return known.has(stem(word)) ? 'stop' : 'hit';
  });
}

/**
 * BOOK-16 — a declared kind makes the intent a **world-fact**, and a world-fact is not a
 * correction of the writing. `«исправь запятую»`, `«убери повтор»`, `«поправь ритм»` are
 * prose corrections dressed as interventions: the same shape `newEntityViolation` already
 * reads (a request verb plus its object), judged against the prose-mechanics vocabulary.
 *
 * Only called when the intervention declares its kind, so an intent without a kind (a note,
 * or a row stored before BOOK-16) is judged exactly as it was before.
 */
export function proseCorrectionViolation(intent: string): string | null {
  return scanRequest(intent, CORRECTION_REQUEST, (word) => (isProseMechanic(word) ? 'hit' : 'stop'), false);
}

/**
 * BOOK-44 — an order about *how to write* is not a goal about the world, and it does not need
 * a declared kind to be refused: `«Пиши короче все реплики смотрителя»` addresses the writer's
 * hand whatever the filing claims to be.
 *
 * The list is closed and consists of **anchored word forms, not stems** — the same lesson as
 * `PROSE_MECHANICS`: exactly the four families the issue names (`пиши`, `упоминай` — including
 * after «не» — `сократи`, `перепиши`) plus their polite `-те` forms. A stem would refuse an
 * infinitive (`сократить`, `переписать`), a noun (`упоминание`) or a third person
 * (`смотритель не упоминает`), and each of those is a legitimate goal, not an order.
 *
 * The tokeniser keeps a hyphen inside the word, so «Пиши-ка» arrives as one token: the enclitic
 * `-ка` is stripped before the lookup, or the same order would pass spelled slightly softer.
 */
const WRITING_ORDER: ReadonlySet<string> = new Set([
  'пиши',
  'пишите',
  'упоминай',
  'упоминайте',
  'сократи',
  'сократите',
  'перепиши',
  'перепишите',
]);

export function writingOrderViolation(intent: string): string | null {
  for (const word of words(intent)) {
    if (WRITING_ORDER.has(word.replace(/-ка$/u, ''))) return word;
  }
  return null;
}

/**
 * BOOK-137: a chapter is no longer refused for being the last one. ch42 used to be closed here
 * («финал заморожен»), which made a filing on the finale undecidable — the reader's paperwork
 * could never be recorded. The ending is protected where text is: a ripple never rewrites it
 * (`engine/queue.ts`, `engine/lease`), a landing must keep the canon sentence (`engine/write.ts`)
 * and an accepted filing that touches that sentence becomes paperwork (`feedback/accept.ts`).
 */
export function validateIntent(raw: string, chapter: number, context: IntentContext = {}): IntentVerdict {
  const intent = normalizeIntent(raw);
  if (intent.length < INTENT_MIN_CHARS) {
    return { ok: false, code: 'INTENT_TOO_SHORT', reason: `интент короче ${INTENT_MIN_CHARS} символов` };
  }
  if (intent.length > INTENT_MAX_CHARS) {
    return { ok: false, code: 'INTENT_TOO_LONG', reason: `интент длиннее ${INTENT_MAX_CHARS} символов` };
  }

  // One goal clause + at most one constraint; three full stops is a prompt, not a goal. The
  // sentences are the shared segmenter's (BOOK-DOC-74 §3.4), not a terminator-and-space split.
  const sentences = splitSentences(intent).map(({ text }) => text);
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

  // BOOK-44: a second-person order about the prose itself — «пиши короче», «не упоминай»,
  // «сократи», «перепиши» — is refused here, before it reaches a writer prompt, and without
  // waiting for a declared kind. Placed before the new-entity rule so a sentence that is both
  // meta and an order keeps reporting the meta verdict above.
  if (writingOrderViolation(intent) !== null) {
    return {
      ok: false,
      code: 'INTENT_WRITING_ORDER',
      reason: 'интент указывает, как писать: назовите, что меняется в мире',
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

  // BOOK-16: with a kind declared, the goal has to be a world-fact. A prose correction
  // («исправь запятую», «убери повтор») is refused here, before it reaches a writer prompt.
  if (context.kind !== undefined && context.kind !== null) {
    const correction = proseCorrectionViolation(intent);
    if (correction !== null) {
      return {
        ok: false,
        code: 'INTENT_PROSE_CORRECTION',
        reason: `интент правит написание («${correction}»), а вмешательство — факт мира: назовите, что меняется`,
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
