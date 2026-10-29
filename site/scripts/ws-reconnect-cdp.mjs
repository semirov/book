#!/usr/bin/env node
/**
 * scripts/ws-reconnect-cdp.mjs — BOOK-DOC-84 §11.1: the head through an outage, in a browser.
 *
 * The owner's phone read `связи нет` while the handshake was still in flight, and the same word
 * stood for a full hall's refusal. jsdom proves the mapping from a `status` the test hands in;
 * only a browser proves the **socket**: six real reconnects (0.5 s → 15 s, jittered), a real
 * head, and a recovery that carries the three frames the page missed.
 *
 * What it drives: `web/harness/reconnect.html` — the real `BookSocket`, the real frame fold and
 * the real `Header` — against the hub in `scripts/lib/wsHub.mjs`, which is the endpoint the
 * script can refuse. Refusal is server-side on purpose: CDP's `Network.setBlockedURLs` was
 * measured first and does not intercept the WebSocket handshake in this Chromium (the path
 * pattern, the absolute `ws://…` URL and `*` all let it connect), so the hub closes the TCP
 * connection, which
 * is what a dead server does.
 *
 * The timeline is recorded by the page from its committed DOM — `(attempt, delay, word)` — and
 * every row below is asserted here:
 *
 *   · attempt 1 → no word; 2, 3 → `связи нет`; 4, 5, 6 → `связи нет · пробуем снова`;
 *   · `connecting` between the attempts → no word at all;
 *   · after the hub answers again, one `hello` brings the three missed frames (a change decided,
 *     a gate round, an applied write) and the state line is back within a second — the healed
 *     state, never the state the dead socket left behind.
 *
 * Screenshots — `00-live`, `02-second`, `04-fourth`, `06-sixth`, `07-recovered` — go to
 * `shots/live/reconnect/`, with `report.json` beside them.
 *
 *   node scripts/ws-reconnect-cdp.mjs [--out DIR] [--verbose]
 *
 * Exit codes: 0 — every assertion holds; 1 — at least one violation, on stderr; 2 — the harness
 * could not run (no browser, no dev server, nothing painted).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { Cdp, chromiumBinary, killTree, launchChromium, portIsFree } from './lib/cdp.mjs';
import { startHub } from './lib/wsHub.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
const PAGE = '/harness/reconnect.html';
const CDP_PORT = 9337;
/** The owner's own step: the phone, 390 × 844. */
const PHONE = { width: 390, height: 844 };
/** Six attempts: the delays are 0.5, 1, 2, 4, 8 s between them (the sixth waits 15 s). */
const ATTEMPTS = 6;
/** `reconnectDelay`'s bases, in the order the gaps between the six failures take them. */
const BASE_DELAY_MS = [500, 1_000, 2_000, 4_000, 8_000];

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const outFlag = args.indexOf('--out');
const OUT = outFlag === -1 ? join(ROOT, 'shots/live/reconnect') : resolve(args[outFlag + 1]);

function bail(message) {
  process.stderr.write(`ws-reconnect:cdp: ${message}\n`);
  process.exit(2);
}

