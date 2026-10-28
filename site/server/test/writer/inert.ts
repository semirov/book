/**
 * Inert prose for the writer's fixtures — and specifically prose with **no repeated 6-gram**.
 *
 * Tier 0 (BOOK-DOC-80) refuses a patch whose changed span repeats six words, so a fixture built by
 * repeating one filler sentence now fails on the invariant instead of on the thing the test is
 * about. This module generates a deterministic word stream instead: the words come from a small
 * closed list through a multiplicative hash, so a six-word window repeats only by astronomical
 * coincidence, the text has no digits and no markdown, and two runs of the same call produce the
 * same bytes (a fixture must be a constant, not a lottery).
 */

const WORDS = [
  'абзац',
  'бумага',
  'время',
  'город',
  'дверь',
  'дело',
  'дорога',
  'запись',
  'зима',
  'знак',
  'книга',
  'комната',
  'конец',
  'край',
  'лампа',
  'лист',
  'место',
  'минута',
  'мост',
  'начало',
  'небо',
  'ночь',
  'окно',
  'опись',
  'очередь',
  'папка',
  'письмо',
  'полка',
  'порядок',
  'путь',
  'работа',
  'рука',
  'свет',
  'село',
  'смена',
  'срок',
  'стена',
  'стол',
  'страница',
  'счёт',
  'тень',
  'тетрадь',
  'тишина',
  'труд',
  'улица',
  'утро',
  'форма',
  'холод',
  'час',
  'шум',
] as const;

/** One word of the stream: a Weyl sequence over the closed list, so windows do not align. */
function wordAt(index: number): string {
  const mixed = Math.imul(index + 7, 2_654_435_761) >>> 0;
  return WORDS[mixed % WORDS.length] as string;
}

/**
 * At least `chars` characters of prose, cut at a sentence boundary: sentences of 5–9 words, so
 * no sentence is shorter than three words and none is anywhere near the 320-character bound.
 */
export function inertProse(chars: number, seed = 0): string {
  const sentences: string[] = [];
  let total = 0;
  let index = seed;
  while (total < chars) {
    const length = 5 + (index % 5);
    const words: string[] = [];
    for (let offset = 0; offset < length; offset += 1) {
      words.push(wordAt(index + offset * 7));
    }
    index += length;
    const first = words[0] ?? 'абзац';
    words[0] = `${first.charAt(0).toUpperCase()}${first.slice(1)}`;
    const sentence = `${words.join(' ')}.`;
    sentences.push(sentence);
    total += sentence.length + 1;
  }
  return sentences.join(' ');
}

/** A paragraph: the marker sentence, then the inert stream. */
export function inertParagraph(marker: string, chars: number): string {
  return `${marker} ${inertProse(chars, marker.length)}`;
}
