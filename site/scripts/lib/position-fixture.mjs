/**
 * scripts/lib/position-fixture.mjs — the book the position guard measures when nobody names one.
 *
 * BOOK-187 made the database the only home of the text (`manuscript/` left the checkout), so a
 * clean clone has nothing to seed a measurement from, and a guard nobody can run is not a guard.
 * This module writes one: `manuscript/00-front.md` plus `ch01.md`…`ch42.md`, every byte a
 * function of the chapter number alone — no clock, no random, no network, no checkout write.
 *
 * It is **not the book**, and the record says so (`- seed: fixture …`). The prose is a fixed
 * archive register built out of word pools, and its shape is chosen so the page has the geometry
 * the guard is about:
 *
 *   - every chapter is written — a valid title line, a blank line, `FIXTURE_PARAGRAPHS`
 *     paragraphs of 2–6 sentences — so all 42 contents rows land on a heading (`.ch-h`);
 *   - ch07 and ch09 carry more paragraphs, because the harness parks a sentence by index there
 *     (`place(7, 60)`, `place(9, 150)`) and the page only delivers prose near the viewport;
 *   - paragraphs differ in length, so the lazy placeholder's estimate
 *     (`estimateChapterHeight`: `chars` split by a 66-character average paragraph) is **not** the
 *     height the chapter really gets — which is the drift the guard exists to correct;
 *   - the canon frame is intact: ch01 opens on `FRAME_FIRST_SENTENCE`, ch42 closes on
 *     `FRAME_LAST_SENTENCE`, so neither is refused as `frame-rejected` (BOOK-137).
 *
 * The canon is **read**, never restated: `writeFixture` loads `@book/shared` when it runs, which
 * is after the build (the driver builds before it seeds) — an import at module load would fail on
 * the clean checkout this fixture exists for, because `@book/shared` resolves to its `dist/`.
 *
 * `writeFixture(dir)` writes `<dir>/manuscript/` and answers what it wrote. The caller owns
 * `dir`, keeps it out of the checkout, and deletes it with the run.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Paragraphs of an ordinary chapter. */
export const FIXTURE_PARAGRAPHS = 12;

/**
 * The chapters the harness parks a sentence deep in, and how many paragraphs each gets: the
 * index it asks for (60 and 150) has to exist on the page, and a paragraph holds 2–6 sentences.
 */
export const FIXTURE_LONG_CHAPTERS = [
  { chapter: 7, paragraphs: 24 },
  { chapter: 9, paragraphs: 42 },
];

/** Paragraphs in chapter `n`. */
export function paragraphsOf(n) {
  return FIXTURE_LONG_CHAPTERS.find((entry) => entry.chapter === n)?.paragraphs ?? FIXTURE_PARAGRAPHS;
}

/** Sentences in paragraph `p` of chapter `n`: 2–6, fixed by the numbers, never by a clock. */
export function sentencesOf(n, p) {
  return 2 + ((n * 3 + p * 7) % 5);
}

const ADJECTIVES = [
  'молчаливый',
  'усталый',
  'аккуратный',
  'прежний',
  'ночной',
  'внимательный',
  'седой',
  'незнакомый',
  'хмурый',
  'вежливый',
  'осторожный',
  'нездешний',
];
const SUBJECTS = [
  'архивист',
  'сторож',
  'секретарь',
  'регистратор',
  'курьер',
  'переводчик',
  'смотритель',
  'писарь',
  'понятой',
  'стажёр',
];
const VERBS = [
  'перелистал',
  'выписал',
  'сверил',
  'запер',
  'вскрыл',
  'пересчитал',
  'отметил',
  'отложил',
  'подшил',
  'переслал',
  'проверил',
];
const OBJECTS = [
  'папку',
  'опись',
  'счёт',
  'дело',
  'протокол',
  'карточку',
  'квитанцию',
  'журнал',
  'реестр',
  'акт',
  'письмо',
];
const PLACES = [
  'в подвале',
  'на третьем этаже',
  'у окна',
  'в коридоре',
  'за перегородкой',
  'в читальном зале',
  'на складе',
  'у стеллажа',
];
const ADVERBS = ['не спеша', 'молча', 'второпях', 'по привычке', 'до обеда', 'без ошибки', 'как всегда'];
const REMARKS = [
  'так записано',
  'это не выдача документа, просто справка',
  'срок истёк',
  'подпись утрачена',
  'номер не совпал',
  'дело вернули из архива',
  'второй экземпляр не найден',
];
const TITLE_NOUNS = [
  'Комната',
  'Опись',
  'Дверь',
  'Счёт',
  'Коридор',
  'Карточка',
  'Приёмная',
  'Стеллаж',
  'Журнал',
  'Квитанция',
  'Архив',
  'Лестница',
];

