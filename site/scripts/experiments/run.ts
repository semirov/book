/**
 * `npx tsx scripts/experiments/run.ts <command> [flags]` — the A/B/C harness (BOOK-DOC-65 §6,
 * BOOK-DOC-75, BOOK-173 extendendum).
 *
 *   ab     mode A (today's rewrite prompt) and mode B (point patch + the plan's ripple)
 *   gates  the editor and the consultant on every landed chapter A and B produced
 *   cache  the four-variant cache matrix, plus C's wide row when a plan is `wide`
 *   all    ab → gates → cache
 *   smoke  one ~$0.0001 call: the key, the stream and the usage reader, end to end
 *
 * Flags: `--only=ch01,ch03,ch06`, `--force` (re-run a complete artifact), `--dry` (build the
 * prompts and the closures, print sizes and hashes, make **zero** calls), `--control` (the seeded
 * promise/deadline fixture instead of the three filings — the only way to price a ripple today).
 *
 * Rules this file keeps:
 *  · **one attempt** — no retry, no repair; a refusal is a row, not a skipped run;
 *  · **a hard cap** — after every call the peak-basis total is persisted (`spend.json`); a call
 *    whose projection would cross $1.75 is not made, and the run writes what it has;
 *  · **no secrets** — the key travels in a header and never into a log, an artifact or a message;
 *  · **nothing is written outside `site/.data/experiments/`** — no manuscript byte, no database,
 *    no engine call, no production lane. The ledger is `:memory:` and dies with the process.
 */

import { DEFAULT_PIPELINE_PATH } from '../../server/src/writer/config.ts';
import { apiModelOf, loadPipeline } from '../../server/src/writer/pipeline.ts';
import { SpendCapError, createMeter, estimateUsd, type Rates } from './metrics.ts';
import { blockedArtifact, runA, runB, type CallModel, type ModeCtx } from './modes.ts';
import { runControl } from './controlRun.ts';
import { controlFixture, wideFixture } from './control.ts';
import { loadPatchModules } from './patch.ts';
import { runGatesFor } from './gatesRun.ts';
import { runCacheMatrix } from './cache.ts';
import { runWideCase } from './wide.ts';
import { openLedger, planFor, type Ledger, type PlanSummary } from './ledger.ts';
import { readChapter } from '../../server/src/engine/text.ts';
import { listArtifacts, loadArtifact, reusable, saveArtifact, saveSpend } from './store.ts';
import { callRecords, spendOf } from './usage.ts';
import { record } from './shape.ts';
import { dryRun } from './dry.ts';
import { callOnce, pipelineUsage, requestChars, WireError, type ChatMessage } from './wire.ts';
import { BOOK_ROOT, CAP_USD, CACHE_MAX_TOKENS, PEAK_MULTIPLIER, SMOKE_MAX_TOKENS, readKey, selectFilings } from './spec.ts';

type Command = 'ab' | 'gates' | 'cache' | 'all' | 'smoke';

const COMMANDS: readonly Command[] = ['ab', 'gates', 'cache', 'all', 'smoke'];

