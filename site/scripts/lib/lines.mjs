/**
 * scripts/lib/lines.mjs — the one-line rule's walker and its grouping (BOOK-128 #3900 §2).
 *
 * Two halves, deliberately in one module with no DOM access of its own:
 *
 *   - `COLLECT_SEGMENTS` is a self-contained expression evaluated **in the page**. It walks
 *     every text node a reader can see, cuts a node that spans several lines into the client
 *     rects the browser itself measured, and answers each piece with the computed
 *     `font-family`/`font-size` of the element that paints it, its rect, and every ancestor's
 *     own box.
 *   - `groupLines` is pure: it takes the segments and decides which of them share one line,
 *     in Node, where it can be reasoned about and changed without touching a browser.
 *
 * A **line** here is the design's own meaning (the owner's rule, 2026-10-28: one line = one
 * typeface + one size): segments share a line when their boxes overlap, sit in one baseline
 * band, share an ancestor deeper than the page, and stand in the same positioning context (a
 * fixed card over the prose is another surface, even when the two land on the same y). Sizes
 * and faces are read, never assumed: no selector is allowed or denied by name, and the report
 * is the data.
 */

/** How far apart two centres may be, beyond half the taller box, and still share a line. */
export const BOTTOM_TOLERANCE = 2;
/** How much larger one size may be than another on one line before the line is mixed. */
export const SIZE_TOLERANCE = 0.5;

/**
 * The in-page walker. Kept as a string (it runs in the browser, not in Node), so it must not
 * contain a template interpolation of its own.
 */
export const COLLECT_SEGMENTS = `(() => {
  const GLYPH = /^[✕×⋯▸■]$/u;
  // Not painted text: a screen-reader-only line, a live region's off-screen announcement, a
  // template, or anything the author hid. The seam's own announcement is 1 px clipped text.
  const SKIP = '.sr-only, .visually-hidden, .seam-announce, [data-harness], [hidden], script, style, noscript, template';

  const segments = [];

  function selectorOf(el) {
    let part = el.tagName.toLowerCase();
    if (el.id !== '') return part + '#' + el.id;
    if (el.dataset !== undefined && el.dataset.line !== undefined) part += '[data-line="' + el.dataset.line + '"]';
    else {
      const classes = [...el.classList].filter((name) => !name.startsWith('ym-')).slice(0, 2);
      if (classes.length > 0) part += '.' + classes.join('.');
    }
    return part;
  }

  // Every ancestor with its own box: the grouping in Node decides which shared ancestor is a
  // row by geometry, so the walk does not have to guess what an element "is".
  function chainOf(el) {
    const chain = [];
    let node = el;
    while (node !== null && node.nodeType === 1 && node !== document.documentElement) {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      chain.unshift({
        sel: selectorOf(node),
        top: box.top + window.scrollY,
        bottom: box.bottom + window.scrollY,
        positioned: style.position !== 'static',
        clip: style.overflowY !== 'visible' || style.overflowX !== 'visible',
      });
      node = node.parentElement;
    }
    return chain;
  }

  // Two segments can only share a line inside one positioning context: a fixed card over the
  // prose is a different surface even when the two happen to land on the same y.
  function contextOf(chain) {
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      if (chain[index].positioned) return chain[index].sel + '@' + String(Math.round(chain[index].top));
    }
    return 'body';
  }

  function painted(el) {
    if (el.closest(SKIP) !== null) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({
        checkOpacity: false,
        checkVisibilityCSS: true,
        opacityProperty: false,
        visibilityProperty: true,
      });
    }
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue === null ? '' : node.nodeValue;
    const trimmed = text.trim();
    // Whitespace paints nothing; a lone ✕ / × / ⋯ / ▸ / ■ is a mark, not words.
    if (trimmed === '' || GLYPH.test(trimmed)) continue;
    const el = node.parentElement;
    if (el === null || !painted(el)) continue;
    range.selectNodeContents(node);
    const style = getComputedStyle(el);
    const chain = chainOf(el);
    // A rect cut away by a clipping ancestor (a clamped margin note, a closed record) is not
    // painted text: it is measured here or it is not read by anyone.
    const cut = (rect) => {
      const top = rect.top + window.scrollY;
      const bottom = rect.bottom + window.scrollY;
      return chain.some((entry) => entry.clip && (bottom > entry.bottom + 0.5 || top < entry.top - 0.5));
    };
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0 && !cut(rect));
    if (rects.length === 0) continue;
    const context = contextOf(chain);
    const total = rects.reduce((sum, rect) => sum + rect.width, 0);
    let travelled = 0;
    for (const rect of rects) {
      const from = total > 0 ? Math.round((travelled / total) * text.length) : 0;
      travelled += rect.width;
      const to = total > 0 ? Math.round((travelled / total) * text.length) : text.length;
      segments.push({
        text: text.slice(from, Math.max(from, to)).trim(),
        family: style.fontFamily,
        size: Number.parseFloat(style.fontSize),
        italic: style.fontStyle === 'italic',
        top: rect.top + window.scrollY,
        bottom: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
        width: rect.width,
        height: rect.height,
        chain: chain,
        context: context,
      });
    }
  }

  return {
    segments: segments,
    sections: [...document.querySelectorAll('[data-line]')].map((node) => node.getAttribute('data-line')),
    height: document.documentElement.scrollHeight,
  };
})()`;

