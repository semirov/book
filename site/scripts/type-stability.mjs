#!/usr/bin/env node
/**
 * scripts/type-stability.mjs — the reading column does not follow the reader's root font size.
 *
 * What it proves, in a real Chromium: at a 16, 18 and 20 px root the chapter's column stays one
 * width per viewport (640 px at ≥1024, 622 px below, 342 px at 390 — viewport-bound), the body
 * stays at the design's 18 / 17.5 / 17 px, and the characters per line — measured from the
 * chapter's own prose, not from a nominal em — do not move. Before BOOK-170 the column was
 * `rem` and the type px, so every root step made the line longer while the glyphs stayed put.
 *
 *   npm run type:stability
 *   node scripts/type-stability.mjs [--url http://127.0.0.1:5173] [--json] [--chromium <path>]
 *
 * Exit codes (the whole control surface):
 *   0 — every assertion held
 *   1 — drift: a row's column, body or character count moved (the row is named)
 *   2 — cannot run: `playwright-core` or a Chromium binary is missing, or `#ch-1` has no prose
 *
 * Manual, on purpose: `playwright-core` is not a dependency of this repo (no new dependency, no
 * CI download), so this script is not part of `npm run verify`. It writes nothing. The browser
 * is `--chromium`, else `PW_CHROMIUM_PATH`, else the newest Playwright cache build.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const USAGE = 'usage: node scripts/type-stability.mjs [--url <url>] [--json] [--chromium <path>]';

const ROOT = resolve(import.meta.dirname, '..');

/** The four viewports and the geometry the sheets declare for each (390 is viewport-bound). */
const VIEWS = [
  { width: 390, body: 17, column: 342 },
  { width: 768, body: 17.5, column: 622 },
  { width: 1024, body: 18, column: 640 },
  { width: 1440, body: 18, column: 640 },
];

const ROOTS = [16, 18, 20];
/** Sub-pixel slack: a fractional column is not a root-size dependency. */
const TOLERANCE = 0.5;

class PageProblem extends Error {}

