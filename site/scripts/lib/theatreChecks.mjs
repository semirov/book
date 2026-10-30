/**
 * lib/theatreChecks.mjs — BOOK-227's check list, one width at a time.
 *
 * Every check names the number it is made of, so a failure is a measurement, not an opinion. The
 * page is `web/harness/theatre.html`; this file only asks it (`window.__theatre.act/snapshot`) and
 * compares the answers with BOOK-DOC-86 §2–§9.
 *
 * The **print is main's** (`PrintPass`, BOOK-220 §11.2, PR #121): this file never inks a
 * character of it. What it measures of the writing act is the theatre's share — that one print
 * and one caret run, that the 2 px spine rides the print's own state and is `--live`, that the
 * ink settles and hands the block back, and that a gate's tally is as tall as the **changed**
 * lines of the write's span (BOOK-DOC-86 §9.5, BOOK-233 item 1).
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { act, call, openPage, sameGrid, snapshot } from './theatrePage.mjs';

/* ------------------------------------------------------------------- the checks ---- */

/** A measured difference, in the report's own precision. */
const round = (value) => Math.round(value * 100) / 100;
/** A token (hex) as the browser reports a computed colour, so a plate check can compare them. */
const rgbOf = (hex) => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(String(hex ?? '').trim());
  return match === null ? null : `rgb(${String(Number.parseInt(match[1], 16))}, ${String(Number.parseInt(match[2], 16))}, ${String(Number.parseInt(match[3], 16))})`;
};
const sameBox = (one, other) =>
  one !== null && one !== undefined && other !== null && other !== undefined
    && Math.abs(one.left - other.left) <= 0.5 && Math.abs(one.top - other.top) <= 0.5;

