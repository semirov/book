/**
 * The control's execution: the promise in ch05, its deadline in ch12, one ripple between them.
 *
 * Same machinery as a real filing — point patch, plan, the plan's mandatory chapters, the same
 * refusals — with one difference that is the whole point: the plan is seeded from a fixture whose
 * edges are known to exist, so it **cannot** come back `local` for lack of evidence. That is what
 * proves the ripple mechanism and prices it, because the three real filings return zero mandatory.
 *
 * The artifact is `control-B-ch05.json`: the same row shape as `ab-B-*`, so the summary reads it
 * with the same code and the table is comparable.
 */

import { irreversibleIn, planFor } from './ledger.ts';
import { closureColumns, type ModeCtx } from './modes.ts';
import { patchPromptOf, type PatchModules } from './patch.ts';
import { patchChapter, runRipple, type ChapterPatch, type RippleRun } from './ripple.ts';
import { saveArtifact } from './store.ts';
import { PASS } from './spec.ts';
import type { ControlFixture } from './control.ts';
import type { Untrusted } from '@book/shared';

export type ControlRun = {
  point: ChapterPatch;
  plan: ReturnType<typeof planFor>['summary'] | null;
  ripple: RippleRun;
  artifact: string;
};

export async function runControl(ctx: ModeCtx, fixture: ControlFixture, modules: PatchModules): Promise<ControlRun> {
  const filing = fixture.filing;
  const assignment = {
    chapter: filing.chapter,
    pass: PASS,
    intent: { value: filing.intent, untrusted: true } as Untrusted<string>,
    interventionKind: null,
    premise: null,
    expectation: null,
    scopeHint: filing.scopeHint,
  };
  const prompt = patchPromptOf(modules, { bookRoot: ctx.bookRoot, chapter: filing.chapter, assignment });
  const point = await patchChapter({
    modules,
    prompt,
    chapter: filing.chapter,
    before: fixture.before,
    reason: null,
    reasonLine: null,
    call: ctx.call,
    label: `control ch${String(filing.chapter)}`,
  });

  // The plan is priced from the edit as it landed; when it refused, from the fixture's own edit.
  const afterText = point.landedText ?? fixture.after;
  const built = planFor({ db: ctx.ledger.db, filing, before: fixture.before, after: afterText });
  const summary = built.summary;

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
  // Seeded from the fixture's pre-image, for the same reason: after the patch the block id is new.
  const afterPlan = planFor({ db: ctx.ledger.db, filing, before: fixture.before, after: afterText, executed }).summary;
  const columns = closureColumns(summary, built.anchor, irreversibleIn(ctx.ledger.db, [...summary.mandatory, ...summary.optional].map((node) => node.factId)));
  const rippleUsdPeak = ripple.chapters.reduce((sum, entry) => sum + (entry.metrics.usdPeak ?? 0), 0);
  const artifact = saveArtifact('control-B-ch05.json', {
    command: 'control',
    id: 'B-ch05',
    run: { mode: 'B', chapter: filing.chapter, filing: filing.label, filingId: filing.id, kind: filing.kind, scope: filing.scopeHint, control: true },
    fixture: {
      promiseFact: fixture.promiseFact,
      deadlineFact: fixture.deadlineFact,
      edgeId: fixture.edgeId,
      chapters: fixture.chapters,
      promise: fixture.promise,
      promisedAfter: fixture.promisedAfter,
      afterSource: afterText === fixture.after ? 'fixture edit (the point patch refused)' : 'the point patch as it landed',
    },
    request: point.request,
    response: point.response,
    point,
    plan: summary,
    closure: {
      ...columns,
      planAfter: closureColumns(afterPlan, built.anchor),
      planEqual: afterPlan.closureNodes === summary.closureNodes && afterPlan.closureChapters === summary.closureChapters,
    },
    ripple: { ...ripple, usdPeak: Math.round(rippleUsdPeak * 1_000_000) / 1_000_000 },
    landed: { ok: point.landedText !== null, text: point.landedText },
    metrics: {
      in: point.metrics.in,
      out: point.metrics.out,
      cachedIn: point.metrics.cachedIn,
      usdBook: point.metrics.usdBook,
      usdPeak: point.metrics.usdPeak,
      wallMs: point.metrics.wallMs,
      charsChanged: point.metrics.charsChanged,
      pctOfChapter: point.metrics.pctOfChapter,
      untouchedHashEqual: point.metrics.untouchedHashEqual,
      refusal: point.refusal,
      closureNodes: columns.closureNodes,
      closureChapters: columns.closureChapters,
      mandatory: columns.mandatory,
      optional: columns.optional,
      outcome: columns.outcome,
      walkMs: columns.walkMs,
      chaptersTouched: columns.chaptersTouched,
    },
  });
  return { point, plan: summary, ripple, artifact: artifact.artifact };
}

/** The ripple chapters' landed texts, which the gate pass judges like the filing's own chapter. */
export function controlTargets(run: ControlRun): Array<{ chapter: number; text: string }> {
  const targets: Array<{ chapter: number; text: string }> = [];
  if (typeof run.point.landedText === 'string') targets.push({ chapter: run.point.chapter, text: run.point.landedText });
  for (const entry of run.ripple.chapters) {
    if (typeof entry.landedText === 'string') targets.push({ chapter: entry.chapter, text: entry.landedText });
  }
  return targets;
}
