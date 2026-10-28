/**
 * Where a quote sits in its paragraph — one sentence index, or nothing (BOOK-174 §5).
 *
 * A filing's fifth column is the sentence it lands in, so the report can name
 * «глава 12 · абзац 4 · предложение 2». This locator answers the one question that needs:
 * does the quote lie inside **exactly one** sentence, and which one (0-based)?
 *
 * The rules of the split, all of them about the book's own typography:
 *   • a terminator run (`!`, `?`, `…`, `.`) ends a sentence, and the closing quotes that follow
 *     it belong to that sentence, not to the next one;
 *   • nothing splits inside `«…»` — a quoted question is still one sentence;
 *   • a single capital before a word is an initial (`И. Иванов`), not a boundary;
 *   • `.` between digits (`12.03.2026`) and the `т. д.`-style abbreviation do not end a
 *     sentence.
 *
 * `shared/src/sentences.ts` (BOOK-182, PR #89) supersedes this locator: it is the book's one
 * segmenter. Ours exists only to fill the display/anchor slot on this base, where a filing's
 * sentence has no other source, and it should be replaced by the shared one when that lands.
 */

const TERMINATORS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['»', '"', '”', ')', "'"]);
/** A `.` after a one- or two-letter lowercase word is an abbreviation, not an end: «т. д.». */
const ABBREVIATION = /^\p{Ll}{1,2}$/u;
const SINGLE_CAPITAL = /^\p{Lu}$/u;

/**
 * The 0-based index of the sentence that contains `quote`, or `null` when the quote is absent
 * from the block or straddles a boundary. A quote of nothing is not a place: `null`.
 */
export function locateSentence(blockText: string | null, quote: string | null): number | null {
  if (blockText === null || quote === null) return null;
  const needle = quote.trim();
  if (needle.length === 0) return null;
  const at = blockText.indexOf(needle);
  if (at < 0) return null;
  const end = at + needle.length;
  const ends = sentenceEnds(blockText);
  // A boundary strictly inside the quote means the quote is more than one sentence: no place.
  if (ends.some((offset) => offset > at && offset < end)) return null;
  // The sentence that holds the start is the count of boundaries already behind it.
  return ends.filter((offset) => offset <= at).length;
}

/**
 * The offsets just past each sentence's end, in order. The text after the last offset (if any)
 * is a final unterminated sentence and simply has no end to record.
 */
export function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (char === '«') {
      depth += 1;
      continue;
    }
    if (char === '»') {
      // A `»` consumed below as a closing quote is counted twice; the depth is clamped at 0,
      // and the counted form is what keeps «Ты придёшь?» a boundary of its own.
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (!TERMINATORS.has(char)) continue;
    let end = index + 1;
    while (end < text.length && TERMINATORS.has(text[end] as string)) end += 1;
    // The closing quotes that follow a terminator belong to this sentence; the depth is copied,
    // so a boundary that is rejected below leaves the scan's own count untouched.
    let after = end;
    let closed = depth;
    while (after < text.length && CLOSERS.has(text[after] as string)) {
      if (text[after] === '»') closed = Math.max(0, closed - 1);
      after += 1;
    }
    if (closed > 0) continue;
    if (isNotBoundary(text, String(text[index]), index, after)) continue;
    ends.push(after);
    depth = closed;
    index = after - 1;
  }
  return ends;
}

/** The three exclusions: a decimal or a date, an abbreviation, an initial. */
function isNotBoundary(text: string, char: string, dotIndex: number, after: number): boolean {
  if (char !== '.') return false;
  const head = text.slice(0, dotIndex);
  const word = /\p{L}+$/u.exec(head)?.[0] ?? '';
  const digits = /\d+$/u.exec(head)?.[0] ?? '';
  const next = text.slice(after).trimStart();
  // `12.03.2026`, `1.5` — a point inside a number is not the end of anything.
  if (digits.length > 0 && /^\d/u.test(next)) return true;
  // «т. д.», «т. е.»: two lowercase letters and a point are an abbreviation of the register.
  if (ABBREVIATION.test(word) && /^\p{Ll}/u.test(next)) return true;
  // `И.` before a name: one capital and a point are an initial, not a boundary.
  return SINGLE_CAPITAL.test(word) && /^\p{Lu}/u.test(next);
}
