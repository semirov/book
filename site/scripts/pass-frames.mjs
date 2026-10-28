#!/usr/bin/env node
/**
 * scripts/pass-frames.mjs — the live pass renderer, photographed in a real browser.
 *
 * What it produces, from artefacts rather than a promise:
 *   • 7 real Chromium frames at 1440 and 7 at 390, taken mid-typing, at least one per width with
 *     both carets on screen (`.caret-read` + `.caret-write`: computed opacity, a place inside the
 *     viewport);
 *   • the no-reflow numbers: the block's line count and every line's `top` (relative to the block,
 *     0.01 px) at mount, at 600 ms and on the fully inked tail — equal to the hundredth, or the
 *     run fails; and the same grid for the ordinary paragraph the renderer hands the block back
 *     to, also equal to the hundredth. The harness then hides the inline provenance door
 *     (`button.prov`, `vertical-align: super`) on the settled side only: the drift returns, which
 *     is how the door's box is shown to be the one that carries the last line;
 *   • `report.json` with the offsets, the beats, the ink left pending per frame, the strings the
 *     page printed, and the console's errors (must be none).
 *
 * How (local only, prod is never written):
 *   1. `npm run build` — the frames are of the shipped bundle, and its service worker exists (the
 *      dev server serves `/sw.js` as `index.html`, which is a console error, not a renderee).
 *   2. `VACUUM INTO` a temp copy of `~/book-site-data/book.db` (`sqlite3 -readonly`);
 *      `DATA_DIR`/`BOOK_ROOT` point at scratch dirs, so the data-dir guard sees a non-production
 *      boot. BOOK-187: the served text is rows, so nothing is copied from a manuscript and the
 *      pass's edit is one `UPDATE blocks` in the copy; the copy's `user_version` is pinned to 20
 *      (v21 added two nullable columns this branch does not know). Nothing else changes but the
 *      edited block and the two replayed rows.
 *   3. `node server/dist/index.js` on :8092 serves the API, the socket and the built SPA.
 *   4. Chromium (Playwright's binary) over raw CDP (scripts/lib/cdp.mjs) — no package.
 *   5. One transaction per run: the copy's block gets the edit and two `pass_stages` rows
 *      (`landed`, then `typing`, one pass id) go into the temp store. The stage tailer publishes
 *      them within its 500 ms tick; the page mounts `LivePass` for that block.
 *   6. Frames at 0/250/600/1000/1500/2200/3000 ms after the first `.p-pass`; the line boxes are
 *      read at the first frame, at 600 ms, and once the renderer has settled and the paragraph's
 *      cross-fade has stopped.
 *
 * Honesty: the stage rows are **replayed** into the temp store — no model ran, no money moved, no
 * prod row was touched. The strip stays closed (its live state needs `queue.processing`/
 * `revising`, which this replay does not set); the running head does say «книга пишется» from the
 * stage log (BOOK-156), and the report prints the exact line it showed.
 *
 *   node scripts/pass-frames.mjs               build, capture, report, remove the temp dir
 *   node scripts/pass-frames.mjs --keep        keep the temp dir and print where it is
 *   node scripts/pass-frames.mjs --no-build    reuse site/web/dist/staging and server/dist
 *   node scripts/pass-frames.mjs --out DIR     put the jpegs and report.json elsewhere
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { chromiumBinary, Cdp, killTree, launchChromium, portIsFree, spawnLogged, waitForUrl } from './lib/cdp.mjs';
import { buildSite, PROD_DB, prepareTemp, replayPass, SITE, storedStages, WORKTREE } from './lib/passBook.mjs';
import { compareLines, graphemes, measure, measureDoorEffect, spanOf, waitForState } from './lib/passProbe.mjs';

// 8091 is the deployed site on this host and 9333 a browser a person may have open: stay clear.
const PORT = 8092;
const CDP_PORT = 9334;
const API = `http://127.0.0.1:${PORT}`;
const SHOT_MS = [0, 250, 600, 1_000, 1_500, 2_200, 3_000];
const LOAD_TIMEOUT_MS = 120_000;

/**
 * The two runs: `phrase` occurs once in the chapter file and inside the block; `replacement`
 * keeps the sentence a sentence. `blockIndex` is the paragraph's index in `GET /api/chapters/:n`.
 * Offsets, run length, line boxes and file names are all derived.
 */
