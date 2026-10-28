/**
 * `npx tsx scripts/experiments/run.ts <command> [flags]` — the A/B/C harness (BOOK-DOC-65 §6).
 *
 *   ab     mode A (today's rewrite prompt) and mode B (the surgical patch) on three filings
 *   gates  the editor and the consultant on every landed result A and B produced
 *   cache  the four-variant cache matrix
 *   all    ab → gates → cache
 *   smoke  one ~$0.0001 call: the key, the stream and the usage reader, end to end
 *
 * Flags: `--only=ch01,ch03,ch06`, `--force` (re-run a complete artifact), `--dry` (build the
 * prompts, print sizes and hashes, make **zero** calls).
 *
 * The rules this file exists to keep:
 *  · **one attempt** — no retry, no repair; a refusal is a row, not a skipped run;
 *  · **a hard cap** — after every call the peak-basis total is added; a call whose projection
 *    would cross $1.75 is not made, and the run writes what it has (`spend_cap`);
 *  · **no secrets** — the key travels in a header and never into a log, an artifact or a message;
 *  · **nothing is written outside `site/.data/experiments/`** — no manuscript byte, no DB row,
 *    no engine call, no production lane.
 *
 * The one deliberate divergence from the lane: the key is read from `DEEPSEEK_API_KEY_FILE` when
 * it is set and from the owner's default file otherwise, because the experiment may run outside
 * production. The writer's own loader refuses that default on purpose; a measurement harness is
 * not a lane.
 */

import type { Untrusted } from '@book/shared';

import { DEFAULT_PIPELINE_PATH } from '../../server/src/writer/config.ts';
import { apiModelOf, loadPipeline } from '../../server/src/writer/pipeline.ts';
import { sha256Hex } from '../../server/src/util/hash.ts';
import { SpendCapError, costOf, createMeter, type Rates } from './metrics.ts';
import { buildRewritePromptA } from './promptA.ts';
import { blockedArtifact, runA, runB, type CallModel, type ModeCtx, type Priced } from './modes.ts';
import { loadPatchModules, patchPromptOf } from './patch.ts';
import { runGatesFor } from './gatesRun.ts';
import { buildVariant, runCacheMatrix } from './cache.ts';
import { listArtifacts, loadArtifact, loadSpend, reusable, saveArtifact, saveSpend } from './store.ts';
import { runChecks } from './checks.ts';
import { callOnce, pipelineUsage, requestChars, WireError, type ChatMessage } from './wire.ts';
import { A_MAX_TOKENS, B_MAX_TOKENS, CACHE_MAX_TOKENS, CAP_USD, PEAK_MULTIPLIER, SMOKE_MAX_TOKENS, BOOK_ROOT, estimateTokens, readKey, selectFilings } from './spec.ts';

type Command = 'ab' | 'gates' | 'cache' | 'all' | 'smoke';

const COMMANDS: readonly Command[] = ['ab', 'gates', 'cache', 'all', 'smoke'];
const CACHE_KEYS = ['i', 'ii', 'iii', 'iv'] as const;

type Ctx = {
  pin: { model: string; apiModel: string; endpoint: string };
  rates: Rates;
  apiKey: string;
  meter: ReturnType<typeof createMeter>;
  force: boolean;
  filings: ReturnType<typeof selectFilings>;
  bookRoot: string;
  timeoutMs: number;
};

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** The most a call can cost on the peak basis: an over-stated input and the whole out cap. */
function estimateUsd(chars: number, maxTokens: number, rates: Rates): number {
  return costOf({ in: estimateTokens(chars), out: maxTokens, cachedIn: 0 }, rates, PEAK_MULTIPLIER);
}

