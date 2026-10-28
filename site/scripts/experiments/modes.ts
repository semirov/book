/**
 * Modes **A** and **B**, one run each, one attempt each (BOOK-DOC-65 §6, BOOK-DOC-75 §3).
 *
 * The two functions are the same shape — build → call → parse → validate → plan → diff →
 * artifact — so the table's two columns are the same measurement on two mechanisms. What differs
 * is the answer's form and its footprint: A is a whole chapter body (a rewrite moves more than the
 * 4 000 characters a ripple may move, so its plan is `wide`), B is a JSON patch the applier must
 * discharge against the pre-image, followed by the plan's own mandatory chapters.
 *
 * The closure is built for **both** modes from the bytes that actually came back: `before` is the
 * pre-image, `after` is what the mode would have landed. A B row whose plan is `wide` is recorded
 * as `wide` with its node count and **spends nothing further** — the price the wide mode would
 * take is computed from prompt sizes, never by calling.
 *
 * A refusal is a row, never a skip.
 */

import type { Untrusted } from '@book/shared';

import { readChapter } from '../../server/src/engine/text.ts';
import { parseChapter } from '../../server/src/ingest/parseChapter.ts';
import { validateAnswer } from '../../server/src/writer/validate.ts';
import { irreversibleIn, planFor, type Ledger, type PlanSummary } from './ledger.ts';
import { diffBlocks, estimateUsd, SpendCapError, type Rates } from './metrics.ts';
import { buildRewritePromptA, type AssignmentData } from './promptA.ts';
import { patchPromptOf, type PatchModules, type PatchPrompt } from './patch.ts';
import { patchChapter, runRipple, type ChapterPatch, type RippleRun } from './ripple.ts';
import { record } from './shape.ts';
import { saveArtifact } from './store.ts';
import { A_MAX_TOKENS, PASS, estimateTokens, type Filing } from './spec.ts';
import type { ChatMessage, WireResult } from './wire.ts';

export type Priced = WireResult & { cost: { usdBook: number; usdPeak: number } };

/** One priced call, already metered; the caller's label goes to the log line. */
export type CallModel = (messages: ChatMessage[], maxTokens: number, label: string) => Promise<Priced>;

export type ModeCtx = {
  bookRoot: string;
  pin: { model: string; apiModel: string; endpoint: string };
  rates: Rates;
  force: boolean;
  call: CallModel;
  /** The scratch ledger the closure is read from. */
  ledger: Ledger;
  /** The resume predicate, injected so this file does not depend on the shelf. */
  reusable: (name: string, promptSha256: string) => boolean;
  reuse: (name: string) => Record<string, unknown> | null;
};

