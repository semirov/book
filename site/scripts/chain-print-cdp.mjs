#!/usr/bin/env node
/**
 * scripts/chain-print-cdp.mjs — the chain prints twice, measured in a real browser.
 *
 * BOOK-DOC-84 §6 — «real chain print at 1440 and 390». What is proved, with numbers:
 *
 *   • two writes on one chapter, 1 200 ms apart (`revisions.at`), each a sentence-keeping
 *     edit → two `revisions` rows + their snapshots, so `engineState/applied.ts` derives two
 *     `chapter:applied` frames (the patch/span come from rev and rev−1, exactly as the site
 *     reads them); the first print settles, the second opens, and the gap between them is
 *     measured and asserted ≤ 1 500 ms — the chain has no artificial silence;
 *   • sampling every ~50 ms: `.caret-read`/`.caret-write` present and visible; blue `top`
 *     median ≤ −60 px/s, blue `left` == the run's first glyph left ±1 px; red `top` median
 *     ≥ +40 px/s and red `left` advances; both gone at settle;
 *   • mid-print arrivals at 30/70/95 % of the print's own duration join the current frame
 *     (the ink is already where the clock says), never restart; a write older than
 *     `PRINT_WINDOW_MS` paints nothing — no `.p-pass`, no `data-pass` after 6 s;
 *   • `prefers-reduced-motion: reduce` → `data-pass="static"`, `.pass-span` + two ticks, no
 *     caret element at all;
 *   • `report.json` with every sample, the rates, the chain gap and the console's errors (0).
 *
 * How (local only, prod is never written):
 *   1. `npm run build` — the frames are of the shipped bundle.
 *   2. `VACUUM INTO` a temp copy of `~/book-site-data/book.db` (`lib/passBook.mjs`); the copy
 *      keeps its own `user_version` (v30).
 *   3. `node server/dist/index.js` on :8092 serves the API, the socket and the built SPA.
 *   4. Chromium (Playwright's binary) over raw CDP (`lib/cdp.mjs`).
 *   5. One transaction per write in the copy: the block rows, `chapters`, the content-addressed
 *      snapshot and the `revisions` row (`lib/chainPrint.mjs`). The bridge's 500 ms poll
 *      publishes it as `chapter:applied`.
 *   6. Sampling, screenshots, report. Nothing is committed; the temp dir is removed after.
 *
 * Two honest notes on the measurement:
 *   • the harness replays writes into the copy, so the frame reaches the page after the
 *     bridge's poll (0–500 ms, `EngineBridge.intervalMs`). `caretOnsetFromFrameMs` is the
 *     client's own bound (≤300 ms: mount + caret birth); `caretOnsetFromAppliedMs` includes the
 *     fixture's poll and is reported beside it, never hidden. The **arrivals** are written just
 *     before the tailer's next tick (the phase is known from the last frame), so a 95 % arrival
 *     still reaches the page before its print ends; the share actually used is in the report;
 *   • «30/70/95 %» is of the measured print (`planPass.settleMs`), not of the 6 000 ms window:
 *     a print settles in ~2–6 s, so 95 % of the window would be past every print and there
 *     would be nothing to join. The window itself is checked separately (the > 6 s case).
 *
 *   node scripts/chain-print-cdp.mjs                build, measure, report, remove the temp dir
 *   node scripts/chain-print-cdp.mjs --keep         keep the temp dir and print where it is
 *   node scripts/chain-print-cdp.mjs --no-build     reuse site/web/dist/staging and server/dist
 *   node scripts/chain-print-cdp.mjs --out DIR      put the shots and report.json elsewhere
 *   node scripts/chain-print-cdp.mjs --chain        stop after the chain (a debugging aid)
 *   node scripts/chain-print-cdp.mjs --data-cwd     start the site with the temp data dir as its
 *                                                   working dir (a diagnostic: see below)
 *
 * The frame's own shape is asserted before anything is measured: `patchTruncated` and `span` are
 * the numbers a print either has or does not. Before BOOK-220's fix the site's `EngineBridge` was
 * built without `dataDir` (head `fbca4d5`), so it read `versions/…` from `site/`, found nothing,
 * and every live `chapter:applied` carried `patchTruncated: true, span: null, patch: 0` — the
 * write could not print. The bridge is now built by `engineState/wiring.ts` from `config`, so the
 * default run reads the copy's own snapshots; `serverProbe` still reads the same revision
 * independently, which is how a wrong root would be told apart. `--data-cwd` (start the process
 * with the copy's data dir as its cwd) is kept as a diagnostic, not as the shipped shape.
 *
 * Exit: 0 pass · 1 an assertion failed (the failing one and its numbers are printed) ·
 * 2 the harness cannot run (no volume, port in use, build, no Chromium).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { chromiumBinary, Cdp, killTree, launchChromium, portIsFree, spawnLogged, waitForUrl } from './lib/cdp.mjs';
import {
  ensureLatestSnapshot,
  installApplied,
  installParser,
  pickStepId,
  storedRevisions,
  WATCH_SOURCE,
} from './lib/chainPrint.mjs';
import { arrivals, carets, chain, checker, reducedMotion, shotter, STAGE, tooLate } from './lib/chainStages.mjs';
import { buildSite, PROD_DB, prepareTemp, SITE, WORKTREE } from './lib/passBook.mjs';

const PORT = 8092;
const CDP_PORT = 9334;
const API = `http://127.0.0.1:${PORT}`;
const LOAD_TIMEOUT_MS = 120_000;

/**
 * The two runs, one per width. `anchor` is a phrase every edit leaves alone: it finds the
 * paragraph in the API and in the DOM before, during and after every write. `edits` is the
 * ordered script of writes: the chain's two, the reduced-motion one, the prime print the
 * arrivals join, three arrivals and the late one. Each `phrase` occurs exactly once in the text
 * it is written against — the harness refuses the write otherwise, so a drifted fixture fails
 * loudly instead of editing nothing. The four long sentences are one skeleton with one word
 * changed, so every arrival's run is the whole tail and every print lasts about as long.
 */
