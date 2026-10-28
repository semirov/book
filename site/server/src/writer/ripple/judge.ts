/**
 * The causality judge (BOOK-173, BOOK-DOC-75 §4, §5) — one model call, over the **closure only**.
 *
 * It is the one part of the ripple a rule cannot answer: «the bytes changed are the bytes named»
 * is code, «every claim that stood on a changed fact was found» is a walk, but «does the reason
 * still lead here» is a reading. So this call is the writer lane's, deliberately (§9: the engine
 * never calls a model), and it is bounded twice: it is shown the closure — ≤40 nodes with their
 * quotes, ≤16 edges, ≤12 patches — and never a chapter, and its answer is two words plus one
 * sentence, parsed strictly.
 *
 * The prefix is the pass's own cache prefix (canon → the writer's role prompt §1 → this protocol),
 * so the call is cheap at cache-read rates; the three questions live in the protocol section of
 * this file, not in `process/ROLE_PROMPTS.md`: the role prompt is the writer's and is not edited by
 * a lane that only borrows it.
 *
 * **An unparsable answer is a refusal, never HOLDS.** A judge that could not be understood has not
 * said the book is whole, and a silent pass through a broken answer is exactly the failure this
 * module exists to stop.
 */

import { canonParts, roleSection } from '../prompt.ts';
import { sha256Hex } from '../../util/hash.ts';
import type { RipplePlan } from '../../ledger/graph/plan.ts';

/** The three questions, verbatim (BOOK-DOC-57, quoted by §5 of the design). */
export const JUDGE_QUESTIONS = [
  'назови предложение, которое стало ложным',
  'назови, кто решает в цепочке',
  'назови необратимое изменение каждой затронутой главы',
] as const;

export const JUDGE_MAX_NODES = 40;
export const JUDGE_MAX_EDGES = 16;
export const JUDGE_MAX_PATCHES = 12;
export const JUDGE_QUOTE_CHARS = 120;
export const JUDGE_SENTENCE_CHARS = 300;

export type JudgePrompt = { system: string; user: string; prefixSha256: string; nodes: number; edges: number };

export type JudgeVerdict =
  | { ok: true; verdict: 'HOLDS'; sentence: null }
  | { ok: true; verdict: 'GAP'; sentence: string }
  | { ok: false; reason: string };

