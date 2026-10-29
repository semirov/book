/**
 * lib/chainCapture.mjs — the rest of BOOK-220 §11.2's capture: the reduced-motion mark, the
 * arrivals, the six-second window, the two-place order is in `chainContract.mjs`, and the
 * 27 000-character perf numbers (node count, p95 frame time, the plan against the arithmetic).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, relative } from 'node:path';

import { collect, untilSettled, waitFrame, waitIdle, writeRevision } from './chainPrint.mjs';
import { PRINT_WINDOW_MS, SAMPLE_MS } from './chainContract.mjs';
import { WORKTREE } from './passBook.mjs';

const ARRIVALS = [0.3, 0.7, 0.95];
const PERF_MS = 25_000;
const PERF_CHARS = 27_000;
const DESK_CPS = 30;
const PHONE_CPS = 26;

const round = (value) => (value === null || value === undefined ? null : Math.round(value * 10) / 10);
const live = (samples) => samples.filter((item) => item.pass === true);

/** D7 — `prefers-reduced-motion: reduce` → the final text, the strike for 600 ms, no caret. */
export async function reducedMotion({ cdp, run, dir, stepId, check, shot }) {
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const edit = run.edits.find((entry) => entry.id === 'reduced');
  const write = writeRevision(dir, run.chapter, { ...edit, at: Date.now(), stepId });
  const frame = await waitFrame(cdp, write.rev);
  const samples = await collect(cdp, run.anchor, { sampleMs: 25, timeoutMs: 10_000, done: untilSettled });
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  const statics = samples.filter((item) => item.beat === 'static');
  const strikes = samples.filter((item) => item.ghost !== null && item.ghost.strike !== 'none');
  const mark = statics[0] ?? samples.find((item) => item.pass === true);
  const result = {
    rev: write.rev,
    frameAt: frame?.t ?? null,
    samples: samples.length,
    staticSamples: statics.length,
    strikeSamples: strikes.length,
    ghostStruck: strikes.length > 0,
    carets: samples.reduce((sum, item) => sum + item.carets.all, 0),
    beats: [...new Set(samples.map((item) => item.beat))],
    shot: await shot(mark === undefined ? `${String(run.width)}-reduced-missing` : `${String(run.width)}-reduced`),
  };
  check(
    `reduced/${String(run.width)} static text, a struck ghost, no caret and no ink`,
    statics.length > 0 && result.ghostStruck === true && result.carets === 0 && statics.every((item) => item.revealed <= 0),
    `${String(statics.length)} static samples, strike ${String(result.strikeSamples)}, caret elements ${String(result.carets)}, ` +
      `beats ${JSON.stringify(result.beats)}`,
  );
  return result;
}

/**
 * D5 — arrivals: a write the page hears about when its print is already under way. The page
 * joins at the plan's own index for that instant (±2 chars), never a replay from zero.
 */
