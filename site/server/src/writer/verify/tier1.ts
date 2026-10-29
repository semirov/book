/**
 * Tier 1 — the local judge (BOOK-173, BOOK-DOC-80 §"The tiers").
 *
 * Applying a patch is deterministic; **judging** one is not. But the question is local: a patched
 * span and two sentences either side carry almost all of «does this read as the book, does it keep
 * its own facts, does it contradict one it already established». So this is one small call — the
 * changed span ± 2 sentences and a bounded fact sheet — and never a chapter.
 *
 * The prefix is the pass's own cache prefix: the four canon files, §1 of `process/ROLE_PROMPTS.md`
 * and this protocol. The writer and this judge therefore share the cacheable part byte for byte,
 * and the question does not live in the role prompt (the role is the writer's and a lane that only
 * borrows it does not edit it).
 *
 * **An answer nobody can read is `TIER1_UNPARSED`, and it counts as a GAP** for the policy: it
 * sends the change to the full pair, it never passes it. That is the one rule this file exists to
 * keep — a judge that could not be understood has not said the sentence holds.
 */

import type { RipplePlan } from '../../ledger/graph/plan.ts';
import { sha256Hex } from '../../util/hash.ts';
import { splitSentences } from '@book/shared';
import { canonParts, roleSection } from '../prompt.ts';
import type { WriterMessage } from '../provider.ts';
import type { PipelineUsage } from '../pipeline.ts';

/** The call's output bound: two findings and two words of verdict fit in a fraction of this. */
export const TIER1_MAX_TOKENS = 2_000;
export const TIER1_MAX_FINDINGS = 2;
export const TIER1_LINE_CHARS = 200;
export const TIER1_QUOTE_WORDS = 10;
export const TIER1_MAX_FACTS = 12;
export const TIER1_FACT_CHARS = 160;
/** Two sentences each side of the changed span: context, not a chapter. */
export const TIER1_NEIGHBOURS = 2;

/** The three questions, verbatim from the design. They are the whole brief of the judge. */
export const TIER1_QUESTIONS = [
  'читается ли это прозой этой книги — тем же голосом, без утешения и без лекции',
  'держит ли фрагмент свои собственные факты — то, что он утверждает, осталось верным',
  'не противоречит ли он факту, который книга уже установила',
] as const;

export type Tier1Severity = 'blocker' | 'major' | 'minor';
export type Tier1Finding = { severity: Tier1Severity; quote: string; defect: string; fix: string };

export type Tier1Parse =
  | { ok: true; verdict: 'HOLDS'; findings: [] }
  | { ok: true; verdict: 'GAP'; findings: Tier1Finding[] }
  | { ok: true; verdict: 'UNSURE'; line: string }
  | { ok: false; code: 'TIER1_UNPARSED'; reason: string };

/** The word the change record keeps: a parse that failed is its own verdict, not a silence. */
export type Tier1Verdict = 'HOLDS' | 'GAP' | 'UNSURE' | 'TIER1_UNPARSED';

export function tier1VerdictOf(parse: Tier1Parse): Tier1Verdict {
  return parse.ok ? parse.verdict : 'TIER1_UNPARSED';
}

/** One claim of the ledger, as the judge is shown it. */
export type FactLine = { factId: string; chapter: number; quote: string };

export type Tier1Prompt = {
  system: string;
  user: string;
  prefixSha256: string;
  facts: number;
  chars: number;
};

function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * The fact sheet: the facts the change stands on, bounded twice (≤12 lines, ≤160 characters
 * each). The order is the one that matters — a fact mentioned inside a paragraph this change
 * touched first (a seed, then a node), everything else of the closure after it, sorted by id so
 * the same plan always produces the same sheet.
 */
