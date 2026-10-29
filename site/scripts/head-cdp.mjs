#!/usr/bin/env node
/**
 * scripts/head-cdp.mjs — BOOK-DOC-84 §11.1: the head's status line, measured in a browser.
 *
 * The line is a text row under the brand row, and two of its promises are geometry that jsdom
 * cannot see:
 *
 *   a. **it never moves the prose** — the first paragraph's top with the line and without it
 *      differs by at most 1 px, at 1440 and at 390 (the line is absolutely placed inside the
 *      head's own box, so the head's height and the flow below it are untouched);
 *   b. **its wrap is bounded** — the longest line takes at most two rows at 390 and exactly one
 *      row at 1440, and nothing is cut mid-word: what the reader sees is the derived line with
 *      only the phone's own drops (the filing's number and the clock; the gate's word under 360).
 *
 * What it drives: `web/harness/head.html`, the real `Header` with the page's own frame fold —
 * seven states, each built from frames, plus one chapter whose first paragraph is the top under
 * measurement. One screenshot per state at 390 goes to `shots/live/head/`.
 *
 *   node scripts/head-cdp.mjs [--out DIR] [--verbose]
 *
 * Exit codes: 0 — every invariant holds; 1 — at least one violation, with the numbers on stderr;
 * 2 — the harness could not run (no browser, no dev server, nothing painted). JSON on stdout is
 * `{ pass, widths: [{ width, states: [{ state, rows, text, expected, firstTopDelta, headerDelta, href, shot }] }] }`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { Cdp, chromiumBinary, killTree, launchChromium, portIsFree } from './lib/cdp.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
const PAGE = '/harness/head.html';
const CDP_PORT = 9336;
/** The seven states §11.1 names, in the order the page builds them. */
const STATES = ['reading', 'approach', 'waiting', 'writing', 'checking', 'fixing', 'applied'];
/** §11.1's phone step and the desktop it is measured against. */
const WIDTHS = [1440, 390];
const PHONE = 390;
const MAX_PHONE_ROWS = 2;
const DELTA_PX = 1;

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const outFlag = args.indexOf('--out');
const OUT = outFlag === -1 ? join(ROOT, 'shots/live/head') : resolve(args[outFlag + 1]);

function bail(message) {
  process.stderr.write(`head:cdp: ${message}\n`);
  process.exit(2);
}

function log(...parts) {
  if (verbose) process.stderr.write(`${parts.join(' ')}\n`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ---------- the dev server and the browser ---------- */

async function serve() {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: join(WEB, 'vite.config.ts'),
    root: WEB,
    server: { port: 0, host: '127.0.0.1', strictPort: false },
    logLevel: 'silent',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || typeof address !== 'object') bail('the dev server did not bind a port');
  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
}

/** One screenshot of the whole viewport. */
async function shot(cdp, name) {
  const answer = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(OUT, name);
  writeFileSync(path, Buffer.from(answer.data, 'base64'));
  return relative(ROOT, path);
}

/** The page's own numbers: the line's rows, the first paragraph's top, the head's height. */
const PROBE = `(() => {
  const line = document.querySelector('.head-line');
  const first = document.querySelector('#first');
  const head = document.querySelector('.top');
  const round = (value) => Math.round(value * 10) / 10;
  let rows = null;
  if (line !== null) {
    // The whole line, the author's own row included: the two-row promise is about the head.
    const range = document.createRange();
    range.selectNodeContents(line);
    const tops = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)));
    rows = tops.size;
  }
  return {
    // innerText, never textContent: the phone's step hides parts with display:none, and text
    // that is not painted is not on the line.
    line: line === null ? null : (line.innerText || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim(),
    rows,
    href: line === null ? null : (line.querySelector('a')?.getAttribute('href') ?? null),
    tag: line === null ? null : (line.querySelector('a') !== null ? 'a' : 'none'),
    firstTop: first === null ? null : round(first.getBoundingClientRect().top),
    headerHeight: head === null ? null : round(head.getBoundingClientRect().height),
  };
})()`;

async function measure(cdp, width, state) {
  await cdp.evaluate(`window.__head.show(${JSON.stringify(state)}); true`);
  await cdp.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))))');
  return cdp.evaluate(PROBE);
}

async function idle(cdp) {
  await cdp.evaluate('window.__head.hide(); true');
  await cdp.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))))');
  return cdp.evaluate(PROBE);
}

/* ---------- main ---------- */

const { server, origin } = await serve();
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'head-cdp-'));
const violations = [];
let browser = null;
let cdp = null;

