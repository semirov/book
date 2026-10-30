#!/usr/bin/env node
/**
 * site/shots/live/analyst/probe/carets.probe.mjs — BOOK-220, the caret questions, measured.
 *
 * ⚠️  NOT EXECUTED IN THIS SESSION. The analyst session that wrote this file had no shell (the
 *     `shell` tool is denied for the whole session) and the in-app browser panel is display-only,
 *     so `node`, `sqlite3`, `docker cp` and Chromium-over-CDP were all out of reach. The numbers in
 *     ../carets.md are the plan's own arithmetic plus the store's timestamps; this script is the
 *     instrument that turns them into pixels. Run it where a shell exists.
 *
 * What it answers, and how:
 *   (a) when a caret exists at all — samples `.caret-read` / `.caret-write` every ~80 ms from the
 *       first `.p-pass` until the renderer settles: presence, computed opacity, rect top/left/height;
 *   (b) do they move as designed — the same samples give blue's decreasing top and red's increasing
 *       top, and the px/s between consecutive samples, at 1440 and 390;
 *   (c) a reader who arrives mid-pass — the `typing` stage's `at` is back-dated to
 *       now − f·settleMs for f ∈ {0.30, 0.70, 0.95}: does the page paint the current frame, or the
 *       plain paragraph, or restart the print;
 *   (d) a reader who arrives after the pass — no stage rows at all: the paragraph must be plain,
 *       settled, with no carets and nothing that says a pass happened.
 *
 * Prerequisites (same as scripts/pass-frames.mjs, which this reuses almost entirely):
 *   1. a prod DB copy at ~/book-site-data/book.db (`docker cp book-site-1:/data/book.db <dir>/
 *      book.db`, then point PROD_DB at it — see NOTE 1);
 *   2. `npm run build` once in site/ (or --no-build with a built dist);
 *   3. nothing on :8092 and :9334.
 *
 * NOTE 1 — the harness is behind the schema. `lib/passBook.mjs:62-65` pins the copy to
 *   `user_version = 20` ("v21 added two nullable columns"), while the live store is **v30**
 *   (`/healthz` → schema_version 30). Expect `prepareTemp()` to need the pin lifted (or the boot
 *   migration to be allowed to run on the copy) before the server will boot on the copy.
 * NOTE 2 — `PROD_DB` is `~/book-site-data/book.db`, which does not exist on the dev Mac; copy the
 *   container's file to that path, or pass a path in an env var and patch `passBook.mjs`'s export.
 *   Never write /data in the container.
 *
 *   node site/shots/live/analyst/probe/carets.probe.mjs
 *   node ... --keep      keep the temp store and the browser profile
 *   node ... --no-build  reuse site/web/dist/staging + server/dist
 *
 * Output: site/shots/live/carets-<width>-<ms>.jpg, site/shots/live/analyst/carets.csv,
 *         site/shots/live/analyst/carets.probe.json
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { chromiumBinary, Cdp, killTree, launchChromium, portIsFree, spawnLogged, waitForUrl } from '../../../../scripts/lib/cdp.mjs';
import { buildSite, prepareTemp, SITE, WORKTREE } from '../../../../scripts/lib/passBook.mjs';
import { graphemes, measure, spanOf, waitForState } from '../../../../scripts/lib/passProbe.mjs';

const PORT = 8092;
const CDP_PORT = 9334;
const API = `http://127.0.0.1:${PORT}`;
const OUT_IMG = join(SITE, 'shots', 'live');
const OUT_DATA = join(SITE, 'shots', 'live', 'analyst');
const SAMPLE_MS = 80;
const SAMPLE_FOR_MS = 6_500;
const ARRIVALS = [0.3, 0.7, 0.95];

/** The two runs: one paragraph each; the edit keeps the sentence a sentence. */
const RUNS = [
  { width: 1440, height: 900, chapter: 3, blockIndex: 79,
    phrase: 'Я представил человека, который через неделю встанет в очередь, и подумал, что он, наверное, ещё не знает.',
    replacement: 'Я представил человека, который как-нибудь через неделю встанет в очередь, и подумал: он, скорее всего, ещё не знает.' },
  { width: 390, height: 844, chapter: 5, blockIndex: 202,
    phrase: 'Одиннадцать минут — это опоздание. Опоздание — это запись в журнале смен.',
    replacement: 'Одиннадцать минут — это уже опоздание. Опоздание — это отметка в журнале смен.' },
];

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const skipBuild = args.includes('--no-build');
const log = (m) => console.log(`[carets] ${m}`);