const RUNS = [
  {
    width: 1440,
    height: 900,
    chapter: 12,
    anchor: 'Я сел на стул',
    edits: [
      // The edit sits mid-paragraph of a nine-line block, so the blue caret climbs five lines and
      // the red one still has lines to descend — even when the frame arrives 400 ms late.
      { id: 'chain-1', phrase: 'Она походила на мою', replacement: 'Она походила на мою подпись, как тень на человека' },
      { id: 'chain-2', phrase: 'как тень на человека', replacement: 'как тень на человека, брошенная на снег' },
      {
        id: 'reduced',
        phrase: 'Или была моя, но из другого времени.',
        replacement: 'Или была моя, но из другого времени и другой жизни.',
      },
      // Four sentences with nothing in common: each write's run is the whole sentence, so the
      // ink lasts long enough to arrive into, and a replacement is never a one-word blur.
      {
        id: 'prime',
        phrase:
          'Я узнал бы её среди тысяч: это была подпись, стоявшая на акте 1965 года, на обороте которого значилось «Подпись П.».',
        replacement:
          'Я узнал бы её среди тысяч других подписей, и от этого узнавания мне стало холодно, как бывает, когда находишь своё имя в чужом документе.',
      },
      {
        id: 'arrival-30',
        phrase:
          'Я узнал бы её среди тысяч других подписей, и от этого узнавания мне стало холодно, как бывает, когда находишь своё имя в чужом документе.',
        replacement:
          'В коридоре пахло пылью и старой бумагой, и женщина за стеклом перекладывала листки так, будто каждый из них был чьей-то чужой жизнью.',
      },
      {
        id: 'arrival-70',
        phrase:
          'В коридоре пахло пылью и старой бумагой, и женщина за стеклом перекладывала листки так, будто каждый из них был чьей-то чужой жизнью.',
        replacement:
          'Стрелка над дверью стояла, и я перестал понимать, сколько прошло времени и зачем я всё ещё стою у этого окошка с бумагами в руках.',
      },
      {
        id: 'arrival-95',
        phrase:
          'Стрелка над дверью стояла, и я перестал понимать, сколько прошло времени и зачем я всё ещё стою у этого окошка с бумагами в руках.',
        replacement:
          'Очередь за спиной дышала и переступала с ноги на ногу, и каждый в ней ждал своей очереди так, как будто она была последней.',
      },
      { id: 'late', phrase: 'как будто она была последней.', replacement: 'как будто она была последней и единственной.' },
    ],
  },
  {
    width: 390,
    height: 844,
    chapter: 5,
    anchor: 'Потом понадобились копии',
    edits: [
      { id: 'chain-1', phrase: 'В два ноль четыре окно открылось.', replacement: 'В два ноль четыре окно открылось, и я поднялся.' },
      { id: 'chain-2', phrase: 'окно открылось, и я поднялся.', replacement: 'окно открылось, и я поднялся к самому стеклу.' },
      { id: 'reduced', phrase: 'зелёный и размытый.', replacement: 'зелёный и размытый, не читая.' },
      {
        id: 'prime',
        phrase: 'не читая.',
        replacement:
          'не читая. Она перекладывала бумаги с места на место, и я ждал, хотя ждать было уже нечего.',
      },
      {
        id: 'arrival-30',
        phrase: 'не читая. Она перекладывала бумаги с места на место, и я ждал, хотя ждать было уже нечего.',
        replacement:
          'не читая. За стеклом шуршали листки, и каждый был чьей-то чужой просьбой, к которой я не имел отношения.',
      },
      {
        id: 'arrival-70',
        phrase:
          'не читая. За стеклом шуршали листки, и каждый был чьей-то чужой просьбой, к которой я не имел отношения.',
        replacement:
          'не читая. Я считал минуты до конца приёма и не мог досчитать, потому что часы над дверью стояли.',
      },
      {
        id: 'arrival-95',
        phrase:
          'не читая. Я считал минуты до конца приёма и не мог досчитать, потому что часы над дверью стояли.',
        replacement:
          'не читая. Очередь за спиной дышала и переступала, и я перестал понимать, зачем стою и чего жду.',
      },
      { id: 'late', phrase: 'чего жду.', replacement: 'чего жду и куда пойду.' },
    ],
  },
];

