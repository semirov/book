/**
 * F023 — support-file containment (ARCHITECTURE.md §13.4, §6E.3), the build half.
 *
 * The guard is a canary: every long line of a support file is a string that must not appear in
 * what the site ships. `scripts/arch.mjs` runs it against the real repository; the test runs it
 * against a fixture, so "the guard saw the file" is a fact and not a reading of the source.
 *
 * A skill is a prompt too (BOOK-5): `.opencode/skills/**` is guarded exactly like `process/` —
 * the operator's procedure is internal, never shipped text.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Support trees: the plan, the prompts, the concept, the voice — plus the retired `bible/`,
 *  kept guarded so a stray file cannot slip back in unguarded. */
export const SUPPORT_DIRS = ['bible', 'outline', 'process', 'concept', 'style'];
/** Prompt trees that live outside the book's own dirs (BOOK-5). */
export const PROMPT_FILES = ['.opencode/skills'];
export const GUARDED_DIRS = [...SUPPORT_DIRS, ...PROMPT_FILES];

/** Shorter lines are not distinctive enough to be a canary. */
export const CANARY_MIN_CHARS = 60;
const TEXT_FILE = /\.(md|txt|json)$/u;
const SHIPPED_FILE = /\.(js|css|html|svg|json)$/u;

export function walkAll(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkAll(path, out);
    else out.push(path);
  }
  return out;
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
 * The shipped files that carry a canary. A missing build is not a failure — the build gate runs
 * after this one — and no canary means nothing to compare, so both answer an empty list.
 */
export function distHits({ distDir, canaries }) {
  const hits = [];
  if (canaries.length === 0 || !existsSync(distDir)) return hits;
  for (const shipped of walkAll(distDir).filter((file) => SHIPPED_FILE.test(file))) {
    const content = readFileSync(shipped, 'utf8');
    const canary = canaries.find((candidate) => content.includes(candidate.text));
    if (canary !== undefined) hits.push({ shipped, canary });
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