function log(...parts) {
  if (verbose) process.stderr.write(`${parts.join(' ')}\n`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The page's dev server: Vite, because the harness is the site's own TSX and its sheets. */
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

async function shot(cdp, name) {
  const answer = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(OUT, name);
  writeFileSync(path, Buffer.from(answer.data, 'base64'));
  return relative(ROOT, path);
}

/** Poll the page until `predicate(value)` holds; `null` when the deadline passes. */
async function until(cdp, expression, predicate, timeoutMs, what) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await cdp.evaluate(expression).catch(() => undefined);
    if (last !== undefined && predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`${what} did not happen within ${String(timeoutMs)} ms (last: ${JSON.stringify(last)})`);
}

const TIMELINE = 'window.__reconnect.timeline()';
const STATE = 'window.__reconnect.state()';

/**
 * One closed row per failure. `BookSocket` reports a close twice — the bare `closed` with the
 * code, then the reconnect's own with the 1-based attempt — so the numbered row is the failure,
 * and the last row for an attempt number wins.
 */
const failures = (rows) => {
  const byAttempt = new Map();
  for (const row of rows) if (row.status === 'closed' && row.attempts >= 1) byAttempt.set(row.attempts, row);
  return [...byAttempt.values()].sort((left, right) => left.attempts - right.attempts);
};
const wordAt = (rows, attempt) => failures(rows).find((row) => row.attempts === attempt)?.word;

/* ---------- main ---------- */

mkdirSync(OUT, { recursive: true });
const hub = await startHub();
const { server, origin } = await serve();
const profile = mkdtempSync(join(tmpdir(), 'ws-reconnect-cdp-'));
const violations = [];
let browser = null;
let cdp = null;
let harnessError = false;

try {
  if (!(await portIsFree(`http://127.0.0.1:${String(CDP_PORT)}/json/version`))) {
    bail(`the CDP port ${String(CDP_PORT)} is in use`);
  }
  browser = await launchChromium({
    binary: chromiumBinary(),
    cdpPort: CDP_PORT,
    profileDir: profile,
    windowSize: `${String(PHONE.width)},${String(PHONE.height)}`,
  });
  cdp = await Cdp.open(browser.pageUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...PHONE, deviceScaleFactor: 1, mobile: true });
  cdp.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error') log('page console error:', JSON.stringify(event.args ?? []));
  });
  cdp.on('Runtime.exceptionThrown', (event) => {
    process.stderr.write(`ws-reconnect:cdp: page exception: ${String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text)}\n`);
  });

  const query = `?hub=${encodeURIComponent(hub.wsUrl)}&hubHttp=${encodeURIComponent(hub.origin)}`;
  await cdp.send('Page.navigate', { url: `${origin}${PAGE}${query}` });
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
    ready = await cdp.evaluate('window.__reconnect === undefined ? false : window.__reconnect.ready()', false).catch(() => false);
    if (!ready) await sleep(50);
  }
  if (!ready) bail('the harness page did not mount (window.__reconnect.ready() never became true)');
  await hub.ready();
  await cdp.evaluate('document.fonts.ready.then(() => true)');

  // --- the page as a reader meets it: a live state line, no connection word at all.
  const liveRow = await until(cdp, STATE, (state) => state.hellos >= 1, 10_000, 'the first hello').catch(async (error) => {
    const pageError = await cdp.evaluate('window.__reconnect.error()').catch(() => undefined);
    const statuses = await cdp.evaluate('window.__reconnect.statuses()').catch(() => undefined);
    const events = await cdp.evaluate('window.__reconnect.events()').catch(() => undefined);
    const failure = await cdp.evaluate('window.__reconnect.failure()').catch(() => undefined);
    throw new Error(`${error.message} — page error: ${String(pageError)} — statuses: ${JSON.stringify(statuses)} — events: ${JSON.stringify(events)} — failure: ${String(failure)}`);
  });
  const beforeWord = await cdp.evaluate('window.__reconnect.word()', false);
  const shotLive = await shot(cdp, '00-live.png');
  if (beforeWord !== 'машина пишет главу 3 · правка 002 · попытка 1 из 5 · 17:04') {
    violations.push(`live: the head reads «${String(beforeWord)}», expected the writing state`);
  }
  if (String(beforeWord).includes('связи нет')) violations.push('live: a connected page printed «связи нет»');

  // --- the endpoint goes away, six times.
  hub.state.refuse = true;
  hub.dropAll();
  const shots = { 2: null, 4: null, 6: null };
  const startedOutage = Date.now();
  for (;;) {
    if (Date.now() - startedOutage > 60_000) bail('six reconnect attempts did not happen within 60 s');
    const rows = await cdp.evaluate(TIMELINE);
    const failed = failures(rows);
    const highest = failed.at(-1)?.attempts ?? 0;
    for (const attempt of [2, 4, 6]) {
      if (shots[attempt] === null && highest >= attempt) {
        shots[attempt] = await shot(cdp, `0${String(attempt)}-${attempt === 2 ? 'second' : attempt === 4 ? 'fourth' : 'sixth'}.png`);
      }
    }
    if (highest >= ATTEMPTS) break;
    await sleep(120);
  }
  const outageRows = await cdp.evaluate(TIMELINE);

  // The matrix, as the DOM showed it (the timeline's word is the committed line).
  const matrix = [];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const word = wordAt(outageRows, attempt);
    matrix.push({ attempt, word });
  }
  if (matrix[0]?.word !== '') violations.push(`attempt 1 printed «${String(matrix[0]?.word)}», expected no word at all`);
  for (const attempt of [2, 3]) {
    if (matrix[attempt - 1]?.word !== 'связи нет') violations.push(`attempt ${String(attempt)} printed «${String(matrix[attempt - 1]?.word)}», expected «связи нет»`);
  }
  for (const attempt of [4, 5, 6]) {
    if (matrix[attempt - 1]?.word !== 'связи нет · пробуем снова') {
      violations.push(`attempt ${String(attempt)} printed «${String(matrix[attempt - 1]?.word)}», expected «связи нет · пробуем снова»`);
    }
  }
  for (const row of outageRows.filter((entry) => entry.status === 'connecting')) {
    if (row.word !== '') violations.push(`connecting printed «${String(row.word)}», expected no word: the handshake is not a lost connection`);
  }

  // The cadence: the wait before failure n is `reconnectDelay(n-2)`, ±20 % plus the connect's
  // own few milliseconds — 0.5, 1, 2, 4, 8 s for the six failures.
  const failed = failures(outageRows);
  const delays = failed.map((row, index) => (index === 0 ? row.sinceRowMs : row.at - failed[index - 1].at));
  const cadence = [];
  for (let index = 1; index < delays.length; index += 1) {
    const base = BASE_DELAY_MS[index - 1];
    const gap = delays[index];
    cadence.push({ attempt: index + 1, gapMs: gap, baseMs: base });
    if (gap < base * 0.5 || gap > base * 1.2 + 800) {
      violations.push(`the wait before attempt ${String(index + 1)} was ${String(gap)} ms, expected ≈${String(base)} ms (0.5×..1.2× + 800)`);
    }
  }

  // --- the hub answers again, with the three frames the page missed in its hello.
  const rowsAtOutageEnd = outageRows.length;
  hub.advance();
  hub.state.refuse = false;
  const recovery = await until(
    cdp,
    TIMELINE,
    (rows) => rows.length > rowsAtOutageEnd && rows.slice(rowsAtOutageEnd).some((row) => row.helloAfterMs !== null),
    40_000,
    'the recovering hello (the socket knocks again at its own pace)',
  );
  const recovered = recovery.slice(rowsAtOutageEnd).findLast((row) => row.helloAfterMs !== null);
  const healed = await cdp.evaluate(STATE);
  const shotRecovered = await shot(cdp, '07-recovered.png');

  if (recovered === undefined || recovered.word !== 'машина проверяет главу 3 · правка 002 · редактор, раунд 1 · 17:08') {
    violations.push(`recovery: the head reads «${String(recovered?.word)}», expected the gate round the page missed`);
  }
  if (recovered !== undefined && recovered.helloAfterMs > 1_000) {
    violations.push(`recovery: the state line took ${String(recovered.helloAfterMs)} ms to come back, the contract is under a second`);
  }
  if (recovered !== undefined && recovered.word === beforeWord) {
    violations.push('recovery: the head shows the state the dead socket left behind — the record is stale');
  }
  if (healed.status !== 'open' || healed.attempts !== 0) {
    violations.push(`recovery: the socket is ${healed.status} at ${String(healed.attempts)} attempts after the reconnect`);
  }
  if (healed.stage !== 'verdict' || healed.stageSeq !== 4) {
    violations.push(`recovery: the missed gate round did not heal (stage ${String(healed.stage)} #${String(healed.stageSeq)})`);
  }
  if (healed.appliedRev !== 13) violations.push(`recovery: the missed write did not heal (rev ${String(healed.appliedRev)})`);
  if (healed.filingState !== 'applied' || healed.queue !== 0) {
    violations.push(`recovery: the missed decision did not heal (filing ${String(healed.filingState)}, queue ${String(healed.queue)})`);
  }

  const report = {
    page: PAGE,
    width: PHONE.width,
    refused: hub.state.refused,
    accepted: hub.state.accepted,
    live: { word: beforeWord, hello: liveRow.hellos, shot: shotLive },
    outage: { attempts: ATTEMPTS, timeline: outageRows, matrix, cadence },
    recovery: { row: recovered, state: healed, shot: shotRecovered, shotAfterMs: recovered?.helloAfterMs ?? null },
    shots: [shotLive, shots[2], shots[4], shots[6], shotRecovered].filter((path) => path !== null),
    pass: violations.length === 0,
    violations,
    chrome: chromiumBinary(),
  };
  writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ pass: report.pass, matrix, cadence, recovery: { word: recovered?.word, afterMs: recovered?.helloAfterMs, state: healed }, shots: report.shots, violations }, null, 2)}\n`);
  if (!report.pass) for (const violation of violations) process.stderr.write(`ws-reconnect:cdp: ${violation}\n`);
} catch (error) {
  process.stderr.write(`ws-reconnect:cdp: ${error instanceof Error ? error.message : String(error)}\n`);
  harnessError = true;
} finally {
  cdp?.close();
  if (browser !== null) killTree(browser.child);
  await hub.close();
  await server.close();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* the OS cleans the temp dir */
  }
}

process.exit(harnessError ? 2 : violations.length === 0 ? 0 : 1);