/** Insert one pass's rows with a chosen `typing.at` (passBook's replayPass hardcodes "now"). */
function replayAt(run, dir, passId, typingAtMs, withStages = true) {
  const db = new DatabaseSync(join(dir, 'data', 'book.db'));
  db.exec('PRAGMA busy_timeout = 5000;');
  db.prepare('UPDATE blocks SET text = ? WHERE id = ?').run(run.after, run.block.id);
  if (!withStages) { db.close(); return; }
  const insert = db.prepare(`INSERT INTO pass_stages
    (pass_id, chapter, stage_seq, stage, at, actor_process, actor_model, change_id, summary, span,
     tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const iso = (ms) => new Date(ms).toISOString();
  insert.run(passId, run.chapter, 1, 'landed', iso(typingAtMs - 50), 'writer', 'deepseek/deepseek-flash', null,
    'внесено: 1 абзац',
    JSON.stringify([{ blockId: run.block.id, before: run.block.text, after: run.after, truncated: false }]),
    120_000, 6_099, 0.08);
  insert.run(passId, run.chapter, 2, 'typing', iso(typingAtMs), 'site', null, null,
    'правка на странице: текст печатается', null, null, null, null);
  db.close();
}

/** Put the run's paragraph in the middle of the viewport and wait for the fonts. */
async function place(cdp, run) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: run.width, height: run.height, deviceScaleFactor: 1, mobile: run.width < 600,
  });
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await cdp.send('Page.navigate', { url: `${API}/#ch-${run.chapter}` });
  await waitForState(cdp, run.locator, (s) => s.found && s.prose.length > 0, {
    timeoutMs: 90_000, everyMs: 100, what: `chapter ${run.chapter} never rendered at ${run.width}px`,
  });
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const n = Array.from(document.querySelectorAll('p[data-block-id]'))
        .find((el) => (el.textContent || '').includes(${JSON.stringify(run.locator)}));
      if (n) n.scrollIntoView({ block: 'center', behavior: 'instant' });
      return true;
    })()`, returnByValue: true,
  });
  await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => 1)', awaitPromise: true });
  await sleep(250);
}

/** (a)+(b): sample both carets every SAMPLE_MS until `.p-pass` leaves the tree. */
async function sampleRun(cdp, run, dir, passId) {
  replayAt(run, dir, passId, Date.now());
  const mounted = await waitForState(cdp, run.locator, (s) => s.found && s.pass, {
    timeoutMs: 10_000, what: '`.p-pass` never appeared — the tailer or the page missed the rows',
  });
  const t0 = Date.now();
  const samples = [];
  for (;;) {
    const elapsed = Date.now() - t0;
    if (elapsed > SAMPLE_FOR_MS) break;
    const s = await measure(cdp, run.locator);
    samples.push({
      tMs: elapsed, pass: s.pass === true, beat: s.beat, pending: s.pending, clusters: s.clusters,
      read: { present: s.carets.read.opacity !== null, opacity: s.carets.read.opacity, top: s.carets.read.top, left: s.carets.read.left, visible: s.carets.read.visible },
      write: { present: s.carets.write.opacity !== null, opacity: s.carets.write.opacity, top: s.carets.write.top, left: s.carets.write.left, visible: s.carets.write.visible },
      blockTop: s.rect.top, blockHeight: s.rect.height, lines: s.lines.count,
    });
    if (s.pass !== true && elapsed > 500) break;
    const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    if (s.carets.read.visible === true && s.carets.write.visible === true) {
      writeFileSync(join(OUT_IMG, `carets-${run.width}-${elapsed}.jpg`), Buffer.from(shot.data, 'base64'));
    }
    await sleep(SAMPLE_MS);
  }
  return { width: run.width, mountBeat: mounted.beat, mountMs: 0, samples };
}

/** px/s from consecutive samples where both are visible and the top actually moved. */
function speeds(samples, which) {
  const out = [];
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1][which];
    const b = samples[i][which];
    if (a.visible !== true || b.visible !== true || a.top === null || b.top === null) continue;
    const dt = samples[i].tMs - samples[i - 1].tMs;
    if (dt <= 0 || a.top === b.top) continue;
    out.push({ tMs: samples[i].tMs, pxPerSec: +(((b.top - a.top) / dt) * 1000).toFixed(1) });
  }
  const px = out.map((entry) => entry.pxPerSec);
  return { samples: out.length, min: Math.min(...px), max: Math.max(...px), median: px.sort((x, y) => x - y)[Math.floor(px.length / 2)] ?? null };
}

/** (c)/(d): mount with the pass already advanced by `fraction` of settleMs, or with no rows. */
async function arrivalRun(cdp, run, dir, passId, fraction) {
  const settleEstimate = run.width < 600 ? 4_419 : 3_207; // ../carets.json, plan_desktop/plan_phone
  replayAt(run, dir, passId, Date.now() - Math.round(fraction * settleEstimate));
  const s = await waitForState(cdp, run.locator, (state) => state.found, { timeoutMs: 20_000, what: 'paragraph missing' });
  await sleep(400);
  const after = await measure(cdp, run.locator);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
  writeFileSync(join(OUT_IMG, `carets-${run.width}-arrival-${Math.round(fraction * 100)}.jpg`), Buffer.from(shot.data, 'base64'));
  return {
    width: run.width, fraction, sawPassAtMount: s.pass === true, first: { pass: s.pass, beat: s.beat, pending: s.pending },
    at400ms: { pass: after.pass, beat: after.beat, pending: after.pending, read: after.carets.read.visible, write: after.carets.write.visible },
    plainParagraph: after.pass !== true,
  };
}

async function afterRun(cdp, run, dir, passId) {
  replayAt(run, dir, passId, Date.now(), false); // the text changed, no stage rows at all
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await cdp.send('Page.navigate', { url: `${API}/#ch-${run.chapter}` });
  await waitForState(cdp, run.locator, (s) => s.found, { timeoutMs: 60_000, what: 'paragraph missing' });
  await sleep(800);
  const s = await measure(cdp, run.locator);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
  writeFileSync(join(OUT_IMG, `carets-${run.width}-after.jpg`), Buffer.from(shot.data, 'base64'));
  return { width: run.width, pass: s.pass, carets: { read: s.carets.read.opacity, write: s.carets.write.opacity }, beat: s.beat,
    passAttribute: s.pass === true ? 'p-pass' : 'none', note: 'no stage rows: this is a reader who arrives after the pass' };
}

