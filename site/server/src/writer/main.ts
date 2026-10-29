/**
 * `npm run writer -- [--once] [--chapter N] [--dry-run] [--revert --chapter N] [--loop]`
 * (`docs/writer-lane.md` §5–§6).
 *
 * The CLI is the supervised process the launchd job `dev.book-writer` runs: one pass, a typed
 * result, one exit code (0 closed or nothing to do, 1 parked, 2 could not run). It owns nothing
 * but the arguments: the pass is `runPass`, the revert is `revertChapter`, and both are driven
 * through the injected engine client.
 *
 * What it may print: the resolved config (redacted — no key, no key value, no key path), one line
 * per stage, and the hashes a revert compares. What it never prints: a prompt, the key, a body.
 */

import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOTAL_CHAPTERS } from '@book/shared';

import { WriterConfigError, loadWriterConfig, type WriterConfig } from './config.ts';
import { assertDataDirIsolation, isProductionEnv } from '../dataDirGuard.ts';
import { createEngineClient, type EngineClient } from './client.ts';
import { runPass, type PassResult } from './pass.ts';
import { dryRunPlan } from './dryRun.ts';
import { callProvider, type ProviderResult } from './provider.ts';
import { reasonOf } from './reasons.ts';
import { runTriage } from './triage.ts';
import { revertChapter } from './revert.ts';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const USAGE = [
  'usage: writer [--once] [--chapter N] [--dry-run] [--revert --chapter N] [--loop]',
  '',
  '  --once            one pass, then exit (default)',
  '  --chapter N       open the first pass for chapter N instead of the lane’s next slot',
  '  --dry-run         resolve config, assignment and prompt; no engine, no model, no writes',
  '  --revert --chapter N  put the chapter back to its pre-pass state, verify the sha, reconcile',
  '  --loop            one pass, then pause (WRITER_PAUSE_MS), until SIGTERM',
  '  --help            this text',
].join('\n');

export type Cli = {
  mode: 'run' | 'revert' | 'help';
  once: boolean;
  loop: boolean;
  dryRun: boolean;
  chapter: number | null;
};

export type ParsedArgs = { ok: true; cli: Cli } | { ok: false; error: string };

const VALUE_FLAGS = new Set(['chapter']);
const BOOLEAN_FLAGS = new Set(['once', 'loop', 'dry-run', 'revert', 'help']);

/**
 * Arguments as data, so the one thing a CLI test can prove without a process is that an unknown
 * or incomplete flag is refused (exit 2) instead of being ignored.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (!arg.startsWith('--')) return { ok: false, error: `unexpected argument: ${arg}` };
    const [rawName, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
    const name = rawName.trim();
    if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name)) return { ok: false, error: `unknown flag: --${name}` };
    if (flags.has(name)) return { ok: false, error: `duplicate flag: --${name}` };
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) return { ok: false, error: `flag --${name} takes no value` };
      flags.set(name, true);
      continue;
    }
    const value = inline ?? argv[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      return { ok: false, error: `flag --${name} needs a value` };
    }
    if (inline === undefined) index += 1;
    flags.set(name, value);
  }

  if (flags.has('help')) return { ok: true, cli: { mode: 'help', once: true, loop: false, dryRun: false, chapter: null } };

  let chapter: number | null = null;
  if (flags.has('chapter')) {
    const raw = flags.get('chapter');
    const value = typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > TOTAL_CHAPTERS) {
      return { ok: false, error: `--chapter must be an integer between 1 and ${String(TOTAL_CHAPTERS)}` };
    }
    chapter = value;
  }

  const revert = flags.has('revert');
  const loop = flags.has('loop');
  const once = flags.has('once');
  if (revert && chapter === null) return { ok: false, error: '--revert needs --chapter N' };
  if (loop && once) return { ok: false, error: '--once and --loop are two different shapes' };
  if (loop && revert) return { ok: false, error: '--loop cannot revert' };

  return { ok: true, cli: { mode: revert ? 'revert' : 'run', once: !loop, loop, dryRun: flags.has('dry-run'), chapter } };
}

/** The two paths the pass writes under, resolved the way the site resolves them. */
export function pathsOf(env: NodeJS.ProcessEnv = process.env): { bookRoot: string; dataDir: string } {
  const absolute = (value: string | undefined): string | null => {
    const raw = (value ?? '').trim();
    if (raw.length === 0) return null;
    return isAbsolute(raw) ? raw : resolve(SITE_ROOT, raw);
  };
  return {
    bookRoot: absolute(env.BOOK_ROOT) ?? resolve(SITE_ROOT, '..'),
    dataDir: absolute(env.DATA_DIR) ?? resolve(SITE_ROOT, '.data'),
  };
}

