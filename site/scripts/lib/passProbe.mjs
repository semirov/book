/**
 * lib/passProbe.mjs — what the page shows a live pass, read without a test double.
 *
 * The probe runs inside the page: it finds the block by a locator (the paragraph's unchanged
 * tail), reads the pass's beat, the ink still pending, both carets' computed opacity and place,
 * the running head's line, and the prose's **line boxes** — every distinct `top` from
 * `Range.getClientRects()`, relative to the block's own top, rounded to a hundredth of a pixel.
 * That is the number the no-reflow claim is made of: the block is the same block, so a line that
 * did not move has the same offset from it at mount, mid-ink and settle.
 */

const segmenter = new Intl.Segmenter('ru', { granularity: 'grapheme' });

/** Grapheme clusters — the renderer's own unit (`lib/reveal.ts`), never code units. */
export const graphemes = (text) => Array.from(segmenter.segment(text), (part) => part.segment);

/** `lib/passDiff.ts`'s minimal changed span, recomputed here to name what the page paints. */
export function spanOf(before, after) {
  const old = graphemes(before);
  const next = graphemes(after);
  const shortest = Math.min(old.length, next.length);
  let prefix = 0;
  while (prefix < shortest && old[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shortest - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  const removed = old.slice(prefix, old.length - suffix).join('');
  const added = next.slice(prefix, next.length - suffix).join('');
  return {
    before: removed,
    after: added,
    kind: removed === '' ? 'insertion' : added === '' ? 'deletion' : 'replacement',
    offset: prefix,
  };
}

/** The in-page function. `locator` survives the edit (the paragraph's tail); `hideDoor` hides the
 * inline provenance door (`button.prov`) so its line-box effect can be measured, not guessed. */
export const PROBE_SOURCE = String.raw`
(locator, hideDoor) => {
  const node = Array.from(document.querySelectorAll('p[data-block-id]'))
    .find((item) => (item.textContent || '').includes(locator)) || null;
  if (node === null) return { found: false };
  const door = node.querySelector('button.prov');
  if (door !== null) door.style.display = hideDoor === true ? 'none' : '';
  const box = node.getBoundingClientRect();
  const skip = (element) =>
    element !== null &&
    element.closest('button, .visually-hidden, .caret-read, .caret-write, .revising-label, .filing-mark') !== null;
  const tops = [];
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  while (walker.nextNode()) {
    const text = walker.currentNode;
    if (skip(text.parentElement) || (text.nodeValue || '').trim() === '') continue;
    range.selectNodeContents(text);
    for (const rect of range.getClientRects()) {
      if (rect.width <= 0.5 || rect.height <= 0.5) continue;
      tops.push(Math.round((rect.top - box.top) * 100) / 100);
    }
  }
  const unique = Array.from(new Set(tops)).sort((left, right) => left - right);
  const caret = (selector) => {
    const element = node.querySelector(selector);
    if (element === null) return { count: 0, opacity: null, transform: null, left: null, top: null, visible: false };
    const opacity = Number(getComputedStyle(element).opacity);
    const rect = element.getBoundingClientRect();
    return {
      count: 1,
      opacity: Number.isFinite(opacity) ? opacity : null,
      transform: element.style.transform || null,
      left: Math.round(rect.left * 100) / 100,
      top: Math.round(rect.top * 100) / 100,
      visible:
        Number.isFinite(opacity) &&
        opacity > 0.05 &&
        rect.left >= -2 &&
        rect.left <= window.innerWidth + 2 &&
        rect.top >= -2 &&
        rect.top <= window.innerHeight + 2,
    };
  };
  const clone = node.cloneNode(true);
  clone.querySelectorAll('button, .visually-hidden, .caret-read, .caret-write, .revising-label')
    .forEach((element) => element.remove());
  const head = document.querySelector('.head-line');
  const strip = document.querySelector('.pass-strip');
  return {
    found: true,
    blockId: node.getAttribute('data-block-id'),
    pass: node.classList.contains('p-pass'),
    beat: node.getAttribute('data-pass'),
    pending: node.querySelectorAll('.pg.is-pending').length,
    clusters: node.querySelectorAll('.pg').length,
    animations: node.getAnimations({ subtree: true }).filter((item) => item.playState === 'running').length,
    carets: { read: caret('.caret-read'), write: caret('.caret-write') },
    lines: { count: unique.length, tops: unique },
    door: door === null ? null : {
      height: Math.round(door.getBoundingClientRect().height * 100) / 100,
      verticalAlign: getComputedStyle(door).verticalAlign,
      display: getComputedStyle(door).display,
    },
    rect: { top: Math.round(box.top * 100) / 100, height: Math.round(box.height * 100) / 100 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    head: head === null ? null : (head.textContent || '').trim(),
    strip: strip === null ? null : (strip.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    prose: (clone.textContent || '').replace(/\s+/g, ' ').trim(),
  };
}`;

/** One probe call: the page's state at this instant (`hideDoor` for the door experiment). */
export async function measure(cdp, locator, hideDoor = false) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(${PROBE_SOURCE})(${JSON.stringify(locator)}, ${hideDoor === true})`,
    returnByValue: true,
  });
  if (result.exceptionDetails !== undefined) {
    throw new Error(`the probe threw: ${result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result.value;
}

/**
 * Two line grids compared: the count and every line's top, to a hundredth of a pixel. A line the
 * other grid does not have is a difference, not a skipped row, so a shortened paragraph cannot
 * look equal.
 */
export function compareLines(left, right) {
  const count = Math.max(left.count, right.count);
  const delta = [];
  let max = 0;
  for (let index = 0; index < count; index += 1) {
    const a = left.tops[index];
    const b = right.tops[index];
    if (a === undefined || b === undefined) {
      delta.push(null);
      continue;
    }
    // Rounded first, so a float tail (0.010000000000001) is the hundredth it claims to be.
    const spread = Math.round(Math.abs(a - b) * 100) / 100;
    max = Math.max(max, spread);
    delta.push(spread);
  }
  return {
    same: left.count === right.count && max <= 0.01,
    count: { left: left.count, right: right.count },
    maxDeltaPx: Math.round(max * 100) / 100,
    deltaPx: delta,
  };
}

/** The paragraph as it is, and as it is with its inline provenance door out of the line box. */
export async function measureDoorEffect(cdp, locator) {
  const shown = await measure(cdp, locator, false);
  if (shown.found !== true || shown.door === null) return { door: false, shown, hidden: shown };
  const hidden = await measure(cdp, locator, true);
  await measure(cdp, locator, false);
  return { door: true, shown, hidden };
}

/** Poll the page until `predicate(state)` holds, or fail with the last state. */
export async function waitForState(cdp, locator, predicate, { timeoutMs, everyMs = 20, what }) {
  const started = Date.now();
  let state = null;
  for (;;) {
    state = await measure(cdp, locator);
    if (predicate(state)) return state;
    if (Date.now() - started > timeoutMs) throw new Error(`${what} (last state: ${JSON.stringify(state).slice(0, 300)})`);
    await new Promise((resolveWait) => setTimeout(resolveWait, everyMs));
  }
}
