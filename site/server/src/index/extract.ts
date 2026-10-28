/**
 * Reading one chapter into index facts (BOOK-18 §1): entities, mentions, promises, time
 * markers, document references with their status.
 *
 * Every rule here is a heuristic over Russian prose, not a parser. It is deterministic —
 * the same paragraphs always produce the same arrays, in a canonical order — and it may
 * err: an uncertain name is kept with `ambiguous: true`, and a chapter with nothing to say
 * yields empty collections. Nothing in this module throws on prose.
 *
 * The lists below are the whole vocabulary of the index: no hidden categories, no learning.
 * Extending one is a code change that bumps `INDEX_VERSION`, so a stale artifact is rebuilt
 * instead of silently meaning something else.
 */

import { splitSentences as sharedSentences } from '@book/shared';

import type {
  ChapterIndex,
  DocumentReference,
  DocumentStatus,
  EntityKind,
  EntityMention,
  IndexedEntity,
  IndexedPromise,
  TimeMarker,
  TimeMarkerKind,
} from './types.ts';

/** A run of capitalised words: «Ковалёв», «Анна Петровна», «Северное управление». */
const CAPITALISED = /\p{Lu}\p{Ll}*(?:[ -]\p{Lu}\p{Ll}*)*/gu;

/** Capitalised words that are grammar, not names. Lowercase form. */
const STOP_WORDS = new Set([
  'он', 'она', 'оно', 'они', 'но', 'и', 'а', 'в', 'во', 'на', 'не', 'ни', 'что', 'как',
  'это', 'тот', 'та', 'те', 'все', 'весь', 'вся', 'я', 'мы', 'вы', 'ты', 'меня', 'мне',
  'его', 'ему', 'её', 'ей', 'их', 'им', 'когда', 'где', 'куда', 'почему', 'если', 'чтобы',
  'только', 'даже', 'уже', 'ещё', 'еще', 'нет', 'да', 'потом', 'тогда', 'здесь', 'там',
  'сейчас', 'опять', 'снова', 'вдруг', 'однако', 'поэтому', 'потому', 'через', 'после',
  'перед', 'между', 'возле', 'около', 'кроме', 'пока', 'словно', 'будто', 'разве',
  'неужели', 'кто', 'чем', 'чей', 'свой', 'своя', 'сам', 'сама', 'само', 'один', 'одна',
  'одно', 'два', 'две', 'три', 'четыре', 'пять', 'книга', 'глава', 'страница', 'конец',
  'начало', 'господи', 'боже',
]);

/** Titles read as people when a capitalised word follows them. Lowercase form. */
const PERSON_WORDS = new Set([
  'господин', 'госпожа', 'товарищ', 'инженер', 'врач', 'доктор', 'техник', 'оператор',
  'дежурный', 'майор', 'капитан', 'лейтенант', 'следователь', 'секретарь', 'сторож',
  'вахтёр', 'вахтер', 'начальник', 'бухгалтер', 'архивариус', 'курьер', 'профессор',
  'ассистент', 'лаборант', 'пилот', 'штурман', 'сержант', 'полковник', 'генерал',
]);

/** Words that make a capitalised run an organisation. Lowercase form. */
const ORG_WORDS = new Set([
  'управление', 'комитет', 'министерство', 'институт', 'отдел', 'служба', 'бюро',
  'контора', 'архив', 'предприятие', 'комбинат', 'трест', 'главк', 'ведомство',
  'администрация', 'поликлиника', 'больница', 'лаборатория', 'редакция', 'кафедра',
  'совет', 'депо',
]);

/** Words that place a name when they stand just before it. Lowercase form. */
const PLACE_WORDS = new Set([
  'город', 'посёлок', 'поселок', 'деревня', 'село', 'станция', 'улица', 'площадь',
  'район', 'уезд', 'область', 'край', 'завод', 'порт', 'вокзал', 'аэродром', 'шахта',
  'рудник', 'поселение', 'квартал', 'переулок', 'проспект', 'набережная', 'остров',
  'река', 'озеро', 'гора',
]);