const EXIT: Record<PassResult['status'], number> = { closed: 0, idle: 0, gone: 0, parked: 1, refused: 2 };

function configLines(config: WriterConfig): string[] {
  return [
    `[writer] provider ${config.provider}, модель ${config.model} (api ${config.apiModel})`,
    `[writer] конвейер ${config.pipelinePath}, ключ из ${config.keySource === 'file' ? 'файла' : 'переменной окружения'}`,
    `[writer] движок ${config.engineUrl}, сессия ${config.session}`,
    `[writer] границы: ${String(config.timeoutMs)} мс на вызов, ${String(config.maxTokensPerPass)} токенов на проход, ${String(config.maxPassesPerDay)} проходов в сутки`,
  ];
}

/**
 * Tokens are information, not a bound (the owner's instruction, 2026-10-27): the day is bounded
 * by money (`BOOK_BUDGET_DAY_USD`, enforced by the engine and by the pass's own estimate), and
 * the daily token number is still printed so a runaway is visible. Printed once, at boot.
 */
function tokenLine(config: WriterConfig): string {
  return `[writer] токены: ${String(config.dailyTokens)} за сутки — информация, не граница (граница — деньги)`;
}

function todayUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The lane's day counter, read from the engine (BOOK-187 AC5): the writer process holds no
 * database and writes no `writer/state.json` — the row is `writer_state`, and the engine is its
 * only door. An engine that cannot answer is not a licence to spend: the money budget is the
 * engine's own and is enforced there, so a failed read only means this process counts the day
 * from zero (one line says so).
 */
async function dayCounter(engine: EngineClient, day: string, log: (line: string) => void): Promise<{ day: string; passes: number }> {
  try {
    const view = await engine.writerState(day);
    return { day: view.day, passes: Number.isInteger(view.passes) && view.passes > 0 ? view.passes : 0 };
  } catch (error) {
    log(`[writer] счётчик дня не прочитан: ${reasonOf(error)} — день считается пустым, деньги по-прежнему считает движок`);
    return { day, passes: 0 };
  }
}

/** Count one pass that spent money. Bookkeeping: a failed write is a line, not a failed pass. */
async function countPass(engine: EngineClient, day: string, log: (line: string) => void): Promise<void> {
  try {
    await engine.recordPass({ day, spent: true });
  } catch (error) {
    log(`[writer] проход не записан в счётчик дня: ${reasonOf(error)}`);
  }
}

/** A pass that spent money counts toward the day, closed or parked. */
function spent(result: PassResult): boolean {
  return result.status === 'closed' || result.status === 'parked';
}

export type MainDeps = {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  log?: (line: string) => void;
  /** Injected in tests: a scripted model transport. */
  provider?: (request: Parameters<typeof callProvider>[0]) => Promise<ProviderResult>;
  /** Injected in tests: the engine client, so a lane whose counter is unreachable can be proven. */
  engine?: EngineClient;
  now?: () => number;
};

