#!/usr/bin/env node
/**
 * scripts/position-cdp.mjs — BOOK-209, the position layer measured in a real browser.
 *
 * Three behaviours, one page, the real site: the contents must land each chapter's heading at
 * the sticky head's **bottom + 16 px** (42 rows at 1440 and at 390), a back must return the
 * sentence the reader left to the pixel, and a reload must put the reader back where they were
 * (`localStorage` on a device, a row on the server once the layer exists).
 *
 *   node scripts/position-cdp.mjs [--stage=before|after] [--json] [--rows=a-b] [--no-build] [--verbose] [--note="…"]
 *
 * What it does, in order: a scratch `DATA_DIR` seeded through the product's one-shot import from
 * **the book this run owns** — by default a fixture `manuscript/` written into a scratch
 * directory (deterministic bytes, deleted with the run, so a clean checkout needs nothing
 * outside itself); `POSITION_SEED_VOLUME` measures a real seeded volume instead (since ADR-043
 * the text's home is the database, so that is the true book), and `POSITION_BOOK_ROOT` a real
 * book tree. The record names which one (`- seed: …`). Then `npm run build` plus
 * `release publish` (unless `--no-build` and a release is on disk); the real server on :8099;
 * then Chromium over CDP — `$POSITION_CHROME`, the Playwright cache, or a system Chrome.
 * The age gate (BOOK-225) stands in front of the chapters, so it is answered the way a reader
 * answers it — one real click per browser context, `lib/position-gate.mjs` — and the sweep then
 * measures a page that has its 42 slots.
 * Everything is torn down on the way out, a crash included.
 *
 * The measured server boots with `READ_PER_MINUTE=100000` (the harness's own default; override
 * with the variable): the read limiter is per network and covers `/api/state` and `/api/me`, and
 * a harness that loads a page per measured row would spend the shipped 60 a minute itself — the
 * signed-in phase would then be refused with a `429` by the budget the sweep spent, not by the
 * product. The limiter is not what this measures; the record says which budget it ran under.
 * A phase that still meets a `429` retries once after `retry-after` (bounded) and then reports
 * the limiter as the outcome — never as a pass.
 *
 * Env seams: `POSITION_CHROME`, `POSITION_BOOK_ROOT`, `POSITION_SEED_VOLUME`, `READ_PER_MINUTE`, and two for
 * measuring a tree that is not the one you are standing in — `POSITION_SITE_ROOT` (build and
 * serve that `site/` instead) and `POSITION_GIT_ROOT` (where the commit and the tree come from).
 * They exist because a before-run needs the commit as it was, and a checkout another session is
 * editing is not that; the record names the tree it was taken from (`- source tree:`).
 *
 * **Each contents row is measured on its own page load.** The AC says "reset to the top"; a
 * reload is the stricter reading, and it is the honest one: in one document the chapters that
 * the previous rows loaded stay loaded, so a row measured late in the sequence sees a page no
 * reader ever has (the placeholders above it are already gone). A reader taps a row on a page
 * that has just arrived, which is where the height drift lives — so that is what is measured.
 *
 * Exit codes (IFACE): 0 — every measured assertion holds; 1 — at least one row outside ±2 px,
 * a back case off by more than 2 px, or a resume miss where the layer is implemented; 2 — the
 * harness could not run (no browser, a build or seed failure, a page that never reaches 42 rows).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Cdp, killTree, portIsFree, spawnLogged, waitForUrl } from './lib/cdp.mjs';
import * as boot from './lib/position-boot.mjs';
import {
  TOTAL_ROWS,
  measureBack,
  measureContents,
  measureSameDevice,
  measureSecondDevice,
  probeResumeServer,
  putPlace,
} from './lib/position-measure.mjs';
import {
  POSITION_TARGET_PX,
  POSITION_TOLERANCE_PX,
  markdownReport,
  positionVerdict,
  summariseRows,
} from './lib/position.mjs';

const ARGS = process.argv.slice(2);
const VERBOSE = ARGS.includes('--verbose');
const JSON_OUT = ARGS.includes('--json');
const NO_BUILD = ARGS.includes('--no-build');
const STAGE = (ARGS.find((arg) => arg.startsWith('--stage=')) ?? '--stage=before').slice('--stage='.length) === 'after' ? 'after' : 'before';
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
/** The chapter AC2/AC3 read: prose, and deep enough that the cover's height is far above it. */
const PLACE_CHAPTER = 9;
const PLACE_CHAPTER_SMALL = 7;
const BACK_CASES = [
  { name: 'discussion', hash: '#discussion', index: 120 },
  { name: 'ch-2', hash: '#ch-2', index: 150 },
];
const NOTE = (ARGS.find((arg) => arg.startsWith('--note=')) ?? '').slice('--note='.length);
const SHOT_DIR = resolve(process.env.POSITION_SHOTS ?? join(boot.SITE_ROOT, 'shots', 'position'));
const RUN_LIMIT_MS = 5 * 60_000;