const KIND_RANK: Record<EntityKind, number> = { unknown: 0, place: 1, organisation: 2, person: 3 };

/** A promise is a stated intention or obligation; the matched word is the marker. */
const PROMISE_RULES: RegExp[] = [
  word('обеща\\p{L}*', false),
  word('долж(?:ен|на|ны|ник)', false),
  word('обязан\\p{L}*', false),
  word('собира(?:ется|лся|лась|ются|лись)', false),
  word('намерен\\p{L}*', false),
  word('клян\\p{L}*|клялся|клялась', false),
  word('даю слово', false),
];

const TIME_RULES: Array<{ kind: TimeMarkerKind; re: RegExp }> = [
  { kind: 'year', re: word('(?:1[0-9]{3}|20[0-9]{2})') },
  {
    kind: 'month',
    re: word('(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\\p{L}*'),
  },
  {
    kind: 'relative',
    re: word(
      '(?:через|спустя)\\s+(?:\\d+|[а-яё]+)\\s+' +
        '(?:год|года|лет|день|дня|дней|недел\\p{L}*|месяц\\p{L}*|час\\p{L}*|минут\\p{L}*)',
    ),
  },
  { kind: 'relative', re: word('на следующ\\p{L}+ (?:день|утро|вечер)|накануне|наутро') },
  { kind: 'season', re: word('зимой|весной|летом|осенью') },
  { kind: 'daypart', re: word('утром|вечером|ночью|днём|днем|к утру|к вечеру') },
];

/** The papers the index knows: a generic “документ” plus the office's own nouns. */
const DOCUMENT_NOUNS = [
  'служебная записка',
  'докладная записка',
  'постановление',
  'распоряжение',
  'предписание',
  'удостоверение',
  'свидетельство',
  'разрешение',
  'ведомость',
  'документ',
  'приказ',
  'протокол',
  'справка',
  'заявление',
  'паспорт',
  'договор',
  'выписка',
  'пропуск',
  'ордер',
  'наряд',
  'реестр',
  'указ',
  'акт',
  'форма',
  'бланк',
];

/** Longest first, so «служебная записка» wins over any shorter noun inside it. */
const DOCUMENT_PATTERN = new RegExp(
  `(?<![\\p{L}])(?:${DOCUMENT_NOUNS.join('|')})(?![\\p{L}])`,
  'giu',
);

/** The four statuses, as verbs the paperwork actually uses (BOOK-18 §1). */
const STATUS_RULES: Array<{ status: DocumentStatus; re: RegExp }> = [
  {
    status: 'issued',
    re: word('(?:выдан|издан|подписан|оформлен|зарегистрирован|утвержд|присвоен|получен|вруч)\\p{L}*'),
  },
  {
    status: 'annulled',
    re: word('(?:аннулирован|отозван|отменён|отменен|погашен|изъят|уничтожен|сдан)\\p{L}*'),
  },
  {
    status: 'amended',
    re: word('(?:изменён|изменен|дополнен|исправлен|переоформлен|переписан)\\p{L}*'),
  },
  {
    status: 'quoted',
    re: word('(?:процитирован|цитируется|зачитан|оглашён|оглашен|приведён|приведен)\\p{L}*'),
  },
];

