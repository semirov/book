/**
 * The ripple's execution: one patch call per chapter the plan made mandatory (BOOK-DOC-75 §3).
 *
 * The plan is the design's own (`buildPlan`), the applier is the shipped one, and this file adds
 * only what a run needs around them:
 *
 *   · a **reason line** — the node's own `reason` (the edge that made it mandatory) plus the fact's
 *     statement, appended to the patch message. A ripple chapter is not patched «because»; it is
 *     patched because a named edge moved a named claim, and the model reads that sentence;
 *   · **the bounds** — at most three chapters in this experiment, and the design's own cumulative
 *     character bound; a bound that stops the ripple is recorded, never silently obeyed;
 *   · **the same refusal surface** as a point patch: `PATCH_*`, and `PATCH_REJECTED:*` from
 *     `validateAnswer` after apply. A chapter that is not patched is a row, not a skipped chapter.
 */

import type { Untrusted } from '@book/shared';

import type { Db } from '../../server/src/db/db.ts';
import { RIPPLE_MAX_CHANGED_CHARS } from '../../server/src/ledger/graph/plan.ts';
import { validateAnswer } from '../../server/src/writer/validate.ts';
import { parseChapter } from '../../server/src/ingest/parseChapter.ts';
import { diffBlocks, SpendCapError } from './metrics.ts';
import type { CallModel } from './modes.ts';
import { normalizeApply, patchPromptOf, type PatchModules, type PatchPrompt } from './patch.ts';
import type { AssignmentData } from './promptA.ts';
import { chapterTextOf, statementOf } from './ledger.ts';
import { record } from './shape.ts';
import { B_MAX_TOKENS, PASS, PATCH_MAX_FRACTION, estimateTokens } from './spec.ts';

/** What one chapter's patch call produced, priced — the unit of the ripple table. */
export type ChapterPatch = {
  chapter: number;
  /** The plan's reason for touching this chapter; null for the filing's own (point) chapter. */
  reason: string | null;
  reasonLine: string | null;
  request: {
    maxTokens: number;
    promptChars: number;
    estTokensIn: number;
    promptSha256: string;
    prefixSha256: string;
    sections: Array<{ id: string; chars: number; sha256: string }>;
    blocks: number;
  };
  response: { text: string; finishReason: string | null; latencyMs: number; usage: { in: number; out: number; cachedIn: number; cacheMiss: number } } | null;
  parsed: unknown;
  applied: ReturnType<typeof normalizeApply> | null;
  validation: unknown;
  refusal: string | null;
  landedText: string | null;
  metrics: {
    in: number | null;
    out: number | null;
    cachedIn: number | null;
    usdBook: number | null;
    usdPeak: number | null;
    wallMs: number | null;
    charsChanged: number | null;
    pctOfChapter: number | null;
    untouchedHashEqual: boolean | null;
    untouchedBlocks: number | null;
  };
};

/** The reason block a ripple patch carries: the closed code, the edge id, the claim in prose. */
export function reasonLine(reason: string, factId: string, statement: string | null): string {
  const claim = statement === null ? 'утверждение не найдено' : `«${statement.slice(0, 240)}»`;
  return `${reason} · узел ${factId} · ${claim}`;
}

/**
 * The patch prompt for one chapter, with the reason appended to the message rather than to the
 * cached prefix: the prefix must stay byte-identical across chapters for the cache to pay, and a
 * reason changes with every node.
 */
export function patchPromptFor(
  modules: PatchModules,
  input: { bookRoot: string; chapter: number; assignment: AssignmentData & { scopeHint: string }; reason: string | null },
): PatchPrompt {
  const built = patchPromptOf(modules, input);
  if (input.reason === null) return built;
  return { ...built, user: `${built.user}\n\n## Почему эта глава\n\n${input.reason}` };
}

