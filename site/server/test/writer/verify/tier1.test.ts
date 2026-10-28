/**
 * Tier 1 (BOOK-DOC-80 §"The tiers"): the answer contract, the fact sheet's bounds and the prompt.
 *
 * The contract is the whole point of the module: `HOLDS`, `GAP` with one or two well-formed
 * findings, `UNSURE` with one line — and **everything else** is `TIER1_UNPARSED`, which the policy
 * reads as a gap. A judge nobody could understand has not said the sentence holds.
 */

import { resolve } from 'node:path';

import { splitSentences } from '@book/shared';
import { describe, expect, it } from 'vitest';

import type { RipplePlan } from '../../../src/ledger/graph/plan.ts';
import {
  TIER1_FACT_CHARS,
  TIER1_LINE_CHARS,
  TIER1_MAX_FACTS,
  TIER1_MAX_TOKENS,
  buildTier1Prompt,
  contextOf,
  factSheet,
  judgeLocally,
  parseTier1Answer,
  tier1Line,
  tier1VerdictOf,
} from '../../../src/writer/verify/tier1.ts';

const SITE_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const BOOK_ROOT = resolve(SITE_ROOT, '..');

function planWith(nodes: Array<{ factId: string; chapter: number; blockId: string | null; quote: string }>, seeds: Array<{ factId: string; blockId: string | null; quote: string }> = []): RipplePlan {
  return {
    changeId: 'chg_one',
    chapter: 5,
    outcome: 'ripple',
    proven: true,
    seeds: seeds.map((seed) => ({ ...seed, chapter: 5, changed: ['status'] })),
    nodes: nodes.map((node) => ({ ...node, mandatory: true, reason: 'CAUSE_CHANGED:edg', direction: 'forward', hops: 1, via: [] })),
    edges: [],
    edgeDetail: [],
    patches: [],
    closureSize: { nodes: nodes.length, edges: 0, chapters: 1, parts: 1 },
    chaptersTouched: [5],
    bounds: { chars: 4_000, usd: 0.6, iterations: 4, nodes: 1_500, edges: 3_000 },
    unresolved: [],
    truncated: false,
  };
}

describe('tier 1 — the answer contract', () => {
  it('reads a bare HOLDS', () => {
    expect(parseTier1Answer('HOLDS')).toEqual({ ok: true, verdict: 'HOLDS', findings: [] });
  });

  it('reads a GAP with one finding, four cells, a short quote', () => {
    const parsed = parseTier1Answer('GAP\nmajor · часы шли по кругу · образ не держит смысла · вернуть прежнюю фразу');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.verdict !== 'GAP') throw new Error('expected a GAP');
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({ severity: 'major', quote: 'часы шли по кругу', fix: 'вернуть прежнюю фразу' });
  });

  it('reads an UNSURE with its one line', () => {
    expect(parseTier1Answer('UNSURE: в отрывке нет факта, который можно проверить')).toEqual({
      ok: true,
      verdict: 'UNSURE',
      line: 'в отрывке нет факта, который можно проверить',
    });
  });

  it('refuses anything else as TIER1_UNPARSED, and that verdict counts as a gap', () => {
    for (const answer of [
      '',
      'наверное, всё в порядке',
      '{"verdict":"HOLDS"}',
      'HOLDS\nи ещё пара слов',
      'GAP',
      'GAP\nmajor · цитата · дефект',
      'GAP\nmajor · цитата · дефект · правка\nminor · вторая · дефект · правка\nminor · третья · дефект · правка',
      `GAP\nmajor · ${'слово '.repeat(11)} · дефект · правка`,
      `GAP\nmajor · цитата · ${'д'.repeat(TIER1_LINE_CHARS)} · правка`,
      'UNSURE',
      'UNSURE: одна строка\nвторая строка',
    ]) {
      const parsed = parseTier1Answer(answer);
      expect(parsed.ok, answer).toBe(false);
      expect(tier1VerdictOf(parsed)).toBe('TIER1_UNPARSED');
    }
  });

  it('strips one surrounding fence and keeps the body', () => {
    expect(parseTier1Answer('```text\nHOLDS\n```')).toEqual({ ok: true, verdict: 'HOLDS', findings: [] });
  });

  it('summarises a verdict in one bounded line', () => {
    expect(tier1Line({ ok: true, verdict: 'HOLDS', findings: [] })).toBe('HOLDS');
    expect(tier1Line(parseTier1Answer('nonsense')).startsWith('TIER1_UNPARSED')).toBe(true);
  });
});

describe('tier 1 — the fact sheet', () => {
  it('puts the facts inside the changed paragraphs first, and is bounded twice', () => {
    const plan = planWith(
      [
        { factId: 'f:far', chapter: 9, blockId: 'ch09#aa', quote: 'далёкий факт' },
        { factId: 'f:near', chapter: 5, blockId: 'ch05#bb', quote: 'близкий факт' },
      ],
      [{ factId: 'f:seed', blockId: 'ch05#cc', quote: 'факт внутри правки' }],
    );
    const sheet = factSheet(plan, ['ch05#bb', 'ch05#cc']);
    expect(sheet.map((fact) => fact.factId)).toEqual(['f:near', 'f:seed', 'f:far']);
  });

  it('clips a quote and never returns more than twelve facts', () => {
    const nodes = Array.from({ length: 20 }, (_, index) => ({
      factId: `f:${String(index).padStart(2, '0')}`,
      chapter: 5,
      blockId: null,
      quote: 'ф'.repeat(TIER1_FACT_CHARS + 40),
    }));
    const sheet = factSheet(planWith(nodes), []);
    expect(sheet).toHaveLength(TIER1_MAX_FACTS);
    for (const fact of sheet) expect(fact.quote.length).toBeLessThanOrEqual(TIER1_FACT_CHARS);
  });

  it('is empty without a plan: a change with no closure has no claims to keep', () => {
    expect(factSheet(null, [])).toEqual([]);
  });
});

