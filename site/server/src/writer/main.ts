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
import { markWriterBoot } from './verify/cli.ts';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const USAGE = [
  'usage: writer [--once] [--chapter N] [--dry-run] [--revert --chapter N] [--loop] [--ripple] [--plan ID] [--audit-samples [N]]',
  '',
  '  --once            one triage pulse and one pass, then exit (default)',
  '  --chapter N       open the first pass for chapter N instead of the lane’s next slot',
  '  --dry-run         resolve config, assignment and prompt; no engine, no model, no writes',
  '  --revert --chapter N  put the chapter back to its pre-pass state, verify the sha, reconcile',
  '  --loop            one pass, then pause (WRITER_PAUSE_MS), until SIGTERM',
  '  --ripple          drain the oldest ripple still owed work (BOOK-173), then exit',
  '  --plan ID         print the reviewable table of change ID’s ripple plan; nothing is written',
  '  --audit-samples [N]  re-read the queued local-only samples with the editor (default 3)',
  '  --help            this text',
].join('\n');

export type Cli = {
  mode: 'run' | 'revert' | 'help' | 'ripple' | 'plan' | 'audit';
  once: boolean;
  loop: boolean;
  dryRun: boolean;
  chapter: number | null;
  /** `--plan <changeId>`: the change whose frozen ripple plan is printed. */
  changeId: string | null;
  /** `--audit-samples [N]`: how many queued samples to re-read (`null` = the default). */
  audit: number | null;
};

export type ParsedArgs = { ok: true; cli: Cli } | { ok: false; error: string };

const VALUE_FLAGS = new Set(['chapter', 'plan']);
const BOOLEAN_FLAGS = new Set(['once', 'loop', 'dry-run', 'revert', 'help', 'ripple']);
/** A flag whose value is optional: `--audit-samples` alone takes the default, `=N` names a count. */
const OPTIONAL_VALUE_FLAGS = new Set(['audit-samples']);

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
    if (!VALUE_FLAGS.has(name) && !BOOLEAN_FLAGS.has(name) && !OPTIONAL_VALUE_FLAGS.has(name)) {
      return { ok: false, error: `unknown flag: --${name}` };
    }
    if (flags.has(name)) return { ok: false, error: `duplicate flag: --${name}` };
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) return { ok: false, error: `flag --${name} takes no value` };
      flags.set(name, true);
      continue;
    }
    const next = argv[index + 1];
    if (OPTIONAL_VALUE_FLAGS.has(name) && inline === undefined && (next === undefined || next.startsWith('--'))) {
      flags.set(name, true);
      continue;
    }
    const value = inline ?? next;
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      return { ok: false, error: `flag --${name} needs a value` };
    }
    if (inline === undefined) index += 1;
    flags.set(name, value);
  }

  if (flags.has('help')) {
    return { ok: true, cli: { mode: 'help', once: true, loop: false, dryRun: false, chapter: null, changeId: null, audit: null } };
  }

  let chapter: number | null = null;
  if (flags.has('chapter')) {
    const raw = flags.get('chapter');
    const value = typeof raw === 'string' ? Number(raw) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > TOTAL_CHAPTERS) {
      return { ok: false, error: `--chapter must be an integer between 1 and ${String(TOTAL_CHAPTERS)}` };
    }
    chapter = value;
  }

  const plan = flags.get('plan');
  if (plan !== undefined && typeof plan !== 'string') return { ok: false, error: '--plan needs a change id' };
  const changeId = typeof plan === 'string' ? plan : null;

  const auditFlag = flags.has('audit-samples');
  let audit: number | null = null;
  if (auditFlag) {
    const raw = flags.get('audit-samples');
    if (raw !== true) {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) return { ok: false, error: '--audit-samples takes a positive integer' };
      audit = value;
    }
  }

  const revert = flags.has('revert');
  const ripple = flags.has('ripple');
  const loop = flags.has('loop');
  const once = flags.has('once');
  // The sample audit reads chapters and calls the editor: it is one command, not a pass.
  if (auditFlag && (revert || ripple || loop || chapter !== null || changeId !== null || once)) {
    return { ok: false, error: '--audit-samples runs alone: no chapter, no pass, no drain' };
  }
  if (revert && chapter === null) return { ok: false, error: '--revert needs --chapter N' };
  if (loop && once) return { ok: false, error: '--once and --loop are two different shapes' };
  if (loop && revert) return { ok: false, error: '--loop cannot revert' };
  if (ripple && revert) return { ok: false, error: '--ripple and --revert are two different shapes' };
  if (ripple && chapter !== null) return { ok: false, error: '--ripple chooses its own chapter from the plan' };
  if (changeId !== null && (revert || ripple || loop)) {
    return { ok: false, error: '--plan prints a table; it runs nothing' };
  }

  const mode = auditFlag ? 'audit' : changeId !== null ? 'plan' : ripple ? 'ripple' : revert ? 'revert' : 'run';
  return {
    ok: true,
    cli: { mode, once: !loop, loop, dryRun: flags.has('dry-run'), chapter, changeId, audit },
  };
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
    `[writer] режим по умолчанию ${config.modeDefault}${config.modeDefault === 'rewrite' ? ' (WRITER_MODE_DEFAULT: переключатель владельца)' : ''}`,
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

