#!/usr/bin/env node
/**
 * scripts/theatre-cdp.mjs — BOOK-227: the theatre of a filing, measured and photographed.
 *
 * The harness is `web/harness/theatre.html` served by the site's own Vite config (`root: web`):
 * the real `SentenceTheatre`, `FilingMark`, `MarginNote`, `PhoneStrip`, `HeadStatus` and sheets,
 * on the book's own sentence (chapter 1, block `ch01#0594465f`, 349 characters, 57 words). Every
 * act is started by the **real frame payload** in the real store; `window.__theatre` answers what
 * the DOM then is.
 *
 * What this proves, per width (BOOK-DOC-86 §2–§9):
 *
 *   1. the clock        — the arrival's fill is on the word the time gives, at 30/70/95 % of the
 *                         sweep, past it, and with no visible line at all (solid, no overlay);
 *   2. thinking         — the 2 px spine stands, the stub sits on the rule's end, no line is drawn;
 *   3. verdict          — the press becomes the stub, 2 × 6, at the rule's end;
 *   4. queue            — stillness: no line, no nib, no tally;
 *   5. checking         — one tally per gate, 4 px apart, and the spine withdraws as the first
 *                         tally inks;
 *   6. landing          — the sentence's lines, the note's hairline withdrawn, the lift one rAF on;
 *   7. failure          — our fault ends the rule short with a 2 × 4 foot; a verdict leaves no stub;
 *   8. writes and cost  — ≤ 1 clip, ≤ 1 transform, ≤ 1 opacity per frame, no node or character
 *                         written, the overlay ≤ 19 nodes, and the rAF work's p95 ≤ 8 ms;
 *   9. reduced motion   — the arrival's end shape and the whole spine at frame 0, no rAF;
 *  10. the margin       — the numeral, the note and the strip stand where the queue act leaves
 *                         them (≤ 0.5 px) through the reading, and the spans survive;
 *  11. taste and the head — two families, the palette only, no shadow, no uppercase, no loop; the
 *                         running head's one word unchanged.
 *
 * The **writing** act — the print, its clock, its caret, its deletion — is not measured here: it
 * belongs to `task/live-continuum` (PR #121), which owns `LivePass`/`passMotion`/the head.
 *
 *   node scripts/theatre-cdp.mjs                 # both widths, checks + plates + frame-cost.json
 *   node scripts/theatre-cdp.mjs --no-shots      # checks only
 *   node scripts/theatre-cdp.mjs --width 1440    # one width
 *   node scripts/theatre-cdp.mjs --verbose       # every measured number on stderr
 *
 * Exit codes: 0 — every check passed; 1 — at least one failed (the JSON names it); 2 — the
 * harness could not run (no browser, no page, no fact).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Cdp, chromiumBinary, killTree, launchChromium, portIsFree } from './lib/cdp.mjs';
import { checksFor } from './lib/theatreChecks.mjs';
import { contactSheet, PLATES, plate } from './lib/theatrePage.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
const SHOTS = join(ROOT, 'shots', 'theatre');
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];
const ARGS = process.argv.slice(2);
const VERBOSE = ARGS.includes('--verbose');
const NO_SHOTS = ARGS.includes('--no-shots');
const ONLY = (() => {
  const at = ARGS.indexOf('--width');
  return at === -1 ? null : Number(ARGS[at + 1]);
})();

const log = (message) => {
  if (VERBOSE) process.stderr.write(`${message}\n`);
};
const bail = (message) => {
  process.stderr.write(`theatre: ${message}\n`);
  process.exit(2);
};

function chromeFor() {
  for (const name of ['THEATRE_CHROME', 'MARGIN_CHROME', 'LINE_FONTS_CHROME']) {
    const explicit = process.env[name];
    if (explicit !== undefined && explicit !== '' && existsSync(explicit)) return explicit;
  }
  try {
    return chromiumBinary();
  } catch {
    /* a system browser is the last resort */
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

async function freePort() {
  for (let port = 9511; port < 9600; port += 1) {
    if (await portIsFree(`http://127.0.0.1:${String(port)}/json/version`)) return port;
  }
  bail('no free port for the debugging endpoint');
  return 0;
}

/* ------------------------------------------------------------------- main ---- */

const chrome = chromeFor();
if (chrome === null) bail('no Chromium found: set $THEATRE_CHROME to a Chrome/Chromium binary');
if (!NO_SHOTS) mkdirSync(SHOTS, { recursive: true });
const served = await serve();
const profile = mkdtempSync(join(tmpdir(), 'theatre-cdp-'));
let cdp = null;
let child = null;
try {
  const port = await freePort();
  const launched = await launchChromium({
    binary: chrome,
    cdpPort: port,
    profileDir: profile,
    windowSize: `${String(WIDTHS.at(-1).width)},${String(WIDTHS.at(-1).height)}`,
  });
  child = launched.child;
  cdp = await Cdp.open(launched.pageUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const errors = [];
  cdp.on('Runtime.exceptionThrown', (params) => {
    errors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'exception');
  });

  const report = { chrome, widths: [] };
  for (const { width, height } of WIDTHS) {
    if (ONLY !== null && ONLY !== width) continue;
    const measured = await checksFor(cdp, served.origin, width, height, { verbose: VERBOSE });
    const plates = [];
    if (!NO_SHOTS) {
      for (const spec of PLATES) plates.push({ name: spec.name, ...(await plate(cdp, served.origin, width, height, spec, SHOTS)) });
    }
    report.widths.push({
      width,
      height,
      acts: Object.fromEntries(plates.map((entry) => [entry.name, entry])),
      arrival: measured.arrivalStats,
      nodes: {
        overlay: plates.find((entry) => entry.name === 'arrival')?.overlay ?? null,
        tallies: plates.find((entry) => entry.name === 'checking')?.tallies ?? null,
      },
      head: measured.head,
      checks: measured.checks,
      pass: measured.checks.every((check) => check.pass) && errors.length === 0,
    });
    log(`${String(width)} — ${String(measured.checks.filter((check) => check.pass).length)}/${String(measured.checks.length)} checks`);
  }

  if (!NO_SHOTS && report.widths.length > 0) {
    for (const entry of report.widths) {
      const files = PLATES.map((spec) => ({ label: `${spec.name}-${String(entry.width)}.png` }));
      entry.plate = await contactSheet(cdp, files, entry.width, entry.height, `all-${String(entry.width)}.png`, SHOTS);
    }
  }

  writeFileSync(join(SHOTS, 'frame-cost.json'), `${JSON.stringify(report, null, 2)}\n`);
  const failures = report.widths.flatMap((entry) => entry.checks.filter((check) => !check.pass).map((check) => `${String(entry.width)}: ${check.name}`));
  if (errors.length > 0) failures.push(...errors.map((error) => `console: ${error}`));
  const answer = {
    pass: failures.length === 0,
    chrome,
    failures,
    widths: report.widths.map((entry) => ({ width: entry.width, pass: entry.pass, checks: entry.checks.length })),
  };
  process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
  for (const entry of report.widths) {
    process.stderr.write(`theatre · ${String(entry.width)}×${String(entry.height)} — ${String(entry.checks.filter((check) => check.pass).length)}/${String(entry.checks.length)} checks · arrival p95 ${String(entry.arrival.script.p95)} ms\n`);
    for (const check of entry.checks.filter((one) => !one.pass)) process.stderr.write(`  FAIL ${check.name} ${JSON.stringify(check.detail)}\n`);
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  process.stderr.write(`theatre: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  cdp?.close();
  if (child !== null) killTree(child);
  await served.server.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* the browser may still be flushing its profile */
  }
}