export async function main(deps: MainDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => Date.now());

  const parsed = parseArgs(deps.argv ?? process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`writer: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const cli = parsed.cli;
  if (cli.mode === 'help') {
    console.log(USAGE);
    return 0;
  }

  let config: WriterConfig;
  try {
    config = loadWriterConfig(env);
  } catch (error) {
    const message = error instanceof WriterConfigError || error instanceof Error ? error.message : 'config refused';
    console.error(`writer: ${message}`);
    return 2;
  }
  const { bookRoot, dataDir } = pathsOf(env);
  try {
    // The one wall a CLI can cross by accident: a scratch run against the live book's data.
    assertDataDirIsolation(
      { dataDir, adminTokenFile: '', engineTokenFile: config.engineTokenFile, feedbackDir: '' },
      isProductionEnv(env),
    );
  } catch (error) {
    console.error(`writer: ${error instanceof Error ? error.message : 'data dir refused'}`);
    return 2;
  }

  // The process's own line about tokens: printed once, information only (§6).
  log(tokenLine(config));

  // The engine client is built where it is used: a dry run must not need a token to exist.
  const engineOf = (): ReturnType<typeof createEngineClient> => {
    try {
      return createEngineClient({ baseUrl: config.engineUrl, tokenFile: config.engineTokenFile, timeoutMs: config.engineTimeoutMs });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'engine token refused');
    }
  };

  if (cli.mode === 'revert') {
    let outcome;
    try {
      outcome = await revertChapter({
        chapter: cli.chapter ?? 0,
        engine: engineOf(),
        dryRun: cli.dryRun,
        log,
      });
    } catch (error) {
      console.error(`writer: ${error instanceof Error ? error.message : 'revert refused'}`);
      return 2;
    }
    if (outcome.status === 'failed') console.error(`writer: ${outcome.reason ?? 'revert failed'}`);
    return outcome.status === 'failed' ? 2 : 0;
  }

  if (cli.dryRun) {
    for (const line of configLines(config)) log(line);
    if (cli.chapter === null) {
      log('[writer] dry-run: без --chapter проход не строится; с --chapter N печатается задание и промпт');
      log(`[writer] dry-run: книга ${bookRoot}, данные ${dataDir}`);
      return 0;
    }
    // A dry run has no engine of its own (the usage line below promises no engine call), so the
    // prompt is built as if nothing had been written yet: it shows the shape, not the rows.
    const plan = dryRunPlan({ bookRoot, chapter: cli.chapter });
    log(JSON.stringify({ dryRun: true, assignment: plan.assignment }, null, 2));
    log(`[writer] dry-run ${plan.summary}; модель не звана, файлы не тронуты`);
    for (const section of plan.prompt.sections) {
      log(`  ${section.id}: ${String(section.chars)} знаков, sha256 ${section.sha256.slice(0, 12)}`);
    }
    // The operator's whole point of a dry run is to read what the model would read.
    log('--- system ---');
    log(plan.prompt.system);
    log('--- user ---');
    log(plan.prompt.user);
    return 0;
  }

  const provider =
    deps.provider ??
    ((request) => callProvider(request));

  let engine: EngineClient;
  try {
    engine = deps.engine ?? engineOf();
  } catch (error) {
    console.error(`writer: ${error instanceof Error ? error.message : 'engine token refused'}`);
    return 2;
  }

  const pass = (): Promise<PassResult> =>
    runPass({
      config,
      bookRoot,
      engine,
      provider,
      now,
      log,
      chapter: cli.chapter,
      dryRun: false,
    });

  if (!cli.loop) {
    const counter = await dayCounter(engine, todayUtc(now()), log);
    if (counter.passes >= config.maxPassesPerDay) {
      log(`[writer] idle проходов на сегодня уже ${String(counter.passes)} из ${String(config.maxPassesPerDay)}`);
      return 0;
    }
    const result = await pass();
    if (spent(result)) await countPass(engine, counter.day, log);
    if (result.reason !== undefined) log(`[writer] ${result.status}: ${result.reason}`);
    return EXIT[result.status];
  }

  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = (): void => {
    stopping = true;
    wake?.();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  const pause = (ms: number): Promise<void> =>
    new Promise<void>((resolveSleep) => {
      if (stopping || ms <= 0) {
        resolveSleep();
        return;
      }
      const timer = setTimeout(() => {
        wake = null;
        resolveSleep();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolveSleep();
      };
    });

  log(
    `[writer] loop: триаж каждые ${String(config.triagePollMs)} мс, пауза прозы ${String(config.pauseMs)} мс, проходов в сутки ${String(config.maxPassesPerDay)}`,
  );
  // BOOK-206: two cadences. A filing is read every `triagePollMs`; prose still waits its own
  // pause, and triage never touches `writer_state` — a reader's filing does not eat a pass.
  let proseDueAt = now();
  while (!stopping) {
    const triage = await runTriage({ config, bookRoot, engine, provider, now, log });
    if (stopping) break;
    // A paused day buys neither a reading nor a pass, and nothing is lost: the filing stays
    // `new` and the next tick asks again.
    if (!triage.budget && now() >= proseDueAt) {
      const counter = await dayCounter(engine, todayUtc(now()), log);
      if (counter.passes >= config.maxPassesPerDay) {
        log(`[writer] idle проходов на сегодня уже ${String(counter.passes)} из ${String(config.maxPassesPerDay)}`);
        proseDueAt = now() + config.pauseMs;
      } else {
        const result = await pass();
        if (spent(result)) await countPass(engine, counter.day, log);
        if (result.reason !== undefined) log(`[writer] ${result.status}: ${result.reason}`);
        // BOOK-145/166: a step the engine took away, or a filing it refused, is a normal event —
        // the next filing is asked for in the same cycle, without the pacing pause.
        proseDueAt = now() + (result.status === 'gone' || result.filingRefused === true ? 0 : config.pauseMs);
      }
    }
    // The fast cadence sleeps too: the lane is supervised, not a busy loop.
    await pause(config.triagePollMs);
  }
  log('[writer] loop stopped');
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`writer: ${error instanceof Error ? error.message : 'failed'}`);
      process.exitCode = 2;
    });
}