const round = (value) => Math.round(value * 100) / 100;

/** Is `short` the beginning of `long`? Two text nodes nested in one element share a prefix. */
function isChainPrefix(short, long) {
  if (short.length > long.length) return false;
  return short.every((entry, index) => entry.sel === long[index]?.sel);
}

const disjoint = (left, right) => left.left + left.width <= right.left + 0.5 || right.left + right.width <= left.left + 0.5;

const width = (segment) => segment.bottom - segment.top;
const centre = (segment) => (segment.top + segment.bottom) / 2;

/** The deepest ancestor every member shares, with that ancestor's own box. */
function sharedRow(members) {
  const [first, ...rest] = members;
  if (first === undefined) return null;
  let shared = first.chain.length;
  for (const member of rest) {
    let index = 0;
    while (index < shared && member.chain[index]?.sel === first.chain[index]?.sel) index += 1;
    shared = index;
  }
  if (shared === 0) return null;
  const last = first.chain[shared - 1];
  return {
    selector: first.chain.slice(0, shared).map((entry) => entry.sel).join(' > '),
    top: last.top,
    bottom: last.bottom,
  };
}

/** A path a person can read: the row and the elements that carry it, not the whole document. */
function shortPath(selector) {
  const parts = selector.split(' > ');
  return parts.length > 5 ? `… > ${parts.slice(-5).join(' > ')}` : selector;
}

function toLine(members, row) {
  const sorted = [...members].sort((left, right) => left.left - right.left);
  const families = [...new Set(sorted.map((segment) => segment.family))];
  const sizes = [...new Set(sorted.map((segment) => round(segment.size)))].sort((left, right) => left - right);
  const lowest = Math.min(...sorted.map((segment) => segment.size));
  const highest = Math.max(...sorted.map((segment) => segment.size));
  return {
    selector: shortPath(row.selector),
    text: sorted
      .map((segment) => segment.text)
      .filter((part) => part !== '')
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 120),
    families,
    sizes,
    italic: sorted.some((segment) => segment.italic),
    rect: {
      top: round(Math.min(...sorted.map((segment) => segment.top))),
      left: round(Math.min(...sorted.map((segment) => segment.left))),
      width: round(
        Math.max(...sorted.map((segment) => segment.left + segment.width)) - Math.min(...sorted.map((segment) => segment.left)),
      ),
      height: round(Math.max(...sorted.map((segment) => segment.bottom)) - Math.min(...sorted.map((segment) => segment.top))),
    },
    mixed: families.length > 1 || highest - lowest > SIZE_TOLERANCE,
  };
}

/**
 * Build the page's lines from its segments: overlap, one baseline band, and a shared ancestor
 * that is a row rather than a section. A member joins a line only when it overlaps **every**
 * member already in it and its centre sits within half the taller box — the band that a
 * baseline row and a centred 44 px row both satisfy, while two stacked paragraphs never do.
 */
export function groupLines(segments) {
  const ordered = [...segments].sort((left, right) => left.bottom - right.bottom || left.left - right.left);
  const lines = [];
  for (const segment of ordered) {
    let target = null;
    for (const line of lines) {
      if (line.members[0]?.context !== segment.context) continue;
      const overlaps = line.members.every(
        (member) => segment.top < member.bottom && member.top < segment.bottom,
      );
      if (!overlaps) continue;
      const band = line.members.every(
        (member) => Math.abs(centre(member) - centre(segment)) <= Math.max(width(member), width(segment)) / 2 + BOTTOM_TOLERANCE,
      );
      if (!band) continue;
      // Side by side, or nested: two runs that overlap horizontally are two lines laid over
      // each other (a marginalia line over the quote above it), not one row.
      const beside = line.members.every(
        (member) => disjoint(member, segment) || isChainPrefix(member.chain, segment.chain) || isChainPrefix(segment.chain, member.chain),
      );
      if (!beside) continue;
      const row = sharedRow([...line.members, segment]);
      if (row === null) continue;
      target = line;
      line.row = row;
      break;
    }
    if (target === null) {
      const row = sharedRow([segment]);
      lines.push({ row, members: [segment] });
    } else {
      target.members.push(segment);
    }
  }
  return lines.map((line) => toLine(line.members, line.row));
}

/** The report's per-width entry: how many lines the page laid out and which of them mix. */
export function reportOf(width, height, segments) {
  const lines = groupLines(segments);
  return {
    width,
    height,
    lines: lines.length,
    violations: lines.filter((line) => line.mixed),
  };
}

/** One readable stderr row per violation, for `--verbose` and for the default summary. */
export function describe(violation) {
  const sizes = violation.sizes.map((size) => `${String(size)}px`).join(' · ');
  return `${violation.selector} — ${violation.families.join(' | ')} · ${sizes} — «${violation.text}»`;
}
