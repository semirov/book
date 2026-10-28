/**
 * BOOK-179 — two checks the rubric described and nothing ran.
 *
 * The editor measured five definitions of one image in ch01 and the pass printed «HOLDS»:
 * nothing in the engine could see it, because only the model's own findings existed. These two
 * checks are deterministic, cheap and honest about being heuristics: they read the landed text
 * and answer the same shape a gate finding has, so `done` can refuse on them.
 *
 * A check that cannot see the text says nothing; it never invents a finding.
 */

import type { Finding, FindingSeverity } from '@book/shared';

/** The marks of an explanation: the sentence tells the reader what an image *means*. */
const GLOSS = [
  'это было',
  'это означало',
  'это значило',
  'это и есть',
  'то есть',
  'иными словами',
  'проще говоря',
  'по сути',
  'как если бы',
  'словно бы',
  'это называлось',
  'это и было',
];

/** Physical verbs the regulation never asks for: an act with a cost (V5/G5/S6). */
const PHYSICAL = [
  'взял',
  'взяла',
  'снял',
  'сняла',
  'бросил',
  'бросила',
  'сорвал',
  'сорвала',
  'разрезал',
  'разрезала',
  'прижал',
  'прижала',
  'ударил',
  'ударила',
  'открыл',
  'открыла',
  'закрыл',
  'закрыла',
  'вынес',
  'вынесла',
  'поставил',
  'поставила',
  'налил',
  'налила',
  'сел',
  'села',
  'встал',
  'встала',
  'поднял',
  'подняла',
  'протёр',
  'протёрла',
  'порвал',
  'порвала',
  'толкнул',
  'толкнула',
];

/** Words that make a sentence procedural: the act was required by a form, not chosen. */
const PROCEDURAL = ['форма', 'регламент', 'пункт', 'графа', 'бланк', 'журнал', 'инструкц', 'предпис'];

const SENTENCE = /[^.!?…]+[.!?…]+/gu;

function sentences(text: string): string[] {
  return (text.match(SENTENCE) ?? []).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}

/** The noun an explanation is about: the longest word of the clause before the gloss mark. */
function imageOf(sentence: string, mark: string): string | null {
  const head = sentence.slice(0, Math.max(0, sentence.toLowerCase().indexOf(mark)));
  const words = head.toLowerCase().match(/[а-яё]{5,}/gu) ?? [];
  return words.length === 0 ? null : (words[words.length - 1] ?? null);
}

function finding(severity: FindingSeverity, rule: string, location: string, defect: string, fix: string): Finding {
  return { severity, location, defect, fix, rule } as Finding;
}

/**
 * The chapter explains the same image twice or more: that is a glossed metaphor, a major.
 * One explanation is a sentence; the second is the author not trusting the first.
 */
export function metaphorGloss(text: string): Finding[] {
  // The editor's measure was five explanations of one image inside 1 400 characters: the check
  // is about proximity, not about a word repeated across a whole chapter.
  const WINDOW = 2_000;
  const marks: Array<{ image: string; at: number }> = [];
  let offset = 0;
  for (const sentence of sentences(text)) {
    const lower = sentence.toLowerCase();
    const mark = GLOSS.find((candidate) => lower.includes(candidate));
    const image = mark === undefined ? null : imageOf(sentence, mark);
    if (image !== null) marks.push({ image, at: offset });
    offset += sentence.length + 1;
  }
  const counts = new Map<string, number>();
  for (const entry of marks) {
    const near = marks.filter((other) => other.image === entry.image && Math.abs(other.at - entry.at) <= WINDOW);
    counts.set(entry.image, Math.max(counts.get(entry.image) ?? 0, near.length));
  }
  const glossed = [...counts.entries()].filter(([, count]) => count >= 2);
  if (glossed.length === 0) return [];
  const [image, count] = glossed.sort((a, b) => b[1] - a[1])[0] as [string, number];
  return [
    finding(
      'major',
      'METAPHOR_GLOSS',
      `образ «${image}»`,
      `образ «${image}» объяснён ${String(count)} раза: читателю не доверяют первый раз`,
      'оставить одно объяснение — то, без которого сцена не читается; остальные снять',
    ),
  ];
}

/**
 * The protagonist does one physical, unchosen act: without it the chapter is procedure that
 * happens *to* people. A sentence with a physical verb the regulation does not require.
 */
export function actWithCost(text: string): Finding[] {
  for (const sentence of sentences(text)) {
    const lower = sentence.toLowerCase();
    if (PROCEDURAL.some((word) => lower.includes(word))) continue;
    // `\b` is ASCII-only in JS: with Cyrillic it matches nothing, so a chapter with every act
    // in the world was flagged. The boundary is spelled with `\p{L}` instead.
    if (PHYSICAL.some((verb) => new RegExp(`(^|[^\\p{L}])${verb}([^\\p{L}]|$)`, 'u').test(lower))) return [];
  }
  return [
    finding(
      'major',
      'NO_ACT_WITH_COST',
      'глава целиком',
      'нет ни одного физического поступка, которого не требует регламент: глава только описывает порядок',
      'дать герою одно телесное действие с ценой — не предусмотренное формой и не отменяемое ею',
    ),
  ];
}

/** Both checks, in one answer `done` can refuse on. */
export function checkProse(text: string): Finding[] {
  if (text.trim().length === 0) return [];
  return [...metaphorGloss(text), ...actWithCost(text)];
}

/** The editor's answer after the deterministic checks: `GAP` wins, and the findings are all kept. */
export function withProseChecks<T extends { verdict: 'HOLDS' | 'GAP'; findings: Finding[] }>(
  parsed: T,
  checks: Finding[],
): T {
  if (checks.length === 0) return parsed;
  return { ...parsed, verdict: 'GAP', findings: [...parsed.findings, ...checks] };
}
