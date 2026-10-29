/**
 * lib/chainStages.mjs — the four measurements `scripts/chain-print-cdp.mjs` makes in one page.
 *
 * Each stage takes the same context (`cdp`, the run's fixture, the temp store and the step the
 * write is attributed to) and answers what it saw; the assertions are checked here, printed as
 * they are decided, and never rewritten afterwards. `chain` is the two writes 1 200 ms apart,
 * `carets` is BOOK-DOC-84 §4 measured on the first print, `reducedMotion` is D7's static mark,
 * `arrivals` is D5's mid-print join, `tooLate` is D5's window.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, relative } from 'node:path';

import { caretWindow, collect, probeApplied, untilSettled, waitFrame, writeRevision } from './chainPrint.mjs';
import { WORKTREE } from './passBook.mjs';

const SAMPLE_MS = 50;
/** BOOK-DOC-84 §4/D5 — a write older than this never prints. */
const PRINT_WINDOW_MS = 6_000;
/** The chain: the two writes' own clocks, and the bound the gap must meet. */
const WRITE_GAP_MS = 1_200;
const MAX_CHAIN_GAP_MS = 1_500;
const ARRIVALS = [0.3, 0.7, 0.95];
/** How long a write gets to appear as `.p-pass` before the harness stops waiting for it. */
const MOUNT_MS = 4_000;

/** The frame's own shape, the number that explains a print that never starts. */
const shapeOf = (frame) =>
  frame === null
    ? 'no frame'
    : `patchTruncated ${String(frame.patchTruncated)}, span ${String(frame.spanLength)}, patch ${String(frame.patchLength)}`;