type Ctx = {
  pin: { model: string; apiModel: string; endpoint: string };
  rates: Rates;
  apiKey: string;
  meter: ReturnType<typeof createMeter>;
  force: boolean;
  filings: ReturnType<typeof selectFilings>;
  bookRoot: string;
  timeoutMs: number;
  ledger: Ledger;
};

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** The one seam to the network: metered before and after, never retried. */
async function callModel(ctx: Ctx, messages: ChatMessage[], maxTokens: number, label: string) {
  const projection = estimateUsd(requestChars(messages), maxTokens, ctx.rates);
  if (!ctx.meter.canAfford(projection)) throw new SpendCapError(ctx.meter.totals(), CAP_USD);
  const started = Date.now();
  let result;
  try {
    result = await callOnce({
      endpoint: ctx.pin.endpoint,
      apiKey: ctx.apiKey,
      apiModel: ctx.pin.apiModel,
      messages,
      maxTokens,
      timeoutMs: ctx.timeoutMs,
    });
  } catch (error) {
    const code = error instanceof WireError ? error.code : 'CALL_FAILED';
    log(`[${label}] refused: ${code}`);
    throw Object.assign(new Error(`call refused: ${code}`), { code });
  }
  const cost = ctx.meter.add(pipelineUsage(result.usage));
  // Persisted immediately: the cap is the experiment's, and a later command inherits it.
  saveSpend(ctx.meter.totals());
  log(
    `[${label}] in ${String(result.usage.promptTokens)} (cache ${String(result.usage.cacheHit)}) · out ${String(
      result.usage.completionTokens,
    )} · ${String(Date.now() - started)} ms · $${cost.usdPeak.toFixed(4)} peak · total $${ctx.meter.totals().usdPeak.toFixed(4)}`,
  );
  return { ...result, cost };
}

/** What modes and gates need from the shelf: resume, or the artifact itself. */
function shelf(force: boolean) {
  return {
    reusable: (name: string, promptSha256: string) => !force && reusable(loadArtifact(name), promptSha256),
    reuse: (name: string) => (loadArtifact(name) as unknown as Record<string, unknown> | null) ?? null,
  };
}

function modeCtx(ctx: Ctx, call: CallModel): ModeCtx {
  return { bookRoot: ctx.bookRoot, pin: ctx.pin, rates: ctx.rates, force: ctx.force, call, ledger: ctx.ledger, ...shelf(ctx.force) };
}

/** The chapters an artifact landed in: the filing's own, then every ripple chapter. */
function targetsOf(name: string): Array<{ chapter: number; text: string }> {
  const artifact = loadArtifact(name);
  const targets: Array<{ chapter: number; text: string }> = [];
  const chapter = record(artifact?.run)?.chapter;
  const landed = record(artifact?.landed)?.text;
  if (typeof landed === 'string' && typeof chapter === 'number') targets.push({ chapter, text: landed });
  const ripple = record(artifact?.ripple)?.chapters;
  if (Array.isArray(ripple)) {
    for (const entry of ripple) {
      const cell = record(entry);
      if (typeof cell?.landedText === 'string' && typeof cell.chapter === 'number') {
        targets.push({ chapter: cell.chapter, text: cell.landedText });
      }
    }
  }
  return targets;
}

function planOutcomeOf(name: string): { outcome: string | null; plan: PlanSummary | null } {
  const artifact = loadArtifact(name);
  const closure = record(artifact?.closure);
  const plan = artifact?.plan;
  return {
    outcome: typeof closure?.outcome === 'string' ? closure.outcome : null,
    plan: (plan as PlanSummary | undefined) ?? null,
  };
}

/**
 * The plan's own equality check, recomputed from the landed text for every B row. Deterministic and
 * free: it is `buildPlan` again with the patched nodes marked executed, seeded from the **pre-image**
 * (the edited block has a new content-derived id, so seeding from the landed text finds nothing).
 */
function refreshPlanChecks(ctx: Ctx): void {
  for (const artifact of listArtifacts('ab')) {
    const run = record(artifact.run);
    if (run?.mode !== 'B') continue;
    const label = typeof run.filing === 'string' ? run.filing : null;
    if (label === null) continue;
    const filing = ctx.filings.find((entry) => entry.label === label);
    if (filing === undefined) continue;
    const landed = record(artifact.landed)?.text;
    if (typeof landed !== 'string') continue;
    const plan = record(artifact.plan) ?? {};
    const closure = record(artifact.closure) ?? {};
    const mandatory = Array.isArray(plan.mandatory) ? (plan.mandatory as Array<Record<string, unknown>>) : [];
    const pre = readChapterText(ctx.bookRoot, filing.chapter);
    const after = planFor({
      db: ctx.ledger.db,
      filing,
      before: pre,
      after: landed,
      executed: mandatory.filter((node) => node.chapter !== filing.chapter).map((node) => String(node.factId)),
    });
    saveArtifact(`plancheck-B-${label}.json`, {
      command: 'plancheck',
      id: `B-${label}`,
      run: { mode: 'B', filing: label, chapter: filing.chapter },
      planAfter: after.summary,
      closureBefore: closure,
      planEqual:
        typeof closure.closureNodes === 'number' &&
        after.summary.closureNodes === closure.closureNodes &&
        after.summary.closureChapters === closure.closureChapters,
      note: 'seeded from the pre-image with the patched nodes marked executed; no model call',
    });
  }
}

