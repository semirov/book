#!/usr/bin/env node
/**
 * scripts/line-fonts-cdp.mjs — BOOK-128 comment #3900 §2: the one-line rule, measured.
 *
 * The owner's ruling (2026-10-28): **one line = one typeface + one size.** Where two things must
 * sit together they go on separate lines. This script is the harness that makes the rule
 * checkable, not the fix: it renders a page in a real browser, walks every line a reader can
 * see and reports each line that carries more than one `font-family` or a `font-size` spread
 * above half a pixel. Nothing here is a list of allowed selectors or expected numbers — the
 * report is the data, and the gate is the absence of mixed lines.
 *
 *   node scripts/line-fonts-cdp.mjs [--url <url>] [--verbose]
 *
 * The default page is `web/harness/lines.html` — the gallery of every line in the audit's §2
 * table, served through the SAME Vite config the site is built with (`web/vite.config.ts`,
 * `root: web`), so the real stylesheets and the real components are what gets measured.
 * `--url` checks any other page instead (a dev server, a preview build) with the same walker.
 *
 * Widths: 1440×900, 390×844 and 768×1024 — the phone is where the phone-only rows exist, the
 * desktop is where the marginalia exist, the middle is the regime between them.
 *
 * **How a line is found.** Every visible text node is walked; a node that spans several lines
 * is cut into the client rects the browser measured for it. Segments join one line when their
 * boxes overlap, their centres sit within half the taller box plus 2 px, they share an ancestor
 * deeper than the page, and they stand in one positioning context. The 2 px is the audit's
 * "same bottom" tolerance: a row whose items are centred rather than baseline-aligned (the 44 px
 * touch rows) has bottoms further apart than 2 px, so the band is compared by centres with the
 * same slack — otherwise the very rows this rule is about would be invisible to the check.
 * Glyphs (`✕ × ⋯ ▸ ■`), `.sr-only`/`.visually-hidden`, `[data-harness]`, `[hidden]`, clipped
 * text and anything `display:none`/`visibility:hidden` are not lines.
 *
 * Exit codes: 0 — every line has one face and one size; 1 — at least one line mixes; 2 — the
 * harness could not run (no browser, no server, no page). The browser comes from
 * `$LINE_FONTS_CHROME`, `$ACCORDION_CHROME`, the Playwright cache, or a system Chrome/Chromium.
 *
 * JSON on stdout is `{ page, chrome, pass, violations, widths: [{ width, height, lines,
 * violations, sections }] }`: one `{width, lines, violations}` triple per measured viewport, and
 * `sections` echoing the gallery's own declaration of what it covered.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { COLLECT_SEGMENTS, describe, reportOf } from './lib/lines.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
const PAGE = '/harness/lines.html';
/** The three regimes the audit names, tallest viewport per width. */
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];
const ARGS = process.argv.slice(2);
const VERBOSE = ARGS.includes('--verbose');
const URL_FLAG = ARGS.indexOf('--url');
const EXPLICIT_URL = URL_FLAG === -1 ? null : ARGS[URL_FLAG + 1];
if (URL_FLAG !== -1 && (EXPLICIT_URL === undefined || EXPLICIT_URL.startsWith('--'))) {
  process.stderr.write('line:fonts: --url needs a URL\n');
  process.exit(2);
}

function log(...parts) {
  if (VERBOSE) process.stderr.write(`${parts.join(' ')}\n`);
}

function bail(message) {
  process.stderr.write(`line:fonts: ${message}\n`);
  process.exit(2);
}

/* ---------- the browser ---------- */