/** One verdict, collected and printed as it is decided; a red one is never swallowed. */
export function checker(log) {
  const assertions = [];
  const check = (name, ok, detail) => {
    assertions.push({ name, ok: ok === true, detail });
    log(`  ${ok === true ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
    return ok === true;
  };
  return { assertions, check };
}

/** The chain: two writes, the first print measured whole, the second opened after its settle. */
export async function chain({ cdp, run, dir, stepId, check, log, shot }) {
  const [first, second] = run.edits;
  const write1 = writeRevision(dir, run.chapter, { ...first, at: Date.now(), stepId });
  const frame1 = await waitFrame(cdp, write1.rev);
  // Both carets are only in the tree while the print runs: photograph them from inside it.
  const waited = Date.now();
  const samples1 = await collect(cdp, run.anchor, {
    sampleMs: SAMPLE_MS,
    timeoutMs: 20_000,
    done: (samples, state) =>
      untilSettled(samples, state) ||
      (!samples.some((item) => item.pass === true) && Date.now() - waited > MOUNT_MS),
  });
  const printed = samples1.some((item) => item.pass === true);
  check(
    `chain/${run.width} the write prints`,
    printed,
    printed ? '`.p-pass` mounted' : `no .p-pass within ${String(MOUNT_MS)} ms of the frame (${shapeOf(frame1)})`,
  );
  if (!printed) {
    // The rest of the contract is the print, so there is nothing to sample; the frame's own
    // shape and the reader's verdict with the copy's data dir are the numbers to report.
    return {
      printed: false,
      write1,
      write2: null,
      frame: frame1 === null ? null : { ...frame1 },
      probe: probeApplied(dir, run.chapter, write1.rev),
      shape: shapeOf(frame1),
      caret1: null,
      second: null,
      samples1,
      samples2: [],
      caretsShot: null,
      firstSettleAt: null,
      secondFirstInkAt: null,
      gap: null,
      insertGapMs: null,
    };
  }
  const firstSettleAt = samples1.at(-1)?.pass === false ? samples1.at(-1).t : null;
  const caret1 = caretWindow(samples1, frame1 === null ? null : { appliedAt: write1.at, receivedAt: frame1.t });
  log(
    `${run.width}: write 1 rev ${String(write1.rev)} — frame +${String(frame1 === null ? '?' : frame1.t - write1.at)} ms,` +
      ` settle +${String(firstSettleAt === null ? 'never' : firstSettleAt - write1.at)} ms, ${String(samples1.length)} samples`,
  );
  check(
    `chain/${run.width} the first print mounts and settles`,
    samples1.some((item) => item.pass === true) && firstSettleAt !== null,
    `${String(samples1.filter((item) => item.pass).length)} pass samples, settle ${firstSettleAt === null ? 'never' : `${String(firstSettleAt - write1.at)} ms after the write`}`,
  );
  check(
    `chain/${run.width} both carets in one frame`,
    caret1.bothVisibleSamples > 0,
    `${String(caret1.bothVisibleSamples)} of ${String(samples1.length)} samples`,
  );

  // The second write keeps its own clock (1 200 ms after the first) and is inserted once the
  // first print is over — the order the design gives a chain (D4: the print, then the next).
  const secondAt = write1.at + WRITE_GAP_MS;
  const insertAt = Math.max(Date.now(), secondAt);
  const write2 = writeRevision(dir, run.chapter, { ...second, at: secondAt, stepId });
  const frame2 = await waitFrame(cdp, write2.rev);
  let caretsShot = null;
  const samples2 = await collect(cdp, run.anchor, {
    sampleMs: SAMPLE_MS,
    timeoutMs: 20_000,
    done: untilSettled,
    // Both carets exist only while a print runs. The second print is photographed: the first
    // window is the one the rates are read from, and a screenshot stalls the sampler.
    onSample: async (state) => {
      if (caretsShot !== null) return;
      if (state.carets.read.visible && state.carets.write.visible) {
        caretsShot = await shot(`${String(run.width)}-carets`);
      }
    },
  });
  const secondInk = samples2.find((item) => item.pass === true && item.clusters - item.pending > 0) ?? null;
  const secondSettle = samples2.at(-1)?.pass === false ? samples2.at(-1).t : null;
  const gap = secondInk === null || firstSettleAt === null ? null : secondInk.t - firstSettleAt;
  log(
    `${run.width}: write 2 rev ${String(write2.rev)} — appliedAt +${String(secondAt - write1.at)} ms, inserted +${String(insertAt - write1.at)} ms,` +
      ` first ink ${gap === null ? 'never' : `${String(gap)} ms after the settle`}, settle ${secondSettle === null ? 'never' : 'reached'}`,
  );
  check(
    `chain/${run.width} the second write prints`,
    samples2.some((item) => item.pass === true) && secondSettle !== null,
    `${String(samples2.filter((item) => item.pass).length)} pass samples`,
  );
  check(
    `chain/${run.width} gap first settle → second first ink ≤ ${String(MAX_CHAIN_GAP_MS)} ms`,
    gap !== null && gap >= 0 && gap <= MAX_CHAIN_GAP_MS,
    gap === null ? 'the second never inked' : `${String(gap)} ms`,
  );
  return {
    printed: true,
    write1,
    write2,
    frame: null,
    probe: null,
    // The frame's own shape is the number that says a print could happen: `patchTruncated`,
    // `span` and `patch` are recorded on a green run too, not only on the failing one.
    shape: shapeOf(frame1),
    firstSettleAt,
    secondFirstInkAt: secondInk?.t ?? null,
    gap,
    insertGapMs: insertAt - write1.at,
    caret1,
    second: caretWindow(samples2, frame2 === null ? null : { appliedAt: secondAt, receivedAt: frame2.t }),
    samples1,
    samples2,
    caretsShot,
  };
}

/**
 * BOOK-DOC-84 §4 — the caret contract, measured on the first print's window.
 *
 * The fixture's first edit is placed where both rates can be read off one print. Two facts about
 * the numbers below: `blue` is the median velocity over the caret's whole lit window, and the
 * blue caret rests on line 0 until the ink ends — so the run must sit far enough down the block
 * for its eased climb to fill that window (a two-line climb never reaches the nominal 4 lines/s,
 * its median is about half). And `red left advances` is only visible while the ink is still being
 * laid (`passMotion.redAt`: col = revealed): the print's clock starts at `appliedAt`, so if the
 * bridge's 500 ms poll delivers the frame after the run is fully inked, the caret is already on
 * its tail and the advance never appears in a sample. Hence the chain's first insertion is
 * mid-paragraph and long enough to outlast the poll, with lines left below it for red's descent.
 */
export function carets(run, caret1, check) {
  check(
    `carets/${run.width} both lit within 300 ms of the frame`,
    caret1.onsetFromFrame.read !== null &&
      caret1.onsetFromFrame.write !== null &&
      caret1.onsetFromFrame.read <= 300 &&
      caret1.onsetFromFrame.write <= 300,
    `read ${String(caret1.onsetFromFrame.read)} ms, write ${String(caret1.onsetFromFrame.write)} ms after the frame` +
      ` (after the write: ${String(caret1.onsetFromApplied.read)} / ${String(caret1.onsetFromApplied.write)} ms, the poll included)`,
  );
  check(
    `blue/${run.width} top median ≤ −60 px/s`,
    caret1.read.medianPxPerSec !== null && caret1.read.medianPxPerSec <= -60,
    `${String(caret1.read.medianPxPerSec)} px/s over ${String(caret1.read.pairs)} pairs, travel ${String(caret1.read.travelPx)} px`,
  );
  const delta =
    caret1.read.leftMedian === null || caret1.firstGlyphLeft === null ? null : caret1.read.leftMedian - caret1.firstGlyphLeft;
  check(
    `blue/${run.width} left == the run's first glyph left ±1 px`,
    delta !== null && Math.abs(delta) <= 1,
    `caret ${String(caret1.read.leftMedian)} px, glyph ${String(caret1.firstGlyphLeft)} px, delta ${String(delta === null ? null : Math.round(delta * 10) / 10)} px`,
  );
  check(
    `red/${run.width} top median ≥ +40 px/s`,
    caret1.write.medianPxPerSec !== null && caret1.write.medianPxPerSec >= 40,
    `${String(caret1.write.medianPxPerSec)} px/s over ${String(caret1.write.pairs)} pairs, travel ${String(caret1.write.travelPx)} px`,
  );
  check(
    `red/${run.width} left advances`,
    caret1.write.advancePx !== null && caret1.write.advancePx > 0.5,
    `largest same-line step ${String(caret1.write.advancePx)} px (${String(caret1.write.leftFirst)} → ${String(caret1.write.leftLast)} px,` +
      ` ${String(caret1.write.wraps)} line wrap(s))`,
  );
  check(`carets/${run.width} both gone at settle`, caret1.goneAtSettle === true, 'the settled paragraph carries neither caret');
}

/** D7 — `prefers-reduced-motion: reduce` → the static mark, no caret element at all. */
export async function reducedMotion({ cdp, run, dir, stepId, check, shot }) {
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const edit = run.edits.find((entry) => entry.id === 'reduced');
  const write = writeRevision(dir, run.chapter, { ...edit, at: Date.now(), stepId });
  const frame = await waitFrame(cdp, write.rev);
  const samples = await collect(cdp, run.anchor, { sampleMs: SAMPLE_MS, timeoutMs: 10_000, done: untilSettled });
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  const statics = samples.filter((item) => item.beat === 'static');
  const mark = statics[0] ?? samples.find((item) => item.pass === true);
  const result = {
    rev: write.rev,
    frameAt: frame?.t ?? null,
    samples: samples.length,
    staticSamples: statics.length,
    passSpan: statics.some((item) => item.passSpan === true),
    ticks: statics[0]?.ticks ?? null,
    caretElements: samples.reduce((sum, item) => sum + item.carets.read.count + item.carets.write.count, 0),
    beats: [...new Set(samples.map((item) => item.beat))],
    shot: await shot(mark === undefined ? `${String(run.width)}-reduced-missing` : `${String(run.width)}-reduced`),
  };
  check(
    `reduced/${run.width} data-pass="static", .pass-span, two ticks, no caret`,
    statics.length > 0 && result.passSpan === true && result.ticks === 2 && result.caretElements === 0,
    `${String(statics.length)} static samples, span ${String(result.passSpan)}, ticks ${String(result.ticks)}, caret elements ${String(result.caretElements)}`,
  );
  return result;
}

/**
 * D5 — arrivals: a write the page hears about when its print is already under way. One prime
 * print of the same shape measures the duration a reader paints; the three arrivals are
 * back-dated inside it, so the page joins at `frameAt(now − appliedAt)` — never at zero.
 */
export async function arrivals({ cdp, run, dir, stepId, check, log, shot }) {
  const primeEdit = run.edits.find((entry) => entry.id === 'prime');
  const prime = writeRevision(dir, run.chapter, { ...primeEdit, at: Date.now(), stepId });
  const primeFrame = await waitFrame(cdp, prime.rev);
  const primeSamples = await collect(cdp, run.anchor, { sampleMs: SAMPLE_MS, timeoutMs: 25_000, done: untilSettled });
  const primeSettledAt = primeSamples.at(-1)?.pass === false ? primeSamples.at(-1).t : null;
  const printMs = primeSettledAt === null ? null : primeSettledAt - prime.at;
  log(`${run.width}: prime rev ${String(prime.rev)} — print ${printMs === null ? 'never settled' : `${String(printMs)} ms`}`);
  check(
    `arrival/${run.width} a print to arrive into`,
    printMs !== null && printMs > 500,
    `${String(printMs)} ms from the write to the settle`,
  );

  const rows = [];
  // The bridge's poll is 500 ms (`EngineBridge.intervalMs`), so a write lands at a random phase
  // and the frame can arrive up to half a second late. The phase is known from the last frame, so
  // each arrival is written just before the next tick: the delay is then ~50 ms, and an arrival at
  // 95 % of a 3 s print still reaches the page before the print ends.
  let tickAt = primeFrame === null ? null : primeFrame.t + 500;
  for (const share of ARRIVALS) {
    const edit = run.edits.find((entry) => entry.id === `arrival-${String(Math.round(share * 100))}`);
    if (tickAt !== null) {
      const wait = tickAt - 40 - Date.now();
      if (wait > 0) await sleep(wait);
    }
    // A print longer than the window cannot be joined at 95 % of itself: the client would (rightly)
    // refuse the frame. The back-dating stops 250 ms short of the print's own end and 400 ms short
    // of `PRINT_WINDOW_MS`; the report names the share actually used.
    const backdate = Math.min(
      Math.round(share * (printMs ?? 4_000)),
      (printMs ?? 4_000) - 250,
      PRINT_WINDOW_MS - 400,
    );
    const at = Date.now() - backdate;
    const write = writeRevision(dir, run.chapter, { ...edit, at, stepId });
    const frame = await waitFrame(cdp, write.rev);
    if (frame !== null) tickAt = frame.t + 500;
    const seen = await collect(cdp, run.anchor, {
      sampleMs: 25,
      timeoutMs: 1_500,
      done: (samples, state) => state.found === true && state.pass === true,
    });
    const first = seen.find((item) => item.pass === true) ?? null;
    const elapsed = first === null ? null : first.t - at;
    // When the page *heard* of the write, on the write's own clock: the one number that says
    // whether a print that never appeared was already over (the poll, not a missing frame).
    const heardAt = frame === null ? null : frame.t - at;
    const revealed = first === null ? null : first.clusters - first.pending;
    // The slowest legal clock: a 700 ms split and one grapheme per 60 ms. A run shorter than
    // that is already fully inked, so the floor is capped by the run itself; a restart shows 0.
    const clusters = first === null ? null : first.clusters;
    const floor =
      elapsed === null || clusters === null ? null : Math.max(1, Math.min(clusters, Math.floor((elapsed - 700) / 60)));
    const arrivalShot = await shot(`${String(run.width)}-arrival-${String(Math.round(share * 100))}`);
    const rest = await collect(cdp, run.anchor, { sampleMs: SAMPLE_MS, timeoutMs: 20_000, done: untilSettled });
    const settledAt = rest.at(-1)?.pass === false ? rest.at(-1).t : null;
    rows.push({
      share,
      backdateMs: backdate,
      effectiveShare: printMs === null ? null : Math.round((backdate / printMs) * 1_000) / 1_000,
      rev: write.rev,
      appliedAt: at,
      frameAt: frame?.t ?? null,
      elapsedAtFirstSightMs: elapsed,
      heardAtMs: heardAt,
      revealedAtFirstSight: revealed,
      slowestClockFloor: floor,
      observedShare: settledAt === null || elapsed === null ? null : Math.round((elapsed / (settledAt - at)) * 1_000) / 1_000,
      joined: first !== null,
      settledAt,
      shot: arrivalShot,
    });
    // Two honest outcomes, one forbidden one. Joined: the ink is already where the clock says.
    // Ended: the page heard of the write after its print was over, so it paints the settled frame
    // — and that case is only legal when the back-dating really passed the print's own end.
    // Forbidden: a `.p-pass` that starts again from zero at that elapsed time.
    const joined = first !== null;
    const ended = heardAt !== null && printMs !== null && heardAt >= printMs;
    const effective = Math.round((backdate / (printMs ?? 1)) * 1_000) / 1_000;
    check(
      `arrival/${run.width} at ${String(Math.round(share * 100))} % joins the current frame — or settles past its print, never restarts`,
      joined ? revealed !== null && floor !== null && revealed >= floor : ended,
      joined
        ? `${String(elapsed)} ms of ink already painted (${String(effective)} of the print): ${String(revealed)} graphemes, the slowest legal clock needs ${String(floor)}`
        : `${String(backdate)} ms back-dated of a ${String(printMs)} ms print, heard at ${String(heardAt)} ms: the print had already ended, and nothing replayed`,
    );
  }
  return { rev: prime.rev, frameAt: primeFrame?.t ?? null, printMs, samples: primeSamples.length, rows };
}

/** D5 — a write the page is told about after its window: plain text, no replay, no `data-pass`. */
export async function tooLate({ cdp, run, dir, stepId, check, shot }) {
  const edit = run.edits.find((entry) => entry.id === 'late');
  const at = Date.now() - PRINT_WINDOW_MS - 500;
  const write = writeRevision(dir, run.chapter, { ...edit, at, stepId });
  const frame = await waitFrame(cdp, write.rev);
  const origin = frame?.t ?? Date.now();
  const samples = await collect(cdp, run.anchor, {
    sampleMs: SAMPLE_MS,
    timeoutMs: 3_000,
    done: (window) => window.length > 0 && window.at(-1).t - origin > 2_000,
  });
  const result = {
    rev: write.rev,
    appliedAt: at,
    frameAt: frame?.t ?? null,
    samples: samples.length,
    passSeen: samples.some((item) => item.pass === true),
    dataPassSeen: samples.some((item) => item.beat !== null),
    shot: await shot(`${String(run.width)}-late`),
  };
  check(
    `late/${run.width} after 6 s no .p-pass, no data-pass`,
    result.passSeen === false && result.dataPassSeen === false,
    `${String(samples.length)} samples over 2 s: pass ${String(result.passSeen)}, data-pass ${String(result.dataPassSeen)}`,
  );
  return result;
}

/**
 * BOOK-220 B3 — the head's word and the folio never touch.
 *
 * The word ends at the column's right edge; the folio's box starts 20 px outside it, so a
 * three-digit folio leans back into the column and a four-digit one leans 8.8 px — the
 * «сейчас тихо154» the owner saw. The reserve in `head-status.css` is the gap, and this stage
 * measures it: the word is forced the honest way (a write lands and the head says «сейчас
 * записывает» for its two seconds, or an open pass says its stage), and both rects are read
 * while it does — at 1440, 768 and 390. The folio is then widened to the four-digit case the
 * reserve is sized for, in the same face and the same position: a two-digit number would prove
 * nothing about the defect.
 */
export async function folioGap({ cdp, run, dir, stepId, check }) {
  const probe = `(() => {
    const word = document.querySelector('.head-status');
    const folio = document.querySelector('.folio');
    if (word === null || folio === null) return { text: null, folioText: null, rects: null };
    const a = word.getBoundingClientRect();
    const b = folio.getBoundingClientRect();
    const round = (value) => Math.round(value * 10) / 10;
    return {
      text: (word.textContent || '').trim(),
      folioText: (folio.textContent || '').trim(),
      rects: {
        word: { left: round(a.left), right: round(a.right), top: round(a.top), bottom: round(a.bottom) },
        folio: { left: round(b.left), right: round(b.right), top: round(b.top), bottom: round(b.bottom) },
      },
    };
  })()`;
  const evaluate = async (expression) => {
    const answer = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    return answer.result.value;
  };
  /** The two boxes as read, plus the folio's left edge at the four-digit width of its own face. */
  const judge = (value) => {
    const rects = value.rects;
    if (rects === null) return { rects: null, overlap: true, gap: null, wideLeft: null, wideGap: null };
    const overlap =
      rects.word.left < rects.folio.right &&
      rects.folio.left < rects.word.right &&
      rects.word.top < rects.folio.bottom &&
      rects.folio.top < rects.word.bottom;
    // PT Mono is 0.6 em per glyph, so the folio's own width divides by its digits: the widest
    // number the design names is four of them, and its left edge moves back by the difference.
    const digits = /^\d+$/u.test(String(value.folioText)) ? String(value.folioText).length : null;
    const perDigit = digits === null || digits === 0 ? null : (rects.folio.right - rects.folio.left) / digits;
    const wideLeft = perDigit === null ? null : Math.round((rects.folio.right - perDigit * 4) * 10) / 10;
    return {
      rects,
      overlap,
      gap: Math.round((rects.folio.left - rects.word.right) * 10) / 10,
      wideLeft,
      wideGap: wideLeft === null ? null : Math.round((wideLeft - rects.word.right) * 10) / 10,
    };
  };

  const rows = [];
  for (const width of [1440, 768, 390]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: width === 390 ? 844 : 900,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await sleep(250);
    const edit = run.edits.find((entry) => entry.id === `folio-${String(width)}`);
    const write = writeRevision(dir, run.chapter, { ...edit, at: Date.now(), stepId });
    const frame = await waitFrame(cdp, write.rev);
    const actual = await evaluate(probe);
    const here = judge(actual);
    rows.push({
      width,
      text: actual.text,
      folioText: actual.folioText,
      frameAt: frame?.t ?? null,
      word: here.rects?.word ?? null,
      folio: here.rects?.folio ?? null,
      gapPx: here.gap,
      overlap: here.overlap,
      fourDigitLeftPx: here.wideLeft,
      fourDigitGapPx: here.wideGap,
    });
    // ≥768 the folio is a fixed box in the margin, the word the row's right end: a real gap.
    // At 390 both are items of the row, so the contract is the same order, not the same reserve.
    const floor = width >= 768 ? 4 : 1;
    const numbers = (left, gap) =>
      here.rects === null
        ? 'no .head-status or no .folio on the page'
        : `word «${actual.text}» ends ${String(here.rects.word.right)} px, folio starts ${String(left)} px — gap ${String(gap)} px`;
    check(
      `folio/${width} the head's word and the folio do not touch`,
      here.overlap === false && typeof actual.text === 'string' && actual.text.length > 0 && here.gap !== null && here.gap >= floor,
      numbers(here.rects?.folio.left ?? null, here.gap),
    );
    check(
      `folio/${width} the reserve clears a four-digit folio`,
      here.overlap === false && here.wideGap !== null && here.wideGap >= floor,
      numbers(here.wideLeft, here.wideGap),
    );
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: run.width,
    height: run.height,
    deviceScaleFactor: 1,
    mobile: run.width < 600,
  });
  return rows;
}

/** Screenshots go beside the report; the path in the report is worktree-relative. */
export function shotter(cdp, out) {
  return async (name) => {
    const data = await cdp.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(out, { recursive: true });
    const file = join(out, `${name}.png`);
    writeFileSync(file, Buffer.from(data.data, 'base64'));
    return relative(WORKTREE, file);
  };
}

export const STAGE = { SAMPLE_MS, PRINT_WINDOW_MS, WRITE_GAP_MS, MAX_CHAIN_GAP_MS, ARRIVALS };
