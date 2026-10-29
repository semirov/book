/**
 * The fixture chapter the validator is judged against (BOOK-185, BOOK-DOC-77 §3).
 *
 * One synthetic chapter carries every shape the rules need: ch04's question, ch15's list of dates,
 * a document number, a signature, a promise with a deadline and an absence. Each test states which
 * rule it proves; this file only supplies the prose and the code-retrieved lists.
 */

import type { LooseAnswer } from '../../src/graph/schema.ts';
import type { Block, EstablishedFact, ThreadHint, ValidateInput, ValidateResult } from '../../src/graph/validate.ts';
import { validateAnswer } from '../../src/graph/validate.ts';

export const BLOCKS: Block[] = [
  // ch04's question: a wish to know, no signature.
  { id: 'b1', text: '— Не знаю. Но я хочу знать, кто подписал мой акт.' },
  { id: 'b2', text: 'Сорокин Андрей Викторович подписал отказ. Номер 65/11877/арх.' },
  { id: 'b3', text: 'Даты в деле: 14.09.2065, 19.02, 20.02 и 03.03.' },
  { id: 'b4', text: 'Я вернусь до 19.02. Это называется правом удержания.' },
  { id: 'b5', text: 'Сорокина больше нет в живых.' },
  { id: 'b6', text: 'Документ 77/1/арх лежит в сейфе.' },
];

export const ESTABLISHED: EstablishedFact[] = [
  { id: 'fact_doc', key: 'document:65-11877-арх', kind: 'document', chapter: 3, term: '65/11877/арх' },
  { id: 'fact_promise', key: 'promise:вернуться@--02-19', kind: 'promise', chapter: 4, term: 'вернуться до 19.02' },
  { id: 'fact_late', key: 'document:77-1-арх', kind: 'document', chapter: 9, term: '77/1/арх' },
];

export const THREADS: ThreadHint[] = [
  { id: 'thr_deal', label: 'дело 65/11877/арх', state: 'opened' },
  { id: 'thr_closed', label: 'закрытая линия', state: 'closed' },
];

export function emptyAnswer(): LooseAnswer {
  return { facts: [], uses: [], edges: [], threads: [] };
}

export function run(answer: Partial<LooseAnswer>, over: Partial<ValidateInput> = {}): ValidateResult {
  return validateAnswer({
    chapter: 5,
    blocks: BLOCKS,
    established: ESTABLISHED,
    threads: THREADS,
    answer: { ...emptyAnswer(), ...answer },
    ...over,
  });
}

export const DOC_FACT = {
  ref: 'f1',
  kind: 'document',
  value: '65/11877/арх',
  term: '65/11877/арх',
  quote: 'Номер 65/11877/арх',
} as const;

export const NAME_FACT = {
  ref: 'f2',
  kind: 'name',
  value: 'Сорокин Андрей Викторович',
  quote: 'Сорокин Андрей Викторович',
} as const;

export const DECISION_FACT = {
  ref: 'f3',
  kind: 'decision',
  value: 'подписать@отказ',
  quote: 'подписал отказ',
} as const;

