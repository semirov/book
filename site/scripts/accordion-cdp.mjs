#!/usr/bin/env node
/**
 * scripts/accordion-cdp.mjs — BOOK-128 comment #3852: the accordion, measured in a browser.
 *
 * jsdom has no layout, so the two claims this issue is built on cannot be tested there:
 *   - **the paragraph does not move.** Its line count and every line's `top` are identical at
 *     0, 100, 200 and 220 ms after the tap, and identical to the closed paragraph;
 *   - **the block grows from zero.** Its height is 0 when it mounts, rises monotonic, and
 *     reaches its final value at 220 ms — and, under `prefers-reduced-motion`, at t = 0.
 * Plus the two contracts around them: the reading line is held within half a pixel when the
 * block opens above the viewport, and a swap to another span moves the touched line by ≤ 1 px.
 *
 * The page is the harness's own (`web/harness/accordion.html`), served by the SAME Vite config
 * the site is built with, and it mounts the real `ProseParagraph` and `Record`. The script
 * prints a JSON report of the numbers and decides pass/fail **from the numbers** — nothing is
 * hardcoded, so a change in the geometry shows up as a changed report, not as a stale green.
 *
 *   node scripts/accordion-cdp.mjs [--keep-open] [--verbose]
 *
 * Exit codes: 0 — every measured contract holds; 1 — a contract failed; 2 — the harness could
 * not run (no browser, no server, no page). The browser comes from `$ACCORDION_CHROME`, the
 * Playwright cache, or a system Chrome/Chromium, in that order.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
const PAGE = '/harness/accordion.html';
const WIDTHS = [1440, 390];
const HEIGHT = 900;
const ARGS = process.argv.slice(2);
const VERBOSE = ARGS.includes('--verbose');
/** `--shots` writes the four states × two widths × two themes into `shots/accordion/`. */
const SHOTS = ARGS.includes('--shots');
const SHOT_DIR = join(ROOT, 'shots', 'accordion');

function log(...parts) {
  if (VERBOSE) process.stderr.write(`${parts.join(' ')}\n`);
}

function bail(message) {
  process.stderr.write(`accordion: ${message}\n`);
  process.exit(2);
}

/* ---------- the browser ---------- */