/**
 * BOOK-DOC-84 §7 IFACE — is a filing waiting? The lane's own `state()` answers it (`queue.pending`),
 * and an engine that cannot answer is **not** a licence to spin: one line, and the idle poll.
 * Asking the door (`next`) would open a pass, which is the thing this question is about.
 */
async function filingPending(engine: EngineClient, log: (line: string) => void): Promise<boolean> {
  try {
    const view = await engine.state();
    // A premise filing is the writer's work (BOOK-166) and is not a queued change; a chain's
    // next pass is taken on the breath, and only a lane with nothing at all sleeps the poll.
    return view.queue.pending > 0 || view.queue.filings > 0;
  } catch (error) {
    log(`[writer] очередь не прочитана: ${reasonOf(error)} — пауза до следующего опроса`);
    return false;
  }
}

/**
 * BOOK-DOC-84 §7 IFACE — how long the loop waits after one pass: the **idle** poll when nothing
 * waits, the breath when a filing does. Pure, so the pacing is a test with no clock in it.
 */
export function proseDelayMs(
  status: PassResult['status'],
  pending: boolean,
  config: { breathMs: number; pauseMs: number },
): number {
  if (pending && status !== 'idle') return config.breathMs;
  return config.pauseMs;
}

/** §7 IFACE: three consecutive parks stop the lane (exit 1) — the brake D4 keeps. */
export const PARK_LIMIT = 3;

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

  if (cli.mode === 'plan' || cli.mode === 'ripple' || cli.mode === 'audit') {
    // The writer holds no database handle (BOOK-187, BOOK-183): every command that needs the
    // ledger is an operator tool in `site/bin/ledger.mjs`, which opens the volume itself the way
    // `bin/restore.mjs` and `bin/index.mjs` do.
    console.error(`writer: --${cli.mode} is an operator command — node site/bin/ledger.mjs ${cli.mode}`);
    return 2;
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

  // BOOK-DOC-80: the boot marker the sample queue consumes — the first `local only` change of
  // this process is always re-read by the editor. A row written through the engine (the writer
  // holds no database): a marker left by a process that filed nothing is still owed its sample.
  await markWriterBoot(engine, log);

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
    // BOOK-206 (--once): a manual run reads one pulse before the pass. Without it a one-shot run
    // left the reader's queue unread and the operator blind to it; `--loop` is unchanged.
    try {
      const triage = await runTriage({ config, bookRoot, engine, provider, now, log });
      log(
        `[writer] триаж: прочитано ${String(triage.triaged)}, без ответа ${String(triage.failed)}` +
          (triage.budget ? ', день на паузе' : ''),
      );
    } catch (error) {
      // A broken pulse is a line, not a reason to skip the pass the operator asked for.
      log(`[writer] триаж: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    `[writer] loop: триаж каждые ${String(config.triagePollMs)} мс, вдох между проходами ${String(config.breathMs)} мс, проходов в сутки ${String(config.maxPassesPerDay)}`,
  );
  // BOOK-206: two cadences. A filing is read every `triagePollMs`; prose still waits its own
  // pause, and triage never touches `writer_state` — a reader's filing does not eat a pass.
  let proseDueAt = now();
  // §7 IFACE: three consecutive parks exit 1 — the brake D4 keeps in place of the old pause.
  let parks = 0;
  while (!stopping) {
    // A missing prompt file (or any other triage fault) is a line and a pause, never a dead lane:
    // prose is the writer's job and a filing is not worth stopping it for.
    let triage: Awaited<ReturnType<typeof runTriage>>;
    try {
      triage = await runTriage({ config, bookRoot, engine, provider, now, log });
    } catch (error) {
      log(`[writer] триаж: ${error instanceof Error ? error.message : String(error)}`);
      triage = { triaged: 0, failed: 1, budget: false };
    }
    if (stopping) break;
    // A paused day buys neither a reading nor a pass, and nothing is lost: the filing stays
    // `new` and the next tick asks again.
    if (!triage.budget && now() >= proseDueAt) {
      const counter = await dayCounter(engine, todayUtc(now()), log);
      if (counter.passes >= config.maxPassesPerDay) {
        log(`[writer] idle проходов на сегодня уже ${String(counter.passes)} из ${String(config.maxPassesPerDay)}`);
        proseDueAt = now() + config.pauseMs;
      } else {
        let result: PassResult;
        try {
          result = await pass();
        } catch (error) {
          // §7 IFACE: a throw is exit 2 — the supervisor restarts, nothing is retried in place.
          log(`[writer] проход упал: ${reasonOf(error)}`);
          return 2;
        }
        if (spent(result)) await countPass(engine, counter.day, log);
        if (result.reason !== undefined) log(`[writer] ${result.status}: ${result.reason}`);
        parks = result.status === 'parked' ? parks + 1 : 0;
        if (parks >= PARK_LIMIT) {
          log('[writer] писатель остановлен после трёх отказов');
          return 1;
        }
        // BOOK-DOC-84 D4: no artificial silence while work waits. A closed pass is followed by
        // the next pending filing after the breath; a refused or gone pass takes the next one on
        // the same breath; only an idle pass (nothing to write, a paused day, the day's cap)
        // sleeps the idle poll.
        const pending = result.status === 'idle' ? false : await filingPending(engine, log);
        proseDueAt = now() + proseDelayMs(result.status, pending, config);
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
