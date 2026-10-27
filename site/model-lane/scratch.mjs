/**
 * The scratch book and the engine child (ADR-038 §7).
 *
 * A live pass must run the **prod sequence** without running on prod: a temp `DATA_DIR`, a temp
 * `BOOK_ROOT` holding copies of `concept/`, `style/`, `outline/`, page 2 of the manuscript and
 * `process/ROLE_PROMPTS.md`, the real entrypoint (`node --import tsx server/src/engine.ts`) on a
 * private port, a per-run token, and the shipped TTLs and step wall.
 *
 * Three walls keep it clear of production, and none of them is a comment:
 *
 *   1. the engine's own `assertDataDirIsolation` refuses a non-production boot that points at a
 *      production data dir (BOOK-107);
 *   2. this module refuses first (`LANE_DIR_REFUSED`) when `realpath` of either directory is
 *      inside `$HOME/book-site-data` or any `PRODUCTION_DATA_DIR`;
 *   3. the writer writes into the copy, and nothing here reads `site/.data` — there is no
 *      default `ENGINE_URL` and no default token file.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { BOOK_ROOT, LaneError, SITE_ROOT } from './pipeline.mjs';

/**
 * What the copy holds: the text a pass reads, and the prompts it must use verbatim.
 *
 * `manuscript/` is **not** copied whole. The scratch book must be the clean page prod's first
 * pass has: ch01 and ch67 hold only their frozen sentence, they are not prose, and copying them
 * would ask the writer to write a chapter whose file already holds the frame (and could replace
 * it). Only page 2 (`00-front.md`) is copied — it is written, so the engine offers a draft
 * rather than a front pass. ch67 is deliberately absent: the backward lane is not part of this
 * pass, and the ending is only ever evaluated, never written.
 */
const COPY_DIRS = ['concept', 'style', 'outline'];
const COPY_FILES = [join('manuscript', '00-front.md'), join('process', 'ROLE_PROMPTS.md')];

function realPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function covers(dir, candidate) {
  return candidate === dir || candidate.startsWith(`${dir}${sep}`);
}

/** Wall 2: our own refusal, alongside the engine's boot guard. */
export function assertScratchIsolation(dirs, env = process.env) {
  const declared = (env.PRODUCTION_DATA_DIR ?? '')
    .split(':')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => realPath(part));
  const productionDirs = [realPath(resolve(homedir(), 'book-site-data')), ...declared];
  for (const [name, dir] of Object.entries(dirs)) {
    const candidate = realPath(dir);
    for (const production of productionDirs) {
      if (covers(production, candidate)) {
        throw new LaneError(
          'LANE_DIR_REFUSED',
          `${name} resolves inside a production data dir (${candidate}); the lane runs on a scratch copy only`,
        );
      }
    }
  }
}

/** An ephemeral loopback port, asked for and handed back, so two runs never collide. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * The entrypoint imports `@book/shared` through the workspace's built `dist`, exactly as
 * `npm run engine` does. Vitest resolves it to source through an alias; plain Node does not, so
 * the lane builds the package once when it is missing — a build, not an edit to any held file.
 */
