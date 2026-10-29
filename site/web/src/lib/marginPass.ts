/**
 * BOOK-90 — the page-wide placement pass of the margin.
 *
 * The margin is a **ledger**, not a set of balloons: notes are read top to bottom, each one
 * never above the line it belongs to and never on top of the one before it. One pass per
 * page, over every `[data-margin-item]` in document order (chapter by chapter, paragraph by
 * paragraph, line by line) — a per-chapter pass would let the last note of one chapter meet
 * the first note of the next.
 *
 * `placeMargin` is pure: it takes anchors and heights in **one** coordinate space (viewport
 * y is what the DOM gives us) and returns a top for every item plus the residual the page
 * must grow to hold the last one. The DOM runner measures and writes; it never invents a
 * number. Heights are always measured: a note is 95.8 / 116.8 / 134.3 px depending on its own
 * text, and a hard-coded height would be a lie on the second note.
 *
 * BOOK-218 — the mark at a sentence is an item too (`data-margin-item="mark"`): the numeral
 * used to be positioned by its own component, which is how it ended up on the prose line and
 * over the note above it. One ledger for the whole channel, and one kind-aware anchor: a note
 * hangs from the line's top, a mark is centred on it.
 */

export type MarginAnchor = {
  /** The top of the anchored sentence's first layout box, in the pass's coordinate space. */
  anchorTop: number;
  /** The measured height of the object; 0 for an item that is not laid out (hidden phone). */
  height: number;
  /**
   * BOOK-218 — the **column** the item stands in. Marks and notes are different x-columns, so
   * they advance different cursors: a note never pushes a mark and a mark never pushes a note.
   * Absent is a note, which is what every item was before the mark joined the ledger.
   */
  kind?: MarginKind;
};

/**
 * BOOK-218 — how an item ties to its line. A **note** hangs from the top of the line it belongs
 * to (its hairline is the tie); a **mark** is centred on that line, so its 44 px target keeps
 * the numeral where the design puts it. Both are anchors of the same ledger.
 */
export type MarginKind = 'note' | 'mark';

/** The top an item's box takes for the line it is anchored to. */
export function anchorTopFor(
  kind: MarginKind,
  lineTop: number,
  lineHeight: number,
  height: number,
): number {
  if (kind !== 'mark') return lineTop;
  // A line height the browser has not resolved (`normal`, a font still swapping) is no line
  // height: the mark then starts at the line rather than guessing where its centre is.
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return lineTop;
  return lineTop + lineHeight / 2 - height / 2;
}

export type MarginPlacement = {
  tops: number[];
  /** How far the last object reaches past the flow's bottom: the tail's height. */
  tail: number;
};

/**
 * `max(anchorTop, cursor)`, step between objects, never a dropped or reordered item.
 *
 * BOOK-218 — **one cursor per column** (`kind`): the mark stands in its own 40 px gutter and
 * the note beyond it, so the two are independent vertically. One shared cursor booked the same
 * line twice: a mark 46 px wide of the prose pushed the note of its own sentence down the
 * margin, and a note pushed the next mark. Each column keeps its own `top + height + step`,
 * and the tail is the deepest bottom of both.
 */
export function placeMargin(
  items: readonly MarginAnchor[],
  step: number,
  flowBottom: number,
): MarginPlacement {
  const tops: number[] = [];
  const cursors: Record<MarginKind, number> = {
    note: Number.NEGATIVE_INFINITY,
    mark: Number.NEGATIVE_INFINITY,
  };
  let bottom = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const kind = item.kind ?? 'note';
    // A zero-height item is not laid out (the phone hides the margin): it keeps its anchor
    // and consumes no room, so the next visible object still starts from the cursor.
    if (item.height <= 0) {
      tops.push(item.anchorTop);
      continue;
    }
    const top = Math.max(item.anchorTop, cursors[kind]);
    tops.push(top);
    bottom = Math.max(bottom, top + item.height);
    cursors[kind] = top + item.height + step;
  }
  return { tops, tail: tops.length === 0 ? 0 : Math.max(0, bottom - flowBottom) };
}

/** The item attribute; the note, the sentence's block and the mark are the kinds of item. */
const MARGIN_ITEM = 'data-margin-item';
const MARGIN_TAIL = 'data-margin-tail';
/** The least air the design leaves between the note's right edge and the viewport (§7). */
const VIEWPORT_AIR = 8;
/** The clear space between the measure and the first margin object (`--mark-air`). */
export const MARK_AIR = 16;
/** The mark's own target: the numeral's room, not the gap (`--mark-hit`). */
export const MARK_HIT = 40;
/** `--note-gap`: where the note starts, right of the prose — the air plus the mark's target. */
export const NOTE_GAP = MARK_AIR + MARK_HIT;
/** `--note-min`: under this width the channel does not hold a note, it holds a strip. */
export const NOTE_MIN = 120;