try {
  if (!(await portIsFree(`http://127.0.0.1:${String(CDP_PORT)}/json/version`))) {
    bail(`the CDP port ${String(CDP_PORT)} is in use`);
  }
  browser = await launchChromium({
    binary: chromiumBinary(),
    cdpPort: CDP_PORT,
    profileDir: profile,
    windowSize: `${String(WIDTHS[0])},900`,
  });
  cdp = await Cdp.open(browser.pageUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error') log('page console error:', JSON.stringify(event.args ?? []));
  });
  await cdp.send('Page.navigate', { url: `${origin}${PAGE}` });

  // The harness's own flag: a page that painted an empty shell has measured nothing.
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
    ready = await cdp.evaluate('window.__head === undefined ? false : window.__head.ready()', false).catch(() => false);
    if (!ready) await sleep(50);
  }
  if (!ready) bail('the harness page did not mount (window.__head.ready() never became true)');
  await cdp.evaluate('document.fonts.ready.then(() => true)');

  const report = { page: PAGE, origin, widths: [] };
  for (const width of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: width < 600 ? 844 : 900,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await sleep(150);

    const without = await idle(cdp);
    const states = [];
    await cdp.evaluate('window.__head.author(false)');
    for (const state of STATES) {
      const measured = await measure(cdp, width, state);
      const expected = await cdp.evaluate(`window.__head.expected(${JSON.stringify(state)}, ${String(width)})`, false);
      const firstTopDelta = Math.abs((measured.firstTop ?? 0) - (without.firstTop ?? 0));
      const headerDelta = Math.abs((measured.headerHeight ?? 0) - (without.headerHeight ?? 0));
      const shotPath = width === PHONE ? await shot(cdp, `${state}-${String(width)}.png`) : null;

      const rowsFloor = width === PHONE ? [1, MAX_PHONE_ROWS] : [1, 1];
      const rowsOk = measured.rows !== null && measured.rows >= rowsFloor[0] && measured.rows <= rowsFloor[1];
      if (!rowsOk) {
        violations.push(
          `${state}/${String(width)}: the line takes ${String(measured.rows)} rows, expected ${rowsFloor.join('..')}`,
        );
      }
      if (measured.line !== expected) {
        violations.push(
          `${state}/${String(width)}: the line reads «${String(measured.line)}», the derived line is «${String(expected)}»`,
        );
      }
      if (measured.tag !== 'a' || measured.href === null || !measured.href.startsWith('#ch-')) {
        violations.push(`${state}/${String(width)}: the line is not a link to a chapter (${String(measured.href)})`);
      }
      if (firstTopDelta > DELTA_PX) {
        violations.push(
          `${state}/${String(width)}: the first paragraph moved ${String(firstTopDelta)} px when the line appeared`,
        );
      }
      if (headerDelta > DELTA_PX) {
        violations.push(`${state}/${String(width)}: the head grew ${String(headerDelta)} px when the line appeared`);
      }
      states.push({
        state,
        rows: measured.rows,
        text: measured.line,
        expected,
        firstTop: measured.firstTop,
        firstTopDelta,
        headerHeight: measured.headerHeight,
        headerDelta,
        href: measured.href,
        shot: shotPath,
      });
      log(`${String(width)} ${state}: ${String(measured.rows)} rows, Δ${String(firstTopDelta)} px — ${String(measured.line)}`);
    }
    // The author's own line is the second row on the phone, never a third: measured on the
    // longest state, with the queue and the price under the line.
    let authorRow = null;
    if (width === PHONE) {
      await cdp.evaluate('window.__head.author(true)');
      const withAuthor = await measure(cdp, width, 'fixing');
      const authorExpected = await cdp.evaluate(`window.__head.expected('fixing', ${String(width)}, true)`, false);
      authorRow = { rows: withAuthor.rows, text: withAuthor.line, expected: authorExpected, shot: await shot(cdp, 'author-390.png') };
      if (withAuthor.rows === null || withAuthor.rows > MAX_PHONE_ROWS) {
        violations.push(`author/${String(width)}: the line and the author's row take ${String(withAuthor.rows)} rows`);
      }
      if (withAuthor.line !== authorExpected) {
        violations.push(`author/${String(width)}: the line reads «${String(withAuthor.line)}», expected «${String(authorExpected)}»`);
      }
      await cdp.evaluate('window.__head.author(false)');
    }
    report.widths.push({ width, idle: { firstTop: without.firstTop, headerHeight: without.headerHeight }, states, authorRow });
  }

  // The idle page has no line at all: no node, no placeholder, nothing reserved.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: PHONE, height: 844, deviceScaleFactor: 1, mobile: true });
  await idle(cdp);
  const empty = await cdp.evaluate("document.querySelector('.head-line') === null");
  if (empty !== true) violations.push('idle: the page still holds a .head-line node');
  report.idleEmpty = empty;
  report.pass = violations.length === 0;
  report.violations = violations;
  report.chrome = chromiumBinary();

  writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) {
    for (const violation of violations) process.stderr.write(`head:cdp: ${violation}\n`);
  }
} finally {
  cdp?.close();
  if (browser !== null) killTree(browser.child);
  await server.close();
  // Chromium's own profile files may still be closing: a leftover temp dir is not a failure.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* the OS cleans the temp dir */
  }
}

process.exit(violations.length === 0 ? 0 : 1);
