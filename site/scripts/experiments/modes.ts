/**
 * Modes **A** and **B**, one run each, one attempt each (BOOK-DOC-65 §6).
 *
 * The two functions are deliberately the same shape — build → call → parse → validate → diff →
 * artifact — so the table's two columns are the same measurement on two mechanisms. What
 * differs is the answer's form: A is a whole chapter body, B is a JSON patch the applier must
 * discharge against the pre-image.
 *
 * A refusal is a row, never a skip: the artifact is written with the code and with whatever
 * numbers the failed attempt still produced (`finish_reason`, usage, the diff of the bytes that
 * came back — none of which is a chapter, and the row says so).
 *
 * Nothing here retries. `parsePatchAnswer`/`applyPatch` are the shipped modules, imported by
 * `patch.ts`: a forked applier would measure a rule that does not exist in production.
 */

import type { Untrusted } from '@book/shared';

import { readChapter } from '../../server/src/engine/text.ts';
import { parseChapter } from '../../server/src/ingest/parseChapter.ts';
import { validateAnswer } from '../../server/src/writer/validate.ts';
import { diffBlocks, SpendCapError } from './metrics.ts';
import { buildRewritePromptA, type AssignmentData } from './promptA.ts';
import { normalizeApply, patchPromptOf, type PatchModules, type PatchPrompt } from './patch.ts';
import { record } from './shape.ts';
import { saveArtifact } from './store.ts';
import { A_MAX_TOKENS, B_MAX_TOKENS, PASS, PATCH_MAX_FRACTION, estimateTokens, type Filing } from './spec.ts';
import type { ChatMessage, WireResult } from './wire.ts';

export type Priced = WireResult & { cost: { usdBook: number; usdPeak: number } };

/** One priced call, already metered; the caller's label goes to the log line. */
export type CallModel = (messages: ChatMessage[], maxTokens: number, label: string) => Promise<Priced>;

export type ModeCtx = {
  bookRoot: string;
  pin: { model: string; apiModel: string; endpoint: string };
  force: boolean;
  call: CallModel;
  /** The resume predicate, injected so this file does not depend on the shelf. */
  reusable: (name: string, promptSha256: string) => boolean;
  reuse: (name: string) => Record<string, unknown> | null;
};

export type RunResult = { artifact: string; refusal: string | null; landedChars: number | null };

function assignmentOf(filing: Filing): AssignmentData {
  return {
    chapter: filing.chapter,
    pass: PASS,
    intent: { value: filing.intent, untrusted: true } as Untrusted<string>,
    interventionKind: null,
    premise: null,
    expectation: null,
  };
}

function preImage(bookRoot: string, chapter: number) {
  const chapterText = readChapter(bookRoot, chapter);
  return { text: chapterText.text, chars: chapterText.chars, blocks: chapterText.blocks };
}

function sectionsOf(sections: ReadonlyArray<{ id: string; chars: number; sha256: string }>) {
  return sections.map((section) => ({ id: section.id, chars: section.chars, sha256: section.sha256 }));
}

function diffOf(
  chapter: number,
  pre: ReturnType<typeof preImage>,
  value: string,
  edited: Set<string> | null,
): ReturnType<typeof diffBlocks> | null {
  try {
    const post = parseChapter(chapter, value);
    return diffBlocks(pre.blocks, post.blocks, pre.chars, edited);
  } catch {
    return null;
  }
}

function usageOf(result: Priced) {
  return {
    in: result.usage.promptTokens,
    out: result.usage.completionTokens,
    cachedIn: result.usage.cacheHit,
    cacheMiss: result.usage.cacheMiss,
    cacheHitDetails: result.usage.cachedDetails,
  };
}

function runOf(mode: 'A' | 'B', filing: Filing) {
  return { mode, chapter: filing.chapter, filing: filing.label, filingId: filing.id, kind: filing.kind, scope: filing.scopeHint };
}

function metricsOf(
  result: Priced | null,
  diff: ReturnType<typeof diffBlocks> | null,
  refusal: string | null,
  refusalDetail: string | null,
) {
  return {
    in: result?.usage.promptTokens ?? null,
    out: result?.usage.completionTokens ?? null,
    cachedIn: result?.usage.cacheHit ?? null,
    usdBook: result?.cost.usdBook ?? null,
    usdPeak: result?.cost.usdPeak ?? null,
    wallMs: result?.latencyMs ?? null,
    charsChanged: diff?.changedChars ?? null,
    pctOfChapter: diff?.pctOfChapter ?? null,
    untouchedBlocks: diff?.untouchedBlocks ?? null,
    editedBlocks: diff?.editedBlocks ?? null,
    untouchedHashEqual: diff?.untouchedHashEqual ?? null,
    preUntouchedSha256: diff?.preUntouchedSha256 ?? null,
    postUntouchedSha256: diff?.postUntouchedSha256 ?? null,
    refusal,
    refusalDetail,
  };
}