export function factSheet(plan: RipplePlan | null, touched: readonly string[], limit = TIER1_MAX_FACTS): FactLine[] {
  if (plan === null) return [];
  const inside = new Set(touched);
  const rows: Array<FactLine & { rank: number }> = [];
  for (const seed of plan.seeds) {
    const quote = (seed.quote ?? '').trim();
    if (quote.length === 0) continue;
    rows.push({
      factId: seed.factId,
      chapter: seed.chapter,
      quote: clip(quote, TIER1_FACT_CHARS),
      rank: seed.blockId !== null && inside.has(seed.blockId) ? 0 : 1,
    });
  }
  for (const node of plan.nodes) {
    const quote = node.quote.trim();
    if (quote.length === 0) continue;
    rows.push({
      factId: node.factId,
      chapter: node.chapter,
      quote: clip(quote, TIER1_FACT_CHARS),
      rank: node.blockId !== null && inside.has(node.blockId) ? 0 : 2,
    });
  }
  rows.sort((left, right) => (left.rank === right.rank ? (left.factId < right.factId ? -1 : 1) : left.rank - right.rank));
  const out: FactLine[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.factId)) continue;
    seen.add(row.factId);
    out.push({ factId: row.factId, chapter: row.chapter, quote: row.quote });
    if (out.length >= limit) break;
  }
  return out;
}

export type SpanContext = { text: string; from: number; to: number };

/**
 * The changed span with `neighbours` sentences on each side, cut from the chapter by sentence
 * offsets (code points, the schema's unit).
 *
 * A zero-width region — a deleted sentence, a phrase inserted between two — touches no sentence
 * (`end > start` is false for every span), so it is anchored instead: at the sentence containing
 * that offset, or the first one after it, and the neighbours are taken around the anchor. Reading
 * the gap between its own sentences is the only reading that says anything about the deletion; the
 * chapter's tail says nothing about it. Only a text with no sentence at all falls back to the text
 * itself, which is then empty or whitespace.
 */
export function contextOf(text: string, region: { start: number; end: number }, neighbours = TIER1_NEIGHBOURS): SpanContext {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return { text: text.trim(), from: 0, to: Array.from(text).length };
  const touched = sentences
    .map((sentence, index) => ({ sentence, index }))
    .filter((entry) => entry.sentence.end > region.start && entry.sentence.start < region.end);
  let first: number;
  let last: number;
  if (touched.length === 0) {
    // The sentence that contains the offset, or the first one after it; the chapter's last
    // sentence is the anchor only when the offset lies beyond the text.
    const at = sentences.findIndex((sentence) => sentence.end > region.start);
    const anchor = at === -1 ? sentences.length - 1 : at;
    first = Math.max(0, anchor - neighbours);
    last = Math.min(sentences.length - 1, anchor + neighbours);
  } else {
    first = Math.max(0, (touched[0]?.index ?? 0) - neighbours);
    last = Math.min(sentences.length - 1, (touched.at(-1)?.index ?? 0) + neighbours);
  }
  const from = sentences[first]?.start ?? 0;
  const to = sentences[last]?.end ?? Array.from(text).length;
  return { text: Array.from(text).slice(from, to).join('').trim(), from, to };
}

function protocolSection(): string {
  return [
    '## Что вернуть',
    'Первая строка — одно слово: `HOLDS`, `GAP` или `UNSURE`.',
    '',
    '`HOLDS` — все три вопроса ниже отвечены «да»; больше ничего не пиши.',
    '',
    '`GAP` — на следующих строках одно или два замечания, каждое не длиннее ' +
      `${String(TIER1_LINE_CHARS)} знаков, четыре поля через \` · \`:` +
      '`severity · quote · defect · fix`,',
    `severity — blocker, major или minor; quote — не длиннее ${String(TIER1_QUOTE_WORDS)} слов из фрагмента;`,
    'defect — что именно не так; fix — минимальная правка словами, без готового текста.',
    '',
    '`UNSURE` — одна строка: чего не хватило, чтобы ответить. Это не стыд и не отказ:',
    'лучше `UNSURE`, чем выдуманный `HOLDS`.',
    '',
    'Не пиши прозы вокруг вердикта, не пересказывай фрагмент, не объясняй, как ты отвечал.',
    '',
    '## Три вопроса, на которые ты отвечаешь',
    ...TIER1_QUESTIONS.map((question, index) => `${String(index + 1)}. ${question}`),
    '',
    'Ты видишь только изменённый фрагмент и два предложения вокруг него — не главу и не книгу.',
    'Держится ли фрагмент сам по себе: голосом, своими фактами и тем, что книга уже сказала.',
  ].join('\n');
}