function bail(message) {
  process.stderr.write(`type: ${message}\n${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { url: 'http://127.0.0.1:5173', json: false, chromium: null };
  const valueFlags = new Map([
    ['--url', 'url'],
    ['--chromium', 'chromium'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (name === '--json') {
      if (equals !== -1) bail('--json takes no value');
      options.json = true;
      continue;
    }
    const key = valueFlags.get(name);
    if (key === undefined) bail(`unknown argument: ${arg}`);
    let value;
    if (equals === -1) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) bail(`${name} needs a value`);
      index += 1;
      value = next;
    } else {
      value = arg.slice(equals + 1);
    }
    if (value.length === 0) bail(`${name} needs a value`);
    options[key] = value;
  }
  return options;
}

/** The checkouts that may hold `playwright-core`: this worktree, then the repository it is cut from. */
function requireRoots() {
  const dirs = [ROOT];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const main = resolve(dirname(common), 'site');
    if (!dirs.includes(main)) dirs.push(main);
  } catch {
    // Not a git checkout (or no git): the fixed candidates below are the whole search.
  }
  for (const dir of [process.env.PW_ROOT]) {
    if (dir !== undefined && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

async function loadPlaywright() {
  for (const dir of requireRoots()) {
    try {
      const require = createRequire(join(dir, 'package.json'));
      const loaded = await import(require.resolve('playwright-core'));
      return loaded.chromium === undefined ? loaded.default : loaded;
    } catch {
      // Try the next checkout.
    }
  }
  bail(
    'playwright-core is not installed — `npm i -D playwright-core` in this checkout (no CI dependency), or set PW_ROOT to a site/ that has it',
  );
}

/** The build number of a Playwright cache directory name, and whether it is the full browser. */
const buildOf = (name) => Number.parseInt(name.slice(name.search(/\d/u)), 10);

/** The newest Chromium binary in the Playwright cache, on macOS or Linux; null when none. */
function cachedChromium() {
  const caches = [
    join(homedir(), 'Library/Caches/ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
  ];
  const suffixes = [
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-mac/headless_shell',
    'chrome-linux/chrome',
    'chrome-linux/headless_shell',
    'chrome-headless-shell-linux64/chrome-headless-shell',
  ];
  const builds = caches
    .filter((cache) => existsSync(cache))
    .flatMap((cache) => readdirSync(cache).map((name) => ({ cache, name })))
    .filter(({ name }) => /^chromium[-_](?:headless[-_]shell-)?\d+$/u.test(name))
    .sort((left, right) => buildOf(right.name) - buildOf(left.name));
  for (const { cache, name } of builds) {
    for (const suffix of suffixes) {
      const path = join(cache, name, suffix);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** The column, the body size and the real prose's advance width, from the page itself. */
async function probe(page) {
  return page.evaluate(async () => {
    const nextFrame = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    await nextFrame();
    // The chapter the URL names, not the first `.ch` in the document: the other articles are
    // placeholders until their own `IntersectionObserver` loads them.
    const columnEl = document.querySelector('#ch-1');
    const prose = columnEl?.querySelector('.p') ?? null;
    if (prose === null || columnEl === null) return null;
    const text = (prose.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 300);
    const span = document.createElement('span');
    span.textContent = text;
    span.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;visibility:hidden';
    prose.appendChild(span);
    const advance = span.getBoundingClientRect().width / Math.max(1, text.length);
    span.remove();
    return {
      text,
      column: columnEl.getBoundingClientRect().width,
      body: Number.parseFloat(getComputedStyle(document.body).fontSize),
      advance,
    };
  });
}

/**
 * The settled measurement: a resize re-renders the chapter, so the first paragraph can be a
 * node that is replaced a frame later. Two consecutive probes of the same box and the same
 * text are the reading. A page that never settles is `null`, not the last sample: a reading of
 * a node that is still being replaced is not a reading.
 */
async function measure(page) {
  let last = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const now = await probe(page);
    if (now !== null && last !== null && now.text === last.text && now.column === last.column) return now;
    last = now;
    await page.waitForTimeout(50);
  }
  return null;
}

async function openChapter(page, url) {
  try {
    await page.goto(`${url}#ch-1`, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForSelector('#ch-1 .p', { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
  } catch {
    throw new PageProblem(`no chapter at ${url}#ch-1 — serve the site and its API (npm run dev) and try again`);
  }
}

async function setRoot(page, root) {
  await page.evaluate((size) => {
    document.documentElement.style.fontSize = `${size}px`;
  }, root);
}

async function collect(page, url) {
  await openChapter(page, url);
  const rows = [];
  for (const view of VIEWS) {
    await page.setViewportSize({ width: view.width, height: 900 });
    for (const root of ROOTS) {
      await setRoot(page, root);
      const measured = await measure(page);
      if (measured === null) {
        throw new PageProblem(`the page at ${url}#ch-1 never settled — no stable prose box across 20 probes`);
      }
      rows.push({
        viewport: view.width,
        root,
        body: measured.body,
        column: Math.round(measured.column * 100) / 100,
        ch: Math.round((measured.column / Math.max(measured.advance, 0.001)) * 100) / 100,
        expected: view,
      });
    }
  }
  // The sanity row: zoom magnifies the page, it does not re-measure the line.
  await page.setViewportSize({ width: 1440, height: 900 });
  await setRoot(page, 16);
  const plain = await measure(page);
  await page.evaluate(() => {
    document.documentElement.style.zoom = '1.5';
  });
  const zoomed = await measure(page);
  await page.evaluate(() => {
    document.documentElement.style.zoom = '';
  });
  if (plain === null || zoomed === null) {
    throw new PageProblem(`the page at ${url}#ch-1 never settled for the zoom row`);
  }
  const lineOf = (sample) => Math.round((sample.column / Math.max(sample.advance, 0.001)) * 100) / 100;
  return { rows, zoom: { ch: lineOf(zoomed), plain: lineOf(plain) } };
}

