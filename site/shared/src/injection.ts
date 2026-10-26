/**
 * Prompt-injection patterns (ARCHITECTURE.md §12.3, §12.5, §12.7).
 *
 * This module is the **pre-filter, not the defense**: framing (§12.3), the scope rules, the
 * triage decision and the post-write validator are the defense. Its job is to keep obvious
 * attacks out of a model's context entirely and to keep public rejection reasons
 * consistent between the server guard and `feedback.mjs --intent` validation.
 *
 * Matching only: Cyrillic look-alikes are folded to Latin before the Latin patterns run, and
 * the Russian patterns run on the lowercased original. Stored text is never altered here.
 */

export type GuardCategory = 'illegal' | 'person' | 'canon' | 'shape' | 'instruction';

export type GuardHit = { category: GuardCategory; flag: string; reason: string };

export const GUARD_REASONS: Record<GuardCategory, string> = {
  shape: 'вне рамок: форма книги',
  canon: 'вне рамок: канон',
  person: 'проверяется: реальные лица и чужие образы',
  illegal: 'проверяется: незаконное содержимое',
  instruction: 'проверяется: возможная инструкция',
};

const FLAGS: Record<GuardCategory, string> = {
  shape: 'shape-request',
  canon: 'canon-request',
  person: 'real-person',
  illegal: 'illegal-content',
  instruction: 'possible-instruction',
};

/** Cyrillic glyphs that a Latin keyword can be smuggled through (`іgnore`, `ѕystem:`). */
const CONFUSABLES: Record<string, string> = {
  а: 'a',
  в: 'b',
  е: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ѕ: 's',
  ԁ: 'd',
  ӏ: 'l',
};

/** Fold look-alikes for matching only; the caller keeps its own copy of the text. */
export function foldForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[а-яёіїєґԁӏ]/gu, (char) => CONFUSABLES[char] ?? char);
}

const LATIN_INSTRUCTION: RegExp[] = [
  /\bignore\s+(all\s+)?(the\s+)?(previous|above|prior|earlier|preceding)\b/u,
  /\bsystem\s*:/u,
  /\byou\s+are\s+(now\s+|an?\s+|the\s+)?/u,
  /\bact\s+as\b/u,
  /\bprompts?\b/u,
  /\binstructions?\b/u,
  /\bdeveloper\s+(mode|message)\b/u,
  /\boutput\s+only\b/u,
  /\btools?\s*:/u,
  /\bassistant\b/u,
  /\bchatgpt\b|\bgpt-?\d\b/u,
  /\bdisregard\b/u,
  /\bnew\s+(role|rules)\b/u,
];

const CYRILLIC_INSTRUCTION: RegExp[] = [
  /игнориру(й|йте|ем|я)\b/u,
  /проигнориру(й|йте)/u,
  /забудь(те)?\s+(все|всё|предыдущ|прежн|инструкц|правил)/u,
  /ты\s+теперь\b/u,
  /вы\s+теперь\b/u,
  /система\s*:/u,
  /инструкц(ия|ии|ию|ий)/u,
  /промпт/u,
  /(ты|вы)\s+(должен|должна|обязан|обязана|будешь)/u,
  /обраща(йся|йтесь)\s+к\s+(модел|систем|процесс)/u,
  /(владелец|автор|система)\s+(говорит|сказал|просит|приказал|разрешил)/u,
  // §12.3/§12.5 (audit M4): the imperative register a reader uses to drive a model — a new
  // rule «с этого момента», a pastiche «в стиле», a person «от первого лица», or a plain
  // «не обращай внимания». Each is a possible instruction, so it is quarantined, not lost.
  /не\s+обраща(й|йте)\s+внимани[яе]/u,
  /с\s+этого\s+момента/u,
  // No `\b` in these patterns: JS word boundaries are ASCII, so `стиле\b` never matches
  // after a Cyrillic letter. The Russian text is matched by prefix + suffix instead.
  /в\s+стиле/u,
  /пиши(те)?\s+(как|в|от|так,?\s+будто)/u,
  /от\s+первого\s+лица/u,
  // A wording asks for something to *appear*, or names the writer directly: both are a
  // request to the machine, not an opinion about the prose.
  /появится/u,
  /пусть\s+(ты|вы|автор|пиши|пишите|теперь|появится|будет|здесь)/u,
];

const LATIN_SHAPE: RegExp[] = [
  /\b(add|remove|delete|introduce|invent|write|create)\b.{0,40}\b(characters?|person|hero|people|chapters?)\b/u,
  /\b(make|rewrite|change|alter)\b.{0,40}\b(longer|shorter|twice|ending|finale|structure|format|canon|the\s+book)\b/u,
  /\b(all|every)\s+(chapters?|sections?)\b/u,
];

const RUS_REQUEST = '(добав|введ|встав|созда|придум|убир|удал|выреж|убери|сотри|напиш|перепиш|переписа|измен|помен|смен|отмен|передела|сдела|увелич|уменьш|сократ|удлин)';
const BETWEEN = '(?:\\s+[а-яё-]+){0,3}';