const args = process.argv.slice(2);
const keepTemp = args.includes('--keep');
const skipBuild = args.includes('--no-build');
const chainOnly = args.includes('--chain');
/**
 * `--data-cwd` starts the site with the snapshot root as its working directory. It is a
 * diagnostic, not the shipped shape: `EngineBridge` is built without `dataDir`, so it reads
 * `versions/…` relative to the process's cwd, and from `site/` that root does not exist —
 * every live `chapter:applied` then carries `patchTruncated: true, span: null` and nothing
 * prints. With this flag the same code, the same rows and the same snapshots do resolve, so
 * the client's print can be measured while the wiring defect stays reported.
 */
const dataCwd = args.includes('--data-cwd');
const outIndex = args.indexOf('--out');
const OUT = resolve(outIndex >= 0 ? args[outIndex + 1] : join(SITE, 'shots', 'live', 'chain'));

const log = (message) => console.log(`[chain-print] ${message}`);

// ── the page ──────────────────────────────────────────────────────────────────────────────

/** A fresh document at the run's width, scrolled until the block is in view and still. */
async function openPage(cdp, run) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: run.width,
    height: run.height,
    deviceScaleFactor: 1,
    mobile: run.width < 600,
  });
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await cdp.send('Page.navigate', { url: `${API}/#ch-${String(run.chapter)}` });
  const started = Date.now();
  let still = 0;
  let lastScroll = -1;
  for (;;) {
    const placed = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const node = Array.from(document.querySelectorAll('p[data-block-id]'))
          .find((item) => (item.textContent || '').includes(${JSON.stringify(run.anchor)})) ?? null;
        if (node === null) return { found: false, scrollY: Math.round(window.scrollY) };
        const before = Math.round(window.scrollY);
        if (node.getBoundingClientRect().top < 0 || node.getBoundingClientRect().bottom > window.innerHeight) {
          node.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
        const rect = node.getBoundingClientRect();
        return { found: true, top: Math.round(rect.top), height: Math.round(rect.height),
                 scrollY: Math.round(window.scrollY), moved: Math.round(window.scrollY) !== before,
                 inView: rect.top >= 0 && rect.bottom <= window.innerHeight };
      })()`,
      returnByValue: true,
    });
    const value = placed.result.value;
    if (value.found === true && value.inView === true && value.moved === false && value.scrollY === lastScroll) {
      still += 1;
      if (still >= 3) {
        run.placedAt = value;
        break;
      }
    } else {
      still = 0;
    }
    lastScroll = value.scrollY;
    if (Date.now() - started > LOAD_TIMEOUT_MS) throw new Error(`the block never came into view at ${run.width}px`);
    await sleep(100);
  }
  await cdp.send('Runtime.evaluate', {
    expression: 'document.fonts.ready.then(() => document.fonts.status)',
    awaitPromise: true,
    returnByValue: true,
  });
  await sleep(300);
}

/** The run's facts before the page opens: the block the anchor names, unique in the chapter. */
async function prepareRun(run) {
  const chapter = await (await fetch(`${API}/api/chapters/${String(run.chapter)}`)).json();
  const matches = chapter.blocks.filter((block) => block.text.includes(run.anchor));
  if (matches.length !== 1) throw new Error(`the anchor occurs in ${matches.length} blocks of chapter ${run.chapter}`);
  const source = chapter.blocks.map((entry) => entry.text).join('\n\n');
  if (source.split(run.anchor).length - 1 !== 1) throw new Error(`the anchor is not unique in chapter ${run.chapter}`);
  Object.assign(run, { block: matches[0] });
  log(`${run.width}: chapter ${run.chapter}, block ${matches[0].id} (${matches[0].text.length} chars)`);
}

// ── the run ───────────────────────────────────────────────────────────────────────────────

async function runOnce({ cdp, run, dir, consoleLog, check, log, shot }) {
  const stepId = pickStepId(dir, run.chapter);
  // This volume stores no revision snapshots: the pre-image is rebuilt from the rows the API
  // serves, and the rebuild is compared with them before a single frame is measured.
  const snapshot = ensureLatestSnapshot(dir, run.chapter);
  check(
    `store/${run.width} the pre-image snapshot is readable and is the served text`,
    snapshot.rebuiltMatchesServedRows === true,
    `rev ${String(snapshot.rev)} ${snapshot.restored ? 'rebuilt from the block rows' : 'was on disk'}, ${String(snapshot.blocks)} blocks${snapshot.rebuiltMatchesServedRows ? '' : ` — ${JSON.stringify(snapshot.rebuiltDiff)}`}`,
  );
  const measured = await chain({ cdp, run, dir, stepId, check, log, shot });
  if (measured.printed === true) carets(run, measured.caret1, check);
  const after = await shot(`${String(run.width)}-after`);
  const result = {
    width: run.width,
    height: run.height,
    chapter: run.chapter,
    anchor: run.anchor,
    blockHeight: run.placedAt?.height ?? null,
    writes: [
      { rev: measured.write1.rev, at: measured.write1.atIso, phrase: measured.write1.phrase, replacement: measured.write1.replacement },
      ...(measured.write2 === null
        ? []
        : [{ rev: measured.write2.rev, at: measured.write2.atIso, phrase: measured.write2.phrase, replacement: measured.write2.replacement }]),
    ],
    chain: {
      writeGapMs: measured.write2 === null ? null : measured.write2.at - measured.write1.at,
      insertGapMs: measured.insertGapMs,
      firstSettleAt: measured.firstSettleAt,
      secondFirstInkAt: measured.secondFirstInkAt,
      firstSettleToSecondInkMs: measured.gap,
      note: "the second row's `at` is 1200 ms after the first; it is inserted once the first print settled, so the second window opens on a settled paragraph",
    },
    printed: measured.printed,
    frame: measured.frame,
    frameShape: measured.shape,
    serverProbe: measured.probe,
    caretWindow: measured.caret1,
    secondWindow: measured.second,
    samples: measured.samples1.map((item) => ({
      t: item.t,
      pass: item.pass,
      beat: item.beat,
      pending: item.pending,
      clusters: item.clusters,
      read: item.carets.read,
      write: item.carets.write,
      firstGlyphLeft: item.firstGlyphLeft,
    })),
    secondSamples: measured.samples2.length,
    stored: storedRevisions(dir, run.chapter),
    snapshot,
    shots: { carets: measured.caretsShot, after },
    console: consoleLog.splice(0, consoleLog.length),
  };
  if (chainOnly) return result;
  if (measured.printed !== true) {
    // Every later stage is the print: a write that never mounts cannot be sampled, measured or
    // photographed, and saying so is the report. The failing check above carries the numbers.
    result.skipped = 'the write never printed, so the caret window, the arrivals and the reduced-motion mark cannot be measured';
    return result;
  }
  result.reduced = await reducedMotion({ cdp, run, dir, stepId, check, shot });
  result.arrivals = await arrivals({ cdp, run, dir, stepId, check, log, shot });
  result.late = await tooLate({ cdp, run, dir, stepId, check, shot });
  return result;
}
// ── main ──────────────────────────────────────────────────────────────────────────────────

async function main() {
  for (const [url, what] of [
    [`${API}/healthz`, `API port ${PORT}`],
    [`http://127.0.0.1:${CDP_PORT}/json/version`, `CDP port ${CDP_PORT}`],
  ]) {
    if (!(await portIsFree(url))) throw new Error(`${what} is already in use — stop it first`);
  }

  await buildSite({ skip: skipBuild, log });
  installParser(await import(pathToFileURL(join(SITE, 'server', 'dist', 'ingest', 'parseChapter.js')).href));
  installApplied(await import(pathToFileURL(join(SITE, 'server', 'dist', 'engineState', 'applied.js')).href));

  const dir = await prepareTemp();
  if (dir === null) throw new Error(`no volume to copy (${PROD_DB} is not there) — the chain needs a local book`);
  if (keepTemp) log(`temp book at ${dir}`);

  const server = spawnLogged('node', [join(SITE, 'server', 'dist', 'index.js')], {
    cwd: dataCwd ? join(dir, 'data') : SITE,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: join(dir, 'data'),
      BOOK_ROOT: join(dir, 'book'),
      FEEDBACK_DIR: join(dir, 'feedback'),
      WEB_DIST: join(SITE, 'web', 'dist', 'staging'),
    },
  });
  let browser = null;
  let cdp = null;
  const cleanup = () => {
    cdp?.close();
    if (browser !== null) killTree(browser);
    killTree(server);
  };
  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    await waitForUrl(`${API}/healthz`, LOAD_TIMEOUT_MS, 'the API');
    const launched = await launchChromium({
      binary: chromiumBinary(),
      cdpPort: CDP_PORT,
      profileDir: join(dir, 'chrome'),
      windowSize: '1440,900',
    });
    browser = launched.child;
    cdp = await Cdp.open(launched.pageUrl);

    const consoleLog = [];
    cdp.on('Runtime.consoleAPICalled', (event) => {
      const text = (event.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' ');
      consoleLog.push({ kind: event.type, text: String(text).slice(0, 400) });
    });
    cdp.on('Runtime.exceptionThrown', (event) => {
      consoleLog.push({ kind: 'exception', text: String(event.exceptionDetails?.text ?? '').slice(0, 400) });
    });
    cdp.on('Log.entryAdded', (event) => {
      consoleLog.push({ kind: `log:${event.entry?.level ?? '?'}`, text: String(event.entry?.text ?? '').slice(0, 400) });
    });
    const requestsFailed = [];
    cdp.on('Network.responseReceived', (event) => {
      const response = event.response;
      if (response !== undefined && response.status >= 400) {
        requestsFailed.push({ status: response.status, url: String(response.url).replace(API, ''), type: event.type });
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH_SOURCE });

    const { assertions, check } = checker(log);
    const shot = shotter(cdp, OUT);
    mkdirSync(OUT, { recursive: true });
    const runs = [];
    for (const run of RUNS) {
      await prepareRun(run);
      await openPage(cdp, run);
      runs.push(await runOnce({ cdp, run, dir, consoleLog, check, log, shot }));
    }

    const errors = runs
      .flatMap((run) => run.console)
      .filter((entry) => entry.kind === 'error' || entry.kind === 'exception' || entry.kind === 'log:error');
    check('console has no errors', errors.length === 0, `${String(errors.length)} entries`);
    const failed = assertions.filter((item) => item.ok !== true);
    const report = {
      capturedAt: new Date().toISOString(),
      worktree: WORKTREE,
      browser: browser.output.match(/DevTools listening on (\S+)/)?.[1] ?? null,
      contract: {
        sampleMs: STAGE.SAMPLE_MS,
        writeGapMs: STAGE.WRITE_GAP_MS,
        maxChainGapMs: STAGE.MAX_CHAIN_GAP_MS,
        printWindowMs: STAGE.PRINT_WINDOW_MS,
        arrivals: STAGE.ARRIVALS,
        arrivalNote:
          'shares are of the measured print duration (write → settle), so 95 % is mid-print rather than past every print',
      },
      replay: {
        siteCwd: dataCwd ? 'the temp data dir (--data-cwd)' : SITE,
        diagnosticCwd: dataCwd,
        note: 'the revisions rows, their snapshots and the block rows went into a temp copy of the store; no model call ran, no money moved, prod was never written',
        tempBook: keepTemp ? dir : 'removed after the run',
        writes: runs.flatMap((run) => run.writes.map((write) => ({ rev: write.rev, at: write.atIso, phrase: write.phrase }))),
      },
      runs,
      assertions,
      console: { errors, entries: runs.flatMap((run) => run.console) },
      network: { failures: requestsFailed },
      verdict: { ok: failed.length === 0, failed: failed.map((item) => item.name) },
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    log(`report: ${relative(WORKTREE, join(OUT, 'report.json'))}`);
    if (!report.verdict.ok) {
      for (const item of failed) log(`FAILED ${item.name} — ${item.detail}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[chain-print] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    for (const [name, child] of [['server', server], ['browser', browser]]) {
      if (child?.output) console.error(`${name}:\n${child.output.split('\n').slice(-12).join('\n')}`);
    }
    // Nothing measured at all means the harness could not run (a crash, not a verdict): 2.
    process.exitCode = assertions.length === 0 ? 2 : 1;
  } finally {
    cleanup();
    await sleep(400);
    if (!keepTemp) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* a stray profile lock is not worth failing the run */
      }
    } else {
      log(`kept ${dir}`);
    }
  }
}

await main().catch((error) => {
  console.error(`[chain-print] CANNOT RUN: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