export function assignmentOf(filing: Filing, chapter = filing.chapter): AssignmentData {
  return {
    chapter,
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

function diffOf(chapter: number, pre: ReturnType<typeof preImage>, value: string, edited: Set<string> | null) {
  try {
    const post = parseChapter(chapter, value);
    return diffBlocks(pre.blocks, post.blocks, pre.chars, edited);
  } catch {
    return null;
  }
}

function runOf(mode: 'A' | 'B', filing: Filing) {
  return { mode, chapter: filing.chapter, filing: filing.label, filingId: filing.id, kind: filing.kind, scope: filing.scopeHint };
}

/** A call's numbers in the shape the metrics take, or null when no call produced any. */
type CallNumbers = {
  in: number | null;
  out: number | null;
  cachedIn: number | null;
  usdBook: number | null;
  usdPeak: number | null;
  wallMs: number | null;
};

function numbersOf(result: { usage: { promptTokens: number; completionTokens: number; cacheHit: number }; latencyMs: number; cost: { usdBook: number; usdPeak: number } } | null): CallNumbers | null {
  if (result === null) return null;
  return {
    in: result.usage.promptTokens,
    out: result.usage.completionTokens,
    cachedIn: result.usage.cacheHit,
    usdBook: result.cost.usdBook,
    usdPeak: result.cost.usdPeak,
    wallMs: result.latencyMs,
  };
}

function metricsOf(
  call: CallNumbers | null,
  diff: ReturnType<typeof diffBlocks> | null,
  refusal: string | null,
  refusalDetail: string | null,
) {
  return {
    in: call?.in ?? null,
    out: call?.out ?? null,
    cachedIn: call?.cachedIn ?? null,
    usdBook: call?.usdBook ?? null,
    usdPeak: call?.usdPeak ?? null,
    wallMs: call?.wallMs ?? null,
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

/**
 * The closure columns every row carries. `null` means the mode produced no text to plan against
 * (a refusal), never «no ripple» — an unseeded plan is `proven: false`, which is its own column.
 */
export function closureColumns(
  summary: PlanSummary | null,
  anchor: { blocks: number; facts: number },
  irreversible = 0,
) {
  return {
    anchorBlocks: anchor.blocks,
    seedFacts: anchor.facts,
    closureNodes: summary?.closureNodes ?? null,
    closureEdges: summary?.closureEdges ?? null,
    closureChapters: summary?.closureChapters ?? null,
    mandatory: summary === null ? null : summary.mandatory.length,
    optional: summary === null ? null : summary.optional.length,
    outcome: summary?.outcome ?? null,
    proven: summary?.proven ?? null,
    longestPath: summary?.longestPath ?? null,
    walkMs: summary?.walkMs ?? null,
    chaptersTouched: summary?.chaptersTouched ?? null,
    planDigest: summary?.digest ?? null,
    /** Closure nodes that name an irreversible act — the class a ripple may not touch blind. */
    irreversible: summary === null ? null : irreversible,
  };
}

/** The irreversible acts inside a closure: a count, and the reason the column exists. */
function irreversibleOf(ctx: ModeCtx, summary: PlanSummary | null): number {
  if (summary === null) return 0;
  return irreversibleIn(ctx.ledger.db, [...summary.mandatory, ...summary.optional].map((node) => node.factId));
}

/** The plan a mode's text would produce, and the anchor it was seeded from. */
function planOf(ctx: ModeCtx, filing: Filing, before: string, after: string, executed?: readonly string[]) {
  const built = planFor({
    db: ctx.ledger.db,
    filing,
    before,
    after,
    ...(executed === undefined ? {} : { executed }),
  });
  return { summary: built.summary, anchor: built.anchor };
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
  // A rewrite is priced by the same closure: `after` is the chapter A would have landed.
  const plan = landed === null ? null : planOf(ctx, filing, pre.text, landed);

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
    closure: closureColumns(plan?.summary ?? null, plan?.anchor ?? { blocks: 0, facts: 0 }, irreversibleOf(ctx, plan?.summary ?? null)),
    plan: plan?.summary ?? null,
    metrics: {
      ...metricsOf(
        numbersOf(result),
        diff,
        refusal,
        failure !== null ? 'the call itself failed; no answer' : (answer !== null && !answer.ok ? answer.reason : null),
      ),
      ...(() => {
        const columns = closureColumns(plan?.summary ?? null, plan?.anchor ?? { blocks: 0, facts: 0 }, irreversibleOf(ctx, plan?.summary ?? null));
        return {
          closureNodes: columns.closureNodes,
          closureChapters: columns.closureChapters,
          mandatory: columns.mandatory,
          optional: columns.optional,
          outcome: columns.outcome,
          walkMs: columns.walkMs,
          chaptersTouched: columns.chaptersTouched,
        };
      })(),
    },
  });
  return artifact as unknown as Record<string, unknown>;
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

// ── mode B ───────────────────────────────────────────────────────────────────

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
  const point: ChapterPatch = await patchChapter({
    modules,
    prompt,
    chapter: filing.chapter,
    before: pre.text,
    reason: null,
    reasonLine: null,
    call: ctx.call,
    label: `B ${filing.label}`,
  });

  // The plan is built from the bytes the point patch would land — that is the actual edit.
  const afterText = point.landedText ?? (point.applied?.ok === true ? point.applied.text : pre.text);
  const built = planOf(ctx, filing, pre.text, afterText);
  const summary = built.summary;

  // A `wide` plan is recorded and not spent: the price is computed from prompt sizes.
  const wide = summary.outcome === 'wide' ? widePrice(ctx, filing, summary) : null;

  let ripple: RippleRun = { chapters: [], stoppedBy: 'none', plannedChapters: [] };
  if (summary.outcome === 'ripple' && point.landedText !== null) {
    ripple = await runRipple({
      modules,
      bookRoot: ctx.bookRoot,
      db: ctx.ledger.db,
      filing: { chapter: filing.chapter, id: filing.id },
      plan: { summary },
      call: ctx.call,
    });
  }

  const executed = summary.mandatory
    .filter((node) => ripple.chapters.some((entry) => entry.chapter === node.chapter && entry.landedText !== null))
    .map((node) => node.factId);
  // Plan equality: the closure recomputed from what landed, with the executed nodes excluded.
  // Seeded from the pre-image: the edited block has a new content-derived id, and the ledger
  // addresses the old one — seeding from the landed text finds no facts at all.
  const afterPlan = point.landedText === null ? null : planFor({ db: ctx.ledger.db, filing, before: pre.text, after: afterText, executed }).summary;

  const columns = closureColumns(summary, built.anchor, irreversibleOf(ctx, summary));
  const rippleUsdPeak = ripple.chapters.reduce((sum, entry) => sum + (entry.metrics.usdPeak ?? 0), 0);
  const artifact = saveArtifact(name, {
    command: 'ab',
    id: `B-${filing.label}`,
    run: runOf('B', filing),
    request: point.request,
    response: point.response,
    point,
    patch: point.parsed,
    applied: point.applied,
    validation: point.validation,
    landed: { ok: point.landedText !== null, text: point.landedText, chars: null },
    closure: { ...columns, planAfter: afterPlan === null ? null : closureColumns(afterPlan, built.anchor), planEqual: afterPlan !== null && afterPlan.closureNodes === summary.closureNodes && afterPlan.closureChapters === summary.closureChapters },
    plan: summary,
    ripple: { ...ripple, usdPeak: Math.round(rippleUsdPeak * 1_000_000) / 1_000_000 },
    wide,
    metrics: {
      ...metricsOf(
        point.response === null ? null : { in: point.metrics.in, out: point.metrics.out, cachedIn: point.metrics.cachedIn, usdBook: point.metrics.usdBook, usdPeak: point.metrics.usdPeak, wallMs: point.metrics.wallMs },
        diffOf(filing.chapter, pre, afterText, namedOf(point)),
        point.refusal,
        point.refusal !== null ? 'the point patch refused; the closure is read from the pre-image' : null,
      ),
      closureNodes: columns.closureNodes,
      closureChapters: columns.closureChapters,
      mandatory: columns.mandatory,
      optional: columns.optional,
      outcome: columns.outcome,
      walkMs: columns.walkMs,
      chaptersTouched: columns.chaptersTouched,
    },
  });
  return artifact as unknown as Record<string, unknown>;
}

function namedOf(point: ChapterPatch): Set<string> | null {
  const parsed = record(point.parsed);
  const patch = parsed?.ok === true ? record(parsed.patch) : null;
  const edits = record(patch)?.edits;
  if (!Array.isArray(edits)) return null;
  const ids = new Set<string>();
  for (const edit of edits) {
    const cell = record(edit);
    for (const key of ['blockId', 'afterBlockId'] as const) {
      const value = cell?.[key];
      if (typeof value === 'string' && value.length > 0) ids.add(value);
    }
  }
  return ids;
}

/**
 * What a `wide` plan would cost: one rewrite per touched chapter, priced from the rewrite prompt's
 * size and the token cap — computed, never called. The chapters are capped at 24 so a closure over
 * the whole book cannot turn a price into a hang; the real chapter count is still reported.
 */
export function widePrice(ctx: ModeCtx, filing: Filing, summary: PlanSummary): { chapters: number; estimateUsdPeak: number } {
  let total = 0;
  for (const chapter of summary.chaptersTouched.slice(0, 24)) {
    try {
      const built = buildRewritePromptA({ bookRoot: ctx.bookRoot, assignment: assignmentOf(filing, chapter) });
      total += estimateUsd(built.system.length + built.user.length, A_MAX_TOKENS, ctx.rates);
    } catch {
      // A chapter that cannot be priced is named by its absence, not counted as free.
    }
  }
  return { chapters: summary.chaptersTouched.length, estimateUsdPeak: Math.round(total * 1_000_000) / 1_000_000 };
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

export type { ChapterPatch };
