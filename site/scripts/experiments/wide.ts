/**
 * C's `wide` row: the price of a closure that is not one chapter (BOOK-DOC-65 §6, extendendum).
 *
 * A wide plan means every touched chapter is rewritten; a full multi-chapter rewrite is out of this
 * experiment's budget, so the row measures **one** chapter (the filing's own) and states the
 * projection: `wideProjectionUsd = perChapter × chapters`. The projection is arithmetic over a
 * measured number, not a second estimate — and the artifact records which chapter was written.
 */

import { readChapter } from '../../server/src/engine/text.ts';
import { parseChapter } from '../../server/src/ingest/parseChapter.ts';
import { validateAnswer } from '../../server/src/writer/validate.ts';
import { buildRewritePromptA } from './promptA.ts';
import { diffBlocks } from './metrics.ts';
import { saveArtifact } from './store.ts';
import { A_MAX_TOKENS, estimateTokens, type Filing } from './spec.ts';
import type { PlanSummary } from './ledger.ts';
import type { WireResult } from './wire.ts';
// ── C, the wide case ─────────────────────────────────────────────────────────

export type WideInput = {
  bookRoot: string;
  pin: { model: string; apiModel: string; endpoint: string };
  call: (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    maxTokens: number,
    label: string,
  ) => Promise<WireResult & { cost: { usdBook: number; usdPeak: number } }>;
  force: boolean;
  filing: Filing;
  plan: PlanSummary;
  reusable: (name: string, promptSha256: string) => boolean;
  reuse: (name: string) => Record<string, unknown> | null;
};

/**
 * The wide mode's price, measured on **one** chapter (BOOK-DOC-65 §6, extendendum).
 *
 * A wide plan means every touched chapter is rewritten; a full multi-chapter wide rewrite is out
 * of this experiment's budget, so the row measures the origin chapter and states the projection:
 * `wideProjectionUsd = perChapter × chapters`. The projection is arithmetic over a measured number,
 * not a second estimate — and the artifact says which chapter was actually written.
 */
export async function runWideCase(input: WideInput): Promise<Record<string, unknown>> {
  const { filing } = input;
  const built = buildRewritePromptA({
    bookRoot: input.bookRoot,
    assignment: {
      chapter: filing.chapter,
      pass: 'change',
      intent: { value: filing.intent, untrusted: true } as const,
      interventionKind: null,
      premise: null,
      expectation: null,
    },
  });
  const name = `wide-${filing.label}.json`;
  if (!input.force && input.reusable(name, built.promptSha256)) {
    process.stdout.write(`[wide ${filing.label}] resumed\n`);
    return input.reuse(name) ?? {};
  }
  const pre = readChapter(input.bookRoot, filing.chapter);
  const request = {
    mode: 'wide',
    model: input.pin.model,
    apiModel: input.pin.apiModel,
    endpoint: input.pin.endpoint,
    maxTokens: A_MAX_TOKENS,
    promptChars: built.system.length + built.user.length,
    estTokensIn: estimateTokens(built.system.length + built.user.length),
    promptSha256: built.promptSha256,
    prefixSha256: built.prefixSha256,
    sections: built.sections.map((section) => ({ id: section.id, chars: section.chars, sha256: section.sha256 })),
  };

  let result: Awaited<ReturnType<WideInput['call']>> | null = null;
  let failure: string | null = null;
  try {
    result = await input.call(
      [
        { role: 'system', content: built.system },
        { role: 'user', content: built.user },
      ],
      A_MAX_TOKENS,
      `wide ${filing.label}`,
    );
  } catch (error) {
    if ((error as { code?: string }).code === 'SPEND_CAP') throw error;
    failure = (error as { code?: string }).code ?? 'CALL_FAILED';
  }

  const answer = result === null ? null : validateAnswer(result.text, { chapter: filing.chapter, finishReason: result.finishReason });
  const landed = answer !== null && answer.ok ? answer.text : null;
  const diff = (() => {
    try {
      const post = parseChapter(filing.chapter, landed ?? (result?.text ?? ''));
      return diffBlocks(pre.blocks, post.blocks, pre.chars, null);
    } catch {
      return null;
    }
  })();
  const chapters = input.plan.chaptersTouched.length;
  const perChapter = result?.cost.usdPeak ?? 0;
  const artifact = saveArtifact(name, {
    command: 'wide',
    id: `${filing.label}`,
    run: { mode: 'wide', chapter: filing.chapter, filing: filing.label, filingId: filing.id, outcome: input.plan.outcome },
    plan: { ...input.plan, nodes: undefined },
    request,
    response:
      result === null
        ? null
        : {
            text: result.text,
            finishReason: result.finishReason,
            latencyMs: result.latencyMs,
            usage: { in: result.usage.promptTokens, out: result.usage.completionTokens, cachedIn: result.usage.cacheHit },
          },
    validation:
      answer === null
        ? null
        : answer.ok
          ? { ok: true, chars: answer.chars, title: answer.title }
          : { ok: false, code: answer.code, reason: answer.reason },
    landed: { ok: landed !== null, text: landed },
    metrics: {
      in: result?.usage.promptTokens ?? null,
      out: result?.usage.completionTokens ?? null,
      cachedIn: result?.usage.cacheHit ?? null,
      usdBook: result?.cost.usdBook ?? null,
      usdPeak: result?.cost.usdPeak ?? null,
      wallMs: result?.latencyMs ?? null,
      charsChanged: diff?.changedChars ?? null,
      pctOfChapter: diff?.pctOfChapter ?? null,
      untouchedHashEqual: diff?.untouchedHashEqual ?? null,
      refusal: failure ?? (answer !== null && !answer.ok ? answer.code : null),
      chaptersRewritten: 1,
      wideChapters: chapters,
      wideProjectionUsd: Math.round(perChapter * chapters * 1_000_000) / 1_000_000,
    },
  });
  return artifact as unknown as Record<string, unknown>;
}