function readChapterText(bookRoot: string, chapter: number): string {
  return readChapter(bookRoot, chapter).text;
}

// ── commands ────────────────────────────────────────────────────────────────

async function runAb(ctx: Ctx, call: CallModel, control: boolean): Promise<void> {
  const loaded = await loadPatchModules();
  if (!loaded.ok) log(`B: BLOCKED — ${loaded.blocked}`);
  if (control) {
    if (!loaded.ok) {
      log('control: BLOCKED (the patch modules are absent)');
      return;
    }
    const fixture = controlFixture(ctx.ledger.db, ctx.bookRoot);
    const run = await runControl(modeCtx(ctx, call), fixture, loaded.modules);
    log(`[control] ${run.artifact} · outcome ${String(run.plan?.outcome ?? '—')} · patches ${String(1 + run.ripple.chapters.length)}`);
    return;
  }
  for (const filing of ctx.filings) {
    await runA(modeCtx(ctx, call), filing);
    if (loaded.ok) await runB(modeCtx(ctx, call), filing, loaded.modules);
    else blockedArtifact(filing, loaded.blocked);
  }
}

async function runGates(ctx: Ctx, call: CallModel, control: boolean): Promise<void> {
  const gateCtx = { bookRoot: ctx.bookRoot, pin: ctx.pin, force: ctx.force, call, ...shelf(ctx.force) };
  if (control) {
    const fixture = controlFixture(ctx.ledger.db, ctx.bookRoot);
    const artifact = loadArtifact('control-B-ch05.json');
    const targets = artifact === null ? [] : targetsOf('control-B-ch05.json');
    if (targets.length === 0) {
      log('[gates control] no landed control text — run `ab --control` first');
      return;
    }
    for (const target of targets) await runGatesFor(gateCtx, 'B', fixture.filing, target);
    // The plan's own equality check, recomputed from the landed text: deterministic, no call.
    const landed = record(artifact?.landed)?.text;
    const plan = planFor({
      db: ctx.ledger.db,
      filing: fixture.filing,
      before: fixture.before,
      after: typeof landed === 'string' ? landed : fixture.after,
      executed: [fixture.deadlineFact],
    });
    const before = record(artifact?.closure);
    saveArtifact('control-plan-after.json', {
      command: 'plancheck',
      id: 'control',
      run: { control: true, filing: fixture.filing.label },
      planAfter: plan.summary,
      closureBefore: before,
      planEqual:
        typeof before?.closureNodes === 'number' &&
        plan.summary.closureNodes === before.closureNodes &&
        plan.summary.closureChapters === before.closureChapters,
      note: 'seeded from the fixture pre-image with the patched node marked executed; no model call',
    });
    return;
  }
  for (const filing of ctx.filings) {
    for (const target of targetsOf(`ab-A-${filing.label}.json`)) await runGatesFor(gateCtx, 'A', filing, target);
    for (const target of targetsOf(`ab-B-${filing.label}.json`)) await runGatesFor(gateCtx, 'B', filing, target);
  }
}

