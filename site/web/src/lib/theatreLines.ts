/**
 * BOOK-227 / BOOK-DOC-86 §9.13 — the sentence's geometry, measured once.
 *
 * The arrival's fill needs three things the paragraph does not carry: one box per line, the rules'
 * y (the baseline's own offset inside a line), and one box per word. All of it is read **once**,
 * in one batch with no writes between the reads: a `Range` is not a node, so measuring never
 * changes the text it measures. The renderer (`SentenceTheatre`) only paints from this answer.
 *
 * The types are exported because they are the renderer's own vocabulary: a `Line` is a line box,
 * a `Word` knows which line it stands on, and a `LineRun` is one line's share of the fill.
 */

import { wordsOf } from './theatre.ts';

export type Line = { top: number; left: number; width: number; visible: boolean };
/**
 * A word on the page. A word that is hyphenated at the line's end owns two fragments — the head on
 * the line it starts on and the tail on the next — so `left/top/width/line` are the head (the pen's
 * press) and `right/endLine` are the true end (the rule's end, the stub). A union box would read as
 * one wide word on the wrong line, and the mark would stand at the line above the last one.
 */
export type Word = { left: number; top: number; width: number; line: number; right: number; endLine: number };
export type Geometry = {
  lines: Line[];
  words: Word[];
  linePx: number;
  ruleTops: number[];
  /** The sentence's own run as it stands on the page — the text the words' offsets count in. */
  text: string;
};
/** One line's share of the fill: its box, its words and where they start. */
export type LineRun = { left: number; width: number; words: Word[]; first: number; visible: boolean };

/** A text node of the sentence's own run, with its start offset and how much of it belongs. */
type RunNode = { node: Text; start: number; length: number };

/** Every text node under `root`, with its start offset. */
function textNodesOf(root: Element): Array<{ node: Text; start: number }> {
  const out: Array<{ node: Text; start: number }> = [];
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  let offset = 0;
  let current = walker.nextNode();
  while (current !== null) {
    const text = current as Text;
    out.push({ node: text, start: offset });
    offset += text.length;
    current = walker.nextNode();
  }
  return out;
}

/**
 * The sentence's **own run**, never a wrapper and never its marks.
 *
 * The text of a sentence lives in an inner span whose class exists only while the paragraph is
 * keyboard-reachable (`.sentence-door` under `history`); with history off the span is unclassed
 * and the filing's numeral and note are its siblings. Measuring "the first wrapper, else the whole
 * `[data-s]`" therefore measured the margin — `№A7K` and the note's words became the pen's words,
 * and the fill, the stub and the rule-end landed outside the measure. The run is cut by the
 * sentence's own `data-quote`: everything after it in the same span is a mark.
 */
function runOf(sentence: HTMLElement): { nodes: RunNode[]; text: string } {
  const wrapper = sentence.querySelector<HTMLElement>(':scope > .sentence-door');
  const all = textNodesOf(wrapper ?? sentence);
  const total = all.reduce((sum, entry) => sum + entry.node.length, 0);
  const quote = sentence.dataset.quote ?? '';
  const limit = quote.length > 0 && quote.length <= total ? quote.length : total;
  const nodes: RunNode[] = [];
  for (const entry of all) {
    if (entry.start >= limit) break;
    nodes.push({ node: entry.node, start: entry.start, length: Math.min(entry.node.length, limit - entry.start) });
  }
  return { nodes, text: nodes.map((entry) => entry.node.data.slice(0, entry.length)).join('') };
}

/** The text node and the offset inside it for an offset of the sentence's run. */
function pointAt(nodes: RunNode[], offset: number): { node: Text; offset: number } | null {
  for (const entry of nodes) {
    if (offset <= entry.start + entry.length) {
      return { node: entry.node, offset: Math.max(0, Math.min(entry.length, offset - entry.start)) };
    }
  }
  const last = nodes[nodes.length - 1];
  return last === undefined ? null : { node: last.node, offset: last.length };
}

/** §9.13 — measured once, before the first frame: a `Range` for the lines, one per word, one
 * probe for the baseline. */