/** The one seam to the network: metered before and after, never retried. */
async function callModel(ctx: Ctx, messages: ChatMessage[], maxTokens: number, label: string): Promise<Priced> {
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

/** What both mode runners and the gates need from the shelf: resume, or the artifact itself. */
function shelf(force: boolean) {
  return {
    reusable: (name: string, promptSha256: string) => !force && reusable(loadArtifact(name), promptSha256),
    reuse: (name: string) => (loadArtifact(name) as unknown as Record<string, unknown> | null) ?? null,
  };
}

function modeCtx(ctx: Ctx, call: CallModel): ModeCtx {
  return { bookRoot: ctx.bookRoot, pin: ctx.pin, force: ctx.force, call, ...shelf(ctx.force) };
}

function landedOf(mode: 'A' | 'B', filing: { label: string }): string | null {
  const artifact = loadArtifact(`ab-${mode}-${filing.label}.json`);
  const landed = artifact?.landed as { text?: unknown } | undefined;
  return typeof landed?.text === 'string' && landed.text.length > 0 ? landed.text : null;
}

// ── dry run ──────────────────────────────────────────────────────────────────

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

async function dryRun(ctx: Ctx): Promise<void> {
  log(`pin: ${ctx.pin.model} (${ctx.pin.apiModel}) · ${ctx.pin.endpoint}`);
  log(
    `rates/1M: in ${String(ctx.rates.input)} · out ${String(ctx.rates.output)} · cache-read ${String(
      ctx.rates.cacheRead,
    )} · peak ${String(PEAK_MULTIPLIER)}× · cap $${CAP_USD.toFixed(2)} (peak basis)`,
  );
  log('— mode A (today-order rewrite) —');
  for (const filing of ctx.filings) {
    const assignment = {
      chapter: filing.chapter,
      pass: 'change',
      intent: { value: filing.intent, untrusted: true as const } as Untrusted<string>,
      interventionKind: null,
      premise: null,
      expectation: null,
    };
    const built = buildRewritePromptA({ bookRoot: ctx.bookRoot, assignment });
    let comparison: string;
    try {
      // Informational: the shipped builder is being reordered by the other lane, so a difference
      // is the point of A, not a defect. Identical means the reorder has not landed yet.
      const shipped = await import('../../server/src/writer/prompt.ts');
      comparison = shipped.buildWriterPrompt({ bookRoot: ctx.bookRoot, assignment }).promptSha256 === built.promptSha256
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
        bookRoot: ctx.bookRoot,
        chapter: filing.chapter,
        assignment: {
          chapter: filing.chapter,
          pass: 'change',
          intent: { value: filing.intent, untrusted: true } as Untrusted<string>,
          interventionKind: null,
          premise: null,
          expectation: null,
          scopeHint: filing.scopeHint,
        },
      });
      describe(`B ${filing.label}`, prompt, B_MAX_TOKENS, `blocks ${String(prompt.blocks.length)}`);
    }
  }

  log('— C cache prefixes —');
  for (const key of CACHE_KEYS) {
    const variant = buildVariant(key, ctx.bookRoot);
    log(
      `C ${key}: ${variant.title} · prefix ${String(variant.prefix.length)} ch (~${String(
        estimateTokens(variant.prefix.length),
      )} tok) · parts ${String(variant.parts.length)} · sha ${sha256Hex(variant.prefix).slice(0, 12)} · ${variant.proves}`,
    );
  }

  const checks = runChecks();
  for (const failure of checks.failed) log(`check FAILED ${failure}`);
  log(`checks: ${String(checks.passed)} passed, ${String(checks.failed.length)} failed · network calls: 0`);
  if (checks.failed.length > 0) process.exitCode = 1;
}

// ── cli ──────────────────────────────────────────────────────────────────────

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
    if (!['only', 'force', 'dry'].includes(key)) {
      log(`unknown flag --${key}; the accepted flags are --only, --force, --dry`);
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
    log(`usage: npx tsx scripts/experiments/run.ts <${COMMANDS.join('|')}> [--only=ch01,ch03,ch06] [--force] [--dry]`);
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
  const ctx: Ctx = {
    pin,
    rates,
    apiKey: key ?? '',
    meter: createMeter(rates, CAP_USD, loadSpend()),
    force: flags.has('force'),
    filings,
    bookRoot: BOOK_ROOT,
    timeoutMs: 420_000,
  };

  if (flags.has('dry')) {
    await dryRun(ctx);
    return;
  }
  if (key === null) {
    log('key: missing (DEEPSEEK_API_KEY_FILE and the default file are absent) — nothing to measure');
    process.exitCode = 1;
    return;
  }
  log(`key: found (file) · pin ${pin.model} · peak rates ×${String(PEAK_MULTIPLIER)} · cap $${CAP_USD.toFixed(2)}`);

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

    if (command === 'ab' || command === 'all') {
      const loaded = await loadPatchModules();
      if (!loaded.ok) log(`B: BLOCKED — ${loaded.blocked}`);
      for (const filing of ctx.filings) {
        await runA(modeCtx(ctx, call), filing);
        if (loaded.ok) await runB(modeCtx(ctx, call), filing, loaded.modules);
        else blockedArtifact(filing, loaded.blocked);
      }
    }
    if (command === 'gates' || command === 'all') {
      const gateCtx = {
        bookRoot: ctx.bookRoot,
        pin,
        force: ctx.force,
        call,
        ...shelf(ctx.force),
        landedOf,
      };
      for (const filing of ctx.filings) {
        await runGatesFor(gateCtx, 'A', filing);
        if (loadArtifact(`ab-B-${filing.label}.json`) !== null) await runGatesFor(gateCtx, 'B', filing);
      }
    }
    if (command === 'cache' || command === 'all') {
      const measured = await runCacheMatrix({
        bookRoot: ctx.bookRoot,
        pin,
        force: ctx.force,
        call: (messages) => call(messages, CACHE_MAX_TOKENS, 'cache'),
      });
      log(measured.calls === 0 ? '[cache] already measured (use --force)' : `[cache] ${String(measured.calls)} calls`);
    }
  } catch (error) {
    if (error instanceof SpendCapError) {
      log(`spend_cap: ${error.message} — stopping and writing what is measured`);
    } else {
      log(`failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  } finally {
    // The summary is written from artifacts, so it is true whether the run finished or stopped.
    if (listArtifacts('ab').length + listArtifacts('gates').length + listArtifacts('cache').length + listArtifacts('smoke').length > 0) {
      const { writeSummary } = await import('./report.ts');
      const written = writeSummary({ pin: { ...pin, rates }, spend: ctx.meter.totals(), startedAt, finishedAt: new Date().toISOString() });
      log(`summary: ${written.path} (${String(written.rows)} A/B rows, ${String(written.cacheCalls)} cache calls)`);
    }
  }
}

await main();