// ── mode A ───────────────────────────────────────────────────────────────────

export async function runA(ctx: ModeCtx, filing: Filing): Promise<Record<string, unknown>> {
  const built = buildRewritePromptA({ bookRoot: ctx.bookRoot, assignment: assignmentOf(filing) });
  const name = `ab-A-${filing.label}.json`;
  if (!ctx.force && ctx.reusable(name, built.promptSha256)) {
    process.stdout.write(`[A ${filing.label}] resumed\n`);
    return ctx.reuse(name) ?? {};
  }

  const pre = preImage(ctx.bookRoot, filing.chapter);
  const request = {
    mode: 'A',
    model: ctx.pin.model,
    apiModel: ctx.pin.apiModel,
    endpoint: ctx.pin.endpoint,
    maxTokens: A_MAX_TOKENS,
    promptChars: built.system.length + built.user.length,
    estTokensIn: estimateTokens(built.system.length + built.user.length),
    promptSha256: built.promptSha256,
    prefixSha256: built.prefixSha256,
    sections: sectionsOf(built.sections),
  };

  let result: Priced | null = null;
  let failure: string | null = null;
  try {
    result = await ctx.call(
      [
        { role: 'system', content: built.system },
        { role: 'user', content: built.user },
      ],
      A_MAX_TOKENS,
      `A ${filing.label}`,
    );
  } catch (error) {
    if (error instanceof SpendCapError) throw error;
    failure = (error as { code?: string }).code ?? 'CALL_FAILED';
  }

  const answer = result === null ? null : validateAnswer(result.text, { chapter: filing.chapter, finishReason: result.finishReason });
  const landed = answer !== null && answer.ok ? answer.text : null;
  const diff = result === null ? null : diffOf(filing.chapter, pre, landed ?? result.text, null);
  const refusal = failure ?? (answer !== null && !answer.ok ? answer.code : null);

  const artifact = saveArtifact(name, {
    command: 'ab',
    id: `A-${filing.label}`,
    run: runOf('A', filing),
    request,
    response:
      result === null
        ? null
        : { text: result.text, finishReason: result.finishReason, latencyMs: result.latencyMs, model: result.responseModel, usage: usageOf(result) },
    validation:
      answer === null
        ? null
        : answer.ok
          ? { ok: true, chars: answer.chars, title: answer.title }
          : { ok: false, code: answer.code, reason: answer.reason },
    landed: { ok: landed !== null, text: landed, chars: answer?.ok === true ? answer.chars : null },
    metrics: metricsOf(
      result,
      diff,
      refusal,
      failure !== null ? 'the call itself failed; no answer' : (answer !== null && !answer.ok ? answer.reason : null),
    ),
  });
  return artifact as unknown as Record<string, unknown>;
}

// ── mode B ───────────────────────────────────────────────────────────────────

type ParsedPatch = { ok: true; patch: unknown } | { ok: false; code: string; detail: string };

function editedIdsOf(patch: unknown): Set<string> {
  const edits = record(patch)?.edits;
  const ids = new Set<string>();
  if (!Array.isArray(edits)) return ids;
  for (const edit of edits) {
    const cell = record(edit);
    for (const key of ['blockId', 'afterBlockId'] as const) {
      const value = cell?.[key];
      if (typeof value === 'string' && value.length > 0) ids.add(value);
    }
  }
  return ids;
}

