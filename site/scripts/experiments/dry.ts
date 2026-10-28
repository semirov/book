/**
 * `--dry`: everything the run would send, priced and hashed, and the closures — with **zero** calls.
 *
 * Two things are printed and both matter to different readers:
 *
 *   · the prompt table — what each mode would send, its size, its hashes, and whether A's frozen
 *     snapshot still matches the shipped builder (it should not, once the reorder lands);
 *   · the closure table — the research answer: how many nodes and chapters a filing reaches in the
 *     whole-book ledger, how many of them are mandatory, and how long the walk took. This needs no
 *     model at all, so it is the one result a run can produce for free.
 *
 * The arithmetic checks (`checks.ts`) run here too: a dry run that proves nothing would be a green
 * light over an unmeasured table.
 */

import type { Untrusted } from '@book/shared';

import { sha256Hex } from '../../server/src/util/hash.ts';
import { cacheSteps } from './cache.ts';
import { controlFixture, wideFixture } from './control.ts';
import { chapterTextOf, ledgerLine, planFor, substituteAfter, type Ledger } from './ledger.ts';
import { buildRewritePromptA } from './promptA.ts';
import { loadPatchModules, patchPromptOf } from './patch.ts';
import { writeDrySummary, type DryClosureRow } from './reportDry.ts';
import { A_MAX_TOKENS, BOOK_ROOT, CAP_USD, PEAK_MULTIPLIER, estimateTokens, type Filing } from './spec.ts';
import { runChecks } from './checks.ts';
import type { Rates } from './metrics.ts';

export type DryCtx = {
  pin: { model: string; apiModel: string; endpoint: string };
  rates: Rates;
  filings: Filing[];
  ledger: Ledger;
};

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function describe(
  label: string,
  prompt: { system: string; user: string; promptSha256: string; prefixSha256: string; sections: ReadonlyArray<{ id: string }> },
  maxTokens: number,
  extra: string,
): void {
  log(
    `${label}: system ${String(prompt.system.length)} ch (~${String(estimateTokens(prompt.system.length))} tok) · user ${String(
      prompt.user.length,
    )} ch (~${String(estimateTokens(prompt.user.length))} tok) · sections ${String(prompt.sections.length)} · out cap ${String(
      maxTokens,
    )} · prompt ${prompt.promptSha256.slice(0, 12)} · prefix ${prompt.prefixSha256.slice(0, 12)}${extra ? ` · ${extra}` : ''}`,
  );
}

function assignmentFor(filing: Filing) {
  return {
    chapter: filing.chapter,
    pass: 'change',
    intent: { value: filing.intent, untrusted: true as const } as Untrusted<string>,
    interventionKind: null,
    premise: null,
    expectation: null,
  };
}