export async function arrivals({ cdp, run, dir, stepId, check, log, shot }) {
  const primeEdit = run.edits.find((entry) => entry.id === 'prime');
  const prime = writeRevision(dir, run.chapter, { ...primeEdit, at: Date.now(), stepId });
  const primeFrame = await waitFrame(cdp, prime.rev);
  const primeSamples = await collect(cdp, run.anchor, { sampleMs: SAMPLE_MS, timeoutMs: 40_000, done: untilSettled });
  const primeSettledAt = primeSamples.at(-1)?.pass === false ? primeSamples.at(-1).t : null;
  const printMs = primeSettledAt === null ? null : primeSettledAt - prime.at;
  log(`${String(run.width)}: prime rev ${String(prime.rev)} — print ${printMs === null ? 'never settled' : `${String(printMs)} ms`}`);
  check(
    `arrival/${String(run.width)} a print to arrive into`,
    printMs !== null && printMs > 500,
    `${String(printMs)} ms from the write to the settle`,
  );

  const rows = [];
  let tickAt = primeFrame === null ? null : primeFrame.t + 500;
  for (const share of ARRIVALS) {
    const edit = run.edits.find((entry) => entry.id === `arrival-${String(Math.round(share * 100))}`);
    if (tickAt !== null) {
      const wait = tickAt - 40 - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const backdate = Math.min(Math.round(share * (printMs ?? 4_000)), (printMs ?? 4_000) - 250, PRINT_WINDOW_MS - 400);
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
    const heardAt = frame === null ? null : frame.t - at;
    const revealed = first === null ? null : first.revealed;
    const expected = first === null || first.plan === null ? null : first.plan.expected;
    const arrivalShot = await shot(`${String(run.width)}-arrival-${String(Math.round(share * 100))}`);
    const rest = await collect(cdp, run.anchor, { sampleMs: SAMPLE_MS, timeoutMs: 40_000, done: untilSettled });
    const settledAt = rest.at(-1)?.pass === false ? rest.at(-1).t : null;
    rows.push({
      share,
      backdateMs: backdate,
      rev: write.rev,
      appliedAt: at,
      frameAt: frame?.t ?? null,
      elapsedAtFirstSightMs: elapsed,
      heardAtMs: heardAt,
      revealedAtFirstSight: revealed,
      planIndexAtFirstSight: expected,
      observedShare: settledAt === null || elapsed === null ? null : Math.round((elapsed / (settledAt - at)) * 1_000) / 1_000,
      joined: first !== null,
      settledAt,
      shot: arrivalShot,
    });
    // Joined: the DOM is where the plan's clock says. Ended: the page heard of the write after
    // its print was over. Forbidden: a `.p-pass` that starts again from zero at that instant.
    const joined = first !== null && revealed !== null && expected !== null && Math.abs(revealed - expected) <= 2;
    // A print with less than a frame or two left is not joinable: the page settles it at once.
    const ended = heardAt !== null && printMs !== null && heardAt >= printMs - 250;
    check(
      `arrival/${String(run.width)} at ${String(Math.round(share * 100))} % joins the current frame — or settles past its print, never restarts`,
      joined || ended,
      joined
        ? `${String(elapsed)} ms of ink already painted: ${String(revealed)} graphemes, the plan says ${String(expected)}`
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
    `late/${String(run.width)} after 6 s no .p-pass, no data-pass`,
    result.passSeen === false && result.dataPassSeen === false,
    `${String(samples.length)} samples over 2 s: pass ${String(result.passSeen)}, data-pass ${String(result.dataPassSeen)}`,
  );
  return result;
}

/**
 * BOOK-220 §11.2 B4 — the 27 000-character capture at 390.
 *
 * The print is ~15 minutes, so the run measures a 25 s window of it and reports three numbers
 * that do not need the end: the **DOM node count** (before/after, and against the chain's own
 * short print), the **p95 frame time** of the renderer's rAF chain, and the **plan's duration**
 * against the arithmetic (`chars ÷ 26 cps` plus the pauses). The window's own reveal rate says
 * the clock is the device's, not a compressed one.
 */
export async function perf({ cdp, run, dir, stepId, check, log, shot, out }) {
  // The applied span carries at most 2 000 characters a block (`STAGE_SPAN_MAX_CHARS`), so a
  // 27 000-character chapter is ~14 paragraphs — and that is the contract's shape anyway: the
  // whole chapter prints, place by place, in document order. `27 000 ÷ 30 cps` is ~15 minutes.
  await waitIdle(cdp, run.anchor, 40_000);
  // The capture reads the caret *on screen*: the run's own paragraph comes to the reading line.
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const node = Array.from(document.querySelectorAll('p[data-block-id]'))
        .find((item) => (item.textContent || '').includes(${JSON.stringify(run.anchor)})) || null;
      node?.scrollIntoView({ block: 'center', behavior: 'instant' });
      return node === null ? null : true;
    })()`,
    returnByValue: true,
  });
  await sleep(300);
  const chunk = `${"Длинная глава печатается целиком, символ за символом, в порядке чтения. ".repeat(40)}`.slice(0, 1_900);
  const parts = [];
  let total = 0;
  while (total < PERF_CHARS) {
    parts.push(chunk);
    total += chunk.length + 2;
  }
  const replacement = parts.join('\n\n');
  const write = writeRevision(dir, run.chapter, { phrase: run.perfPhrase, replacement, at: Date.now(), stepId });
  const frame = await waitFrame(cdp, write.rev);
  const started = Date.now();
  // BOOK-220 §11.2 B10 — the follow control, in a real page: turned on after the ink starts,
  // the caret must sit on the 45 % line (± the 40 px band plus one sample's own drift).
  const follow = { on: false, target: null, maxDelta: 0, samples: 0 };
  const samples = await collect(cdp, run.anchor, {
    sampleMs: 250,
    timeoutMs: PERF_MS,
    done: () => Date.now() - started > PERF_MS,
    onSample: async (state) => {
      if (state.pass !== true || state.carets?.ink?.visible !== true) return;
      if (!follow.on) {
        follow.on = true;
        await cdp.send('Runtime.evaluate', { expression: "document.querySelector('.print-follow')?.click()" });
        follow.target = state.viewport.height * 0.45;
        return;
      }
      const centre = state.carets.ink.top + (state.carets.ink.height ?? 0) / 2;
      follow.maxDelta = Math.max(follow.maxDelta, Math.abs(centre - follow.target));
      follow.samples += 1;
    },
  });
  await cdp.send('Runtime.evaluate', { expression: "window.dispatchEvent(new Event('wheel'))" });
  const printing = live(samples).filter((item) => item.plan !== null);
  const first = printing[0] ?? null;
  const last = printing.at(-1) ?? null;
  const frames = await cdp.send('Runtime.evaluate', {
    expression: 'window.__frameTimes ? window.__frameTimes.slice() : []',
    returnByValue: true,
  });
  const deltas = (frames.result.value ?? []).filter((value) => Number.isFinite(value) && value > 0);
  const sorted = [...deltas].sort((left, right) => left - right);
  const p95 = sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const p50 = sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];

  /** The arithmetic the contract names, for a text: chars ÷ cps, word ends ×1.4, the pauses. */
  const baseMs = 1_000 / (run.width < 600 ? PHONE_CPS : DESK_CPS);
  const arithmetic = (text) => {
    const words = text.split(/\s+/u).filter((word) => word.length > 0).length;
    const stops = (text.match(/[.!?…]/gu) ?? []).length;
    const commas = (text.match(/[,;:—]/gu) ?? []).length;
    return text.length * baseMs + words * baseMs * 0.4 + stops * 140 + commas * 60;
  };
  const chapterArithmeticMs = arithmetic(replacement);
  const blockChars = first?.plan?.total ?? null;
  const blockDuration = first?.plan?.duration ?? null;
  const blockArithmeticMs = arithmetic(chunk);
  const revealed = first === null || last === null ? null : last.revealed - first.revealed;
  const elapsedMs = first === null || last === null ? null : last.t - first.t;
  const cps = revealed === null || elapsedMs === null || elapsedMs <= 0 ? null : (revealed / elapsedMs) * 1_000;
  const passNodes = [...new Set(samples.filter((item) => item.pass).map((item) => item.passNodes))];
  const documentNodes = samples.map((item) => item.documentNodes);
  const blocksSeen = new Set(printing.map((item) => item.blockId));
  const image = await shot(`${String(run.width)}-perf-${String(PERF_CHARS)}`);
  log(
    `${String(run.width)}: ${String(replacement.length)} chars in ${String(parts.length)} blocks — first block ${String(blockChars)} chars,` +
      ` plan ${String(blockDuration === null ? '?' : Math.round(blockDuration / 1_000))} s (arithmetic ${String(Math.round(blockArithmeticMs / 1_000))} s),` +
      ` chapter arithmetic ${String(Math.round(chapterArithmeticMs / 60_000))} min, measured ${String(round(cps))} cps, p95 frame ${String(round(p95))} ms`,
  );
  check(
    `perf/${String(run.width)} a ${String(PERF_CHARS)}-character chapter prints at the device rate, not a compressed one`,
    blockChars !== null && blockDuration !== null &&
      Math.abs(blockDuration - blockArithmeticMs) / blockArithmeticMs <= 0.2 &&
      cps !== null && cps > (run.width < 600 ? PHONE_CPS : DESK_CPS) * 0.6 && cps < (run.width < 600 ? PHONE_CPS : DESK_CPS) * 1.4 &&
      chapterArithmeticMs / 60_000 > 12,
    `${String(replacement.length)} chars: the first ${String(blockChars)}-character block plans ` +
      `${String(blockDuration === null ? '?' : Math.round(blockDuration / 1_000))} s against ` +
      `${String(Math.round(blockArithmeticMs / 1_000))} s of arithmetic; the chapter's arithmetic is ` +
      `${String(Math.round(chapterArithmeticMs / 60_000))} min at ${String(run.width < 600 ? PHONE_CPS : DESK_CPS)} cps; measured ${String(round(cps))} cps`,
  );
  // One node for the paragraph, one for its copy, one for the caret, one for the hidden
  // sentence, the ghost while it lives, and the `⋯` door on a block that has one: a fixed set,
  // whatever the block's length (a 1 900-character block and a 30-character one agree).
  const spread = passNodes.length === 0 ? null : Math.max(...passNodes) - Math.min(...passNodes);
  check(
    `perf/${String(run.width)} the DOM node count does not follow the character count`,
    spread !== null && spread <= 1 && Math.max(...passNodes) <= 7 && documentNodes.every((value) => value !== null),
    `the printing block holds ${JSON.stringify(passNodes)} nodes over ${String(samples.length)} samples ` +
      `(a short print's block: ${String(run.chainPassNodes)}); the document ${String(documentNodes[0])} → ${String(documentNodes.at(-1))}`,
  );
  check(
    `follow/${String(run.width)} «следить» keeps the caret on the 45 % line (±40 px + a sample)`,
    follow.on && follow.samples > 5 && follow.maxDelta <= 60,
    follow.on
      ? `${String(follow.samples)} samples after the tap, largest |centre − 45 %| = ${String(round(follow.maxDelta))} px (line ${String(round(follow.target))} px)`
      : 'the control never appeared during the capture',
  );
  check(
    `perf/${String(run.width)} p95 frame time stays under two frames`,
    p95 !== null && p95 <= 34,
    `${String(deltas.length)} frames, p50 ${String(round(p50))} ms, p95 ${String(round(p95))} ms`,
  );
  return {
    rev: write.rev,
    frameAt: frame?.t ?? null,
    shot: image,
    out,
    chars: replacement.length,
    blocks: parts.length,
    blocksSeen: blocksSeen.size,
    blockChars,
    blockPlanMs: blockDuration,
    blockArithmeticMs: Math.round(blockArithmeticMs),
    chapterArithmeticMs: Math.round(chapterArithmeticMs),
    measuredCps: round(cps),
    windowMs: round(elapsedMs),
    frames: deltas.length,
    p50: round(p50),
    p95: round(p95),
    passNodes,
    documentNodes: { first: documentNodes[0] ?? null, last: documentNodes.at(-1) ?? null },
    samples: samples.length,
    revealedAtWindowEnd: last?.revealed ?? null,
    follow: { on: follow.on, samples: follow.samples, maxDeltaPx: round(follow.maxDelta), targetPx: round(follow.target) },
  };
}