/** One line of text, cut to a bound without inventing an ellipsis inside a quote. */
function clip(value: string, limit: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function protocolSection(): string {
  return [
    '## Что вернуть',
    'Ответ — одна из двух форм, и ничего больше:',
    '```',
    'HOLDS',
    '```',
    'или',
    '```',
    'GAP: одно предложение — что именно стало ложным и где',
    '```',
    'Не объясняй, не перечисляй, не пиши прозы вокруг. `GAP` без предложения не принимается.',
    '',
    '## Три вопроса, на которые ты отвечаешь',
    ...JUDGE_QUESTIONS.map((question, index) => `${String(index + 1)}. ${question}`),
    '',
    'Ты судишь только по замыканию ниже: это утверждения книги и связи между ними, а не текст глав.',
    '`HOLDS` значит: ни одно утверждение замыкания не стало ложным и ни одна цепочка не потеряла',
    'решающего звена. `GAP` значит: названное предложение стоит на том, что изменилось, и правки',
    'в замыкании его не покрывают.',
  ].join('\n');
}

/**
 * The `user` turn: the closure as compact lines, bounded by the design's caps. Nodes are the
 * plan's own order (sorted by fact id), so the same plan always produces the same prompt — the
 * judge is a question about this closure, not a lottery.
 */
export function buildJudgePrompt(input: { bookRoot: string; plan: RipplePlan }): JudgePrompt {
  const { plan } = input;
  const nodes = plan.nodes.slice(0, JUDGE_MAX_NODES);
  const edges = plan.edgeDetail.slice(0, JUDGE_MAX_EDGES);
  const patches = plan.patches.slice(0, JUDGE_MAX_PATCHES);

  const lines: string[] = ['## Узлы замыкания', `${String(nodes.length)} из ${String(plan.nodes.length)}`];
  for (const node of nodes) {
    const quote = node.quote.length > 0 ? `«${clip(node.quote, JUDGE_QUOTE_CHARS)}»` : '(без цитаты)';
    lines.push(`${node.factId} · глава ${String(node.chapter)} · ${quote}`);
  }
  lines.push('', '## Связи', `${String(edges.length)} из ${String(plan.edgeDetail.length)}`);
  for (const edge of edges) {
    const evidence = edge.statement.length > 0 ? ` · «${clip(edge.statement, JUDGE_QUOTE_CHARS)}»` : '';
    lines.push(`${edge.from} → ${edge.to} · ${edge.kind} · on=${edge.on}${evidence}`);
  }
  lines.push('', '## Правки', `${String(patches.length)} из ${String(plan.patches.length)}`);
  if (patches.length === 0) lines.push('правок ещё нет: решение принимается до первой из них');
  for (const patch of patches) {
    lines.push(
      `глава ${String(patch.chapter)} · ${patch.blockId} · «${clip(patch.oldText, JUDGE_QUOTE_CHARS)}» → «${clip(patch.newText, JUDGE_QUOTE_CHARS)}»`,
    );
  }
  lines.push('', '## Вопросы', ...JUDGE_QUESTIONS.map((question, index) => `${String(index + 1)}. ${question}`));

  const prefix = [...canonParts(input.bookRoot), roleSection(input.bookRoot)].map((part) => part.body).join('\n\n');
  const system = `${prefix}\n\n${protocolSection()}`;
  return {
    system,
    user: lines.join('\n'),
    prefixSha256: sha256Hex(system),
    nodes: nodes.length,
    edges: edges.length,
  };
}

/**
 * Strict parse: `HOLDS`, or `GAP: <sentence>`. Everything else — an empty answer, a JSON object, a
 * paragraph of reasoning, a `GAP` with no sentence — is a refusal with a reason, never a verdict.
 */
export function parseJudgeAnswer(answer: string): JudgeVerdict {
  const text = answer.trim().replace(/^```(?:text)?\s*/u, '').replace(/```$/u, '').trim();
  if (text.length === 0) return { ok: false, reason: 'JUDGE_EMPTY: the answer was empty' };
  if (/^HOLDS\s*[.!]?$/u.test(text)) return { ok: true, verdict: 'HOLDS', sentence: null };
  const gap = /^GAP\s*:\s*([\s\S]+)$/u.exec(text);
  if (gap === null) return { ok: false, reason: `JUDGE_UNPARSED: expected HOLDS or «GAP: …», got «${clip(text, 80)}»` };
  const sentence = (gap[1] ?? '').replace(/\s+/gu, ' ').trim();
  if (sentence.length === 0) return { ok: false, reason: 'JUDGE_UNPARSED: a GAP needs the sentence that became false' };
  if (sentence.length > JUDGE_SENTENCE_CHARS) {
    return { ok: false, reason: `JUDGE_UNPARSED: the sentence is ${String(sentence.length)} characters, limit is ${String(JUDGE_SENTENCE_CHARS)}` };
  }
  return { ok: true, verdict: 'GAP', sentence };
}

export type JudgeRun = {
  prompt: JudgePrompt;
  /** The pass's own asker: money, heartbeat, stage and transcript stay the lane's. */
  ask: (prompt: JudgePrompt) => Promise<string>;
  log: (line: string) => void;
};

/**
 * Ask once. A call that fails is a refusal too — the caller escalates with a sentence rather than
 * treating a broken call as HOLDS (that is the silent pass this module forbids).
 */
export async function judgeCausality(input: JudgeRun): Promise<JudgeVerdict> {
  let answer: string;
  try {
    answer = await input.ask(input.prompt);
  } catch (error) {
    return { ok: false, reason: `JUDGE_CALL_FAILED: ${error instanceof Error ? error.message : 'unknown'}`.slice(0, 300) };
  }
  const verdict = parseJudgeAnswer(answer);
  input.log(
    `[writer] судья причинности: ${verdict.ok ? verdict.verdict : 'отказ разбора'} (${String(input.prompt.nodes)} узлов, ${String(input.prompt.edges)} связей)`,
  );
  return verdict;
}
