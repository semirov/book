/**
 * Which component of a fact a change actually moved (BOOK-173, BOOK-DOC-75 §1.2).
 *
 * The ripple's predicate asks one question of every hop: «does the target consume the part of the
 * source that changed?». Answering it needs four names, and the names must come from closed lists
 * — this module is the whole vocabulary, not a heuristic a model could bend:
 *
 *   · `value`      — a digit or a date token changed («30 дней» → «45 дней»);
 *   · `identity`   — a document **instance** changed: the noun plus the number that names it
 *                    («акт 4-У» → «акт 5-У»), so the paper is a different paper;
 *   · `status`     — a verb of the closed status list changed (выдан → аннулирован);
 *   · `existence`  — a thing the removed text named (a document noun, a proper name) is gone from
 *                    the new text entirely, with nothing in its place.
 *
 * A change of tone, word order or punctuation moves nothing: that is the answer that keeps the
 * ripple from marking a whole book mandatory for a comma. Offsets, digits and case are compared
 * after `norm`, so a re-typed sentence is not a different world.
 */

import { DOCUMENT_NOUNS } from '../../index/extract.ts';

export type Component = 'value' | 'identity' | 'status' | 'existence';

/**
 * The verbs after which a document or a state is in another state (BOOK-DOC-75 §2 asks for a
 * closed list; extending it is a code change, never a model's opinion). Stems, because Russian
 * inflects: «выдан», «выдана», «выдано» are one status.
 */
export const STATUS_VERBS = [
  'выдан',
  'подписан',
  'отказан',
  'аннулирован',
  'прекращ',
  'закрыт',
  'внес',
  'отозван',
  'утратил',
  'отмен',
  'уничтож',
  'изъят',
  'сдан',
  'исполнен',
  'назначен',
  'погашен',
  'присвоен',
  'утвержд',
  'зарегистрирован',
] as const;

const STATUS_RE = new RegExp(`(?<![\\p{L}])(?:${STATUS_VERBS.join('|')})\\p{L}*`, 'giu');

/** A digit token: `30`, `14.09.2065`, `12:30`, `65/11877`, `4-У` → `4`. */
const NUMBER_RE = /\d+(?:[.,:/]\s*\d+)*/gu;

/** The number that names a document: `14-УП`, `65/11877/арх`, `4-У`, `№ 1136`. */
const INSTANCE_NUMBER_RE = /^\s*(?:№\s*)?(\d+(?:[-/]\s*[\p{L}\d]+)*)/u;

const DOCUMENT_PATTERN = new RegExp(`(?<![\\p{L}])(?:${DOCUMENT_NOUNS.join('|')})(?![\\p{L}])`, 'giu');

/** A capitalised run: «Ковалёв», «Анна Петровна», «Северное управление». */
const CAPITALISED = /\p{Lu}\p{Ll}*(?:[ -]\p{Lu}\p{Ll}*)*/gu;

/** Capitalised words that are grammar or the beginning of a sentence, not a name. */
const STOP_WORDS = new Set([
  'он', 'она', 'оно', 'они', 'но', 'и', 'а', 'в', 'во', 'на', 'не', 'ни', 'что', 'как', 'это',
  'тот', 'та', 'те', 'все', 'весь', 'вся', 'я', 'мы', 'вы', 'ты', 'когда', 'где', 'куда', 'если',
  'только', 'даже', 'уже', 'ещё', 'еще', 'нет', 'да', 'потом', 'тогда', 'здесь', 'там', 'сейчас',
  'опять', 'снова', 'вдруг', 'однако', 'поэтому', 'потому', 'через', 'после', 'перед', 'между',
  'пока', 'словно', 'будто', 'разве', 'неужели', 'кто', 'чем', 'чей', 'свой', 'сам', 'один',
]);

/** Lowercase, ё → е, whitespace collapsed — the comparison both sides of the edit go through. */
export function norm(value: string): string {
  return value.toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

function numbersOf(text: string): string[] {
  return [...text.matchAll(NUMBER_RE)].map((match) => norm(match[0]).replace(/\s+/gu, ''));
}

/** Noun + the number that follows it — the identity of one paper, not the noun's bucket. */
export function documentInstances(text: string): Array<{ surface: string; key: string }> {
  const found: Array<{ surface: string; key: string }> = [];
  for (const match of text.matchAll(DOCUMENT_PATTERN)) {
    const tail = text.slice((match.index ?? 0) + match[0].length);
    const number = INSTANCE_NUMBER_RE.exec(tail);
    const surface = number === null ? match[0] : `${match[0]} ${number[1] ?? ''}`.trim();
    found.push({ surface, key: norm(surface) });
  }
  return found;
}

function statusWordsOf(text: string): string[] {
  return [...text.matchAll(STATUS_RE)].map((match) => norm(match[0]));
}

/**
 * The things a sentence can lose: a paper, a name. The **noun** of a document counts, not its
 * instance — «акт 4-У» → «акт 5-У» is another paper (identity), not a paper that stopped existing.
 */
function contentWords(text: string): string[] {
  const found: string[] = [];
  for (const instance of documentInstances(text)) found.push(norm(instance.surface.split(' ')[0] ?? ''));
  for (const match of text.matchAll(CAPITALISED)) {
    const key = norm(match[0]);
    if (key.length < 2 || STOP_WORDS.has(key)) continue;
    found.push(key);
  }
  return found;
}

function occurrencesOf(text: string, needle: string): number {
  if (needle === '') return 0;
  return norm(text).split(needle).length - 1;
}

/** Is a token still somewhere in the new text (a word, not a substring of an unrelated word)? */
function stillThere(after: string, word: string): boolean {
  const haystack = norm(after);
  return new RegExp(`(?<![\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\p{L}])`, 'u').test(haystack);
}

const same = (left: string[], right: string[]): boolean =>
  left.length === right.length && [...left].sort().join('\u0000') === [...right].sort().join('\u0000');

/**
 * The components an edit moved, oldest question first: a digit, an instance, a status, a thing.
 * Empty when the edit changed no component — the honest answer for a comma, and the one the
 * ripple needs to keep its hands off the rest of the book.
 */
export function movedComponents(before: string, after: string): Set<Component> {
  const moved = new Set<Component>();
  if (before === after) return moved;
  if (!same(numbersOf(before), numbersOf(after))) moved.add('value');
  // A bucket (a noun with no number) is not an identity: «заявление» and «акт» are classes, and
  // the ledger's own thinness was exactly that collapse. Only a numbered instance is compared.
  const numbered = (text: string): string[] =>
    documentInstances(text)
      .map((instance) => instance.key)
      .filter((key) => /\d/u.test(key));
  if (!same(numbered(before), numbered(after))) moved.add('identity');
  if (!same(statusWordsOf(before), statusWordsOf(after))) moved.add('status');
  for (const word of contentWords(before)) {
    if (occurrencesOf(before, word) > occurrencesOf(after, word) && !stillThere(after, word)) {
      moved.add('existence');
      break;
    }
  }
  return moved;
}