function log(...parts) {
  if (VERBOSE) process.stderr.write(`${parts.join(' ')}\n`);
}

function harnessError(message) {
  return Object.assign(new Error(message), { harness: true });
}

/**
 * The record's copy of the seed: which book, and never the cookie. `seeded.session` stays with
 * the run — the `PUT` and the second device need it — while the record is a file the repository
 * may publish, and a credential does not belong in one.
 */
function seedRecord(seeded) {
  return {
    line: seeded.line,
    how: seeded.how,
    source: seeded.source,
    fixture: seeded.fixture ?? null,
    identityId: seeded.session === null ? null : seeded.session.identityId,
  };
}

/** `--rows=a-b` / `--rows=n`: the subset a debug run measures; the whole book by default. */
function wantedRows() {
  const flag = ARGS.find((arg) => arg.startsWith('--rows='));
  if (flag === undefined) return Array.from({ length: TOTAL_ROWS }, (_, index) => index + 1);
  const value = flag.slice('--rows='.length);
  const [from, to] = value.split('-');
  const first = Number.parseInt(from ?? '', 10);
  const last = to === undefined ? first : Number.parseInt(to, 10);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > TOTAL_ROWS || first > last) {
    throw harnessError(`--rows=${value} is not a range inside 1-${String(TOTAL_ROWS)}`);
  }
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

