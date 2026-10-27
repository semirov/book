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
 * The three fixed sentences. `STOP-PERSON` and `RIGHTS-PERSON` share one line because they
 * answer one question — is this a real person or somebody else's hero — asked by the scan and
 * by the model respectively.
 */
export const RIGHTS_COPY = {
  quote: 'не принято: чужая цитата без источника',
  paraphrase: 'не принято: пересказ чужого текста без источника',
  person: 'не принято: реальный человек или чужой герой',
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
  if (rule === 'STOP-PERSON' || rule === 'RIGHTS-PERSON') return RIGHTS_COPY.person;
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