/**
 * BOOK-220 B3 — the head's word and the folio never touch (unchanged by this contract).
 */
export async function folioGap({ cdp, run, dir, stepId, check }) {
  const probe = `(() => {
    const word = document.querySelector('.head-status');
    const folio = document.querySelector('.folio');
    if (word === null || folio === null) {
      return {
        text: null,
        folioText: null,
        rects: null,
        dom: { heads: document.querySelectorAll('.top').length, folios: document.querySelectorAll('.folio').length,
               statuses: document.querySelectorAll('.head-status').length, scrollY: Math.round(window.scrollY) },
      };
    }
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
  const judge = (value) => {
    const rects = value.rects;
    if (rects === null) return { rects: null, overlap: true, gap: null, wideLeft: null, wideGap: null };
    const overlap =
      rects.word.left < rects.folio.right &&
      rects.folio.left < rects.word.right &&
      rects.word.top < rects.folio.bottom &&
      rects.folio.top < rects.word.bottom;
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
  // The folio names the chapter at the reading line: the run's own chapter is on it.
  await cdp.send('Runtime.evaluate', {
    expression: `document.getElementById('ch-${String(run.chapter)}')?.scrollIntoView({ block: 'center', behavior: 'instant' }) ?? null`,
    returnByValue: true,
  });
  await sleep(250);
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
    const floor = width >= 768 ? 4 : 1;
    const numbers = (left, gap) =>
      here.rects === null
        ? `no .head-status or no .folio on the page (${JSON.stringify(actual.dom ?? null)})`
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