/** One chapter: call, parse, apply, validate. No retry, no repair. */
export async function patchChapter(
  input: {
    modules: PatchModules;
    prompt: PatchPrompt;
    chapter: number;
    before: string;
    reason: string | null;
    reasonLine: string | null;
    call: CallModel;
    label: string;
  },
): Promise<ChapterPatch> {
  const { modules, prompt } = input;
  const base: ChapterPatch = {
    chapter: input.chapter,
    reason: input.reason,
    reasonLine: input.reasonLine,
    request: {
      maxTokens: B_MAX_TOKENS,
      promptChars: prompt.system.length + prompt.user.length,
      estTokensIn: estimateTokens(prompt.system.length + prompt.user.length),
      promptSha256: prompt.promptSha256,
      prefixSha256: prompt.prefixSha256,
      sections: prompt.sections.map((section) => ({ id: section.id, chars: section.chars, sha256: section.sha256 })),
      blocks: prompt.blocks.length,
    },
    response: null,
    parsed: null,
    applied: null,
    validation: null,
    refusal: null,
    landedText: null,
    metrics: {
      in: null,
      out: null,
      cachedIn: null,
      usdBook: null,
      usdPeak: null,
      wallMs: null,
      charsChanged: null,
      pctOfChapter: null,
      untouchedHashEqual: null,
      untouchedBlocks: null,
    },
  };

  let result;
  try {
    result = await input.call(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      B_MAX_TOKENS,
      input.label,
    );
  } catch (error) {
    if (error instanceof SpendCapError) throw error;
    return { ...base, refusal: (error as { code?: string }).code ?? 'CALL_FAILED' };
  }

  const response = {
    text: result.text,
    finishReason: result.finishReason,
    latencyMs: result.latencyMs,
    usage: {
      in: result.usage.promptTokens,
      out: result.usage.completionTokens,
      cachedIn: result.usage.cacheHit,
      cacheMiss: result.usage.cacheMiss,
    },
  };
  const metrics: ChapterPatch['metrics'] = {
    in: result.usage.promptTokens,
    out: result.usage.completionTokens,
    cachedIn: result.usage.cacheHit,
    usdBook: result.cost.usdBook,
    usdPeak: result.cost.usdPeak,
    wallMs: result.latencyMs,
    charsChanged: null,
    pctOfChapter: null,
    untouchedHashEqual: null,
    untouchedBlocks: null,
  };

  const parsed = modules.parsePatchAnswer(result.text) as unknown as
    | { ok: true; patch: unknown }
    | { ok: false; code: string; detail: string };
  if (!parsed.ok) return { ...base, response, metrics, parsed, refusal: parsed.code };
  if (record(parsed.patch)?.mode === 'rewrite') {
    return { ...base, response, metrics, parsed, refusal: 'PATCH_ASKED_REWRITE' };
  }

  const applied = normalizeApply(
    modules.applyPatch({ chapter: input.chapter, text: input.before, patch: parsed.patch, maxFraction: PATCH_MAX_FRACTION }),
  );
  if (!applied.ok) return { ...base, response, metrics, parsed, applied, refusal: applied.code };

  const answer = validateAnswer(applied.text, { chapter: input.chapter, finishReason: result.finishReason });
  const pre = parseChapter(input.chapter, input.before);
  const post = parseChapter(input.chapter, applied.text);
  const named = new Set<string>();
  for (const edit of (record(parsed.patch)?.edits as unknown[]) ?? []) {
    const cell = record(edit);
    for (const key of ['blockId', 'afterBlockId'] as const) {
      const value = cell?.[key];
      if (typeof value === 'string' && value.length > 0) named.add(value);
    }
  }
  const diff = diffBlocks(pre.blocks, post.blocks, pre.chars, named);

  return {
    ...base,
    response,
    metrics: {
      ...metrics,
      charsChanged: diff.changedChars,
      pctOfChapter: diff.pctOfChapter,
      untouchedHashEqual: diff.untouchedHashEqual,
      untouchedBlocks: diff.untouchedBlocks,
    },
    parsed,
    applied,
    validation: answer.ok
      ? { ok: true, chars: answer.chars, title: answer.title }
      : { ok: false, code: answer.code, reason: answer.reason },
    refusal: answer.ok ? null : `PATCH_REJECTED:${answer.code}`,
    landedText: answer.ok ? answer.text : null,
  };
}

/** The experiment's own cap on how many chapters a ripple may patch here (the design has none). */
export const EXPERIMENT_MAX_RIPPLE_CHAPTERS = 3;

export type RippleRun = {
  chapters: ChapterPatch[];
  /** Why the ripple stopped short of the plan: a bound, the experiment's cap, or nothing. */
  stoppedBy: 'none' | 'experiment-cap' | 'chars-bound';
  plannedChapters: number[];
};

/**
 * Walk the plan's mandatory nodes in chapter order, one patch call per chapter. A chapter that
 * already landed (the filing's own) is not patched twice, and a node whose chapter is the filing's
 * is executed by the point patch.
 */
export async function runRipple(input: {
  modules: PatchModules;
  bookRoot: string;
  db: Db;
  filing: { chapter: number; id: string };
  plan: {
    summary: { mandatory: Array<{ factId: string; chapter: number; reason: string }> };
  };
  call: CallModel;
  maxChapters?: number;
}): Promise<RippleRun> {
  const max = input.maxChapters ?? EXPERIMENT_MAX_RIPPLE_CHAPTERS;
  const wanted = [...new Set(input.plan.summary.mandatory.map((node) => node.chapter))]
    .filter((chapter) => chapter !== input.filing.chapter)
    .sort((left, right) => left - right);
  const run: RippleRun = { chapters: [], stoppedBy: 'none', plannedChapters: wanted };
  let changed = 0;

  for (const chapter of wanted) {
    if (run.chapters.length >= max) {
      run.stoppedBy = 'experiment-cap';
      break;
    }
    if (changed >= RIPPLE_MAX_CHANGED_CHARS) {
      run.stoppedBy = 'chars-bound';
      break;
    }
    const node = input.plan.summary.mandatory.find((entry) => entry.chapter === chapter);
    if (node === undefined) continue;
    const line = reasonLine(node.reason, node.factId, statementOf(input.db, node.factId));
    const assignment = {
      chapter,
      pass: PASS,
      intent: { value: line, untrusted: true } as Untrusted<string>,
      interventionKind: null,
      premise: null,
      expectation: null,
      scopeHint: 'phrase',
    };
    const prompt = patchPromptFor(input.modules, {
      bookRoot: input.bookRoot,
      chapter,
      assignment,
      reason: line,
    });
    const result = await patchChapter({
      modules: input.modules,
      prompt,
      chapter,
      before: chapterTextOf(input.bookRoot, chapter),
      reason: node.reason,
      reasonLine: line,
      call: input.call,
      label: `ripple ch${String(chapter)}`,
    });
    changed += result.metrics.charsChanged ?? 0;
    run.chapters.push(result);
  }
  return run;
}