/**
 * BOOK-DOC-47 §7 — may this paragraph carry a margin note at all?
 *
 * The channel is measured from the paragraph's own right edge: `right + gap + width + air`
 * must stay inside the viewport, or the note would be clipped by `body { overflow-x: hidden }`.
 * A width of 0 means the channel does not hold a note (see `noteWidth`), and a zero-width note
 * is not a margin: it is the strip. The decision is per paragraph, not per viewport: the
 * one-column frame widens the page while the prose keeps its measure, and a paragraph that
 * grows past this bound is a strip, not a margin. Pure, so the three widths can be asserted
 * without a browser.
 */
export function marginFits(
  paragraphRight: number,
  viewport: number,
  gap: number = NOTE_GAP,
  width = 188,
  air: number = VIEWPORT_AIR,
): boolean {
  if (width <= 0) return false;
  return paragraphRight + gap + width + air <= viewport;
}

/**
 * BOOK-91 — the note's used width: `--note-w` (188) while the centred column leaves room,
 * otherwise the channel itself, minus the gap (16 px of air + the mark's 40 px target) and the
 * 8 px of air before the viewport's edge. `marginalia.css` states the same expression as
 * `--note-fit`; the pass measures what the browser paints, so at 1024 (a 640 px column) the
 * note is 128 wide and the paragraph keeps its margin instead of being demoted to a strip for a
 * note that would no longer be clipped.
 *
 * Below `--note-min` (120) the channel is not a margin: the function answers **0**, which
 * `marginFits` reads as "does not fit". The floor is never forced into a width — a 91 px note
 * at 900 would be narrower than the object it holds, and the strip is the honest answer there.
 */
export function noteWidth(
  viewport: number,
  measure: number,
  gap: number = NOTE_GAP,
  noteW = 188,
  air: number = VIEWPORT_AIR,
  min: number = NOTE_MIN,
): number {
  const channel = (viewport - measure) / 2 - gap - air;
  return channel < min ? 0 : Math.min(noteW, channel);
}