/** Every way the measured table fails to be the design: named rows, not a boolean. */
function driftOf(rows, zoom) {
  const drift = [];
  for (const row of rows) {
    const at = `viewport ${row.viewport} at root ${row.root}`;
    if (Math.abs(row.column - row.expected.column) > TOLERANCE) {
      drift.push(`${at}: column ${row.column} px, expected ${row.expected.column} px`);
    }
    if (Math.abs(row.body - row.expected.body) > 0.01) {
      drift.push(`${at}: body ${row.body} px, expected ${row.expected.body} px`);
    }
  }
  for (const view of VIEWS) {
    const group = rows.filter((row) => row.viewport === view.width);
    const spread = (values) => Math.max(...values) - Math.min(...values);
    const columns = group.map((row) => row.column);
    if (spread(columns) > TOLERANCE) {
      drift.push(`viewport ${view.width}: the column follows the root size (${columns.join(' / ')} px)`);
    }
    const counts = group.map((row) => row.ch);
    if (spread(counts) > TOLERANCE) {
      drift.push(`viewport ${view.width}: characters per line follow the root size (${counts.join(' / ')})`);
    }
  }
  if (Math.abs(zoom.ch - zoom.plain) > TOLERANCE) {
    drift.push(`zoom 1.5: ${zoom.ch} ch per line, ${zoom.plain} at zoom 1 — zoom must not re-measure the line`);
  }
  return drift;
}

function printTable(rows, zoom) {
  const lines = [];
  const add = (cells) => lines.push(cells.map((cell, index) => String(cell).padEnd([10, 6, 8, 10, 6][index])).join(''));
  add(['viewport', 'root', 'body px', 'column px', 'ch']);
  for (const row of rows) add([row.viewport, row.root, row.body, row.column, row.ch]);
  add(['zoom 1.5', 16, '—', '—', zoom.ch]);
  lines.push(`zoom 1.5 at 1440 is a sanity row: ${zoom.plain} ch at zoom 1.`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

const options = parseArgs(process.argv.slice(2));
const playwright = await loadPlaywright();
const executablePath = options.chromium ?? process.env.PW_CHROMIUM_PATH ?? cachedChromium();
if (executablePath === null || !existsSync(executablePath)) {
  bail(
    'no Chromium binary — pass --chromium <path>, set PW_CHROMIUM_PATH, or install one (`npx playwright install chromium`)',
  );
}

// The browser is part of "cannot run": a present but unrunnable binary must exit 2, not fall
// through the top-level await into Node's exit 1, which the contract reserves for drift.
/** The first line of an error: Playwright appends its whole launch argv, which is noise here. */
const firstLine = (message) => String(message).split('\n')[0].trim();
let browser = null;
let result = null;
let problem = null;
try {
  browser = await playwright.chromium.launch({ executablePath, headless: true });
  result = await collect(await browser.newPage({ viewport: { width: 1440, height: 900 } }), options.url);
} catch (error) {
  problem =
    error instanceof PageProblem
      ? firstLine(error.message)
      : `cannot measure ${options.url}: ${firstLine(error.message)}`;
} finally {
  try {
    await browser?.close();
  } catch {
    // The browser is already gone: the measurement or its error is what the exit code carries.
  }
}
if (problem !== null || result === null) bail(problem ?? 'the browser produced no measurement');

const drift = driftOf(result.rows, result.zoom);
if (options.json) {
  process.stdout.write(
    `${JSON.stringify({ ok: drift.length === 0, rows: result.rows, zoom: result.zoom, drift }, null, 2)}\n`,
  );
} else {
  printTable(result.rows, result.zoom);
  process.stdout.write(
    drift.length === 0
      ? 'ok: the column, the body and the line are the same at every root font size\n'
      : `drift:\n${drift.map((entry) => `  - ${entry}`).join('\n')}\n`,
  );
}
process.exitCode = drift.length === 0 ? 0 : 1;