async function main() {
  for (const url of [`${API}/healthz`, `http://127.0.0.1:${CDP_PORT}/json/version`]) {
    if (!(await portIsFree(url))) throw new Error(`${url} is in use — stop it first`);
  }
  await buildSite({ skip: skipBuild, log });
  const dir = await prepareTemp();
  if (dir === null) throw new Error('no DB to copy: put a prod copy at ~/book-site-data/book.db (see NOTE 2)');
  log(`temp book at ${dir}`);
  mkdirSync(OUT_IMG, { recursive: true });
  mkdirSync(OUT_DATA, { recursive: true });

  const server = spawnLogged('node', ['server/dist/index.js'], {
    cwd: SITE,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: join(dir, 'data'), BOOK_ROOT: join(dir, 'book'),
      FEEDBACK_DIR: join(dir, 'feedback'), WEB_DIST: join(SITE, 'web', 'dist', 'staging') },
  });
  let browser = null;
  let cdp = null;
  const cleanup = () => { cdp?.close(); if (browser !== null) killTree(browser); killTree(server); };
  process.once('SIGINT', () => { cleanup(); process.exit(130); });

  try {
    await waitForUrl(`${API}/healthz`, 120_000, 'the API');
    const launched = await launchChromium({ binary: chromiumBinary(), cdpPort: CDP_PORT, profileDir: join(dir, 'chrome'), windowSize: '1440,900' });
    browser = launched.child;
    cdp = await Cdp.open(launched.pageUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const report = { capturedAt: new Date().toISOString(), worktree: WORKTREE, runs: [], arrivals: [], after: [], consoleErrors: [] };
    cdp.on('Runtime.exceptionThrown', (e) => report.consoleErrors.push(String(e.exceptionDetails?.text ?? '')));

    for (const run of RUNS) {
      const chapter = await (await fetch(`${API}/api/chapters/${run.chapter}`)).json();
      const block = chapter.blocks[run.blockIndex];
      run.block = block;
      run.after = block.text.replace(run.phrase, run.replacement);
      run.span = spanOf(block.text, run.after);
      run.locator = block.text.slice(-45);
      log(`${run.width}: block ${block.id}, run ${graphemes(run.span.after).length} graphemes at offset ${run.span.offset}`);

      await place(cdp, run);
      const sampled = await sampleRun(cdp, run, dir, `stp_carets_${run.width}`);
      report.runs.push({ ...sampled, bluePxPerSec: speeds(sampled.samples, 'read'), redPxPerSec: speeds(sampled.samples, 'write') });
      log(`${run.width}: ${sampled.samples.length} samples, blue ${JSON.stringify(report.runs.at(-1).bluePxPerSec)}, red ${JSON.stringify(report.runs.at(-1).redPxPerSec)}`);

      for (const fraction of ARRIVALS) {
        await place(cdp, run);
        report.arrivals.push(await arrivalRun(cdp, run, dir, `stp_arr_${run.width}_${fraction}`, fraction));
      }
      await place(cdp, run);
      report.after.push(await afterRun(cdp, run, dir, `stp_after_${run.width}`));
    }

    const csv = ['width,tMs,beat,pass,pending,readPresent,readOpacity,readTop,writePresent,writeOpacity,writeTop,blockTop'];
    for (const run of report.runs) {
      for (const s of run.samples) {
        csv.push([run.width, s.tMs, s.beat, s.pass, s.pending,
          s.read.present, s.read.opacity, s.read.top, s.write.present, s.write.opacity, s.write.top, s.blockTop].join(','));
      }
    }
    writeFileSync(join(OUT_DATA, 'carets.csv'), `${csv.join('\n')}\n`);
    writeFileSync(join(OUT_DATA, 'carets.probe.json'), `${JSON.stringify(report, null, 2)}\n`);
    log(`wrote ${relative(WORKTREE, join(OUT_DATA, 'carets.csv'))} and carets.probe.json`);
    if (report.consoleErrors.length > 0) { log(`console errors: ${report.consoleErrors.length}`); process.exitCode = 1; }
  } finally {
    cleanup();
    await sleep(300);
    if (keep) log(`kept ${dir}`);
  }
}

await main();
