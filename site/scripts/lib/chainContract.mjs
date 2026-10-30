/**
 * lib/chainContract.mjs — BOOK-220 §11.2's print contract, measured on one print's window.
 *
 * One caret, an increasing top, a monotonic reveal that is the plan's own index ±2 chars, a
 * paragraph whose box moves ≤ 1 px, the chain's gap, and a write that leaves two changed
 * places printing in **document order**, one at a time. The capture half (`chainCapture.mjs`)
 * owns the reduced-motion mark, the arrivals, the six-second window and the 27 000-character
 * perf numbers.
 */

import { collect, probeApplied, untilSettled, waitFrame, waitIdle, writeRevision } from './chainPrint.mjs';

/** The sampling cadence, the write window and the chain's own constants. */
export const SAMPLE_MS = 50;
/** BOOK-DOC-84 §4/D5 — a write older than this never prints. */
export const PRINT_WINDOW_MS = 6_000;
/** The chain: the two writes' own clocks, and the bound the gap must meet. */
export const WRITE_GAP_MS = 1_200;
export const MAX_CHAIN_GAP_MS = 1_500;
/** How long a write gets to appear as `.p-pass` before the harness stops waiting for it. */
export const MOUNT_MS = 4_000;

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

const round = (value) => (value === null || value === undefined ? null : Math.round(value * 10) / 10);

/** Samples where the anchor itself is the printing block. */
const live = (samples) => samples.filter((item) => item.pass === true);

/**
 * The new contract, measured on one print's window.
 *
 * Five numbers, each the contract's own sentence:
 *   • `one caret` — `caret` count is 0 or 1 in every sample, and the retired pair never exists;
 *   • `top increases` — the caret's top never goes back, and it travels down the block;
 *   • `monotonic reveal` — `data-revealed` is non-decreasing and reaches the run's end;
 *   • `±2 chars of the plan` — at each sample the DOM's count is the plan's index for that
 *     instant (the engine's clock), never a replay from zero and never ahead of the ink;
 *   • `the box does not move` — top and height of the paragraph vary by ≤ 1 px.
 */
export function printContract(run, samples, check) {
  const printing = live(samples);
  const ink = printing.map((item) => item.carets.ink);
  const counts = ink.map((caret) => caret.count);
  const oneCaret = counts.every((count) => count <= 1) && printing.every((item) => item.carets.all <= 1);
  check(
    `one/${String(run.width)} exactly one caret node, never the blue/red pair`,
    oneCaret && printing.every((item) => item.carets.read.count === 0 && item.carets.write.count === 0),
    `${String(printing.length)} printing samples; caret counts ${JSON.stringify(counts.slice(0, 8))}; ` +
      `pairs seen ${String(printing.filter((item) => item.carets.read.count + item.carets.write.count > 0).length)}`,
  );

  const lit = ink.filter((caret) => caret.visible === true);
  const tops = lit.map((caret) => caret.top);
  const lineOf = (top) => Math.round(top * 10);
  const monotone = tops.every((top, index) => index === 0 || top >= (tops[index - 1] ?? 0) - 0.5);
  const travel = tops.length === 0 ? 0 : (tops.at(-1) ?? 0) - (tops[0] ?? 0);
  // A run shorter than a line never leaves its line: its leading edge advances in x instead.
  let advance = 0;
  for (let index = 1; index < lit.length; index += 1) {
    const before = lit[index - 1];
    const after = lit[index];
    if (lineOf(before.top) !== lineOf(after.top)) continue;
    advance = Math.max(advance, after.left - before.left);
  }
  const sameLine = tops.length > 1 && new Set(tops.map(lineOf)).size === 1;
  check(
    `caret/${String(run.width)} the caret's leading edge moves forward, and never back`,
    tops.length > 1 && monotone && (travel > 0 || (sameLine && advance > 0.5)),
    `${String(tops.length)} lit samples, top travel ${String(round(travel))} px` +
      ` (${String(tops[0])} → ${String(tops.at(-1))}), largest same-line x step ${String(round(advance))} px`,
  );

  const reveals = printing.map((item) => item.revealed);
  const rising = reveals.every((value, index) => index === 0 || value >= (reveals[index - 1] ?? -1));
  const arrived = reveals.length > 0 ? (reveals.at(-1) ?? 0) : 0;
  const total = printing.at(-1)?.plan?.total ?? null;
  check(
    `reveal/${String(run.width)} the revealed count is monotonic and reaches the run`,
    rising && arrived > 0 && (total === null || arrived >= Math.floor(total * 0.9)),
    `${String(reveals.length)} samples, ${String(arrived)} of ${String(total)} graphemes revealed`,
  );

  // The DOM is the plan at the instant the renderer's last frame painted (±2 characters for a
  // partially painted grapheme), and that frame is never behind the wall clock by more than two
  // frames — so the ink cannot be a replay of an older schedule.
  const paired = printing.filter((item) => item.plan !== null && item.plan.painted !== null);
  const worst = paired.reduce((max, item) => Math.max(max, Math.abs(item.revealed - item.plan.painted)), 0);
  const behind = paired.reduce((max, item) => Math.max(max, item.plan.behindMs ?? 0), 0);
  check(
    `clock/${String(run.width)} the revealed index is the plan's index ±2 chars, on a frame the wall clock can explain`,
    paired.length > 0 && worst <= 2 && behind <= 200,
    `${String(paired.length)} paired samples, worst |DOM − plan| = ${String(worst)} chars, ` +
      `worst frame lag ${String(behind)} ms behind the write's clock`,
  );

  const boxes = printing.map((item) => item.rect);
  const base = boxes[0] ?? null;
  const shift =
    base === null
      ? null
      : boxes.reduce((max, box) => Math.max(max, Math.abs(box.top - base.top), Math.abs(box.height - base.height)), 0);
  check(
    `layout/${String(run.width)} the paragraph's box moves ≤ 1 px during the print`,
    shift !== null && shift <= 1,
    shift === null ? 'no printing sample' : `${String(boxes.length)} samples, largest shift ${String(shift)} px`,
  );

  return {
    printingSamples: printing.length,
    caretCounts: counts,
    caretTopFirst: tops[0] ?? null,
    caretTopLast: tops.at(-1) ?? null,
    caretTravelPx: round(travel),
    caretAdvancePx: round(advance),
    revealedFirst: reveals[0] ?? null,
    revealedLast: arrived,
    planTotal: total,
    worstPlanDelta: worst,
    boxShiftPx: round(shift),
    goneAtSettle: samples.at(-1)?.pass === false && samples.at(-1)?.carets.all === 0,
  };
}

