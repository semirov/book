/**
 * F023 — support-file containment (ARCHITECTURE.md §13.4, §6E.3), the build half.
 *
 * The guard is a canary: every long line of a support file is a string that must not appear in
 * what the site ships. `scripts/arch.mjs` runs it against the real repository; the test runs it
 * against a fixture, so "the guard saw the file" is a fact and not a reading of the source.
 *
 * A skill is a prompt too (BOOK-5): `.opencode/skills/**` is guarded exactly like `process/` —
 * the operator's procedure is internal, never shipped text. `notes/` is guarded as well: it holds
 * `canon-constraints.md`, which `README.md` calls canon and the site must never print.
 *
 * The comparison is normalised (BOOK-46): a formatter may split a sentence with a newline and
 * indentation, wrap it in `{'…'}`, add emphasis, escape the reflow as `\n` in a string (what a
 * minifier emits), or render an entity, and a reflow is still the same leak.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Support trees: the plan, the prompts, the concept, the voice — plus the retired `bible/`,
 *  kept guarded so a stray file cannot slip back in unguarded. */
export const SUPPORT_DIRS = ['bible', 'outline', 'process', 'concept', 'style'];
/** Prompt trees that live outside the book's own dirs (BOOK-5). */
export const PROMPT_FILES = ['.opencode/skills'];
/** `notes/` is read by the writer and the editor, never by the site (canon constraints). */
export const GUARDED_DIRS = [...SUPPORT_DIRS, ...PROMPT_FILES, 'notes'];

/** Shorter lines are not distinctive enough to be a canary. */
export const CANARY_MIN_CHARS = 60;
/**
 * A canary whose normalised form is shorter than this would match half the bundle by accident
 * (a line of mostly markup strips down to a few common words), so it is not used for matching.
 * The raw test above stays at 60: the floor only guards the looser, punctuation-free comparison.
 */
export const CANARY_MIN_NORMALISED = 40;

/**
 * The frozen frame (F029), printed by the site by design: chapter 1 and chapter 67. A support file
 * may quote it — `notes/canon-constraints.md` does — so it is public text, not evidence of a leak,
 * and the guard subtracts it from both sides. The line still has to carry its own words to count.
 *
 * `archPromptFiles.test.ts` asserts both sentences are still the first line of the manuscript
 * files, so this allowlist cannot drift away from the book it excuses.
 */
export const PUBLIC_TEXT = [
  'Я вошёл в пустую комнату. Её освещал яркий свет.',
  'Свет погас, потому что не осталось глаз, которым он был бы нужен.',
];

const TEXT_FILE = /\.(md|txt|json)$/u;
const SHIPPED_FILE = /\.(js|css|html|svg|json)$/u;

/**
 * Markdown, JSX, escape and typographic punctuation: a formatter adds it, so it carries no identity.
 * ASCII `-` is in the class on purpose (BOOK-46 m7): `—`, `--`, `&mdash;` and `-` are one dash to a
 * reader, and stripping only the typographic form let a formatter swap one for the other.
 */