function chromeFor() {
  for (const name of ['LINE_FONTS_CHROME', 'ACCORDION_CHROME']) {
    const explicit = process.env[name];
    if (explicit !== undefined && explicit !== '' && existsSync(explicit)) return explicit;
  }
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
  #listeners = new Map();

  static async connect(url) {
    const client = new Cdp();
    client.#socket = new WebSocket(url);
    await new Promise((resolvePromise, reject) => {
      client.#socket.addEventListener('open', () => resolvePromise());
      client.#socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)));
    });
    client.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) {
        for (const listener of client.#listeners.get(message.method) ?? []) listener(message.params);
        return;
      }
      const pending = client.#pending.get(message.id);
      if (pending === undefined) return;
      client.#pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(`${message.error.message} (${String(message.error.code)})`));
      else pending.resolve(message.result);
    });
    return client;
  }

  on(method, listener) {
    const list = this.#listeners.get(method) ?? [];
    list.push(listener);
    this.#listeners.set(method, list);
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

/* ---------- the browser process ---------- */

async function launch(chrome, url) {
  const profile = mkdtempSync(join(tmpdir(), 'line-fonts-cdp-'));
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
      `--window-size=${String(VIEWPORTS[0].width)},${String(VIEWPORTS[0].height)}`,
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

/** Wait for a settled page: the harness's own flag (when it has one), then the webfonts. */
async function settle(cdp, expectHarness) {
  let ready = false;
  if (expectHarness) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const flag = await cdp.evaluate('window.__lines === undefined ? null : window.__lines.ready()', false).catch(() => null);
      if (flag === true) {
        ready = true;
        break;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    if (!ready) throw new Error('the harness page did not mount (window.__lines.ready() never became true)');
  }
  // Metrics after a webfont swap are metrics of a different page: nothing is measured before.
  await cdp.evaluate('document.fonts.ready.then(() => true)');
  await cdp.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))');
}

async function measure(cdp, url, viewport, expectHarness) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.width < 600,
  });
  await cdp.send('Page.navigate', { url });
  await settle(cdp, expectHarness);
  const collected = await cdp.evaluate(COLLECT_SEGMENTS);
  if (collected === undefined || !Array.isArray(collected.segments)) {
    bail('the page answered no segments');
  }
  log(`width ${String(viewport.width)}: ${String(collected.segments.length)} segments, page height ${String(collected.height)}`);
  return { ...reportOf(viewport.width, viewport.height, collected.segments), sections: collected.sections };
}

/* ---------- main ---------- */

const chrome = chromeFor();
if (chrome === null) bail('no Chromium found: set $LINE_FONTS_CHROME to a Chrome/Chromium binary');

const served = EXPLICIT_URL === null ? await serve() : null;
const page = EXPLICIT_URL ?? `${served.origin}${PAGE}`;
const { child, profile, ws } = await launch(chrome, page);
let cdp;
try {
  cdp = await Cdp.connect(ws);
  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (params) => {
    pageErrors.push(params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? 'page error');
  });
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params?.type !== 'error') return;
    pageErrors.push((params.args ?? []).map((arg) => String(arg.value ?? arg.description ?? '')).join(' '));
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const widths = [];
  for (const viewport of VIEWPORTS) {
    widths.push(await measure(cdp, page, viewport, EXPLICIT_URL === null));
  }

  const violations = widths.reduce((sum, entry) => sum + entry.violations.length, 0);
  const report = {
    page,
    chrome,
    pass: violations === 0,
    violations,
    widths,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  for (const entry of widths) {
    process.stderr.write(`line:fonts · ${String(entry.width)}×${String(entry.height)} — ${String(entry.lines)} lines, ${String(entry.violations.length)} mixed\n`);
    // The summary repeats a row once per instance (the contents prints 42 of them); the JSON
    // keeps every line, the summary says how many share one shape.
    const seen = new Map();
    for (const violation of entry.violations) {
      const key = `${violation.selector}|${violation.families.join('|')}|${violation.sizes.join('|')}`;
      const kept = seen.get(key);
      if (kept === undefined) seen.set(key, { violation, count: 1 });
      else kept.count += 1;
    }
    for (const { violation, count } of seen.values()) {
      process.stderr.write(`  ${count > 1 ? `${String(count)}× ` : ''}${describe(violation)}\n`);
    }
  }
  if (VERBOSE && pageErrors.length > 0) {
    process.stderr.write(`line:fonts · ${String(pageErrors.length)} page error(s):\n`);
    for (const error of pageErrors) process.stderr.write(`  ${error.split('\n')[0]}\n`);
  }
  process.exitCode = violations === 0 ? 0 : 1;
} catch (error) {
  process.stderr.write(`line:fonts: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  cdp?.close();
  child.kill('SIGKILL');
  if (served !== null) await served.server.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // The browser may still be flushing its profile: a leftover temp directory is not a gate.
  }
}