export async function runB(ctx: ModeCtx, filing: Filing, modules: PatchModules): Promise<Record<string, unknown>> {
  const prompt: PatchPrompt = patchPromptOf(modules, {
    bookRoot: ctx.bookRoot,
    chapter: filing.chapter,
    assignment: { ...assignmentOf(filing), scopeHint: filing.scopeHint },
  });
  const name = `ab-B-${filing.label}.json`;
  if (!ctx.force && ctx.reusable(name, prompt.promptSha256)) {
    process.stdout.write(`[B ${filing.label}] resumed\n`);
    return ctx.reuse(name) ?? {};
  }

  const pre = preImage(ctx.bookRoot, filing.chapter);
  const request = {
    mode: 'B',
    model: ctx.pin.model,
    apiModel: ctx.pin.apiModel,
    endpoint: ctx.pin.endpoint,
    maxTokens: B_MAX_TOKENS,
    promptChars: prompt.system.length + prompt.user.length,
    estTokensIn: estimateTokens(prompt.system.length + prompt.user.length),
    promptSha256: prompt.promptSha256,
    prefixSha256: prompt.prefixSha256,
    sections: sectionsOf(prompt.sections),
    blocks: prompt.blocks.length,
  };

  let result: Priced | null = null;
  let failure: string | null = null;
  try {
    result = await ctx.call(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      B_MAX_TOKENS,
      `B ${filing.label}`,
    );
  } catch (error) {
    if (error instanceof SpendCapError) throw error;
    failure = (error as { code?: string }).code ?? 'CALL_FAILED';
  }

  let parsed: ParsedPatch | null = null;
  let applied: ReturnType<typeof normalizeApply> | null = null;
  let answer: ReturnType<typeof validateAnswer> | null = null;
  let edited: Set<string> | null = null;

  if (result !== null) {
    parsed = modules.parsePatchAnswer(result.text) as ParsedPatch;
    if (parsed.ok) {
      // `mode: "rewrite"` is the model declining to patch: a row, and the rewrite path is the
      // production decision, not this harness's.
      if (record(parsed.patch)?.mode === 'rewrite') {
        parsed = { ok: false, code: 'PATCH_ASKED_REWRITE', detail: 'the model declined to patch' };
      } else {
        applied = normalizeApply(
          modules.applyPatch({ chapter: filing.chapter, text: pre.text, patch: parsed.patch, maxFraction: PATCH_MAX_FRACTION }),
        );
        if (applied.ok) {
          edited = editedIdsOf(parsed.patch);
          answer = validateAnswer(applied.text, { chapter: filing.chapter, finishReason: result.finishReason });
        }
      }
    }
  }

  const landed = answer !== null && answer.ok ? answer.text : null;
  const diffText = landed ?? (applied !== null && applied.ok ? applied.text : (result?.text ?? null));
  const diff = diffText === null ? null : diffOf(filing.chapter, pre, diffText, edited);
  const refusal =
    failure ??
    (parsed !== null && !parsed.ok ? parsed.code : null) ??
    (applied !== null && !applied.ok ? applied.code : null) ??
    (answer !== null && !answer.ok ? `PATCH_REJECTED:${answer.code}` : null);

  const artifact = saveArtifact(name, {
    command: 'ab',
    id: `B-${filing.label}`,
    run: runOf('B', filing),
    request,
    response:
      result === null
        ? null
        : { text: result.text, finishReason: result.finishReason, latencyMs: result.latencyMs, model: result.responseModel, usage: usageOf(result) },
    patch: { parsed: parsed !== null && parsed.ok, refusal: parsed !== null && !parsed.ok ? parsed : null, patch: parsed !== null && parsed.ok ? parsed.patch : null },
    applied:
      applied === null
        ? null
        : applied.ok
          ? { ok: true, changedChars: applied.changedChars, fraction: applied.fraction, edits: applied.edits }
          : { ok: false, code: applied.code, detail: applied.detail },
    validation:
      answer === null
        ? null
        : answer.ok
          ? { ok: true, chars: answer.chars, title: answer.title }
          : { ok: false, code: answer.code, reason: answer.reason },
    landed: { ok: landed !== null, text: landed, chars: answer?.ok === true ? answer.chars : null },
    metrics: metricsOf(
      result,
      diff,
      refusal,
      (parsed !== null && !parsed.ok ? parsed.detail : null) ??
        (applied !== null && !applied.ok ? applied.detail : null) ??
        (answer !== null && !answer.ok ? answer.reason : null),
    ),
  });
  return artifact as unknown as Record<string, unknown>;
}

/** The other lane has not landed the patch modules: a row that says so, not a missing row. */
export function blockedArtifact(filing: Filing, blocked: string): Record<string, unknown> {
  return saveArtifact(`ab-B-${filing.label}.json`, {
    command: 'ab',
    id: `B-${filing.label}`,
    run: runOf('B', filing),
    blocked,
    request: null,
    response: null,
    metrics: { refusal: 'BLOCKED' },
  });
}
