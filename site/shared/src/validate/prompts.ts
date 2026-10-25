/**
 * F024 — no names in prompts (ARCHITECTURE.md §6E.2, §6E.4).
 *
 * A writer prompt that carried a person, a chapter title or a plot point would let hostile
 * input reach the *cast* instead of one sentence: the prompt is the one place where an
 * assignment stays a frame and never becomes canon. So the templates may describe the job,
 * the rules and the format — and must not contain a name the book already has.
 *
 * The rule is mechanical and narrow on purpose: an exact occurrence of a recorded dossier
 * name or of a chapter's title line inside a template is an error. It says nothing about
 * ordinary words, and a template may of course contain the word «глава».
 */

import type { Finding } from './text.ts';

export type PromptFile = { file: string; text: string };

/**
 * The names a prompt may not carry: every capitalised word of `bible/dossiers.md` and every
 * chapter title line. Kept here, next to the check, so `scripts/arch.mjs` cannot grow a
 * second definition of «a name».
 */
export function promptGuardNames(dossiers: string, chapterTitles: readonly string[]): string[] {
  const names = new Set<string>();
  for (const match of dossiers.matchAll(/[А-ЯЁA-Z][а-яёa-z-]{3,}/gu)) names.add(match[0]);
  for (const title of chapterTitles) {
    const trimmed = title.trim();
    if (trimmed.length >= 8 && trimmed.length <= 80) names.add(trimmed);
  }
  return [...names].sort();
}

/** F024 findings: one per (template, name) pair, at line 1 — a template is a whole file. */
export function checkPromptNames(prompts: readonly PromptFile[], names: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const prompt of prompts) {
    for (const name of names) {
      if (!prompt.text.includes(name)) continue;
      findings.push({
        rule: 'F024',
        severity: 'error',
        file: prompt.file,
        line: 1,
        message: `prompt carries the name «${name}»: a template names a person, never a character`,
      });
    }
  }
  return findings;
}