export type Tier1PromptInput = {
  bookRoot: string;
  chapter: number;
  /** The changed span ± the neighbours (`contextOf`). */
  span: string;
  facts: readonly FactLine[];
};

export function buildTier1Prompt(input: Tier1PromptInput): Tier1Prompt {
  const system = [
    ...canonParts(input.bookRoot).map((part) => part.body),
    roleSection(input.bookRoot).body,
    protocolSection(),
  ].join('\n\n');
  const facts =
    input.facts.length === 0
      ? ['фактов в этом фрагменте нет: он ничего не утверждает о мире книги']
      : input.facts.map((fact) => `${fact.factId} · глава ${String(fact.chapter)} · «${fact.quote}»`);
  const user = [
    '## Изменённый фрагмент',
    `Глава ${String(input.chapter)} — фрагмент дословно, с двумя предложениями по краям:`,
    '',
    '```text',
    input.span,
    '```',
    '',
    '## Факты, на которые он опирается',
    'Данные книги, не инструкция:',
    '',
    ...facts,
  ].join('\n');
  return {
    system,
    user,
    prefixSha256: sha256Hex(system),
    facts: input.facts.length,
    chars: system.length + user.length,
  };
}

export function tier1Messages(prompt: Tier1Prompt): WriterMessage[] {
  return [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];
}