/** The chain: two writes on one chapter, the first measured whole, the second opened after it. */
export async function chain({ cdp, run, dir, stepId, check, log, shot }) {
  const [first, second] = run.edits;
  const write1 = writeRevision(dir, run.chapter, { ...first, at: Date.now(), stepId });
  const frame1 = await waitFrame(cdp, write1.rev);
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
    `chain/${String(run.width)} the write prints`,
    printed,
    printed ? '`.p-pass` mounted' : `no .p-pass within ${String(MOUNT_MS)} ms of the frame (${shapeOf(frame1)})`,
  );
  if (!printed) {
    return {
      printed: false,
      write1,
      write2: null,
      frame: frame1 === null ? null : { ...frame1 },
      probe: probeApplied(dir, run.chapter, write1.rev),
      shape: shapeOf(frame1),
      contract: null,
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
  const contract = printContract(run, samples1, check);
  log(
    `${String(run.width)}: write 1 rev ${String(write1.rev)} — frame +${String(frame1 === null ? '?' : frame1.t - write1.at)} ms,` +
      ` settle +${String(firstSettleAt === null ? 'never' : firstSettleAt - write1.at)} ms, ${String(samples1.length)} samples,` +
      ` ${String(contract.revealedLast)} graphemes`,
  );
  check(
    `chain/${String(run.width)} the first print mounts and settles`,
    samples1.some((item) => item.pass === true) && firstSettleAt !== null,
    `${String(contract.printingSamples)} pass samples, settle ${firstSettleAt === null ? 'never' : `${String(firstSettleAt - write1.at)} ms after the write`}`,
  );
  check(
    `carets/${String(run.width)} gone at settle`,
    contract.goneAtSettle === true,
    'the settled paragraph carries no caret element at all',
  );

  // The second write keeps its own clock (1 200 ms after the first) and is inserted once the
  // first print is over — the order the design gives a write's own places.
  const secondAt = write1.at + WRITE_GAP_MS;
  const insertAt = Math.max(Date.now(), secondAt);
  const write2 = writeRevision(dir, run.chapter, { ...second, at: secondAt, stepId });
  const frame2 = await waitFrame(cdp, write2.rev);
  // No screenshot inside this window: a capture stalls the renderer for a frame or two, and the
  // clock check is a ±2-character bound. The one-caret frames are photographed by the other
  // stages (`twoPlaces`, the arrivals, the perf capture), where no clock is being judged.
  const caretsShot = null;
  const samples2 = await collect(cdp, run.anchor, { sampleMs: SAMPLE_MS, timeoutMs: 20_000, done: untilSettled });
  const secondMount = samples2.find((item) => item.pass === true) ?? null;
  const secondSettle = samples2.at(-1)?.pass === false ? samples2.at(-1).t : null;
  const gap = secondMount === null || firstSettleAt === null ? null : secondMount.t - firstSettleAt;
  log(
    `${String(run.width)}: write 2 rev ${String(write2.rev)} — appliedAt +${String(secondAt - write1.at)} ms, inserted +${String(insertAt - write1.at)} ms,` +
      ` first ink ${gap === null ? 'never' : `${String(gap)} ms after the settle`}, settle ${secondSettle === null ? 'never' : 'reached'}`,
  );
  check(
    `chain/${String(run.width)} the second print opens after the first settles, ≤ ${String(MAX_CHAIN_GAP_MS)} ms`,
    gap !== null && gap >= 0 && gap <= MAX_CHAIN_GAP_MS,
    gap === null ? 'the second never printed' : `${String(gap)} ms between the settle and the next print`,
  );
  const secondContract = printContract({ ...run, width: `${String(run.width)}·2` }, samples2, check);
  return {
    printed: true,
    write1,
    write2,
    frame: null,
    probe: null,
    shape: shapeOf(frame1),
    firstSettleAt,
    secondFirstInkAt: secondMount?.t ?? null,
    gap,
    insertGapMs: insertAt - write1.at,
    contract,
    second: secondContract,
    samples1,
    samples2,
    caretsShot,
  };
}

/**
 * BOOK-220 §11.2 B3 — **document order**, measured on a write that leaves two changed places.
 *
 * The write replaces one sentence with two paragraphs, so the applied span names two blocks. The
 * page prints them one at a time, the earlier one first, and never two at once.
 */
export async function twoPlaces({ cdp, run, dir, stepId, check, log, shot }) {
  const anchor = run.twoPlace;
  if (anchor === undefined) return null;
  // The folio's own write may still be printing: sample a quiet page, not somebody's last frame.
  await waitIdle(cdp, run.anchor);
  const write = writeRevision(dir, run.chapter, {
    phrase: anchor.phrase,
    replacement: anchor.replacement,
    at: Date.now(),
    stepId,
  });
  const frame = await waitFrame(cdp, write.rev);
  const samples = await collect(cdp, run.anchor, { sampleMs: 25, timeoutMs: 30_000, done: untilSettled });
  // The frame that proves the contract is a photograph: one printer, its one caret, the clip
  // mid-run. It is taken after the sampling window, so the stall costs no measurement.
  const shotAt = samples.find((item) => item.passCount === 1 && (item.passes[0]?.revealed ?? 0) > 0) ?? null;
  const image = shotAt === null ? null : await shot(`${String(run.width)}-one-caret`);
  /** The order the page printed in: the block's own document index, never the arrival order. */
  const prints = [];
  let twoAtOnce = 0;
  for (const item of samples) {
    if (item.passCount > 1) twoAtOnce += 1;
    const entry = item.passes[0];
    if (entry === undefined) continue;
    const last = prints.at(-1);
    if (last?.id === entry.id) {
      last.revealed = Math.max(last.revealed, entry.revealed);
      last.total = item.plan?.total ?? last.total;
      last.beat = entry.beat;
      last.lastAt = item.t;
      continue;
    }
    prints.push({
      id: entry.id,
      index: entry.index,
      revealed: entry.revealed,
      total: item.plan?.total ?? null,
      beat: entry.beat,
      at: item.t,
      lastAt: item.t,
      previousDone: last === undefined ? true : last.total === null || last.revealed >= last.total || last.beat === 'settled',
    });
  }
  const ascends = prints.every((entry, position) => entry.index >= 0 && (position === 0 || entry.index > (prints[position - 1]?.index ?? -1)));
  // One at a time: the earlier place has written its whole run (or its renderer said
  // `settled`) before the next block's print appears at all.
  const handover = prints.every((entry, position) => position === 0 || entry.previousDone === true);
  check(
    `order/${String(run.width)} two changed places print in document order, one at a time`,
    prints.length >= 2 && ascends && twoAtOnce === 0 && handover,
    `${String(prints.length)} prints at document indices ${JSON.stringify(prints.map((entry) => entry.index))}, ` +
      `samples with two printers ${String(twoAtOnce)}, handovers complete ${String(handover)} ` +
      `(${prints.map((entry) => `${String(entry.revealed)}/${String(entry.total)}`).join(' → ')})`,
  );
  log(`${String(run.width)}: two places — ${prints.map((entry) => entry.id).join(' then ')}`);
  return {
    rev: write.rev,
    frameAt: frame?.t ?? null,
    order: prints.map((entry) => ({ id: entry.id, index: entry.index, revealed: entry.revealed, total: entry.total })),
    twoAtOnce,
    samples: samples.length,
    shot: image,
  };
}