/** `(?<!letter)body(?!letter)` — `\b` is ASCII-only and lies about Cyrillic. */
function word(body: string, global = true): RegExp {
  return new RegExp(`(?<![\\p{L}])(?:${body})(?![\\p{L}])`, global ? 'giu' : 'iu');
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

function wordsOf(value: string): string[] {
  return value.split(/[ -]+/u).filter((part) => part.length > 0);
}

/**
 * One paragraph → its sentences as text, in order. The split itself is the shared segmenter
 * (BOOK-DOC-74 §3.4); the index keeps this shape because every rule below reads a sentence as
 * a string.
 */
export function splitSentences(text: string): string[] {
  return sharedSentences(text).map((span) => span.text);
}

/** The lowercase words of the text — the evidence that a capitalised word is a common noun. */
function lowercaseWords(text: string): Set<string> {
  const set = new Set<string>();
  for (const match of text.matchAll(/(?<![\p{L}])\p{Ll}[\p{Ll}-]*/gu)) set.add(normalise(match[0]));
  return set;
}

function wordBefore(sentence: string, index: number): string {
  const match = /([\p{L}-]+)\s*$/u.exec(sentence.slice(0, index));
  return match?.[1] === undefined ? '' : normalise(match[1]);
}

type EntityCandidate = { surface: string; kind: EntityKind; sentenceInitial: boolean };

function entityCandidate(sentence: string, match: RegExpExecArray): EntityCandidate {
  const parts = wordsOf(match[0]);
  const first = normalise(parts[0] ?? '');
  const rest = parts.slice(1).join(' ');
  if (rest.length > 0 && PERSON_WORDS.has(first)) {
    return { surface: rest, kind: 'person', sentenceInitial: match.index === 0 };
  }
  if (parts.some((part) => ORG_WORDS.has(normalise(part)))) {
    return { surface: match[0], kind: 'organisation', sentenceInitial: match.index === 0 };
  }
  const before = wordBefore(sentence, match.index);
  const kind: EntityKind = PERSON_WORDS.has(before)
    ? 'person'
    : PLACE_WORDS.has(before)
      ? 'place'
      : ORG_WORDS.has(before)
        ? 'organisation'
        : 'unknown';
  return { surface: match[0], kind, sentenceInitial: match.index === 0 };
}

function readEntities(paragraphs: readonly string[]): IndexedEntity[] {
  const lowered = lowercaseWords(paragraphs.join('\n'));
  const found = new Map<
    string,
    { kind: EntityKind; surfaces: Set<string>; mentions: EntityMention[]; sentenceInitial: boolean }
  >();
  paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const sentence of splitSentences(paragraph)) {
      for (const match of sentence.matchAll(CAPITALISED)) {
        const candidate = entityCandidate(sentence, match);
        const surface = candidate.surface.trim();
        const key = normalise(surface);
        if (surface.length < 2 || STOP_WORDS.has(key)) continue;
        const entry = found.get(key) ?? {
          kind: 'unknown' as EntityKind,
          surfaces: new Set<string>(),
          mentions: [] as EntityMention[],
          sentenceInitial: false,
        };
        entry.surfaces.add(surface);
        entry.mentions.push({ paragraph: paragraphIndex, surface });
        if (KIND_RANK[candidate.kind] > KIND_RANK[entry.kind]) entry.kind = candidate.kind;
        entry.sentenceInitial ||= candidate.sentenceInitial;
        found.set(key, entry);
      }
    }
  });
  return [...found.entries()]
    .map(([key, entry]): IndexedEntity => ({
      key,
      kind: entry.kind,
      surfaces: [...entry.surfaces].sort(compare),
      mentions: entry.mentions.sort((left, right) => left.paragraph - right.paragraph),
      // Two spellings that collapse into one key, or the same word used lowercase nearby:
      // either is doubt worth recording, and neither is an error.
      ambiguous: entry.surfaces.size > 1 || lowered.has(key) || (entry.sentenceInitial && entry.kind === 'unknown'),
    }))
    .sort((left, right) => compare(left.key, right.key));
}

function readPromises(paragraphs: readonly string[]): IndexedPromise[] {
  const promises: IndexedPromise[] = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const sentence of splitSentences(paragraph)) {
      for (const rule of PROMISE_RULES) {
        const found = sentence.match(rule);
        if (found === null) continue;
        promises.push({ paragraph: paragraphIndex, marker: normalise(found[0]), text: sentence.slice(0, 200) });
        break;
      }
    }
  });
  return promises;
}