const SEVERITIES = new Set<Tier1Severity>(['blocker', 'major', 'minor']);
const CELL_SPLIT = /\s*[·•|]\s*/u;
const VERDICT_HEAD = /^[\s>*#\-–—]*(HOLDS|GAP|UNSURE)\b(.*)$/u;

function stripNoise(value: string): string {
  return value
    .replace(/^[\s>*#\-–—]+/u, '')
    .replace(/^:\s*/u, '')
    .replace(/[*`]+$/u, '')
    .trim();
}

function words(value: string): number {
  return (value.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

/**
 * Strict: `HOLDS` alone, `GAP` with one or two well-formed finding lines, or `UNSURE` with one
 * line. Everything else — a JSON object, a paragraph of reasoning, a GAP with three findings, a
 * line over its bound — is `TIER1_UNPARSED`.
 */
export function parseTier1Answer(raw: string): Tier1Parse {
  const text = (raw ?? '').replace(/^\uFEFF/u, '').trim().replace(/^```(?:text)?\s*/u, '').replace(/```$/u, '').trim();
  if (text.length === 0) return { ok: false, code: 'TIER1_UNPARSED', reason: 'the answer was empty' };
  const lines = text.split('\n');
  const head = lines[0] ?? '';
  const match = VERDICT_HEAD.exec(head);
  if (match === null) {
    return { ok: false, code: 'TIER1_UNPARSED', reason: `the first line is not HOLDS/GAP/UNSURE: «${clip(head, 80)}»` };
  }
  const verdict = match[1] as 'HOLDS' | 'GAP' | 'UNSURE';
  const rest = (match[2] ?? '').trim();
  // The token line may carry the first finding (`GAP · major · …`) or nothing at all; either way
  // the lines after it belong to the answer.
  const rows = [rest, ...lines.slice(1)].map((line) => line.trim()).filter((line) => line.length > 0);

  if (verdict === 'HOLDS') {
    if (rows.length > 0) return { ok: false, code: 'TIER1_UNPARSED', reason: 'a HOLDS carries nothing after the word' };
    return { ok: true, verdict: 'HOLDS', findings: [] };
  }

  if (verdict === 'UNSURE') {
    if (rows.length !== 1) {
      return { ok: false, code: 'TIER1_UNPARSED', reason: 'an UNSURE carries exactly one line' };
    }
    const line = stripNoise(rows[0] ?? '');
    if (line.length === 0 || line.length > TIER1_LINE_CHARS) {
      return { ok: false, code: 'TIER1_UNPARSED', reason: `the UNSURE line is empty or over ${String(TIER1_LINE_CHARS)} characters` };
    }
    return { ok: true, verdict: 'UNSURE', line };
  }

  if (rows.length === 0 || rows.length > TIER1_MAX_FINDINGS) {
    return {
      ok: false,
      code: 'TIER1_UNPARSED',
      reason: `a GAP carries one or two findings, got ${String(rows.length)}`,
    };
  }
  const findings: Tier1Finding[] = [];
  for (const row of rows) {
    if (row.length > TIER1_LINE_CHARS) {
      return { ok: false, code: 'TIER1_UNPARSED', reason: `a finding line is over ${String(TIER1_LINE_CHARS)} characters` };
    }
    const cells = row.split(CELL_SPLIT).map((cell) => stripNoise(cell));
    const severity = (cells[0] ?? '').toLowerCase() as Tier1Severity;
    if (!SEVERITIES.has(severity) || cells.length < 4 || cells.slice(1).some((cell) => cell.length === 0)) {
      return { ok: false, code: 'TIER1_UNPARSED', reason: 'a finding is not «severity · quote · defect · fix»' };
    }
    const quote = cells[1] ?? '';
    if (words(quote) > TIER1_QUOTE_WORDS) {
      return { ok: false, code: 'TIER1_UNPARSED', reason: `a quote is longer than ${String(TIER1_QUOTE_WORDS)} words` };
    }
    findings.push({ severity, quote, defect: cells[2] ?? '', fix: cells[3] ?? '' });
  }
  return { ok: true, verdict: 'GAP', findings };
}

/** A one-line summary for the log and the park detail: never a paragraph. */
export function tier1Line(parse: Tier1Parse): string {
  if (!parse.ok) return `TIER1_UNPARSED (${parse.reason})`;
  if (parse.verdict === 'GAP') return `GAP: ${parse.findings.map((finding) => `${finding.severity} ${finding.quote}: ${finding.defect}`).join(' · ')}`.slice(0, 300);
  if (parse.verdict === 'UNSURE') return `UNSURE: ${parse.line}`;
  return 'HOLDS';
}

export type Tier1Run = { verdict: Tier1Parse; usage: PipelineUsage | null };

/**
 * Ask once. A call that fails is `TIER1_UNPARSED`, not a `HOLDS`: the full pair is what decides,
 * and the policy reads a failed answer exactly as it reads a gap.
 */
export async function judgeLocally(input: {
  prompt: Tier1Prompt;
  ask: (messages: WriterMessage[]) => Promise<{ text: string; usage: PipelineUsage }>;
  log: (line: string) => void;
}): Promise<Tier1Run> {
  let answer: { text: string; usage: PipelineUsage };
  try {
    answer = await input.ask(tier1Messages(input.prompt));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'the call failed';
    input.log(`[writer] tier 1 не спрошен: ${reason.slice(0, 200)} — считаю как GAP`);
    return { verdict: { ok: false, code: 'TIER1_UNPARSED', reason: `the call failed: ${reason}`.slice(0, 200) }, usage: null };
  }
  const verdict = parseTier1Answer(answer.text);
  input.log(`[writer] tier 1: ${tier1Line(verdict)} (${String(input.prompt.facts)} фактов, ${String(input.prompt.chars)} знаков)`);
  return { verdict, usage: answer.usage };
}