/** `POSITION_GIT_ROOT` names the checkout when the measured tree is an export without `.git`. */
function git(...args) {
  try {
    return execFileSync('git', args, { cwd: process.env.POSITION_GIT_ROOT ?? boot.SITE_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** `git status --porcelain`, parsed: the first line's leading status byte is part of the row. */
function dirtyFiles() {
  try {
    const raw = execFileSync('git', ['status', '--porcelain'], {
      cwd: process.env.POSITION_GIT_ROOT ?? boot.SITE_ROOT,
      encoding: 'utf8',
    });
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => line.slice(3).trim());
  } catch {
    return [];
  }
}

/** The browser, one page target plus its browser-level endpoint (a second context needs it). */
async function launchBrowser(binary, profileDir, viewport) {
  mkdirSync(profileDir, { recursive: true });
  for (let port = 9340; port < 9360; port += 1) {
    if (!(await portIsFree(`http://127.0.0.1:${String(port)}/json/version`))) continue;
    const child = spawnLogged(binary, [
      '--headless=new',
      `--remote-debugging-port=${String(port)}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${String(viewport.width)},${String(viewport.height)}`,
      'about:blank',
    ], { cwd: profileDir });
    try {
      await waitForUrl(`http://127.0.0.1:${String(port)}/json/version`, 30_000, 'Chromium CDP');
    } catch {
      killTree(child);
      continue;
    }
    const version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json();
    const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json();
    const target = targets.find((item) => item.type === 'page');
    if (target === undefined) {
      killTree(child);
      throw harnessError('the browser opened no page target');
    }
    return { child, port, pageWs: target.webSocketDebuggerUrl, browserWs: version.webSocketDebuggerUrl };
  }
  throw harnessError('no free debugging port in 9340-9359');
}

/**
 * Wait for a killed child to be gone, bounded: a teardown that hung on a stuck process would be
 * worse than the leak it prevents. `killTree` signals the group; the browser's own exit is what
 * says its profile has stopped being written.
 */
function exited(child, timeoutMs = 3_000) {
  if (child === undefined || child === null || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  const started = Date.now();
  const rows = wantedRows();
  const dataDir = boot.scratch('position-data-');
  const profileDir = boot.scratch('position-chrome-');
  let server = null;
  let browser = null;
  let cdp = null;
  /** The fixture manuscript, when the run had to write one: the run's own, deleted with it. */
  let seeded = null;

  // The browser is killed and waited for before anything is removed: a Chromium that is told to
  // die still flushes its profile on the way out, and a directory removed underneath it comes
  // back — a leaked profile per run, which is exactly what a harness must not leave behind.
  const cleanup = async () => {
    try {
      if (cdp !== null) cdp.close();
    } catch {
      /* already gone */
    }
    if (browser !== null) killTree(browser.child);
    if (server !== null) killTree(server);
    await Promise.all([exited(browser?.child), exited(server)]);
    boot.dispose([dataDir, profileDir, seeded?.tempDir]);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void cleanup().then(() => process.exit(2)));

  try {
    if (!NO_BUILD || !boot.releaseReady()) await boot.build({ log });
    else log('build: skipped (--no-build, a release is on disk)');
    seeded = await boot.seed({ dataDir, log });
    server = await boot.serve({ dataDir, log });

    const binary = boot.browserBinary();
    log(`browser: ${binary}`);
    browser = await launchBrowser(binary, profileDir, VIEWPORTS[0]);
    cdp = await Cdp.open(browser.pageWs);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    // ── the signed-in phase first ────────────────────────────────────────────────
    // The read budget is per network, and the sweep below is 84 page loads: measuring the
    // session's place *after* it would be measuring a budget already spent. So: the device's
    // own place, its `PUT`, the second context's resume, and the route probe — then the sweep.
    const sameDevice = await measureSameDevice(cdp, VIEWPORTS[0], PLACE_CHAPTER_SMALL, 60, log);
    const resumed = (place) =>
      place === null ? 'not-measured' : place.restored === true ? 'yes' : place.restored === false ? 'no' : 'not-measured';
    process.stdout.write(
      `resume same-device top=${String(sameDevice?.top ?? null)} ` +
        `sentence=${sameDevice?.sentence === null || sameDevice?.sentence === undefined ? 'none' : sameDevice.sentence} ` +
        `restored=${resumed(sameDevice)}\n`,
    );

    const anchor = sameDevice?.anchor ?? null;
    const put = anchor === null || seeded.session === null ? null : await putPlace(seeded.session, anchor, log);
    log(`second device: PUT ${String(put ?? '-')}`);
    const other =
      anchor === null || put !== 204 || seeded.session === null
        ? null
        : await measureSecondDevice(browser, VIEWPORTS[0], seeded.session, { ...anchor, before: sameDevice.before }, log);
    process.stdout.write(
      `resume second-device top=${String(other?.top ?? null)} ` +
        `sentence=${other?.sentence === null || other?.sentence === undefined ? 'none' : other.sentence} ` +
        `restored=${resumed(other)}\n`,
    );

    const serverState = await probeResumeServer(seeded.session, log);
    process.stdout.write(
      `resume-server: ${serverState.outcome} (anonymous=${String(serverState.anonymous)}, signed=${String(serverState.signed)})` +
        (serverState.outcome === 'guarded' && seeded.session !== null
          ? ' — the seeded session was refused; the place route could not be exercised'
          : '') +
        '\n',
    );
    log('signed-in phase: done');

    // ── the sweep ───────────────────────────────────────────────────────────────
    const contents = [];
    for (const viewport of VIEWPORTS) {
      contents.push(...(await measureContents(cdp, viewport, rows, log)));
    }
    log('contents: done');

    const back = [];
    for (const viewport of VIEWPORTS) back.push(...(await measureBack(cdp, viewport, PLACE_CHAPTER, BACK_CASES, log)));

    const report = {
      stage: STAGE,
      at: new Date().toISOString(),
      commit: git('rev-parse', '--short', 'HEAD'),
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      dirty: dirtyFiles(),
      browser: binary,
      source: boot.SITE_ROOT,
      note: NOTE.length === 0 ? null : NOTE,
      seed: seedRecord(seeded),
      widths: VIEWPORTS.map((viewport) => viewport.width),
      target: POSITION_TARGET_PX,
      tolerance: POSITION_TOLERANCE_PX,
      freshPerRow: true,
      rows: contents,
      back,
      budget: { readPerMinute: boot.READ_PER_MINUTE },
      resume: {
        server: serverState,
        anchor,
        put,
        sameDevice,
        secondDevice: other,
      },
    };

    const verdict = positionVerdict(report);
    report.summary = summariseRows(contents);
    report.exit = verdict.code;

    mkdirSync(SHOT_DIR, { recursive: true });
    writeFileSync(join(SHOT_DIR, `${STAGE}.md`), markdownReport(report, { stage: STAGE }), 'utf8');
    if (JSON_OUT) writeFileSync(join(SHOT_DIR, `${STAGE}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    for (const width of report.summary) {
      process.stdout.write(
        `summary width=${String(width.width)} rows=${String(width.count)} outside=${String(width.outside)} ` +
          `median=${String(width.median)} worst-row=${String(width.worst?.row ?? '-')} worst-delta=${String(width.worst?.delta ?? '-')}\n`,
      );
    }
    process.stdout.write(`record: ${join(SHOT_DIR, `${STAGE}.md`)}${JSON_OUT ? ` + ${STAGE}.json` : ''}\n`);
    const runtimeMs = Date.now() - started;
    process.stdout.write(`runtime: ${String(Math.round(runtimeMs / 1000))} s\n`);
    process.stdout.write(`${verdict.code === 0 ? 'PASS' : 'FAIL'} — ${verdict.reasons.join('; ') || 'every measured assertion holds'}\n`);
    if (runtimeMs > RUN_LIMIT_MS) {
      process.stderr.write(`position: the run took ${String(Math.round(runtimeMs / 1000))} s, past its ${String(RUN_LIMIT_MS / 1000)} s budget\n`);
    }
    await cleanup();
    process.exit(verdict.code);
  } catch (error) {
    await cleanup();
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`position: ${message}\n`);
    process.exit(2);
  }
}

await main();