const RUS_SHAPE: RegExp[] = [
  new RegExp(`${RUS_REQUEST}[а-яё]*${BETWEEN}\\s+(персонаж|геро[йя]|человек|девочк|мальчик|женщин|мужчин|ребён|ребен)`, 'u'),
  new RegExp(`${RUS_REQUEST}[а-яё]*${BETWEEN}\\s+(ещё\\s+|еще\\s+)?глав`, 'u'),
  /(ещё|еще)\s+одн[уу]\s+глав/u,
  new RegExp(`${RUS_REQUEST}[а-яё]*${BETWEEN}\\s+(длинн|объём|объем|размер|символ|знак|страниц)`, 'u'),
  new RegExp(`${RUS_REQUEST}[а-яё]*${BETWEEN}\\s+(конец|концовк|финал)`, 'u'),
  new RegExp(`${RUS_REQUEST}[а-яё]*${BETWEEN}\\s+(всю\\s+книг|всю\\s+рукопись|весь\\s+текст|структур|формат|устройств)`, 'u'),
];

const LATIN_CANON: RegExp[] = [/\b(canon|concept\.md|voice\.md)\b/u];
const RUS_CANON: RegExp[] = [
  /(измен|помен|перепиш|переписа|отмен|трон|забудь)[а-яё]*(?:\s+[а-яё-]+){0,3}\s+(канон|concept|voice|правил[ао]\s+книг)/u,
  /канон\s+(книги|проекта|меняется|измен)/u,
];

const REAL_WORLD_MARKERS =
  /(путин|навальн|трамп|байден|маск|зеленск|гарри\s+поттер|шерлок\s+холмс|батман|человек-паук|супермен|микки\s+маус|дисней|голливуд|real\s+person|celebrity|politician|famous\s+person)/u;

const ILLEGAL_MARKERS =
  /(экстремизм|терроризм|террорист|разжига|призыв\s+к\s+(насил|свержен)|наркотик|детск[а-яё]*\s+порн|порнограф|взрывчатк|оружие\s+массового|убей|убийств[оа]\s+по\s+наци|суицид)/u;

const REQUEST_WORDS =
  /(добав|введ|встав|напиш|опиши|пропиш|сдела|изобраз|расскаж|пусть|созда|придум|change|add|write|make)/u;

/** A long unbroken base64-ish run is an encoding trick, not prose (§12.5). */
const ENCODED_RUN = /[A-Za-z0-9+/]{60,}={0,2}/gu;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function hasAny(patterns: readonly RegExp[], ...texts: string[]): boolean {
  return patterns.some((pattern) => texts.some((text) => pattern.test(text)));
}

/**
 * Classify reader-authored text. Order is deliberate: an illegal or real-world request is
 * the most serious finding, a shape violation is public and final, and an instruction is
 * quarantined (stored, shown, not delivered) because it is a *possible* instruction.
 */
export function classifyText(raw: string): GuardHit | null {
  const lower = raw.normalize('NFKC').toLowerCase();
  const folded = foldForMatch(raw);

  if (ILLEGAL_MARKERS.test(lower)) {
    const requested = splitSentences(lower).some(
      (sentence) => ILLEGAL_MARKERS.test(sentence) && REQUEST_WORDS.test(sentence),
    );
    if (requested) return hit('illegal');
  }

  if (REAL_WORLD_MARKERS.test(lower)) {
    const requested = splitSentences(lower).some(
      (sentence) => REAL_WORLD_MARKERS.test(sentence) && REQUEST_WORDS.test(sentence),
    );
    if (requested) return hit('person');
  }

  if (hasAny(RUS_CANON, lower) || hasAny(LATIN_CANON, folded)) return hit('canon');
  if (hasAny(RUS_SHAPE, lower) || hasAny(LATIN_SHAPE, folded)) return hit('shape');
  if (hasAny(CYRILLIC_INSTRUCTION, lower) || hasAny(LATIN_INSTRUCTION, folded)) return hit('instruction');

  for (const match of raw.matchAll(ENCODED_RUN)) {
    const run = match[0];
    const around = raw.slice(Math.max(0, match.index - 12), match.index);
    if (around.includes('://') || around.includes('www.')) continue;
    if (/[a-z]/u.test(run) && /[A-Z]/u.test(run) && /[0-9]/u.test(run)) return hit('instruction', 'encoded');
  }

  return null;
}

function hit(category: GuardCategory, flag = FLAGS[category]): GuardHit {
  return { category, flag, reason: GUARD_REASONS[category] };
}

/** The meta-vocabulary an `--intent` sentence may not carry (§12.3). */
export function intentMetaViolation(raw: string): GuardHit | null {
  const found = classifyText(raw);
  if (found === null) return null;
  // `shape` is the only category that matters for an intent: it may describe prose only.
  if (found.category === 'instruction') return { ...found, flag: 'possible-instruction' };
  return found;
}