export async function dryRun(ctx: DryCtx): Promise<void> {
  log(`pin: ${ctx.pin.model} (${ctx.pin.apiModel}) · ${ctx.pin.endpoint}`);
  log(
    `rates/1M: in ${String(ctx.rates.input)} · out ${String(ctx.rates.output)} · cache-read ${String(
      ctx.rates.cacheRead,
    )} · peak ${String(PEAK_MULTIPLIER)}× · cap $${CAP_USD.toFixed(2)} (peak basis)`,
  );

  log('— mode A (today-order rewrite) —');
  for (const filing of ctx.filings) {
    const assignment = assignmentFor(filing);
    const built = buildRewritePromptA({ bookRoot: BOOK_ROOT, assignment });
    let comparison: string;
    try {
      // Informational: the shipped builder is being reordered by the other lane, so a difference
      // is the point of A, not a defect. Identical means the reorder has not landed yet.
      const shipped = await import('../../server/src/writer/prompt.ts');
      comparison =
        shipped.buildWriterPrompt({ bookRoot: BOOK_ROOT, assignment }).promptSha256 === built.promptSha256
          ? 'matches-shipped-builder'
          : 'differs-from-shipped-builder';
    } catch {
      comparison = 'shipped-builder-unavailable';
    }
    describe(`A ${filing.label}`, built, A_MAX_TOKENS, comparison);
  }

  log('— mode B (surgical patch) —');
  const loaded = await loadPatchModules();
  if (!loaded.ok) {
    log(`B: BLOCKED — ${loaded.blocked}`);
    for (const filing of ctx.filings) log(`B ${filing.label}: not built (BLOCKED)`);
  } else {
    for (const filing of ctx.filings) {
      const prompt = patchPromptOf(loaded.modules, {
        bookRoot: BOOK_ROOT,
        chapter: filing.chapter,
        assignment: { ...assignmentFor(filing), scopeHint: filing.scopeHint },
      });
      describe(`B ${filing.label}`, prompt, 12_000, `blocks ${String(prompt.blocks.length)}`);
    }
  }

  log('— closure: scratch ledger, whole book, no chapter window —');
  log(
    `ledger: ${String(ctx.ledger.chapters)} chapters projected · ${String(ctx.ledger.backfill.facts)} facts · ${String(
      ctx.ledger.backfill.edges,
    )} edges · backfill ${String(ctx.ledger.backfillMs)} ms` +
      (ctx.ledger.backfill.failed.length > 0 ? ` · failed [${ctx.ledger.backfill.failed.join(', ')}]` : ''),
  );
  const closures: DryClosureRow[] = [];
  for (const filing of ctx.filings) {
    const before = chapterTextOf(BOOK_ROOT, filing.chapter);
    const after = substituteAfter(BOOK_ROOT, filing, filing.anchor?.quote ?? null);
    const { summary, anchor } = planFor({ db: ctx.ledger.db, filing, before, after: after.text });
    log(`${filing.label}: ${ledgerLine(summary)} · after: ${after.source}`);
    if (summary.mandatory.length > 0) {
      log(`  mandatory: ${summary.mandatory.map((node) => `ch${String(node.chapter)} ${node.reason}`).join(' · ')}`);
    }
    closures.push({
      filing: filing.label,
      chapter: filing.chapter,
      outcome: summary.outcome,
      anchorBlocks: anchor.blocks,
      seeds: anchor.facts,
      nodes: summary.closureNodes,
      edges: summary.closureEdges,
      chapters: summary.closureChapters,
      chaptersTouched: summary.chaptersTouched,
      mandatory: summary.mandatory.length,
      optional: summary.optional.length,
      longestPath: summary.longestPath,
      walkMs: summary.walkMs,
      proven: summary.proven,
      note: summary.mandatory.length === 0 ? 'point patch only' : `${String(summary.mandatory.length)} chapter(s) to patch`,
    });
  }

  const control = controlFixture(ctx.ledger.db, BOOK_ROOT);
  const controlPlan = planFor({ db: ctx.ledger.db, filing: control.filing, before: control.before, after: control.after });
  log(`control: ${ledgerLine(controlPlan.summary)} · promise «${control.promise}» → «${control.promisedAfter}»`);
  closures.push({
    filing: 'ctl05 (control)',
    chapter: 5,
    outcome: controlPlan.summary.outcome,
    anchorBlocks: controlPlan.anchor.blocks,
    seeds: controlPlan.anchor.facts,
    nodes: controlPlan.summary.closureNodes,
    edges: controlPlan.summary.closureEdges,
    chapters: controlPlan.summary.closureChapters,
    chaptersTouched: controlPlan.summary.chaptersTouched,
    mandatory: controlPlan.summary.mandatory.length,
    optional: controlPlan.summary.optional.length,
    longestPath: controlPlan.summary.longestPath,
    walkMs: controlPlan.summary.walkMs,
    proven: controlPlan.summary.proven,
    note: `seeded fixture: «${control.promise}» → «${control.promisedAfter}»`,
  });

  const wide = wideFixture(ctx.ledger.db, BOOK_ROOT, control);
  const widePlan = planFor({ db: ctx.ledger.db, filing: wide.filing, before: wide.before, after: wide.after, bounds: wide.bounds });
  log(`control-wide: ${ledgerLine(widePlan.summary)} · bounds $${String(wide.bounds.usd)} < $${String(wide.bounds.estimatedUsd)}`);
  closures.push({
    filing: 'ctl05 (control, wide)',
    chapter: 5,
    outcome: widePlan.summary.outcome,
    anchorBlocks: widePlan.anchor.blocks,
    seeds: widePlan.anchor.facts,
    nodes: widePlan.summary.closureNodes,
    edges: widePlan.summary.closureEdges,
    chapters: widePlan.summary.closureChapters,
    chaptersTouched: widePlan.summary.chaptersTouched,
    mandatory: widePlan.summary.mandatory.length,
    optional: widePlan.summary.optional.length,
    longestPath: widePlan.summary.longestPath,
    walkMs: widePlan.summary.walkMs,
    proven: widePlan.summary.proven,
    note: `six synthetic nodes; the money bound $${String(wide.bounds.usd)} is below the projection`,
  });

  log('— C cache matrix: seven calls against one warmed baseline —');
  for (const step of cacheSteps(BOOK_ROOT, 'dry0')) {
    log(
      `C ${step.call} ${step.id}: ${step.what} · prefix ${String(step.prefix.length)} ch (~${String(
        estimateTokens(step.prefix.length),
      )} tok) · sha ${sha256Hex(step.prefix).slice(0, 12)} · expected ${step.expected}`,
    );
  }

  const written = writeDrySummary({
    pin: { ...ctx.pin, rates: ctx.rates },
    ledger: {
      chapters: ctx.ledger.chapters,
      facts: ctx.ledger.backfill.facts,
      edges: ctx.ledger.backfill.edges,
      backfillMs: ctx.ledger.backfillMs,
    },
    rows: closures,
    startedAt: new Date().toISOString(),
  });
  log(`closures written: ${written}`);

  const checks = runChecks();
  for (const failure of checks.failed) log(`check FAILED ${failure}`);
  log(`checks: ${String(checks.passed)} passed, ${String(checks.failed.length)} failed · network calls: 0`);
  if (checks.failed.length > 0) process.exitCode = 1;
}
