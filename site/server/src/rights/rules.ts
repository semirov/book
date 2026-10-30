/**
 * Gate B's public words (BOOK-61, BOOK-DOC-42 §3, §5).
 *
 * A model never writes the line a reader reads. The rights gate returns a **rule id**, and the
 * engine prints the one fixed Russian sentence this file holds for that id — so a coerced or
 * confused model can mislabel a filing but cannot author the sentence (BOOK-DOC-37 m7). The
 * model's English reason and the quote live in `findings`/the operator surface only.
 *
 * The sentences are `не принято: …` and nothing else. «Не принято» is Gate B's one word; it
 * never stands for a hold (Gate A, «проверяется») or for the auditor's refusal (Gate C,
 * «отклонено»), and no fourth state word exists.
 *
 * The rule table is closed. `RIGHTS_RULES` is the one list `gate.ts` (the verdict parser), the
 * operator CLI and `recordRights` read, so a rule a row stores is always a rule some surface
 * could have named.
 */

import { harmCaseOfFlags, type HarmCase } from '@book/shared';

import { STOP_RULES } from './stoplist.ts';

/** The ids Gate B may refuse with. `RIGHTS-FLAG` is not one: a flag is not a refusal. */
export type RightsRuleId =
  | 'RIGHTS-STOP'
  | 'RIGHTS-QUOTE'
  | 'RIGHTS-PERSON'
  | 'RIGHTS-PARAPHRASE'
  | (typeof STOP_RULES)[number];

export const RIGHTS_RULES: readonly RightsRuleId[] = [
  'RIGHTS-STOP',
  'RIGHTS-QUOTE',
  'RIGHTS-PERSON',
  'RIGHTS-PARAPHRASE',
  ...STOP_RULES,
];

export function isRightsRule(value: string): value is RightsRuleId {
  return (RIGHTS_RULES as readonly string[]).includes(value);
}

/**
 * The fixed sentences. `STOP-PERSON` and `RIGHTS-PERSON` share one line because they answer one
 * question — is this a real person or somebody else's hero — asked by the scan and by the model
 * respectively. `STOP-MINOR` and the three instruction categories own a line each: a refusal
 * says **which** of the harm lock's four cases it is (owner's ruling, 2026-10-29), and the
 * blanket «содержимое вне закона» stays only for the law categories that have no case of their
 * own (`STOP-EXTREMISM`, `STOP-HATE`, `RIGHTS-STOP`).
 */
export const RIGHTS_COPY = {
  quote: 'не принято: чужая цитата без источника',
  paraphrase: 'не принято: пересказ чужого текста без источника',
  person: 'не принято: реальный человек или чужой герой',
  minor: 'не принято: с ребёнком и сексом — нельзя',
  instructions: 'не принято: инструкция, как причинить вред — в книге такого не будет',
  other: 'не принято: содержимое вне закона',
} as const;

/**
 * The line a reader is owed for a rule id. Unknown ids get `null`: `recordRights` refuses to
 * write a refusal without a sentence, so this is a guard against a bad caller, not a default
 * verdict (there is no default verdict anywhere in Gate B).
 */
export function rightsRefusalLine(rule: string): string | null {
  if (rule === 'RIGHTS-QUOTE') return RIGHTS_COPY.quote;
  if (rule === 'RIGHTS-PARAPHRASE') return RIGHTS_COPY.paraphrase;
  if (rule === 'STOP-PERSON' || rule === 'RIGHTS-PERSON' || rule === 'STOP-DEFAME') return RIGHTS_COPY.person;
  if (rule === 'STOP-MINOR') return RIGHTS_COPY.minor;
  if (rule === 'STOP-DRUGS' || rule === 'STOP-WEAPON' || rule === 'STOP-SELFHARM') return RIGHTS_COPY.instructions;
  if (rule === 'RIGHTS-STOP' || rule.startsWith('STOP-')) return RIGHTS_COPY.other;
  return null;
}

/**
 * A refusal no operator may release: the law's categories and the real-person class. A false
 * positive is fixed by editing the list, not by an exception (BOOK-DOC-42 §3, §5).
 *
 * `RIGHTS-QUOTE` **and** `RIGHTS-PARAPHRASE` are releasable: both are a judgement about
 * provenance, made by a model over text it could misread, so an operator who can name the
 * source may lift them. Everything else here is the law or a real person (BOOK-61 review B5).
 */
export function isListRefusal(rule: string): boolean {
  return rule === 'RIGHTS-STOP' || rule.startsWith('STOP-') || rule === 'RIGHTS-PERSON';
}

/** The provenance refusals an operator may lift with a reason (`feedback.mjs release`). */
export function isReleasableRights(rule: string): boolean {
  return rule === 'RIGHTS-QUOTE' || rule === 'RIGHTS-PARAPHRASE';
}

/**
 * Which of the harm lock's four cases a rule names, or null for a rule that is not the harm
 * lock's (a quote or a paraphrase is provenance — the `rights` lock, «это не ваш текст»).
 *
 * The mapping is by the rule's own meaning, not by its list membership: a rule that a reader
 * could follow (a recipe, a weapon, a method to hurt oneself) is case 1; a real person, with an
 * accusation on top, is case 2; a child is case 3; the rest of the law is case 4. `STOP-TERROR`
 * is mixed («оправдание терроризма, инструкции, вербовка»), so it takes the widest case.
 */
export function harmCaseOfRule(rule: string | null | undefined): HarmCase | null {
  if (rule === null || rule === undefined) return null;
  if (rule === 'STOP-MINOR') return 'minor-sexual';
  if (rule === 'STOP-PERSON' || rule === 'RIGHTS-PERSON' || rule === 'STOP-DEFAME') return 'real-person';
  if (rule === 'STOP-DRUGS' || rule === 'STOP-WEAPON' || rule === 'STOP-SELFHARM') return 'instructions';
  if (rule === 'RIGHTS-STOP' || rule === 'STOP-EXTREMISM' || rule === 'STOP-TERROR' || rule === 'STOP-HATE') {
    return 'unpublishable';
  }
  // A quote or a paraphrase: a provenance judgement, and the rights lock's own sentence.
  return null;
}

/**
 * Which of the harm lock's four cases a stored filing names: the refusal's own rule is the most
 * specific fact (Gate B named the category), the stored flags are next (the scan and Gate A both
 * leave one), and a `harm` lock with neither is the law's own category — the one claim such a
 * row always made. Total, so every surface prints the same case for the same row.
 */
export function harmCaseOfFacts(facts: {
  rule?: string | null;
  flags?: readonly string[] | null;
}): HarmCase {
  return harmCaseOfRule(facts.rule ?? null) ?? harmCaseOfFlags(facts.flags ?? []) ?? 'unpublishable';
}