const RUNS = [
  {
    width: 1440,
    height: 900,
    chapter: 3,
    blockIndex: 79,
    phrase: 'Я представил человека, который через неделю встанет в очередь, и подумал, что он, наверное, ещё не знает.',
    replacement: 'Я представил человека, который как-нибудь через неделю встанет в очередь, и подумал: он, скорее всего, ещё не знает.',
  },
  {
    width: 390,
    height: 844,
    chapter: 5,
    blockIndex: 202,
    phrase: 'Одиннадцать минут — это опоздание. Опоздание — это запись в журнале смен.',
    replacement: 'Одиннадцать минут — это уже опоздание. Опоздание — это отметка в журнале смен.',
  },
];

const args = process.argv.slice(2);
const keepTemp = args.includes('--keep');
const skipBuild = args.includes('--no-build');
const outIndex = args.indexOf('--out');
const OUT = resolve(outIndex >= 0 ? args[outIndex + 1] : join(SITE, 'artifacts', 'pass-live'));

const log = (message) => console.log(`[pass-frames] ${message}`);
const fail = (message) => {
  throw new Error(message);
};

// ── the page ────────────────────────────────────────────────────────────────────────────────

/** A fresh document at the run's width, scrolled to the block — retried until it is in view. */
async function openPage(cdp, run) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: run.width,
    height: run.height,
    deviceScaleFactor: 1,
    mobile: run.width < 600,
  });
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await cdp.send('Page.navigate', { url: `${API}/#ch-${run.chapter}` });
  const started = Date.now();
  // The deep link's own scroll is smooth and lands after ours; scroll, then keep scrolling until
  // the block is in view and the page has stopped moving (three quiet checks in a row).
  let still = 0;
  let lastScroll = -1;
  for (;;) {
    const placed = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const node = Array.from(document.querySelectorAll('p[data-block-id]'))
          .find((item) => (item.textContent || '').includes(${JSON.stringify(run.locator)})) ?? null;
        if (node === null) return { found: false, scrollY: Math.round(window.scrollY) };
        const before = Math.round(window.scrollY);
        if (node.getBoundingClientRect().top < 0 || node.getBoundingClientRect().bottom > window.innerHeight) {
          node.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
        const rect = node.getBoundingClientRect();
        return { found: true, top: Math.round(rect.top), height: Math.round(rect.height), scrollY: Math.round(window.scrollY),
                 moved: Math.round(window.scrollY) !== before,
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
    if (Date.now() - started > LOAD_TIMEOUT_MS) fail(`the block never came into view at ${run.width}px`);
    await sleep(100);
  }
  // A webfont swapping in after the first frame would move every line: wait for the fonts.
  const fonts = await cdp.send('Runtime.evaluate', {
    expression: 'document.fonts.ready.then(() => document.fonts.status)',
    awaitPromise: true,
    returnByValue: true,
  });
  run.fonts = fonts.result.value;
  await sleep(300);
}

/** The run's facts before the page opens: block, edit, span, and the surviving locator. */
async function prepareRun(run) {
  const chapter = await (await fetch(`${API}/api/chapters/${run.chapter}`)).json();
  const block = chapter.blocks[run.blockIndex];
  if (block === undefined) fail(`chapter ${run.chapter} has no block ${run.blockIndex}`);
  if (!block.text.includes(run.phrase)) fail(`block ${block.id} does not hold the phrase`);
  // BOOK-187: the chapter's text is the rows the API just served, not a file.
  const source = chapter.blocks.map((entry) => entry.text).join('\n\n');
  const occurrences = source.split(run.phrase).length - 1;
  if (occurrences !== 1) fail(`the phrase occurs ${occurrences} times in chapter ${run.chapter}, expected once`);
  // The locator is the paragraph's tail: unchanged by the edit, so it finds the block before,
  // during (the renderer paints the new text) and after (the ordinary paragraph).
  const locator = block.text.slice(-45);
  if (locator.length < 20 || source.split(locator).length - 1 !== 1) {
    fail(`the locator "${locator}" is not a unique tail of the paragraph`);
  }
  const after = block.text.replace(run.phrase, run.replacement);
  if (after === block.text) fail('the replacement changed nothing');
  const span = spanOf(block.text, after);
  // Every offset the report names: the changed run in graphemes and in characters, and the
  // phrase the edit replaced in the paragraph.
  const charStart = graphemes(block.text).slice(0, span.offset).join('').length;
  const offsets = {
    grapheme: span.offset,
    charStart,
    charEnd: charStart + graphemes(span.before).join('').length,
    phraseCharStart: block.text.indexOf(run.phrase),
    phraseLength: run.phrase.length,
    runGraphemes: graphemes(span.after).length,
  };
  Object.assign(run, { block, source, after, locator, span, offsets });
  log(
    `${run.width}: chapter ${run.chapter}, block ${block.id}, ${graphemes(run.span.after).length} graphemes at offset ${run.span.offset}`,
  );
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────

async function runOnce({ cdp, run, dir, consoleLog }) {
  const { locator, span, block } = run;
  const passId = `stp_carets_${run.chapter}_${run.width}`;
  replayPass(run, dir, passId);
  const startedAt = Date.now();
  const mounted = await waitForState(cdp, locator, (state) => state.found && state.pass, {
    timeoutMs: 10_000,
    what: '`.p-pass` never appeared — check the `pass:stage` frames and the tailer cursor',
  });
  // The pass mounted; put the block in the middle of the viewport once more (a scroll moves no
  // line box, and a frame is only evidence if the carets are in it).
  const recentred = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const node = Array.from(document.querySelectorAll('p[data-block-id]'))
        .find((item) => (item.textContent || '').includes(${JSON.stringify(locator)})) ?? null;
      if (node === null) return { found: false };
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = node.getBoundingClientRect();
      return { found: true, top: Math.round(rect.top), inView: rect.top >= 0 && rect.bottom <= window.innerHeight };
    })()`,
    returnByValue: true,
  });
  await sleep(120);
  const t0 = Date.now();
  log(
    `${run.width}: .p-pass after ${t0 - startedAt} ms — beat ${mounted.beat}, ${mounted.clusters} graphemes, ${mounted.pending} pending,` +
      ` block at ${recentred.result.value.top}px`,
  );

  mkdirSync(OUT, { recursive: true });
  const frames = [];
  for (const at of SHOT_MS) {
    const wait = t0 + at - Date.now();
    if (wait > 0) await sleep(wait);
    const state = await measure(cdp, locator);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    const name = `${run.width}-${run.chapter}-${at}.jpg`;
    writeFileSync(join(OUT, name), Buffer.from(shot.data, 'base64'));
    frames.push({
      atMs: at,
      file: relative(WORKTREE, join(OUT, name)),
      pass: state.pass,
      beat: state.beat,
      pending: state.pending,
      clusters: state.clusters,
      carets: state.carets,
      bothCarets: state.carets.read.visible === true && state.carets.write.visible === true,
      lines: state.lines,
      rect: state.rect,
      head: state.head,
    });
    log(
      `  ${String(at).padStart(4)} ms: beat ${String(state.beat).padEnd(8)} pending ${String(state.pending).padStart(2)}/${state.clusters}` +
        ` carets read ${state.carets.read.visible ? 'on' : 'off'} write ${state.carets.write.visible ? 'on' : 'off'}` +
        ` lines ${state.lines.count}`,
    );
  }

  // Settle: the renderer unmounts itself; then the paragraph's cross-fade finishes, so the
  // measured line boxes are the settled page's and not a composited frame's.
  const gone = await waitForState(cdp, locator, (state) => state.found && !state.pass, {
    timeoutMs: 15_000,
    everyMs: 50,
    what: '`.p-pass` never settled',
  });
  const quietStart = Date.now();
  let settled = gone;
  while (settled.animations > 0 && Date.now() - quietStart < 3_000) {
    await sleep(50);
    settled = await measure(cdp, locator);
  }
  const settleMs = Date.now() - t0;

  // The pass's own final layout: the last frame that is still the renderer with all ink in.
  const inked = [...frames].reverse().find((frame) => frame.pass && frame.pending === 0) ?? frames[frames.length - 1];
  // The ordinary paragraph after the swap, and the same paragraph with its inline provenance
  // door out of the line box (`LivePass` renders no door; `.prov` is `inline-block`,
  // `vertical-align: super`, so it lifts the line box it sits on).
  const door = await measureDoorEffect(cdp, locator);

  const mountLines = frames[0].lines;
  const midLines = frames.find((frame) => frame.atMs === 600)?.lines ?? mountLines;
  const inkLines = inked.lines;
  const swapLines = settled.lines;
  const doorlessLines = door.hidden.lines;

  const ink = compareLines(mountLines, midLines);
  const inkTail = compareLines(mountLines, inkLines);
  const swap = compareLines(inkLines, swapLines);
  // The counterfactual, now that the renderer paints the door too: hide it on the settled side
  // only, and the drift the defect produced comes back — proof of which box carries the line.
  const swapWithoutDoor = compareLines(inkLines, doorlessLines);

  return {
    width: run.width,
    height: run.height,
    chapter: run.chapter,
    blockIndex: run.blockIndex,
    blockId: block.id,
    blockHeight: run.placedAt?.height ?? null,
    fonts: run.fonts,
    passId,
    mountDelayMs: t0 - startedAt,
    settleMs,
    animationsAtSettle: settled.animations,
    phrase: run.phrase,
    replacement: run.replacement,
    span,
    offsets: run.offsets,
    runGraphemes: graphemes(span.after).length,
    frames,
    bothCaretsIn: frames.filter((frame) => frame.bothCarets).map((frame) => frame.atMs),
    noReflow: {
      /** The claim, both halves: the ink moves no line, and handing the block back moves none. */
      matches: ink.same && inkTail.same && swap.same,
      ink: { mountVsMid: ink, mountVsInkedTail: inkTail, inkedFrameMs: inked.atMs },
      /** The pass renderer (inked) against the ordinary paragraph it hands the block back to. */
      swap: { raw: swap },
      door: {
        present: door.door,
        shown: door.shown.door,
        /** Counterfactual: the door hidden on the settled side only; the old drift returns. */
        withoutDoorOnSettledSide: swapWithoutDoor,
        boxIsLoadBearing: swapWithoutDoor.maxDeltaPx > 0.01,
        tops: { inked: inkLines.tops, afterSwap: swapLines.tops, afterSwapDoorHidden: doorlessLines.tops },
      },
      lines: { mount: mountLines.count, mid: midLines.count, inked: inkLines.count, afterSwap: swapLines.count },
      metric: 'each line top relative to the block top, Range.getClientRects(), rounded to 0.01 px',
    },
    strip: {
      open: settled.strip !== null,
      text: settled.strip,
      note: 'the strip stays closed: its live state needs queue.processing/revising, which this replay does not set',
    },
    head: { atMount: mounted.head, atSettle: settled.head },
    paragraph: {
      atMount: { blockId: mounted.blockId, pass: true, beat: mounted.beat, prose: mounted.prose.slice(0, 240) },
      atSettle: { blockId: settled.blockId, pass: settled.pass, prose: settled.prose.slice(0, 240) },
      showsTheEdit: settled.prose.includes(run.replacement),
      textIsTheWholeParagraph: settled.prose === run.after,
    },
    stored: storedStages(dir, passId),
    console: consoleLog.splice(0, consoleLog.length),
  };
}

// ── main ────────────────────────────────────────────────────────────────────────────────────

async function main() {
  for (const [url, what] of [
    [`${API}/healthz`, `API port ${PORT}`],
    [`http://127.0.0.1:${CDP_PORT}/json/version`, `CDP port ${CDP_PORT}`],
  ]) {
    if (!(await portIsFree(url))) fail(`${what} is already in use — stop it first`);
  }

  await buildSite({ skip: skipBuild, log });
  const dir = await prepareTemp();
  if (dir === null) {
    // Dev-only: this harness photographs a pass in the live book's copy. With no volume there is
    // nothing to photograph, and that is not a failure of the script.
    log(`skipped: no volume to copy (${PROD_DB} is not there) — this run needs a local book`);
    return;
  }
  log(`temp book at ${dir}`);
  const server = spawnLogged('node', ['server/dist/index.js'], {
    cwd: SITE,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: join(dir, 'data'),
      // Prompts and canon only: since BOOK-187 nothing reads a manuscript from here.
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
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    const runs = [];
    for (const run of RUNS) {
      await prepareRun(run);
      await openPage(cdp, run);
      runs.push(await runOnce({ cdp, run, dir, consoleLog }));
    }

    const errors = runs
      .flatMap((run) => run.console)
      .filter((entry) => entry.kind === 'error' || entry.kind === 'exception' || entry.kind === 'log:error');
    const report = {
      capturedAt: new Date().toISOString(),
      worktree: WORKTREE,
      widths: runs.map((run) => run.width),
      framesPerWidth: SHOT_MS.length,
      browser: browser.output.match(/DevTools listening on (\S+)/)?.[1] ?? null,
      build: { rebuilt: skipBuild === false, servedFrom: 'web/dist/staging by node server/dist/index.js' },
      replay: {
        note: 'the two pass_stages rows were inserted into a temp copy of the store; no model call ran, no money moved, prod was never written',
        tempBook: keepTemp ? dir : 'removed after the run',
        schema: 'the copy is v21 pinned to v20 (v21 added two nullable columns); this branch understands v20',
      },
      runs,
      console: { errors, messages: runs.flatMap((run) => run.console) },
      verdict: {
        frames: runs.reduce((sum, run) => sum + run.frames.length, 0),
        bothCaretsSomewhere: runs.every((run) => run.bothCaretsIn.length > 0),
        inkNoReflow: runs.every((run) => run.noReflow.ink.mountVsMid.same && run.noReflow.ink.mountVsInkedTail.same),
        swapNoReflow: runs.every((run) => run.noReflow.swap.raw.same),
        doorBoxIsLoadBearing: runs.every((run) => run.noReflow.door.boxIsLoadBearing),
        noConsoleErrors: errors.length === 0,
        frameCountInRange: runs.every((run) => run.frames.length >= 6 && run.frames.length <= 8),
      },
    };
    report.verdict.ok =
      report.verdict.bothCaretsSomewhere &&
      report.verdict.inkNoReflow &&
      report.verdict.swapNoReflow &&
      report.verdict.noConsoleErrors &&
      report.verdict.frameCountInRange;
    writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    log(`report: ${relative(WORKTREE, join(OUT, 'report.json'))}`);
    log(`verdict: ${JSON.stringify(report.verdict)}`);
    if (!report.verdict.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`[pass-frames] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    for (const [name, child] of [['server', server], ['browser', browser]]) {
      if (child?.output) console.error(`${name}:\n${child.output.split('\n').slice(-15).join('\n')}`);
    }
    process.exitCode = 1;
  } finally {
    cleanup();
    await sleep(500);
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

await main();