function ensureSharedBuild() {
  if (existsSync(join(SITE_ROOT, 'shared', 'dist', 'index.js'))) return;
  try {
    execFileSync('npm', ['run', 'build', '-w', '@book/shared'], { cwd: SITE_ROOT, encoding: 'utf8' });
  } catch (error) {
    throw new LaneError(
      'SCRATCH_BOOT',
      `cannot build @book/shared, which the engine entrypoint imports: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function gitStatus() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: BOOK_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * The opening blocks of a chapter: paragraphs after whitespace normalisation, title first.
 */
function openingBlocks(text) {
  return String(text)
    .split(/\n{2,}/u)
    .map((block) => block.replace(/\s+/gu, ' ').trim())
    .filter((block) => block.length > 0)
    .slice(0, 2);
}

/**
 * Does the landed ch01 open on its frozen frame? The frame is read from the **checkout**
 * (`BOOK_ROOT/manuscript/ch01.md`, read-only) — the scratch chapter starts empty by design —
 * and compared with the landed opening. Recorded, never enforced: replacing the frame is the
 * validator's rule (F029), not the lane's. `null` when either file cannot be read.
 */
export function frameCheck(scratchBookRoot) {
  try {
    const checkout = openingBlocks(readFileSync(join(BOOK_ROOT, 'manuscript', 'ch01.md'), 'utf8'));
    const frame = checkout.length > 1 ? checkout[1] : checkout[0];
    if (frame === undefined) return null;
    const landed = openingBlocks(readFileSync(join(scratchBookRoot, 'manuscript', 'ch01.md'), 'utf8'));
    return landed.some((block) => block.startsWith(frame));
  } catch {
    // A missing file is not a fact about the frame; the transcript says `null`, not `false`.
    return null;
  }
}

/**
 * The engine's own account of a close, read from `bin/engine.mjs trace`: the step line and the
 * gates line, trimmed, plus the writer's model parsed from the step line. Each gate's own segment
 * must name the model — one line carrying it twice would satisfy a check that only asks the line
 * (review, AC2). A refusal is `PASS_NOT_CLOSED`, exit 1: the pass did not close.
 */
export function assertClosedTrace(traceText, model) {
  const closedLine = (String(traceText).split('\n').find((row) => row.startsWith('step ')) ?? '').trim();
  const gateLine = (String(traceText).split('\n').find((row) => row.includes('gates:')) ?? '').trim();
  const notClosed = (why) => new LaneError('PASS_NOT_CLOSED', why, 1);
  if (!closedLine.includes('closed')) throw notClosed(`trace does not say closed: ${closedLine}`);
  const stepModel = /(?:^|\s)model\s+(\S+)/u.exec(closedLine)?.[1] ?? null;
  if (stepModel !== model) throw notClosed(`the step names model ${String(stepModel)}, not ${model}`);
  const segments = gateLine.split('·').map((segment) => segment.trim());
  for (const role of ['editor', 'consultant']) {
    const own = segments.find((segment) => segment.includes(`${role}:`)) ?? 'none';
    if (!own.includes(model)) throw notClosed(`the ${role} gate line does not name the model: ${own}`);
  }
  return { closedLine, gateLine, stepModel };
}

/**
 * The CLI, called the way a session calls it: through `bin/engine.mjs`, over HTTP, with the run's
 * own token. `--json` is not a flag; every command already prints JSON except `trace`.
 */
function cliRunner(engineUrl, token) {
  return (args) => {
    try {
      const stdout = execFileSync('node', ['bin/engine.mjs', ...args], {
        cwd: SITE_ROOT,
        env: { ...process.env, ENGINE_URL: engineUrl, ENGINE_TOKEN: token, ENGINE_SESSION: 'model-lane' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      const failure = error;
      return { code: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  };
}

/**
 * Build the scratch book, boot the engine and return the handles a pass needs. The caller must
 * `stop()` in a `finally`: it removes the temp dirs unless `keep` is set.
 */
export async function openScratch(options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'book-lane-data-'));
  const bookRoot = mkdtempSync(join(tmpdir(), 'book-lane-root-'));
  assertScratchIsolation({ DATA_DIR: dataDir, BOOK_ROOT: bookRoot });

  // The copy is the wall that matters: the writer cannot reach the real manuscript through a
  // relative path, because the root it is told about has its own `manuscript/`.
  for (const name of COPY_DIRS) cpSync(join(BOOK_ROOT, name), join(bookRoot, name), { recursive: true });
  mkdirSync(join(bookRoot, 'manuscript'), { recursive: true });
  for (const file of COPY_FILES) cpSync(join(BOOK_ROOT, file), join(bookRoot, file), { recursive: false });

  const token = randomBytes(32).toString('hex');
  const port = await freePort();
  ensureSharedBuild();
  const env = {
    ...process.env,
    BOOK_ROOT: bookRoot,
    DATA_DIR: dataDir,
    ENGINE_HOST: '127.0.0.1',
    ENGINE_PORT: String(port),
    ENGINE_URL: `http://127.0.0.1:${String(port)}`,
    ENGINE_TOKEN: token,
    DRAFTING: 'on',
    LOG_LEVEL: 'error',
  };
  // `NODE_ENV` decides the production invariants and the data-dir guard's direction: a launchd
  // shell that ships `production` would flip both, so the lane unsets it deliberately.
  delete env.NODE_ENV;
  delete env.PRODUCTION_DATA_DIR;

  const before = gitStatus();
  const child = spawn('node', ['--import', 'tsx', 'server/src/engine.ts'], {
    cwd: SITE_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    err += String(chunk);
  });

  const engineUrl = `http://127.0.0.1:${String(port)}`;
  const deadline = Date.now() + 30_000;
  let booted = false;
  while (Date.now() < deadline && !booted) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${engineUrl}/internal/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000),
      });
      booted = response.ok;
    } catch {
      await sleep(150);
    }
  }
  if (!booted) {
    child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(bookRoot, { recursive: true, force: true });
    throw new LaneError(
      'SCRATCH_BOOT',
      `the engine under test did not answer on ${engineUrl}${err.trim() === '' ? '' : `: ${err.trim().split('\n').slice(-3).join(' | ')}`}`,
    );
  }

  const cli = cliRunner(engineUrl, token);
  return {
    bookRoot,
    dataDir,
    engineUrl,
    token,
    cli,
    /** JSON-answer helper: the CLI prints one object, so a failure is a lane error, not a parse. */
    call(args) {
      const result = cli(args);
      if (result.code !== 0) {
        throw new LaneError('ENGINE_REFUSED', `${args.join(' ')} → exit ${String(result.code)}: ${result.stderr.trim()}`);
      }
      return result.stdout.trim() === '' ? null : JSON.parse(result.stdout);
    },
    /** Did the run touch the checkout? The copy is the point; the checkout must be untouched. */
    checkoutAfter: () => gitStatus(),
    async stop({ keep = false } = {}) {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise((resolveExit) => child.once('exit', () => resolveExit(true))),
        sleep(5_000).then(() => false),
      ]);
      if (!exited) child.kill('SIGKILL');
      if (!keep) {
        rmSync(dataDir, { recursive: true, force: true });
        rmSync(bookRoot, { recursive: true, force: true });
      }
      return { checkoutBefore: before, checkoutAfter: gitStatus() };
    },
  };
}