/** A token's px value from the root, with the design's number as the last resort. */
function tokenPx(doc: Document, name: string, fallback: number): number {
  if (typeof getComputedStyle === 'undefined') return fallback;
  // The sheets are px by contract — the guard's check 8 refuses a `rem` — so the specified
  // number is the used one. A root-relative unit would need the reader's root size, which this
  // pass never reads: that is exactly the dependency BOOK-170 removed from the column.
  const value = Number.parseFloat(getComputedStyle(doc.documentElement).getPropertyValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

type Item = { element: HTMLElement; anchorTop: number; height: number; originTop: number; kind: MarginKind };

/** The kind an element declares; anything that is not a mark hangs from its line's top. */
function kindOf(element: HTMLElement): MarginKind {
  return element.dataset.marginItem === 'mark' ? 'mark' : 'note';
}

/**
 * BOOK-208 — the gap the pass measures with: `--mark-air` + `--mark-hit`, both plain px.
 *
 * The sheet states `--note-gap: calc(var(--mark-air) + var(--mark-hit))`, and a custom
 * property's computed value is an **unevaluated token stream**: `getPropertyValue('--note-gap')`
 * answers the `calc(…)` text, so `Number.parseFloat` on it is `NaN` and the pass silently used
 * the fallback — the sheet was never read, and "the pass and the sheet agree" was a claim with
 * no measurement behind it. Reading the two px tokens the `calc` is made of is the same sum the
 * browser paints; the design's own numbers are the last resort only.
 */
export function noteGapFrom(doc: Document): number {
  return tokenPx(doc, '--mark-air', MARK_AIR) + tokenPx(doc, '--mark-hit', MARK_HIT);
}

/** Measure every item in document order; a fixed object (the phone sheet) is not an item. */
function measure(doc: Document): Item[] {
  const out: Item[] = [];
  for (const element of doc.querySelectorAll<HTMLElement>(`[${MARGIN_ITEM}]`)) {
    const positioned = typeof getComputedStyle === 'undefined' ? '' : getComputedStyle(element).position;
    // The phone sheet is `position: fixed`: it is not an item of the pass, and a `top` left
    // from the channel placement must not survive the breakpoint.
    if (positioned === 'fixed') {
      element.style.top = '';
      continue;
    }
    // BOOK-128 comment #3815 — a reader block in flow (the phone's body under the strip, the
    // chronicle's) wears the same attribute and is not an item either: it has no channel to be
    // placed in, and a `top` written here would lift it out of the paragraph it belongs to.
    if (positioned === 'static') continue;
    if (element.offsetParent === null) continue; // not laid out: the margin is not shown
    const box = element.getBoundingClientRect();
    const anchor = element.parentElement;
    const lineTop = anchor === null ? box.top : anchor.getBoundingClientRect().top;
    // A mark is centred on the line it belongs to; a note hangs from its top (BOOK-218).
    const lineHeight =
      anchor === null || typeof getComputedStyle === 'undefined'
        ? Number.NaN
        : Number.parseFloat(getComputedStyle(anchor).lineHeight);
    const anchorTop = anchorTopFor(kindOf(element), lineTop, lineHeight, box.height);
    // The paragraph's own top, read now: every read in the pass happens before any write, so
    // the loop never thrashes layout, and `top` is written in the paragraph's coordinate space.
    const originTop = (element.offsetParent as HTMLElement | null)?.getBoundingClientRect().top ?? 0;
    out.push({ element, anchorTop, height: box.height, originTop, kind: kindOf(element) });
  }
  return out;
}

/**
 * One page-wide pass. Anchors are recomputed from the DOM on every run: opening the seam
 * parts the paragraph and moves every line below the tap, so a cached top would point at the
 * wrong line. Positions are written through CSSOM (no `style` attribute in the markup).
 */
export function runMarginPass(doc: Document = document): MarginPlacement {
  const tail = doc.querySelector<HTMLElement>(`[${MARGIN_TAIL}]`);
  const all = [...doc.querySelectorAll<HTMLElement>(`[${MARGIN_ITEM}]`)];
  if (all.length === 0) {
    // Nothing in the margin: reset the tail without forcing a layout for a rect nobody needs.
    if (tail !== null) tail.style.height = '0px';
    return { tops: [], tail: 0 };
  }
  // The measured guard: a paragraph whose channel does not fit the viewport is a strip. The
  // attribute is written before the heights are measured, so a hidden note takes no room.
  // The guard compares against the viewport the design proved against (innerWidth), not the
  // layout width minus a classic scrollbar: at 1024 the narrowed note ends at 1024 of 1024.
  const viewport = doc.defaultView?.innerWidth ?? doc.documentElement.clientWidth;
  const gap = noteGapFrom(doc);
  const noteW = tokenPx(doc, '--note-w', 188);
  const min = tokenPx(doc, '--note-min', NOTE_MIN);
  const width = noteWidth(viewport, tokenPx(doc, '--measure', 640), gap, noteW, VIEWPORT_AIR, min);
  const paragraphs = new Set<HTMLElement>();
  for (const element of all) {
    const paragraph = element.closest<HTMLElement>('.p');
    if (paragraph !== null) paragraphs.add(paragraph);
  }
  for (const paragraph of paragraphs) {
    paragraph.dataset.margin = marginFits(paragraph.getBoundingClientRect().right, viewport, gap, width)
      ? 'margin'
      : 'strip';
  }
  const items = measure(doc);
  if (items.length === 0) {
    // Everything in this pass is hidden (a strip paragraph, the phone): only the tail resets.
    if (tail !== null) tail.style.height = '0px';
    return { tops: [], tail: 0 };
  }
  // The tail sits after the colophon: while it holds no height, its top is the flow's bottom.
  const flowBottom = tail === null ? doc.documentElement.scrollHeight : tail.getBoundingClientRect().top;
  const placed = placeMargin(items, tokenPx(doc, '--note-step', 12), flowBottom);
  items.forEach((item, index) => {
    // The pass works in one viewport space; `top` is measured against the paragraph's padding
    // box (the item's positioned ancestor), so the paragraph's own top is subtracted once.
    item.element.style.top = `${(placed.tops[index] ?? item.anchorTop) - item.originTop}px`;
    item.element.dataset.placed = 'true';
  });
  if (tail !== null) tail.style.height = `${Math.round(placed.tail)}px`;
  return placed;
}

/** One pass per commit: several notes may mount in the same layout pass, so runs coalesce. */
let queued = false;

/**
 * Place once per frame, before paint. Every item that mounts in a commit asks for a pass; the
 * first ask queues a microtask and the rest are folded into it, so the page-wide pass runs
 * once however many notes arrived (a microtask drains before the browser paints).
 */
export function scheduleMarginPass(doc: Document = document): void {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    runMarginPass(doc);
  });
}

/** rAF-debounced resize: one pass per frame, never one per resize event. */
function debounceMarginPass(doc: Document = document): () => void {
  let frame = 0;
  return () => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      runMarginPass(doc);
    });
  };
}

/**
 * The page keeps one margin engine, however many notes subscribe: resize (rAF-debounced) and
 * `document.fonts.ready` (PT Serif is `font-display: swap`; a first pass in the fallback face
 * measures the wrong line). Subscribing runs one pass immediately — a note that mounted
 * before paint is placed before paint.
 */
let listeners = 0;
let detach: (() => void) | null = null;

export function attachMarginPass(doc: Document = document): () => void {
  listeners += 1;
  if (detach === null) {
    const onResize = debounceMarginPass(doc);
    window.addEventListener('resize', onResize);
    void doc.fonts?.ready.then(() => runMarginPass(doc));
    detach = () => window.removeEventListener('resize', onResize);
  }
  scheduleMarginPass(doc);
  return () => {
    listeners -= 1;
    if (listeners > 0 || detach === null) return;
    detach();
    detach = null;
  };
}