export async function checksFor(cdp, origin, width, height, { verbose = false } = {}) {
  const log = (message) => {
    if (verbose) process.stderr.write(`${message}\n`);
  };
  const head = await openPage(cdp, origin, width, height);
  const facts = await call(cdp, 'window.__theatre.facts()');
  const results = [];
  const add = (name, pass, detail) => {
    results.push({ name, pass: pass === true, detail });
    log(`${String(width)} · ${pass === true ? 'ok  ' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
  };

  /* 1 — the arrival's fill follows the clock, word by word. The words are read **inside** the
     act: the head's own row appears with the reading, and a box captured before it is 26 px off. */
  const fractions = [0.3, 0.7, 0.95];
  const arrival = [];
  let words = [];
  for (const fraction of fractions) {
    const snap = await act(cdp, 'arrival', { back: Math.round(fraction * facts.sweepMs) });
    words = await call(cdp, 'window.__theatre.words()');
    // The page's own clock, not the fraction asked for: the act's frames cost a millisecond or two.
    const elapsed = snap.claim === null ? Math.round(fraction * facts.sweepMs) : snap.at - snap.claim.fact;
    const inked = Math.min(facts.words, Math.floor((elapsed * facts.words) / facts.sweepMs) + 1);
    // The pen is placed on the frame the fill ran, the snapshot is taken a frame or two later: the
    // word is the clock's, and one press either side is the same reading (§8.1 — one press a word).
    const nib = snap.theatre?.nib?.box;
    const near = [inked - 1, inked, inked + 1]
      .map((index) => words[index - 1])
      .filter((candidate) => candidate !== undefined)
      .filter((candidate) => nib !== undefined && nib !== null
        && Math.abs(nib.left - candidate.left) <= 1.5
        && Math.abs(nib.width - candidate.width) <= 1.5
        && nib.top >= candidate.top - 2 && nib.top <= candidate.top + 40);
    const word = near[0];
    const onWord = near.length > 0;
    arrival.push({ fraction, inked, nib, word, onWord: onWord === true, near: near === true });
    add(`arrival ${String(Math.round(fraction * 100))} % — the pen is on word ${String(inked)}`,
      onWord && near && snap.act?.kind === 'arrival',
      { nib: nib === undefined ? null : { left: nib.left, top: nib.top, width: nib.width }, word });
  }

  /* The unread rule is the plain cite: dotted and quiet — `--ink-3`, never the accent. */
  const unread = await act(cdp, 'arrival', { back: 600 });
  add('arrival — the unread rule is dotted and quiet (`--ink-3`), never the accent',
    unread.act?.kind === 'arrival' && unread.rule?.style === 'dotted'
      && unread.rule?.colour === rgbOf(unread.theme?.ink3)
      && unread.rule?.colour !== rgbOf(unread.theme?.live),
    { rule: unread.rule ?? null, ink3: rgbOf(unread.theme?.ink3), live: rgbOf(unread.theme?.live) });

  const done = await act(cdp, 'arrival', { back: facts.sweepMs + 400 });
  add('arrival past the sweep — the fact happened, nothing is performed',
    done.act === null && (done.theatre === null || (done.theatre.lines === 0 && done.theatre.ends === 0))
      && Number.parseFloat(done.theatre?.nib?.width === undefined || done.theatre?.nib?.width === '' ? '0' : String(done.theatre?.nib?.width)) === 0
      && done.rule.style === 'solid',
    { act: done.act, rule: done.rule.style, lines: done.theatre?.lines ?? 0, nib: done.theatre?.nib?.width });

  /* After the fill — the chain ends on its own frame, and the whole act leaves with it: no line
     nodes, no nib, the shipped cite, and the margin exactly where it stood. (The "past the sweep"
     case above mounts *after* the fact; this one watches the fill actually finish.) */
  const nearEnd = await act(cdp, 'arrival', { back: facts.sweepMs - 900 });
  const penAtMount = nearEnd.theatre?.nib ?? null;
  const marginAtMount = width < 600 ? nearEnd.marks?.stripBox : nearEnd.marks?.noteBox;
  await sleep(1_400);
  const afterFill = await snapshot(cdp);
  const penAfter = afterFill.theatre?.nib ?? null;
  const marginAfter = width < 600 ? afterFill.marks?.stripBox : afterFill.marks?.noteBox;
  add('arrival after the fill — the pen has left, the cite is solid, the margin unchanged',
    afterFill.act === null && (afterFill.theatre?.lines ?? -1) === 0
      && penAfter !== null && Number.parseFloat(penAfter.width === '' ? '1' : penAfter.width) === 0
      && Number.parseFloat(penAfter.opacity === '' ? '1' : penAfter.opacity) === 0
      && afterFill.rule?.style === 'solid' && sameBox(marginAfter, marginAtMount)
      && (marginAfter?.width ?? 0) > 0,
    { act: afterFill.act, lines: afterFill.theatre?.lines ?? 0, pen: penAfter === null ? null : { width: penAfter.width, opacity: penAfter.opacity },
      rule: afterFill.rule?.style, margin: { after: marginAfter, atMount: marginAtMount }, atMount: penAtMount === null ? null : penAtMount.opacity });

  /* The arrival's frame budget, over two seconds of the real sweep. */
  await act(cdp, 'arrival', { back: 0 });
  const fillWrites = await call(cdp, `(async () => {
    const since = performance.now();
    await new Promise((done) => setTimeout(done, 900));
    return window.__theatre.snapshot({ since });
  })()`);
  const sweepWrites = await snapshot(cdp);
  const arrivalStats = sweepWrites.writes.raf;
  add('arrival — p95 frame work ≤ 8 ms', arrivalStats.script.p95 <= 8 && arrivalStats.script.count > 20,
    { script: arrivalStats.script, deltas: arrivalStats.deltas, frames: arrivalStats.rafCount });
  /* The fill's own writes, sampled from the mount: the mount births its nodes, the fill may not
     birth another one, and it writes one clip (and the pen) a frame at most. */
  add('writes — ≤ 1 clip, ≤ 1 transform, ≤ 1 opacity per frame; no node or character written',
    fillWrites.writes.perFrame.maxClip <= 1 && fillWrites.writes.perFrame.maxTransform <= 1
      && fillWrites.writes.perFrame.maxOpacity <= 1 && fillWrites.writes.rafCount > 5
      && fillWrites.writes.mutations.childList === 0 && fillWrites.writes.mutations.characterData === 0,
    { perFrame: fillWrites.writes.perFrame, mutations: fillWrites.writes.mutations, frames: fillWrites.writes.rafCount });

  /* The sentence out of the viewport: solid in the arriving frame, no mark drawn. */
  const away = await act(cdp, 'arrival', { back: 300, scroll: 2600 });
  add('arrival with no visible line — solid at once, no overlay',
    away.act === null && (away.theatre === null || away.theatre.lines === 0)
      && away.rule.style === 'solid' && away.scroll.visible === false,
    { visible: away.scroll.visible, act: away.act, rule: away.rule.style, lines: away.theatre?.lines ?? 0 });
  await call(cdp, 'window.scrollTo(0, 0)');

  /* thinking — the 2 px spine and the stub, and no line rule at all. */
  const thinking = await act(cdp, 'thinking');
  const spineThinking = thinking.theatre?.spine ?? null;
  add('thinking — the spine stands (2 px), the stub on the rule’s end, no line drawn',
    thinking.act?.kind === 'thinking' && spineThinking?.open === 'true'
      && Math.abs((spineThinking?.box?.width ?? 0) - 2) <= 0.5
      && thinking.theatre?.nib?.shape === 'stub' && thinking.theatre?.nib?.opacity === '1'
      && thinking.theatre?.foot === 'false'
      && thinking.theatre?.lines === 0 && thinking.theatre?.tallies.length === 0,
    { spine: spineThinking?.box ?? null, open: spineThinking?.open, nib: thinking.theatre?.nib ?? null,
      foot: thinking.theatre?.foot, lines: thinking.theatre?.lines });

  /* checking — the hand becomes the gate, one tally per gate, the spine withdrawn. */
  const check = await act(cdp, 'checking');
  const gates = check.theatre?.tallies ?? [];
  const gap = gates.length === 2 ? Math.abs((gates[0].box.left ?? 0) - (gates[1].box.left ?? 0)) : 0;
  add('checking — two tallies 4 px apart, inked, the spine gone',
    check.act?.kind === 'checking' && gates.length === 2 && gates.every((gate) => gate.ink === '')
      && Math.abs(gap - 4) <= 0.5 && check.theatre?.spine?.open === 'false'
      && gates.every((gate) => (gate.box.height ?? 0) > 20),
    { gates: gates.map((gate) => ({ left: gate.box.left, height: gate.box.height, ink: gate.ink })), gap, spine: check.theatre?.spine?.open });

  /* writing — main's print on the block; the theatre's spine on it, and no second print. */
  const writing = await act(cdp, 'writing', { back: 250 });
  const printSpine = writing.print?.spine ?? null;
  // While the ink runs, the act's surface **is** the print: the paragraph is `PrintPass`, so the
  // theatre's overlay is not mounted and `data-theatre` is not set — the mark appears when the
  // block is handed back (the check below), exactly as §9.4 puts it.
  add('writing — one print on the block, one caret, and the theatre’s own 2 px spine on it',
    writing.print?.blocks === 1 && writing.print?.carets === 1
      && (writing.print?.beat === 'type' || writing.print?.beat === 'hold')
      && printSpine !== null && printSpine.content !== 'none' && printSpine.width === '2px'
      && printSpine.colour === rgbOf(writing.theme?.live)
      && (writing.theatre?.lines ?? 0) === 0 && (writing.theatre?.tallies.length ?? 0) === 0,
    { act: writing.act, print: writing.print ?? null, lines: writing.theatre?.lines, tallies: writing.theatre?.tallies.length,
      live: rgbOf(writing.theme?.live) });

  /* The hand-off §9.4 promises: the ink ends on its own clock, the print's spine goes with the
     print, and the theatre's own stroke carries the act from there — one mark, never two. */
  await sleep(2_600);
  const handed = await snapshot(cdp);
  add('writing — the ink settles, the print’s spine leaves with it, the theatre’s stroke stays',
    handed.print?.blocks === 0 && handed.act?.kind === 'writing'
      && handed.theatre?.spine?.open === 'true'
      && Math.abs((handed.theatre?.spine?.box?.width ?? 0) - 2) <= 0.5,
    { print: handed.print ?? null, act: handed.act, spine: handed.theatre?.spine ?? null });

  /* §9.5 / BOOK-233 item 1 — a gate’s tally is as tall as the **changed** lines of the write’s
     span, measured on the sentence’s one pass: one short run, never the whole sentence. */
  const tallied = await act(cdp, 'checking');
  const linePx = (tallied.grid.tops[1] ?? 0) - (tallied.grid.tops[0] ?? 0);
  const tallyBox = tallied.theatre?.tallies?.[0]?.box ?? null;
  const sentenceLines = tallied.sentenceGrid.lines;
  add('checking — the tally’s height is the changed lines of the write’s span, not the sentence’s',
    tallyBox !== null && linePx > 0 && sentenceLines > 2
      && tallyBox.height >= linePx + 8 - 0.5 && tallyBox.height <= linePx * 2 + 8 + 0.5
      && tallyBox.height < sentenceLines * linePx + 8 - 0.5,
    { tallyHeight: tallyBox?.height ?? null, linePx, sentenceLines, budget: linePx * 2 + 8 });

  /* BOOK-227 §0 — the margin records what happened to the sentence, and the theatre's own
     overlay never moves it: the boxes are compared with the queue act's own, because "the margin
     is still there" is a measurement, not an opinion. */
  const queue = await act(cdp, 'queue');
  const baseline = queue.marks;
  const sway = await act(cdp, 'arrival', { back: 4_000 });
  const margin = sway.marks;
  const noteIs = width < 600 ? margin?.stripShown === true : margin?.noteShown === true;
  add('margin — the numeral and the note (1440) / the strip (390) stand through the reading',
    margin?.markShown === true && noteIs,
    { width, mark: margin?.markShown, note: margin?.noteShown, strip: margin?.stripShown,
      boxes: { mark: margin?.markBox, note: margin?.noteBox, strip: margin?.stripBox } });
  add('margin — the numeral, the note and the strip stand where the queue act leaves them (≤ 0.5 px)',
    baseline?.markShown === true
      && sameBox(margin?.markBox, baseline?.markBox)
      && (width < 600 || sameBox(margin?.noteBox, baseline?.noteBox))
      // The phone's strip is a fixed sheet: above 1024 it is hidden and its viewport place is not
      // the margin's business.
      && (width >= 600 || sameBox(margin?.stripBox, baseline?.stripBox)),
    { act: { mark: margin?.markBox, note: margin?.noteBox, strip: margin?.stripBox },
      queue: { mark: baseline?.markBox, note: baseline?.noteBox, strip: baseline?.stripBox },
      delta: { mark: { x: round(Number(margin?.markBox?.left ?? 0) - Number(baseline?.markBox?.left ?? 0)), y: round(Number(margin?.markBox?.top ?? 0) - Number(baseline?.markBox?.top ?? 0)) },
        note: { x: round(Number(margin?.noteBox?.left ?? 0) - Number(baseline?.noteBox?.left ?? 0)), y: round(Number(margin?.noteBox?.top ?? 0) - Number(baseline?.noteBox?.top ?? 0)) } } });
  add('theatre — the sentence’s spans and the paragraph’s own grid survive the act',
    (margin?.sentenceSpans ?? 0) >= 1 && margin?.sentenceSpans === (baseline?.sentenceSpans ?? 0)
      && margin?.act === 'arrival' && sameGrid(sway.grid, queue.grid),
    { spans: margin?.sentenceSpans, queueSpans: baseline?.sentenceSpans, act: margin?.act,
      grid: { act: sway.grid.tops, queue: queue.grid.tops } });

  /* queue — stillness: no line, no nib, no tally. */
  add('queue — nothing stands: no line rule, no nib, no tally',
    queue.act?.kind === 'queue' && (queue.theatre?.lines ?? -1) === 0
      && Number(queue.theatre?.nib?.opacity ?? '1') === 0 && (queue.theatre?.tallies.length ?? -1) === 0,
    { act: queue.act?.kind, lines: queue.theatre?.lines, nib: queue.theatre?.nib?.opacity, tallies: queue.theatre?.tallies.length });

  /* The verdict's press becomes the stub: 2 × 6, standing at the rule's end. */
  const verdict = await act(cdp, 'verdict');
  const stub = verdict.theatre?.nib ?? null;
  const lastRight = verdict.paragraph !== null ? verdict.paragraph.left + (verdict.sentenceGrid.rights.at(-1) ?? 0) : null;
  const lastTop = verdict.paragraph !== null ? verdict.paragraph.top + (verdict.sentenceGrid.tops.at(-1) ?? 0) : null;
  add('verdict — the stub stands at the rule’s end (2 × 6, visible)',
    stub !== null && stub.shape === 'stub' && stub.opacity === '1' && stub.width === '2px'
      && stub.box.width === 2 && stub.box.height >= 5 && stub.box.height <= 7
      && stub.box.top > 0 && stub.box.left > 0 && stub.box.top < height && stub.box.left < width
      && lastRight !== null && Math.abs(stub.box.left - (lastRight + 1)) <= 2
      && lastTop !== null && stub.box.top > lastTop - 4 && stub.box.top < lastTop + 40,
    { stub, lastRight, lastTop });

  /* landing — the rule is **ink**, not a node: every line painted at its own full width, at the
     frame before the lift (the sink's 120 ms hold). */
  const landingRule = await act(cdp, 'landing', { freeze: true });
  const landingPainted = landingRule.theatre?.painted ?? [];
  const landingWidths = (landingRule.theatre?.lineBoxes ?? []).map((box) => box.width);
  const landingOpacity = landingRule.theatre?.lineOpacity ?? [];
  add('landing — every line is painted at full width, visible, before the lift',
    landingRule.act?.kind === 'landing' && landingPainted.length >= 1
      && landingPainted.every((painted, index) => Math.abs(painted - (landingWidths[index] ?? 0)) <= 1)
      && landingOpacity.every((opacity) => Number(opacity) > 0.9),
    { painted: landingPainted, widths: landingWidths, opacity: landingOpacity });

  /* landing — the sentence's lines, the note's hairline, and the lift one rAF later. */
  const landing = await act(cdp, 'landing');
  add('landing — the sentence’s lines are drawn and the note’s hairline withdraws',
    landing.act?.kind === 'landing' && (landing.theatre?.lines ?? 0) >= 1
      && landing.theatre?.noteRule !== null && landing.theatre?.noteRule?.withdraw === ''
      && landing.theatre?.lifts.every((lift) => lift === '')
      && Number(landing.theatre?.nib?.opacity ?? '1') === 0,
    { lines: landing.theatre?.lines, noteRule: landing.theatre?.noteRule ?? null,
      lifts: landing.theatre?.lifts ?? null, nib: landing.theatre?.nib?.opacity });

  /* failure, our fault — the rule's end (the 2 × 4 foot) stands under the last word's own edge,
     and the last line's rule carries a paint at that end. */
  const fault = await act(cdp, 'failure-fault');
  const lastClip = (fault.theatre?.clips ?? []).at(-1) ?? null;
  const endBox = fault.theatre?.ruleEndBox ?? null;
  const lastWord = words.at(-1);
  const lastLineBox = (fault.theatre?.lineBoxes ?? []).at(-1);
  // The rule is measured as **painted ink**: every line at its own width but the last, which ends
  // short of its words, and the 2 × 4 foot standing under that end — the edge the clip leaves.
  const faultPainted = fault.theatre?.painted ?? [];
  const faultWidths = (fault.theatre?.lineBoxes ?? []).map((box) => box.width);
  const lastIndex = faultPainted.length - 1;
  const tail = faultPainted[lastIndex] ?? 0;
  const tailWidth = faultWidths[lastIndex] ?? 0;
  const footAtRuleEnd = endBox === null || lastLineBox === undefined ? null : round(endBox.left - (lastLineBox.left + tail));
  add('failure, our fault — the rule is painted, ends short of the last words, and the foot stands under its end',
    fault.act?.kind === 'failed' && fault.act?.cause === 'fault' && fault.theatre?.ruleEnd === true
      && faultPainted.length >= 1
      && faultPainted.slice(0, lastIndex).every((painted, index) => Math.abs(painted - (faultWidths[index] ?? 0)) <= 1)
      && tail >= 0 && tail < tailWidth - 1
      && endBox !== null && lastLineBox !== undefined && lastWord !== undefined
      && endBox.width === 2 && endBox.height === 4
      && footAtRuleEnd !== null && Math.abs(footAtRuleEnd) <= 2
      && endBox.top >= lastLineBox.top && endBox.top <= lastLineBox.top + 40,
    { act: fault.act, lines: fault.theatre?.lines, painted: faultPainted, widths: faultWidths,
      tail, footAtRuleEnd, end: endBox, word: lastWord ?? null, line: lastLineBox ?? null, clip: lastClip });

  /* failure, a verdict — refused: no stub, no gap, no foot. */
  const refused = await act(cdp, 'failure-verdict');
  add('failure, a verdict — refused leaves no stub, no rule-end and no foot',
    refused.act?.kind === 'verdict' && refused.act?.outcome === 'refused'
      && Number(refused.theatre?.nib?.opacity ?? '1') === 0
      && refused.theatre?.ruleEnd === false && refused.theatre?.foot === 'false',
    { act: refused.act, nib: refused.theatre?.nib?.opacity, ruleEnd: refused.theatre?.ruleEnd, foot: refused.theatre?.foot });

  /* The phone's tick is the mark's `::before` bar, which used to be the accent by hand: at 390 the
     acts differed by the rule alone. It takes the mark's own ink now — quiet in queue and in our
     fault, never `--live` (§3: no accent where there is no «now»). */
  // At 390 the tick is the mark's `::before` bar — the one surface that used to hard-code the
  // accent; above 1024 the numeral prints and the same rule is checked on the mark's own ink.
  const barQuiet = width < 600
    ? queue.marks?.bar !== undefined && queue.marks?.bar === queue.marks?.markInk
      && queue.marks?.bar !== rgbOf(queue.theme?.live)
      && fault.marks?.bar !== undefined && fault.marks?.bar === fault.marks?.markInk
      && fault.marks?.bar !== rgbOf(fault.theme?.live)
    : queue.marks?.markInk === rgbOf(queue.theme?.ink3) && fault.marks?.markInk === rgbOf(fault.theme?.ink3);
  add('the phone’s tick follows the act’s ink — quiet in queue and our fault, never the accent',
    barQuiet === true,
    { queue: { bar: queue.marks?.bar, ink: queue.marks?.markInk }, fault: { bar: fault.marks?.bar, ink: fault.marks?.markInk },
      live: rgbOf(queue.theme?.live), ink3: rgbOf(queue.theme?.ink3) });

  /* history off — the paragraph `SentenceRuns` renders when the page is not keyboard-reachable:
     the text has no `.sentence-door` wrapper, and the numeral and the note sit inside the same
     `[data-s]`. The reading must still measure the sentence alone — 57 words, not the margin's. */
  const plainShape = await call(cdp, 'window.__theatre.plain()');
  const plainGeometry = await call(cdp, 'window.__theatre.geometry()');
  const plainArrival = await act(cdp, 'arrival', { back: Math.round(facts.sweepMs * 0.6) });
  const plainRight = (plainArrival.paragraph?.left ?? 0) + (plainArrival.paragraph?.width ?? 0);
  const plainNib = plainArrival.theatre?.nib?.box ?? null;
  add('history off — the run is the sentence’s own text: 57 words, the rule inside the measure',
    plainShape.theatre !== null && plainGeometry !== null
      && plainGeometry.words === facts.words
      && plainGeometry.lines === plainArrival.sentenceGrid.lines
      && plainArrival.theatre?.lines === plainArrival.sentenceGrid.lines
      && plainGeometry.firstLeft !== null && plainGeometry.firstLeft >= 0
      && plainGeometry.lastRight !== null && plainGeometry.lastRight <= (plainArrival.paragraph?.width ?? 0) + 1
      && plainNib !== null && plainNib.left + plainNib.width <= plainRight + 1,
    { words: plainGeometry?.words, lines: plainGeometry?.lines, gridLines: plainArrival.sentenceGrid.lines,
      firstLeft: plainGeometry?.firstLeft, lastRight: plainGeometry?.lastRight, paragraphWidth: plainArrival.paragraph?.width,
      nib: plainNib, plainRight });
  await call(cdp, 'window.__theatre.reset()');

  /* node count — the overlay is the sentence's lines, never its words. */
  const overlayNodes = (await act(cdp, 'arrival', { back: 600 })).theatre?.nodes ?? 0;
  add('node count — the theatre overlay ≤ 19 nodes', overlayNodes > 0 && overlayNodes <= 19, { nodes: overlayNodes });

  /* 9 — reduced motion: the end shape at once, no rAF. */
  await openPage(cdp, origin, width, height, true);
  const stillArrival = await act(cdp, 'arrival', { back: 1_200 });
  add('reduced motion — the arrival is the span mark at once, no rAF',
    stillArrival.theatre !== null && stillArrival.theatre.ends === 2 && stillArrival.theatre.lines > 0
      && stillArrival.writes.rafCount === 0,
    { ends: stillArrival.theatre?.ends, lines: stillArrival.theatre?.lines, raf: stillArrival.writes.rafCount });
  const stillThinking = await act(cdp, 'thinking');
  add('reduced motion — the spine is already whole, and no rAF runs',
    stillThinking.theatre?.spine?.open === 'true' && stillThinking.writes.rafCount === 0,
    { spine: stillThinking.theatre?.spine?.open, raf: stillThinking.writes.rafCount });
  await call(cdp, 'window.__theatre.reset()');

  /* The taste rules, read off the DOM the plates are taken of. */
  const taste = await openPage(cdp, origin, width, height);
  await act(cdp, 'arrival', { back: 800 });
  await sleep(500);
  const audit = (await snapshot(cdp)).style;
  add('taste — two families, the palette only, no shadow, no uppercase, no infinite animation',
    audit.families.length <= 2 && audit.colours.length === 0 && audit.shadows.length === 0
      && audit.shout.length === 0
      && audit.animations.every((animation) => animation.kind === 'CSSTransition' && (animation.iterations ?? 1) !== Number.POSITIVE_INFINITY),
    { families: audit.families.length, colours: audit.colours, shadows: audit.shadows, shout: audit.shout, animations: audit.animations.length });
  // The head is the page's own (`HeadLine`): it prints one word while a frame gives it one, and
  // no act of the theatre writes to it. The same reading twice is the same word.
  const headOne = (await act(cdp, 'arrival', { back: 2_000 })).head;
  const headTwo = (await act(cdp, 'arrival', { back: 2_000 })).head;
  add('the head prints the page’s own word during a reading, and no act feeds it',
    typeof headOne === 'string' && headOne.trim().length > 0 && headOne === headTwo,
    { head: headOne, second: headTwo, atLoad: head });

  return {
    width,
    height,
    head,
    facts,
    arrivalStats,
    arrival,
    checks: results,
  };
}
