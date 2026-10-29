/**
 * The prose and the answers the extractor's own tests are judged against (BOOK-185, BOOK-DOC-77).
 *
 * Synthetic on purpose: the real chapters carry the lessons (`rules.test.ts` reads them), and a
 * failure here must name a mechanism — an id, a role, a retired row — not a sentence of the book.
 * The chapter is shaped so every carrier the brief asks for is present once: a date, a paper of
 * this chapter, a paper an earlier chapter established, and a thread the two moves run through.
 */

import type { Pipeline } from '../../src/pipeline.ts';
import type { Provider, ProviderAnswer } from '../../src/graph/extract.ts';

export const AT = '2026-10-28T00:00:00Z';
export const AT_LATER = '2026-10-29T00:00:00Z';

/** The pin, as `config/pipeline.json` shapes it — the rates a test's money is computed from. */
export const PIPELINE: Pipeline = {
  provider: 'deepseek',
  model: 'deepseek/deepseek-flash',
  endpoint: 'https://api.example.invalid/v1/chat/completions',
  maxOutputTokens: 8192,
  apiModel: 'deepseek-flash',
  pricing: {
    currency: 'USD',
    per: 1_000_000,
    input: 0.28,
    output: 0.42,
    cacheRead: 0.028,
    source: 'test',
    date: '2026-10-28',
  },
};

/** Chapter 1: the paper the book holds before the chapter under extraction. */
export const CH1: string[] = ['Номер 65/11877/арх выдан в канцелярии.'];

/** Chapter 2: a date, a second paper, and a use of chapter 1's paper. */
export const CH2: string[] = [
  'Акт датирован 14.09.2065.',
  'По делу № 65/11877/арх составлен акт 77/1/арх.',
  'Дело 65/11877/арх ведёт Сорокин.',
];

/** Chapter 3: a later chapter that consumes chapter 2's paper — the one a retirement can orphan. */
export const CH3: string[] = ['Дело 65/11877/арх и акт 77/1/арх лежат в сейфе.'];

/**
 * Padding that makes chapter 2 count as a **written** chapter: `MIN_PROSE_CHARS` is 1000, and a
 * chapter under it may legitimately yield nothing, which is exactly the case a refusal must not
 * cover. Long enough on its own, so the fixture does not count characters by hand.
 */
export const LONG_TAIL = 'Служебный текст продолжается, чтобы глава считалась написанной. '.repeat(20);

export const ANSWER_CH1 = {
  facts: [
    {
      ref: 'f1',
      kind: 'document',
      value: '65/11877/арх',
      term: '65/11877/арх',
      quote: 'Номер 65/11877/арх',
    },
  ],
  uses: [],
  edges: [],
  threads: [],
};

/** Two facts, one use, one document edge and one thread with two moves. */
export const ANSWER_CH2 = {
  facts: [
    { ref: 'f1', kind: 'date', value: '14.09.2065', term: '14.09.2065', quote: '14.09.2065' },
    { ref: 'f2', kind: 'document', value: '77/1/арх', term: '77/1/арх', quote: 'акт 77/1/арх' },
  ],
  uses: [{ kind: 'document', value: '65/11877/арх', quote: 'делу № 65/11877/арх' }],
  edges: [
    {
      from: 'f2',
      to: { key: 'document:65-11877-арх' },
      kind: 'document',
      quote: 'акт 77/1/арх',
      statement: 'акт 77/1/арх составлен по делу 65/11877/арх',
    },
  ],
  threads: [
    {
      label: 'дело 65/11877/арх',
      direction: 'forward',
      events: [
        { kind: 'opened', fact: 'f2', note: 'акт составлен' },
        { kind: 'advanced', fact: 'f2' },
      ],
    },
  ],
};

/** The forced re-extraction of chapter 2: the second paper is gone, the date is restated. */
export const ANSWER_CH2_NARROWED = {
  facts: [{ ref: 'f1', kind: 'date', value: '14.09.2065', term: 'акт от 14.09.2065', quote: '14.09.2065' }],
  uses: [{ kind: 'document', value: '65/11877/арх', quote: 'делу № 65/11877/арх' }],
  edges: [],
  threads: [],
};

export const ANSWER_CH3 = {
  facts: [],
  uses: [{ kind: 'document', value: '77/1/арх', quote: 'акт 77/1/арх' }],
  edges: [],
  threads: [],
};

export function answerText(answer: unknown): string {
  return JSON.stringify(answer);
}

export type FakeProvider = Provider & { calls: Array<{ system: string; user: string; maxTokens?: number }> };

/**
 * A provider that answers from a list, and records every request: `calls === 1` is the only proof
 * that a reuse really did not ask the model. The last reply repeats when the list runs out, so a
 * repair test can name exactly two answers.
 */
export function fakeProvider(...replies: string[]): FakeProvider {
  const calls: FakeProvider['calls'] = [];
  const answer = async (request: { system: string; user: string; maxTokens?: number }): Promise<ProviderAnswer> => {
    calls.push(request);
    const text = replies.length === 0 ? '' : (replies[Math.min(calls.length - 1, replies.length - 1)] ?? '');
    return { text, model: 'deepseek-flash', usage: { in: 1000, out: 200, cached: 0 }, latencyMs: 12, finishReason: 'stop' };
  };
  const provider = answer as FakeProvider;
  provider.calls = calls;
  return provider;
}

/** One reply as the provider would report it: the text and the reason it stopped. */
export type Reply = { text: string; finishReason?: string | null };

/**
 * A provider whose replies carry their own `finish_reason` — the seam a truncation test needs. The
 * text is what was cut; the reason is the provider's own word for why, and the pass must read it.
 */
export function replyingProvider(...replies: Reply[]): FakeProvider {
  const calls: FakeProvider['calls'] = [];
  const answer = async (request: { system: string; user: string; maxTokens?: number }): Promise<ProviderAnswer> => {
    calls.push(request);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? { text: '' };
    return {
      text: reply.text,
      model: 'deepseek-flash',
      usage: { in: 1000, out: 200, cached: 0 },
      latencyMs: 12,
      finishReason: reply.finishReason ?? 'stop',
    };
  };
  const provider = answer as FakeProvider;
  provider.calls = calls;
  return provider;
}