export function measure(host: HTMLElement | null): Geometry | null {
  if (host === null) return null;
  const sentence = host.closest<HTMLElement>('[data-s]');
  const origin = host.offsetParent as HTMLElement | null;
  if (sentence === null || origin === null) return null;
  const { nodes, text } = runOf(sentence);
  const firstNode = nodes[0];
  const lastNode = nodes[nodes.length - 1];
  if (firstNode === undefined || lastNode === undefined) return null;
  const originBox = origin.getBoundingClientRect();
  const linePx = Number.parseFloat(getComputedStyle(origin).lineHeight);
  if (!Number.isFinite(linePx) || linePx <= 0) return null;

  // One range over the run — never `selectNodeContents`, which would take the marks with it.
  const whole = sentence.ownerDocument.createRange();
  whole.setStart(firstNode.node, 0);
  whole.setEnd(lastNode.node, lastNode.length);
  const fragments = [...whole.getClientRects()].filter((rect) => rect.width > 0);
  if (fragments.length === 0) return null;
  const viewport = typeof window === 'undefined' ? 0 : window.innerHeight;
  // A **line**, not a fragment. Chrome may hand back several rects for one line box (a hyphenated
  // word, an inline boundary), and each fragment counted as a line shifts every rule and every
  // word's line below it by one — the fill would then ink the wrong line on a phone.
  const byTop = new Map<number, { top: number; left: number; right: number; bottom: number }>();
  for (const rect of fragments) {
    const top = Math.round((rect.top - originBox.top) * 100) / 100;
    const left = rect.left - originBox.left;
    const right = rect.right - originBox.left;
    const held = byTop.get(top);
    byTop.set(
      top,
      held === undefined
        ? { top, left, right, bottom: rect.bottom }
        : { top, left: Math.min(held.left, left), right: Math.max(held.right, right), bottom: Math.max(held.bottom, rect.bottom) },
    );
  }
  const ordered = [...byTop.values()].sort((left, right) => left.top - right.top);
  const lines: Line[] = ordered.map((line) => ({
    top: line.top,
    left: line.left,
    width: Math.max(line.right - line.left, 1),
    visible: viewport === 0 || (line.bottom > 0 && line.top + originBox.top < viewport),
  }));

  // The baseline: an empty inline-block sits on it, and the line it joins is the last one.
  const probe = sentence.ownerDocument.createElement('span');
  probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  sentence.appendChild(probe);
  const probeBox = probe.getBoundingClientRect();
  probe.remove();
  // The baseline's own offset inside a line, from the probe's bottom and the last line's top.
  const baseline = probeBox.bottom - originBox.top - (ordered[ordered.length - 1]?.top ?? 0);
  const ruleTops = lines.map((line) => line.top + baseline + 4);

  const words: Word[] = [];
  const firstTop = lines[0]?.top ?? 0;
  for (const word of wordsOf(text)) {
    const from = pointAt(nodes, word.start);
    const to = pointAt(nodes, word.end);
    if (from === null || to === null) continue;
    const range = sentence.ownerDocument.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    // One `Range`, one word, one or two fragments: a hyphenated word ends on the next line.
    const fragments = [...range.getClientRects()].filter((rect) => rect.width > 0);
    const first = fragments[0] ?? range.getBoundingClientRect();
    const last = fragments[fragments.length - 1] ?? first;
    if (first.width <= 0) continue;
    const at = (rect: DOMRect): number =>
      Math.max(0, Math.min(lines.length - 1, Math.round((rect.top - originBox.top - firstTop) / linePx)));
    words.push({
      left: first.left - originBox.left,
      top: first.top - originBox.top,
      width: first.width,
      line: at(first),
      right: last.right - originBox.left,
      endLine: at(last),
    });
  }
  if (words.length === 0) return null;
  return { lines, words, linePx, ruleTops, text };
}
/** The visible run, line by line: the pen walks words on lines the reader can see. */
export function arrivalRuns(geometry: Geometry): { runs: LineRun[]; visible: Word[] } {
  const visible = geometry.words.filter((word) => geometry.lines[word.line]?.visible ?? false);
  const order = new Map<Word, number>(visible.map((word, index) => [word, index]));
  const runs: LineRun[] = geometry.lines.map((line, index) => {
    const here = visible.filter((word) => word.line === index);
    return {
      left: line.left,
      width: line.width,
      words: geometry.words.filter((word) => word.line === index),
      first: here.length === 0 ? 0 : (order.get(here[0] as Word) ?? 0),
      visible: line.visible,
    };
  });
  return { runs, visible };
}

/**
 * BOOK-227 §9.5 / BOOK-233 item 1 — **the changed lines**, from the write's own span and the
 * sentence's one measurement.
 *
 * A gate's tally is as tall as the lines the write changed (§9.5), and the page can count them
 * without a second layout pass: the write's `span` names the run it wrote (`before`/`after`),
 * the run's offsets are found in the sentence's text, and the words the run covers are already
 * measured on their lines. The answer is the number of **distinct lines** those words stand on;
 * `null` when the run cannot be placed (a deletion whose words are gone, a truncated side, a run
 * outside this sentence) and the caller then keeps the sentence's own line count.
 */
export function changedLines(words: readonly Word[], text: string, run: string | null): number | null {
  const needle = run === null ? '' : run.trim();
  if (needle.length === 0 || text.length === 0 || words.length === 0) return null;
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const end = at + needle.length;
  const offsets = wordsOf(text);
  const lines = new Set<number>();
  words.forEach((word, index) => {
    const offsetsOf = offsets[index];
    if (offsetsOf === undefined || offsetsOf.end <= at || offsetsOf.start >= end) return;
    lines.add(word.line);
    lines.add(word.endLine);
  });
  return lines.size === 0 ? null : lines.size;
}
