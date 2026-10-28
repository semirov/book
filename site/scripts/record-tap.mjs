#!/usr/bin/env node
/**
 * scripts/record-tap.mjs — the record's tap matrix, in a real browser.
 *
 * The owner reported the same phone defect twice: a tap on a sentence did not open the record,
 * and `вмешаться` in an open record did not produce the form. jsdom cannot reproduce either
 * (it has no gesture, no layout and no click synthesis), so this script drives the real
 * `ProseParagraph` (through `web/harness/accordion.html`) with the browser's own input:
 * `Input.dispatchTouchEvent` at 390, `Input.dispatchMouseEvent` at 1440 — the same
 * pointerdown/pointerup/click sequence a thumb and a mouse send.
 *
 *   node scripts/record-tap.mjs [--label before|after] [--verbose]
 *
 * It prints one JSON report (also written to `shots/record-tap/<label>.json`) and exits 1 when
 * a case fails. Every case reloads the page: the record store is page state, and a leftover
 * block would make the next case say nothing. The cases themselves are `lib/recordTapCases.mjs`
 * (a–g, the owner's 1–6, and h for the inner-toggle compensation); the gestures and page
 * helpers are `lib/recordTapGestures.mjs`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Cdp, chromiumBinary } from './lib/cdp.mjs';
import { matrix } from './lib/recordTapCases.mjs';
import { open, pointOn, press, tap } from './lib/recordTapGestures.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
const PAGE = '/harness/accordion.html';
const WIDTHS = [390, 1440];
const HEIGHT = 780;
const ARGS = process.argv.slice(2);
const VERBOSE = ARGS.includes('--verbose');
const LABEL_AT = ARGS.indexOf('--label');
const LABEL = LABEL_AT === -1 ? 'run' : (ARGS[LABEL_AT + 1] ?? 'run');
const SHOT_DIR = join(ROOT, 'shots', 'record-tap');

function log(...parts) {
  if (VERBOSE) process.stderr.write(`${parts.join(' ')}\n`);
}

function bail(message) {
  process.stderr.write(`record-tap: ${message}\n`);
  process.exit(2);
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
  const profile = mkdtempSync(join(tmpdir(), 'record-tap-'));
  const child = spawnChrome(chrome, profile);
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
  // A fresh target carries the harness URL; the first about:blank page stays untouched.
  await fetch(`http://127.0.0.1:${String(port)}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).catch(
    () => undefined,
  );
  const fresh = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json();
  const target = fresh.find((item) => item.type === 'page' && item.url.startsWith(url)) ?? page;
  return { child, profile, ws: target.webSocketDebuggerUrl };
}

function spawnChrome(chrome, profile) {
  return spawn(
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
      `--window-size=${String(WIDTHS[1])},${String(HEIGHT)}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
}

/* ---------- the screenshot ---------- */

async function shoot(cdp, name) {
  mkdirSync(SHOT_DIR, { recursive: true });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(SHOT_DIR, `${name}.png`);
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  return path;
}

/* ---------- main ---------- */

let chrome = process.env.ACCORDION_CHROME;
if (chrome === undefined || !existsSync(chrome)) {
  try {
    chrome = chromiumBinary();
  } catch {
    bail('no Chromium found: set $ACCORDION_CHROME to a Chrome/Chromium binary');
  }
}

const { server, origin } = await serve();
const { child, profile, ws } = await launch(chrome, `${origin}${PAGE}`);
let cdp;
try {
  cdp = await Cdp.open(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const report = { label: LABEL, chrome, page: `${origin}${PAGE}`, widths: {}, shot: null };
  for (const width of WIDTHS) {
    report.widths[String(width)] = await matrix(cdp, origin, PAGE, width, log);
    log(`width ${String(width)} done`);
  }
  // One shot of the record after `без правки`: the state the owner could not reach at all.
  const mobile = await open(cdp, origin, PAGE, WIDTHS[0], 'rows=0');
  await tap(cdp, mobile, await pointOn(cdp, 1));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 420));
  await press(cdp, mobile, '.rec-cta');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 220));
  await press(cdp, mobile, '.note-action');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 320));
  // The screenshot is the whole block, not the compensated line: scroll it into view first.
  await cdp.evaluate("document.querySelector('.rec')?.scrollIntoView({ block: 'start' })");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  report.shot = await shoot(cdp, 'after-note');
  report.pass = Object.values(report.widths).every((cases) => cases.every((entry) => entry.pass));
  mkdirSync(SHOT_DIR, { recursive: true });
  writeFileSync(join(SHOT_DIR, `${LABEL}.json`), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.pass ? 0 : 1;
} catch (error) {
  process.stderr.write(`record-tap: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  cdp?.close();
  child.kill('SIGKILL');
  await server.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // A lingering temp profile is not a gate.
  }
}