async function runCache(ctx: Ctx, call: CallModel, control: boolean): Promise<void> {
  const measured = await runCacheMatrix({
    bookRoot: ctx.bookRoot,
    pin: ctx.pin,
    force: ctx.force,
    call: (messages) => call(messages, CACHE_MAX_TOKENS, 'cache'),
  });
  log(measured.calls === 0 ? '[cache] already measured (use --force)' : `[cache] ${String(measured.calls)} calls`);

  const wideCtx = {
    bookRoot: ctx.bookRoot,
    pin: ctx.pin,
    call,
    force: ctx.force,
    ...shelf(ctx.force),
  };
  if (control) {
    const seeded = controlFixture(ctx.ledger.db, ctx.bookRoot);
    const wide = wideFixture(ctx.ledger.db, ctx.bookRoot, seeded);
    const plan = planFor({ db: ctx.ledger.db, filing: wide.filing, before: wide.before, after: wide.after, bounds: wide.bounds });
    log(`[wide control] plan ${plan.summary.outcome} · ${String(plan.summary.chaptersTouched.length)} chapters`);
    const row = await runWideCase({ ...wideCtx, filing: wide.filing, plan: plan.summary });
    const metrics = record(record(row)?.metrics) ?? {};
    log(
      `[wide control] per chapter $${String(metrics.usdPeak ?? '—')} peak · projection $${String(
        metrics.wideProjectionUsd ?? '—',
      )} over ${String(metrics.wideChapters ?? '?')} chapters`,
    );
    return;
  }
  let ran = 0;
  for (const filing of ctx.filings) {
    const state = planOutcomeOf(`ab-B-${filing.label}.json`);
    if (state.outcome !== 'wide' || state.plan === null) continue;
    log(`[wide ${filing.label}] plan is wide over ${String(state.plan.chaptersTouched.length)} chapters — one rewrite measured`);
    await runWideCase({ ...wideCtx, filing, plan: state.plan });
    ran += 1;
  }
  if (ran === 0) {
    log('[wide] no filing produced a wide plan — the files are local; run `cache --control` for the wide case');
  }
}

// ── cli ─────────────────────────────────────────────────────────────────────