type Timed = TimeMarker & { index: number };

function readTimeMarkers(paragraphs: readonly string[]): TimeMarker[] {
  const markers: Timed[] = [];
  paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const sentence of splitSentences(paragraph)) {
      for (const rule of TIME_RULES) {
        for (const match of sentence.matchAll(rule.re)) {
          const text = match[0].trim();
          if (text.length === 0) continue;
          markers.push({ paragraph: paragraphIndex, kind: rule.kind, text, index: match.index });
        }
      }
    }
  });
  const seen = new Set<string>();
  return markers
    .sort((left, right) => left.paragraph - right.paragraph || left.index - right.index)
    .filter((marker) => {
      const identity = `${marker.paragraph}|${marker.kind}|${marker.text.toLowerCase()}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .map(({ paragraph, kind, text }) => ({ paragraph, kind, text }));
}

type DocumentMention = { end: number; surface: string; document: string };

function documentMentions(sentence: string): DocumentMention[] {
  const mentions: DocumentMention[] = [];
  for (const match of sentence.matchAll(DOCUMENT_PATTERN)) {
    const tail = sentence.slice(match.index + match[0].length);
    const number = /^\s*(?:№\s*\d+|\d+)/u.exec(tail);
    const quoted = /^\s*[«"]([^»"]{1,40})[»"]/u.exec(tail);
    const suffix = number?.[0] ?? quoted?.[0] ?? '';
    const surface = suffix.length > 0 ? `${match[0]} ${suffix.trim()}` : match[0];
    mentions.push({
      end: match.index + match[0].length,
      surface,
      document: normalise(`${match[0]} ${(quoted?.[1] ?? suffix).trim()}`),
    });
  }
  return mentions;
}

/** The status marker nearest to the paper — the verb acts on what stands beside it. */
function statusNear(sentence: string, at: number): DocumentStatus | null {
  let best: { status: DocumentStatus; distance: number; index: number } | null = null;
  for (const rule of STATUS_RULES) {
    for (const match of sentence.matchAll(rule.re)) {
      const distance = Math.abs(match.index - at);
      if (best === null || distance < best.distance) best = { status: rule.status, distance, index: match.index };
    }
  }
  return best?.status ?? null;
}

function readDocuments(paragraphs: readonly string[]): DocumentReference[] {
  const found = new Map<string, DocumentReference>();
  paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const sentence of splitSentences(paragraph)) {
      for (const mention of documentMentions(sentence)) {
        const status = statusNear(sentence, mention.end);
        if (status === null) continue;
        const existing = found.get(mention.document);
        if (existing === undefined) {
          found.set(mention.document, {
            document: mention.document,
            surface: mention.surface,
            status,
            paragraphs: [paragraphIndex],
          });
          continue;
        }
        // Reading order is the chapter's own order: the last status is the one that stands.
        existing.status = status;
        if (!existing.paragraphs.includes(paragraphIndex)) existing.paragraphs.push(paragraphIndex);
      }
    }
  });
  return [...found.values()]
    .sort((left, right) => compare(left.document, right.document))
    .map((reference) => ({
      document: reference.document,
      surface: reference.surface,
      status: reference.status,
      paragraphs: [...reference.paragraphs].sort((left, right) => left - right),
    }));
}

export function extractChapter(input: {
  n: number;
  written: boolean;
  sha256: string;
  paragraphs: readonly string[];
}): ChapterIndex {
  if (!input.written) {
    return {
      n: input.n,
      written: false,
      sha256: input.sha256,
      entities: [],
      promises: [],
      timeMarkers: [],
      documents: [],
    };
  }
  return {
    n: input.n,
    written: true,
    sha256: input.sha256,
    entities: readEntities(input.paragraphs),
    promises: readPromises(input.paragraphs),
    timeMarkers: readTimeMarkers(input.paragraphs),
    documents: readDocuments(input.paragraphs),
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