describe('tier 1 — the context', () => {
  it('reads a deleted sentence from the gap, not from the chapter’s tail', () => {
    const text =
      'Первый час шёл снег. Второй час стало тихо. Третий час вышел Петров. Четвёртый час дорога. Пятый час конец.';
    const sentences = splitSentences(text);
    expect(sentences).toHaveLength(5);
    // A deletion is a zero-width region where the sentence stood.
    const gap = { start: sentences[1]?.start ?? 0, end: sentences[1]?.start ?? 0 };
    const context = contextOf(text, gap);
    // The sentences around the gap, with the usual two neighbours each way — never the chapter's
    // last sentence, which is what the old fallback read.
    expect(context.from).toBe(sentences[0]?.start);
    expect(context.to).toBe(sentences[3]?.end);
    expect(context.text).toContain('Первый час шёл снег.');
    expect(context.text).toContain('Третий час вышел Петров.');
    expect(context.text).not.toContain('Пятый час конец.');
  });

  it('anchors a zero-width region inside a sentence at that sentence', () => {
    const text = 'Первый час шёл снег. Второй час стало тихо. Третий час вышел Петров.';
    const sentences = splitSentences(text);
    const inside = (sentences[1]?.start ?? 0) + 4;
    const context = contextOf(text, { start: inside, end: inside }, 0);
    expect(context.from).toBe(sentences[1]?.start);
    expect(context.to).toBe(sentences[1]?.end);
    expect(context.text).toBe('Второй час стало тихо.');
  });

  it('falls back to the whole text when there is no sentence to anchor on', () => {
    expect(contextOf('', { start: 0, end: 0 })).toEqual({ text: '', from: 0, to: 0 });
    // Whitespace has no sentence either: the whole text, trimmed, is what the judge is shown.
    expect(contextOf('   ', { start: 1, end: 1 })).toEqual({ text: '', from: 0, to: 3 });
  });
});

describe('tier 1 — the prompt', () => {
  it('reads the canon, the writer role and the protocol in the prefix, and the span plus facts in the tail', () => {
    const text = `Глава двенадцатая\n\nПервый час шёл снег. Потом стало тихо. Петров вышел на лёд. Дальше дорога.`;
    const span = contextOf(text, { start: text.indexOf('Потом'), end: text.indexOf('Потом') + 5 });
    const prompt = buildTier1Prompt({
      bookRoot: BOOK_ROOT,
      chapter: 12,
      span: span.text,
      facts: [{ factId: 'f:seed', chapter: 12, quote: 'Петров вышел на лёд' }],
    });
    // The canon (shared with the writer and the gates), then the protocol of the three questions.
    expect(prompt.system).toContain('### concept/CONCEPT.md');
    expect(prompt.system).toContain('## Три вопроса, на которые ты отвечаешь');
    expect(prompt.system).toContain('`UNSURE`');
    expect(prompt.system).toContain('`HOLDS`');
    expect(prompt.user).toContain('Потом стало тихо.');
    // ± 2 sentences: the neighbours are there, and so is the fact.
    expect(prompt.user).toContain('Первый час шёл снег.');
    expect(prompt.user).toContain('f:seed');
    expect(prompt.prefixSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(TIER1_MAX_TOKENS).toBe(2_000);
  });

  it('says plainly when the span asserts nothing', () => {
    const prompt = buildTier1Prompt({ bookRoot: BOOK_ROOT, chapter: 12, span: 'Первый час шёл снег.', facts: [] });
    expect(prompt.user).toContain('фактов в этом фрагменте нет');
  });
});

describe('tier 1 — the call', () => {
  it('passes the answer through the seam and prices nothing of its own', async () => {
    const prompt = buildTier1Prompt({ bookRoot: BOOK_ROOT, chapter: 12, span: 'Первый час шёл снег.', facts: [] });
    const lines: string[] = [];
    const run = await judgeLocally({
      prompt,
      ask: async (messages) => {
        expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
        return { text: 'HOLDS', usage: { in: 10, out: 2, cachedIn: 0 } };
      },
      log: (line) => lines.push(line),
    });
    expect(run.verdict).toEqual({ ok: true, verdict: 'HOLDS', findings: [] });
    expect(run.usage).toEqual({ in: 10, out: 2, cachedIn: 0 });
    expect(lines.join('\n')).toContain('tier 1: HOLDS');
  });

  it('turns a failed call into TIER1_UNPARSED, never into a HOLDS', async () => {
    const prompt = buildTier1Prompt({ bookRoot: BOOK_ROOT, chapter: 12, span: 'Первый час шёл снег.', facts: [] });
    const run = await judgeLocally({
      prompt,
      ask: async () => {
        throw new Error('engine said no');
      },
      log: () => undefined,
    });
    expect(run.usage).toBeNull();
    expect(tier1VerdictOf(run.verdict)).toBe('TIER1_UNPARSED');
  });
});