function parseFlags(rest: string[]): Map<string, string | true> | null {
  const flags = new Map<string, string | true>();
  for (const arg of rest) {
    if (!arg.startsWith('--')) {
      log(`unknown argument ${arg}`);
      return null;
    }
    const body = arg.slice(2);
    const at = body.indexOf('=');
    flags.set(at === -1 ? body : body.slice(0, at), at === -1 ? true : body.slice(at + 1));
  }
  for (const key of flags.keys()) {
    if (!['only', 'force', 'dry', 'control'].includes(key)) {
      log(`unknown flag --${key}; the accepted flags are --only, --force, --dry, --control`);
      return null;
    }
  }
  return flags;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // `run.ts --dry` is the brief's own check: flags alone mean the whole set, and nothing runs.
  const leadingFlag = argv[0]?.startsWith('--') === true;
  const command = (leadingFlag ? 'all' : (argv[0] ?? '')) as Command;
  if (!COMMANDS.includes(command)) {
    log(`usage: npx tsx scripts/experiments/run.ts <${COMMANDS.join('|')}> [--only=…] [--force] [--dry] [--control]`);
    process.exitCode = 2;
    return;
  }
  const flags = parseFlags(leadingFlag ? argv : argv.slice(1));
  if (flags === null) {
    process.exitCode = 2;
    return;
  }

  const pipeline = loadPipeline(DEFAULT_PIPELINE_PATH);
  const rates: Rates = {
    per: pipeline.pricing.per,
    input: pipeline.pricing.input,
    output: pipeline.pricing.output,
    cacheRead: pipeline.pricing.cacheRead,
  };
  const pin = { model: pipeline.model, apiModel: apiModelOf(pipeline), endpoint: pipeline.endpoint };
  const key = readKey();
  const only = typeof flags.get('only') === 'string' ? (flags.get('only') as string) : null;
  let filings;
  try {
    filings = selectFilings(only);
  } catch (error) {
    log((error as Error).message);
    process.exitCode = 2;
    return;
  }
  const control = flags.has('control');

  // The ledger is the closure's only source: `:memory:`, projected from the manuscript, read once.
  const ledger = openLedger(BOOK_ROOT);
  const ctx: Ctx = {
    pin,
    rates,
    apiKey: key ?? '',
    // Seeded from the artifacts, not from `spend.json`: two processes clobbered that file, and a
    // cap seeded too low is a cap that lets a run overspend.
    meter: createMeter(rates, CAP_USD, spendOf(callRecords(), rates)),
    force: flags.has('force'),
    filings,
    bookRoot: BOOK_ROOT,
    timeoutMs: 420_000,
    ledger,
  };

  try {
    if (flags.has('dry')) {
      await dryRun({ pin, rates, filings, ledger });
      return;
    }
    if (key === null) {
      log('key: missing (DEEPSEEK_API_KEY_FILE and the default file are absent) — nothing to measure');
      process.exitCode = 1;
      return;
    }
    log(`key: found (file) · pin ${pin.model} · peak rates ×${String(PEAK_MULTIPLIER)} · cap $${CAP_USD.toFixed(2)}`);
    if (control) log('control: the seeded promise/deadline fixture stands in for the three filings');

    const call: CallModel = (messages, maxTokens, label) => callModel(ctx, messages, maxTokens, label);
    const startedAt = new Date().toISOString();
    try {
      if (command === 'smoke') {
        const result = await call(
          [
            { role: 'system', content: 'Это проверка связи, не задание.' },
            { role: 'user', content: 'Ответь одним словом: связь.' },
          ],
          SMOKE_MAX_TOKENS,
          'smoke',
        );
        saveArtifact('smoke.json', {
          command: 'smoke',
          id: 'smoke',
          run: { maxTokens: SMOKE_MAX_TOKENS },
          request: { model: pin.model, apiModel: pin.apiModel, maxTokens: SMOKE_MAX_TOKENS, promptChars: 0 },
          response: {
            textLength: result.text.length,
            text: result.text,
            finishReason: result.finishReason,
            latencyMs: result.latencyMs,
            usage: { in: result.usage.promptTokens, out: result.usage.completionTokens, cachedIn: result.usage.cacheHit },
          },
          metrics: { usdBook: result.cost.usdBook, usdPeak: result.cost.usdPeak },
        });
        log(
          `smoke ok: in ${String(result.usage.promptTokens)} · out ${String(result.usage.completionTokens)} · $${result.cost.usdBook.toFixed(
            6,
          )} book / $${result.cost.usdPeak.toFixed(6)} peak`,
        );
        return;
      }

      if (command === 'ab' || command === 'all') await runAb(ctx, call, control);
      if (command === 'gates' || command === 'all') await runGates(ctx, call, control);
      if (command === 'cache' || command === 'all') await runCache(ctx, call, control);
    } catch (error) {
      if (error instanceof SpendCapError) {
        log(`spend_cap: ${error.message} — stopping and writing what is measured`);
      } else {
        log(`failed: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    } finally {
      // The summary is written from artifacts, so it is true whether the run finished or stopped.
      refreshPlanChecks(ctx);
      if (listArtifacts('ab').length + listArtifacts('gates').length + listArtifacts('cache').length + listArtifacts('wide').length + listArtifacts('control').length > 0) {
        const { writeSummary } = await import('./report.ts');
        const written = writeSummary({
          pin: { ...pin, rates },
          spend: ctx.meter.totals(),
          startedAt,
          finishedAt: new Date().toISOString(),
          ledger: {
            chapters: ctx.ledger.chapters,
            facts: ctx.ledger.backfill.facts,
            edges: ctx.ledger.backfill.edges,
            backfillMs: ctx.ledger.backfillMs,
          },
        });
        log(`summary: ${written.path} (${String(written.rows)} A/B rows, ${String(written.cacheCalls)} cache calls)`);
      }
    }
  } finally {
    ledger.close();
  }
}

// A `true` here would run the CLI on import; `selftest.ts` needs `main` without it.
if (process.env.EXPERIMENTS_NO_MAIN !== '1') await main();

export { main };