function chromeFor() {
  const explicit = process.env.ACCORDION_CHROME;
  if (explicit !== undefined && existsSync(explicit)) return explicit;
  const cache = join(process.env.HOME ?? '', 'Library/Caches/ms-playwright');
  if (existsSync(cache)) {
    for (const name of readdirSync(cache)) {
      if (!name.startsWith('chromium')) continue;
      for (const candidate of [
        join(cache, name, 'chrome-mac', 'headless_shell'),
        join(cache, name, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  for (const candidate of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/* ---------- the CDP client ---------- */

class Cdp {
  #socket;
  #next = 1;
  #pending = new Map();

  static async connect(url) {
    const client = new Cdp();
    client.#socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      client.#socket.addEventListener('open', () => resolvePromise());
      client.#socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)));
    });
    client.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const pending = client.#pending.get(message.id);
      if (pending === undefined) return;
      client.#pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(`${message.error.message} (${String(message.error.code)})`));
      else pending.resolve(message.result);
    });
    return client;
  }

  send(method, params = {}) {
    const id = this.#next++;
    return new Promise((resolvePromise, reject) => {
      this.#pending.set(id, { resolve: resolvePromise, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed');
    }
    return result.result?.value;
  }

  close() {
    this.#socket.close();
  }
}

/* ---------- the server ---------- */

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

/** One screenshot of the current state, for the owner's eye; numbers decide the gate. */
async function shoot(cdp, name) {
  mkdirSync(SHOT_DIR, { recursive: true });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(SHOT_DIR, `${name}.png`);
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  return path;
}

/* ---------- the browser process ---------- */

async function launch(chrome, url) {
  const profile = mkdtempSync(join(tmpdir(), 'accordion-cdp-'));
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${String(WIDTHS[0])},${String(HEIGHT)}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(portFile)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  if (!existsSync(portFile)) {
    child.kill('SIGKILL');
    bail('the browser did not open a debugging port');
  }
  const [port] = readFileSync(portFile, 'utf8').split('\n');
  const list = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json();
  const page = list.find((target) => target.type === 'page');
  if (page === undefined) {
    child.kill('SIGKILL');
    bail('the browser opened no page target');
  }
  await fetch(`http://127.0.0.1:${String(port)}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).catch(() => undefined);
  const fresh = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json();
  const target = fresh.find((item) => item.type === 'page' && item.url.startsWith(url)) ?? page;
  return { child, profile, ws: target.webSocketDebuggerUrl };
}

/* ---------- one viewport ---------- */

async function measure(cdp, origin, width) {
  const url = `${origin}${PAGE}`;
  const open = async (reduced = false) => {
    await cdp.send('Emulation.setEmulatedMedia', {
      features: reduced ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [],
    });
    await cdp.send('Page.navigate', { url });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const ready = await cdp.evaluate('window.__accordion?.ready?.() === true', false).catch(() => false);
      if (ready === true) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    // Webfonts change the text's metrics: every line measured before they settle is a
    // measurement of a different paragraph.
    await cdp.evaluate('document.fonts.ready.then(() => true)');
    await cdp.evaluate('window.__accordion.wait(120)');
  };

  if (SHOTS) {
    const shots = {};
    for (const theme of ['day', 'night']) {
      await open();
      await cdp.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
      shots[`${String(width)}-${theme}-closed`] = await shoot(cdp, `${String(width)}-${theme}-closed`);
      await cdp.evaluate('window.__accordion.open(1)');
      await cdp.evaluate('window.__accordion.wait(320)');
      shots[`${String(width)}-${theme}-open`] = await shoot(cdp, `${String(width)}-${theme}-open`);
      await cdp.evaluate('window.__accordion.swap(2)');
      shots[`${String(width)}-${theme}-swapped`] = await shoot(cdp, `${String(width)}-${theme}-swapped`);
    }
    if (!VERBOSE) process.stderr.write(`accordion: ${String(Object.keys(shots).length)} screenshots in ${SHOT_DIR}\n`);
  }

  /** The read height with 0–3 interventions: the design's own ladder, measured. */
  const heights = {};
  for (const rows of [0, 1, 2, 3]) {
    await cdp.send('Page.navigate', { url: `${url}?rows=${String(rows)}` });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const ready = await cdp.evaluate('window.__accordion?.ready?.() === true', false).catch(() => false);
      if (ready === true) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    await cdp.evaluate('document.fonts.ready.then(() => true)');
    await cdp.evaluate('window.__accordion.wait(80)');
    await cdp.evaluate('window.__accordion.open(1)');
    await cdp.evaluate('window.__accordion.wait(320)');
    heights[String(rows)] = await cdp.evaluate('window.__accordion.blockHeight()');
  }

  /**
   * The long-paragraph policy, built from **geometry**, not from a paragraph length guessed to
   * land in a branch:
   *   - short — a paragraph whose block is already on screen: no scroll;
   *   - minimum — 390 × 700 and a 790-char paragraph tapped at its first line: the block's top
   *     is below the fold, the minimum scroll brings it to `bottom − 24`, and the touched line
   *     stays on screen;
   *   - far — both widths, 1065 chars, a 500 px viewport, the first line tapped: any scroll
   *     that shows the block would push the line under the header, so no scroll and the marker;
   *   - marker — pressing the marker scrolls once and the marker leaves.
   */
  const scrollCase = async (options) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: options.height ?? HEIGHT,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await cdp.send('Page.navigate', { url: `${url}?${options.query}` });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const ready = await cdp.evaluate('window.__accordion?.ready?.() === true', false).catch(() => false);
      if (ready === true) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    await cdp.evaluate('document.fonts.ready.then(() => true)');
    await cdp.evaluate(`window.__accordion.scrollToLine(${String(options.line)}, ${String(options.top ?? 8)})`);
    await cdp.evaluate('window.__accordion.wait(220)');
    return cdp.evaluate(`window.__accordion.policy(${String(options.sentence)})`);
  };

  await open();
  const closed = await cdp.evaluate('window.__accordion.before()');
  const timeline = await cdp.evaluate('window.__accordion.open(1)');
  const finalBlock = await cdp.evaluate('window.__accordion.blockHeight()');

  // The reading line: the tail paragraph is parked at the top of the viewport, and the block
  // opens above it — the case in which the page would slide if nothing held it.
  await open();
  await cdp.evaluate('window.__accordion.scrollAfter(20)');
  const anchor = await cdp.evaluate('window.__accordion.anchor()');

  await open(true);
  const reduced = await cdp.evaluate('window.__accordion.reduced()');

  await open();
  const swap = await cdp.evaluate('window.__accordion.swap(2)');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: width < 600 });
  const policy = {
    short: await scrollCase({ query: '', line: 0, sentence: 1 }),
    // The minimum-scroll branch needs the block's top **below** the fold: the first line is
    // parked 191 px down (the reviewer's repro), and the paragraph is long enough at each width.
    minimum: await scrollCase({
      query: width < 600 ? 'len=790' : 'len=1400',
      line: 0,
      sentence: 0,
      height: 700,
      top: 191,
    }),
    // The far branch at both widths: a 420 px viewport, the first line at the top, a long
    // paragraph — any scroll that showed the block would hide the line.
    far: await scrollCase({ query: 'len=1065', line: 0, sentence: 0, height: 420, top: 8 }),
    marker: await cdp.evaluate('window.__accordion.marker()'),
  };
  return { width, closed, timeline, finalBlock, anchor, reduced, swap, heights, policy };
}

/** The pass/fail rule, computed from the report's own numbers. */
function judge(result) {
  const tops = (shape) => shape.tops;
  const closedTops = tops(result.closed.lines);
  const closedCount = result.closed.lines.count;
  let maxLineDelta = 0;
  let countsStable = true;
  for (const sample of result.timeline.samples) {
    if (sample.lines.count !== closedCount) countsStable = false;
    const sampleTops = tops(sample.lines);
    const length = Math.max(sampleTops.length, closedTops.length);
    for (let index = 0; index < length; index += 1) {
      const a = sampleTops[index] ?? Number.NaN;
      const b = closedTops[index] ?? Number.NaN;
      const delta = Number.isNaN(a) || Number.isNaN(b) ? Number.POSITIVE_INFINITY : Math.abs(a - b);
      maxLineDelta = Math.max(maxLineDelta, delta);
    }
  }
  const heights = result.timeline.samples.map((sample) => sample.block);
  const monotonic = heights.every((height, index) => index === 0 || height >= (heights[index - 1] ?? 0) - 0.01);
  return {
    lineCountStable: countsStable,
    lines: closedCount,
    maxLineTopDelta: Math.round(maxLineDelta * 100) / 100,
    linesStill: countsStable && maxLineDelta <= 0.01,
    timelineHeights: heights,
    heightStartsAtZero: heights[0] <= 0.5,
    heightMonotonic: monotonic,
    heightFinal: result.finalBlock,
    heightGrows: result.finalBlock > 0 && monotonic,
    anchorDelta: Math.round(Math.abs(result.anchor.after - result.anchor.before) * 100) / 100,
    anchorHeld: Math.abs(result.anchor.after - result.anchor.before) <= 0.5,
    reducedFirst: result.reduced.first,
    reducedFinal: result.reduced.final,
    reducedInstant: Math.abs(result.reduced.first - result.reduced.final) <= 0.5,
    swapDelta: result.swap.delta,
    swapHeld: Math.abs(result.swap.delta) <= 1,
    heights: result.heights,
    heightsLadder: [0, 1, 2, 3].every((rows, index, all) =>
      index === 0 ? true : (result.heights[String(rows)] ?? 0) > (result.heights[String(all[index - 1])] ?? 0),
    ),
    noInnerScroll: result.timeline.innerScroll === false,
    shortNoScroll: result.policy.short.scroll === 0,
    // B1: the minimum-scroll branch — the policy must move the page, and the hold must not
    // put it back; the block's top lands at `bottom − 24` with the touched line on screen.
    minimumScrolls: result.policy.minimum.scroll > 0,
    minimumBlockVisible: result.policy.minimum.blockTop <= result.policy.minimum.bottom - 24 + 1,
    minimumLineOnScreen: result.policy.minimum.lineOnScreen === true,
    minimumNoMarker: result.policy.minimum.marker === false,
    // The far case: no scroll, and the marker offers the move at both widths.
    farNoScroll: result.policy.far.scroll === 0,
    farMarker: result.policy.far.marker === true,
    markerOnce: result.policy.marker.after === false && result.policy.marker.scrolled > 0,
  };
}

function ok(checks) {
  return (
    checks.linesStill === true &&
    checks.heightStartsAtZero === true &&
    checks.heightGrows === true &&
    checks.anchorHeld === true &&
    checks.reducedInstant === true &&
    checks.swapHeld === true &&
    checks.heightsLadder === true &&
    checks.noInnerScroll === true &&
    checks.shortNoScroll === true &&
    checks.minimumScrolls === true &&
    checks.minimumBlockVisible === true &&
    checks.minimumLineOnScreen === true &&
    checks.minimumNoMarker === true &&
    checks.farNoScroll === true &&
    checks.farMarker === true &&
    checks.markerOnce === true
  );
}

/* ---------- main ---------- */

const chrome = chromeFor();
if (chrome === null) bail('no Chromium found: set $ACCORDION_CHROME to a Chrome/Chromium binary');

const { server, origin } = await serve();
const { child, profile, ws } = await launch(chrome, `${origin}${PAGE}`);
let cdp;
try {
  cdp = await Cdp.connect(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const report = { chrome, page: `${origin}${PAGE}`, widths: {} };
  for (const width of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    const result = await measure(cdp, origin, width);
    const checks = judge(result);
    report.widths[String(width)] = { measured: result, checks };
    log(`width ${String(width)}:`, JSON.stringify(checks));
  }
  report.pass = Object.values(report.widths).every((entry) => ok(entry.checks));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.pass ? 0 : 1;
} catch (error) {
  process.stderr.write(`accordion: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  cdp?.close();
  child.kill('SIGKILL');
  await server.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // The browser may still be flushing its profile: a leftover temp directory is not a gate.
  }
}