function pick(list, key) {
  const at = ((key % list.length) + list.length) % list.length;
  return list[at];
}

function capital(text) {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * One sentence. The first of a paragraph carries the record number (`Запись 9.12`), which is how
 * two paragraphs are told apart; the rest are built from the pools. Pure in `(n, p, i)`.
 */
export function sentenceOf(n, p, i) {
  const key = n * 977 + p * 131 + i * 29;
  const adjective = pick(ADJECTIVES, key);
  const subject = pick(SUBJECTS, key + 1);
  const verb = pick(VERBS, key + 2);
  const object = pick(OBJECTS, key + 3);
  const place = pick(PLACES, key + 4);
  const adverb = pick(ADVERBS, key + 5);
  const remark = pick(REMARKS, key + 6);
  if (i === 0) return `Запись ${String(n)}.${String(p + 1)}: ${adjective} ${subject} ${verb} ${object} ${place}.`;
  switch (i % 4) {
    case 1:
      return `${capital(adjective)} ${subject} ${verb} ${object} ${place} ${adverb}.`;
    case 2:
      return `${capital(adjective)} ${subject} ${verb} ${object} — ${place} было тихо.`;
    case 3:
      return `${capital(subject)} сказал ${adverb}: «${remark}».`;
    default:
      return (
        `${capital(adjective)} ${subject} ${verb} ${object} ${place}, и ` +
        `${pick(SUBJECTS, key + 7)} ${pick(VERBS, key + 8)} ${pick(OBJECTS, key + 9)} ${adverb}.`
      );
  }
}

/**
 * Paragraph `p` of chapter `n`: its sentences, one space between them. The first sheet's prose
 * has no record number to start on (`numbered: false`), the chapters do.
 */
export function paragraphOf(n, p, { numbered = true } = {}) {
  const count = sentencesOf(n, p);
  const start = numbered ? 0 : 1;
  const sentences = [];
  for (let i = start; i < start + count; i += 1) sentences.push(sentenceOf(n, p, i));
  return sentences.join(' ');
}

/** The canon the fixture must respect, read from the book model when the fixture is written. */
export async function canonOf() {
  const shared = await import('@book/shared');
  return {
    chapters: shared.TOTAL_CHAPTERS,
    first: shared.FRAME_FIRST_SENTENCE,
    last: shared.FRAME_LAST_SENTENCE,
  };
}

/** One chapter file: title line, blank line, paragraphs; the frame's paragraph stays canonical. */
export function chapterFile(n, canon) {
  const paragraphs = [];
  for (let p = 0; p < paragraphsOf(n); p += 1) paragraphs.push(paragraphOf(n, p));
  if (n === 1) paragraphs[0] = `${canon.first} ${paragraphs[0]}`;
  if (n === canon.chapters) paragraphs[paragraphs.length - 1] = `${paragraphs[paragraphs.length - 1]} ${canon.last}`;
  const title = `Глава ${String(n)}. ${pick(TITLE_NOUNS, n * 7)}`;
  return { name: `ch${String(n).padStart(2, '0')}.md`, text: `${title}\n\n${paragraphs.join('\n\n')}\n` };
}

/**
 * The first sheet (F021): a title line, a blank line, and an annotation of 1–12 blocks of
 * 300–4 000 characters in total, no markdown.
 */
export function frontFile(canon) {
  const blocks = [];
  for (let p = 0; p < 5; p += 1) blocks.push(paragraphOf(canon.chapters + 1, p, { numbered: false }));
  return { name: '00-front.md', text: `Книга проверки\n\n${blocks.join('\n\n')}\n` };
}

/** Every file of the fixture manuscript, the first sheet first. */
export function fixtureFiles(canon) {
  const files = [frontFile(canon)];
  for (let n = 1; n <= canon.chapters; n += 1) files.push(chapterFile(n, canon));
  return files;
}

/** What was written, for the record: counts and bytes, never the prose. */
export function fixtureStats(files) {
  let bytes = 0;
  let blocks = 0;
  for (const file of files) {
    bytes += Buffer.byteLength(file.text, 'utf8');
    blocks += file.text.split(/\n\s*\n/u).filter((block) => block.trim().length > 0).length;
  }
  return { files: files.length, chapters: files.length - 1, blocks, bytes };
}

/** Write `<dir>/manuscript/` and answer its counts. The caller owns `dir` and removes it. */
export async function writeFixture(dir) {
  const canon = await canonOf();
  const manuscript = join(dir, 'manuscript');
  mkdirSync(manuscript, { recursive: true });
  const files = fixtureFiles(canon);
  for (const file of files) writeFileSync(join(manuscript, file.name), file.text, 'utf8');
  return fixtureStats(files);
}