const PUNCTUATION = /[`"'*_~#>|(){}<>\[\]«»„“”‘’—–…•·\\-]/gu;

/** HTML entities a shipped page or a JSON payload may carry instead of the character itself. */
const NAMED_ENTITIES = new Map([
  ['laquo', '«'],
  ['raquo', '»'],
  ['mdash', '—'],
  ['ndash', '–'],
  ['nbsp', ' '],
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
]);
const ENTITY = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(laquo|raquo|mdash|ndash|nbsp|amp|lt|gt|quot));/gu;

/** A code point in range, or the source text unchanged — a broken escape must not crash the gate. */
function codePointOr(value, fallback) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : fallback;
}

/**
 * Escapes and entities decoded, because a build carries the text in an escaped form: a minifier
 * writes a reflow as `\n` inside one string, a page writes `&mdash;`. Order matters: `\u{…}` before
 * `\uXXXX` (both begin with `\u`), and `\\` last so an escaped backslash is not read as the start of
 * a second escape. `\b` and `\f` answer a space: they are whitespace to a formatter, not text.
 */
export function decodeEscapes(text) {
  return text
    .replace(ENTITY, (match, decimal, hex, name) => {
      if (decimal !== undefined) return codePointOr(Number(decimal), match);
      if (hex !== undefined) return codePointOr(Number.parseInt(hex, 16), match);
      return NAMED_ENTITIES.get(name) ?? match;
    })
    .replace(/\\u\{([0-9a-fA-F]+)\}/gu, (match, hex) => codePointOr(Number.parseInt(hex, 16), match))
    .replace(/\\u([0-9a-fA-F]{4})/gu, (match, hex) => codePointOr(Number.parseInt(hex, 16), match))
    .replace(/\\n/gu, '\n')
    .replace(/\\r/gu, '\r')
    .replace(/\\t/gu, '\t')
    .replace(/\\[bf]/gu, ' ')
    .replace(/\\\\/gu, '\\');
}

export function walkAll(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkAll(path, out);
    else out.push(path);
  }
  return out;
}

/** A path that can be walked: absent paths and paths that are a file both answer false. */
function isDirectory(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

/**
 * Both sides of a comparison pass through here, so a reflow still matches while a sentence keeps
 * its words: escapes decoded, punctuation becomes a space, every whitespace run becomes one space.
 */
export function normaliseForCompare(text) {
  return decodeEscapes(text).replace(PUNCTUATION, ' ').replace(/\s+/gu, ' ').trim();
}

const PUBLIC_NORMALISED = PUBLIC_TEXT.map(normaliseForCompare);

/** The frozen frame is public on both sides, so it is removed from canary and bundle alike. */
function withoutPublicText(normalised) {
  let text = normalised;
  for (const publicText of PUBLIC_NORMALISED) text = text.split(publicText).join(' ');
  return text.replace(/\s+/gu, ' ').trim();
}

/** One side of the guard: the comparison form, minus the text the site prints by design. */
function comparableText(text) {
  return withoutPublicText(normaliseForCompare(text));
}

/** Every long line of every guarded tree, as `{file, text}`. */
export function collectCanaries(bookRoot, dirs = GUARDED_DIRS) {
  const canaries = [];
  for (const dir of dirs) {
    const root = join(bookRoot, dir);
    if (!existsSync(root)) continue;
    for (const file of walkAll(root)) {
      if (!TEXT_FILE.test(file)) continue;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const text = line.replace(/^[\s#>*\-]+/u, '').trim();
        if (text.length >= CANARY_MIN_CHARS) canaries.push({ file, text });
      }
    }
  }
  return canaries;
}

/**
 * The shipped files that carry a canary. A missing build is not a failure here — a dev/test run
 * has not built yet, and `missingDistProblem` says what a release run does about it — and no
 * canary means nothing to compare, so both answer an empty list. A build path that is not a
 * directory is skipped, not walked: `readdirSync` would throw `ENOTDIR` (BOOK-46 n8).
 */
export function distHits({ distDir, canaries }) {
  const hits = [];
  if (canaries.length === 0 || !isDirectory(distDir)) return hits;
  const matchable = canaries
    .map((canary) => ({ canary, normalised: comparableText(canary.text) }))
    .filter((entry) => entry.normalised.length >= CANARY_MIN_NORMALISED);
  for (const shipped of walkAll(distDir).filter((file) => SHIPPED_FILE.test(file))) {
    const content = comparableText(readFileSync(shipped, 'utf8'));
    const hit = matchable.find((entry) => content.includes(entry.normalised));
    if (hit !== undefined) hits.push({ shipped, canary: hit.canary });
  }
  return hits;
}

/**
 * F023 exactly as the build gate states it: one `{file, message}` per shipped file that carries a
 * support line. `scripts/arch.mjs` only prints these, so the exit path is testable here.
 */
export function f023Problems({ bookRoot, distDir }) {
  return distHits({ distDir, canaries: collectCanaries(bookRoot) }).map((hit) => ({
    file: hit.shipped,
    message: `F023: ships a line of the support file ${relative(bookRoot, hit.canary.file)}`,
  }));
}

const MISSING_DIST = 'F023: web/dist is missing — a release build has no bundle to guard';

/**
 * A release build must carry a bundle, or the canary compares against nothing and the guard passes
 * for the wrong reason. "No bundle" is a missing path, a path that is a file instead of a directory
 * (BOOK-46 n8), or a directory that holds no shipped file (an empty build). A dev/test run has not
 * built yet, so it asks for no failure.
 */
export function missingDistProblem({ distDir, requireDist }) {
  if (!requireDist) return null;
  if (!existsSync(distDir)) return { file: distDir, message: MISSING_DIST };
  if (!statSync(distDir).isDirectory()) {
    return { file: distDir, message: 'F023: the build path is a file, not a bundle directory — nothing to guard' };
  }
  const shipsSomething = walkAll(distDir).some((file) => SHIPPED_FILE.test(file));
  return shipsSomething ? null : { file: distDir, message: MISSING_DIST };
}
