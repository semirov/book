/**
 * scripts/lib/position-page.mjs — the page side of the position harness (BOOK-209).
 *
 * Every measurement happens **in** the page: a rect, a scroll and a frame are things only the
 * browser has, and jsdom has no layout at all (the AC's own words). Node sends one expression
 * per step, the page answers with plain numbers, and nothing here writes to the document except
 * a scroll — the harness measures the product, it does not re-implement it.
 *
 * `install()` defines `window.__position` once per page load: the sticky head's live bottom, the
 * chapter's landing edge (`.ch-h`, or the `<article>` of a slot that holds only its basis
 * sentence), the frame-quiet loop, and the sentence helpers AC2/AC3 need. The rest of the file
 * is a thin builder per call, so the numbers a step needs are interpolated with
 * `JSON.stringify` and never by hand.
 *
 * The jump is a **real click** on the row (`link.click()` — the browser's own activation, so
 * `onClick` runs and its `preventDefault` path is exercised), after the page is reset to the top
 * the way the AC describes. A listener at the document reads `defaultPrevented` after React's
 * root handler has run, which is how the report can say whether the page took the tap.
 */

const INSTALL = `(() => {
  if (window.__position !== undefined) return true;
  const round = (value) => Math.round(value * 100) / 100;
  const headBottom = () => {
    const head = document.querySelector('.top');
    return head === null ? 0 : head.getBoundingClientRect().bottom;
  };
  const targetOf = (n) => document.querySelector('#ch-' + n + ' .ch-h') ?? document.querySelector('#ch-' + n);
  const measure = (n) => {
    const element = targetOf(n);
    if (element === null) return { actual: null, head: 'missing' };
    return {
      actual: round(element.getBoundingClientRect().top - headBottom()),
      head: element.classList.contains('ch-h') ? 'ch-h' : 'article',
    };
  };
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const frames = async (count) => { for (let i = 0; i < count; i += 1) await frame(); };
  const settle = async (options) => {
    const budgetMs = options?.budgetMs ?? 3000;
    const stableFrames = options?.stableFrames ?? 3;
    const minMs = options?.minMs ?? 0;
    const started = performance.now();
    let last = null;
    let still = 0;
    for (;;) {
      await frame();
      const now = { y: window.scrollY, height: document.documentElement.scrollHeight };
      if (last !== null && Math.abs(now.y - last.y) < 0.5 && now.height === last.height) still += 1;
      else still = 0;
      last = now;
      const elapsed = performance.now() - started;
      if (still >= stableFrames && elapsed >= minMs) return { stable: true, elapsed: Math.round(elapsed), y: now.y };
      if (elapsed > budgetMs) return { stable: false, elapsed: Math.round(elapsed), y: now.y };
    }
  };
  const jump = async (n) => {
    const link = document.querySelectorAll('a.toc-link')[n - 1];
    if (link === undefined) return { error: 'no contents row ' + n };
    window.scrollTo(0, 0);
    await frames(2);
    let prevented = false;
    const note = (event) => { prevented = event.defaultPrevented; };
    document.addEventListener('click', note);
    const started = performance.now();
    const from = window.scrollY;
    link.click();
    document.removeEventListener('click', note);
    const at = async (ms) => {
      const wait = ms - (performance.now() - started);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      return measure(n);
    };
    const s150 = await at(150);
    const s800 = await at(800);
    let last = measure(n).actual;
    let still = 0;
    let stable = false;
    for (;;) {
      await frame();
      const now = measure(n).actual;
      if (now !== null && last !== null && Math.abs(now - last) < 0.01) still += 1;
      else still = 0;
      last = now;
      if (still >= 3) { stable = true; break; }
      if (performance.now() - started > 3000) break;
    }
    return {
      at150: s150.actual,
      at800: s800.actual,
      quiet: last,
      stable,
      head: s150.head,
      prevented,
      from,
      scrollY: window.scrollY,
    };
  };
  const spansOf = (chapter) => [...document.querySelectorAll('#ch-' + chapter + ' .p [data-s]')];
  const prefixOf = (element) => (element.textContent ?? '').trim().slice(0, 40);
  // The prose arrives only when the slot comes near the viewport (BOOK-DOC-34 §6): a sentence
  // that is not on the page yet is not a missing sentence, so bring the chapter to the reading
  // line first — the same act a reader's scroll performs — and wait for it.
  const ensureChapter = async (chapter, need) => {
    if (spansOf(chapter).length >= need) return { ok: true, spans: spansOf(chapter).length };
    const node = document.getElementById('ch-' + chapter);
    if (node === null) return { ok: false, spans: 0 };
    // The slot has to come near the viewport — that observer is what fetches the prose — and the
    // page moves under a fresh load (the cover sequence, fonts, a placeholder). So the chapter is
    // re-centred every ~800 ms until its prose is there, coarse and head-independent: the sticky
    // head is not stuck yet while the opening is still on screen, and its rect is not the offset.
    const started = performance.now();
    let nextNudge = 0;
    for (;;) {
      const spans = spansOf(chapter).length;
      if (spans >= need) {
        await settle({ budgetMs: 4000, stableFrames: 3, minMs: 300 });
        return { ok: true, spans };
      }
      const elapsed = performance.now() - started;
      if (elapsed > 8000) return { ok: false, spans };
      if (elapsed >= nextNudge) {
        window.scrollTo({
          top: node.getBoundingClientRect().top + window.scrollY - Math.round(window.innerHeight / 2),
          behavior: 'auto',
        });
        nextNudge = elapsed + 800;
      }
      await frame();
    }
  };
  // Park one sentence **on the reading line** — the head's bottom, the line the product's place
  // is measured from (landingLine). Not the middle of the screen: a place is «the sentence at
  // the line», so a sentence parked anywhere else would make the captured anchor a different
  // sentence than the one the harness is holding, and «restored» would compare two places.
  const placeAt = async (chapter, index) => {
    const ready = await ensureChapter(chapter, index + 1);
    if (ready.ok !== true) return { found: false, count: ready.spans };
    const spans = spansOf(chapter);
    const span = spans[index];
    if (span === undefined) return { found: false, count: spans.length };
    const line = () => headBottom();
    const park = () => {
      const drift = span.getBoundingClientRect().top - line();
      window.scrollTo({ top: window.scrollY + drift, behavior: 'auto' });
    };
    park();
    let settled = await settle({ budgetMs: 3000, stableFrames: 3, minMs: 250 });
    // The page can move under the scroll (a chapter above loads, the font settles): one more
    // correction, then the number.
    if (Math.abs(span.getBoundingClientRect().top - line()) > 2) {
      park();
      settled = await settle({ budgetMs: 3000, stableFrames: 3, minMs: 200 });
    }
    return {
      found: true,
      prefix: prefixOf(span),
      before: round(span.getBoundingClientRect().top),
      line: round(line()),
      settled,
      count: spans.length,
    };
  };
  const locate = (prefix, chapter) => {
    for (const scope of ['#ch-' + chapter + ' .p [data-s]', '.p [data-s]']) {
      for (const element of document.querySelectorAll(scope)) {
        if (prefixOf(element) === prefix) return { found: true, after: round(element.getBoundingClientRect().top) };
      }
    }
    return { found: false, after: null };
  };
  // The sentence at the head's own bottom — the product's landingLine (no epsilon: a place is
  // not a folio). Printed as a label after a reload; no assertion reads it.
  const readingLine = () => {
    const line = headBottom();
    let best = null;
    for (const element of document.querySelectorAll('.p [data-s]')) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom <= line) continue;
      if (best === null || rect.top < best.top) best = { top: rect.top, text: prefixOf(element) };
    }
    return best === null ? null : { top: round(best.top), text: best.text };
  };
  const placeKeys = () => Object.keys(window.localStorage).filter((key) => /place/i.test(key));
  // The product's own row — whatever key its place store uses — read back so the harness can
  // send the very row the page would send. Nothing here builds a place: the page owns that.
  const placeRow = () => {
    const keys = Object.keys(window.localStorage).filter((key) => /place/i.test(key));
    if (keys.length === 0) return null;
    try {
      return { key: keys[0], value: JSON.parse(window.localStorage.getItem(keys[0])) };
    } catch {
      return { key: keys[0], value: null };
    }
  };
  // Resolve an anchor key (ch9#abcd/s120, ch9#abcd/p, or ch9) to the element it names, and
  // answer that element's own top. The key is the product's contract; this is a reader of it.
  const locateById = (sentenceId) => {
    const sentence = /^(.*)\\/s(\\d+)$/.exec(sentenceId);
    const paragraph = sentence === null ? /^(.*)\\/p$/.exec(sentenceId) : null;
    const chapter = sentence === null && paragraph === null ? /^ch(\\d+)$/.exec(sentenceId) : null;
    let element = null;
    if (sentence !== null) {
      const block = document.querySelector('.p[data-block-id="' + CSS.escape(sentence[1]) + '"]');
      element = block === null ? null : block.querySelector('[data-s="' + sentence[2] + '"]');
    } else if (paragraph !== null) {
      element = document.querySelector('.p[data-block-id="' + CSS.escape(paragraph[1]) + '"]');
    } else if (chapter !== null) {
      element = document.getElementById('ch-' + chapter[1]);
    }
    if (element === null) return { found: false, after: null, text: null };
    return { found: true, after: round(element.getBoundingClientRect().top), text: prefixOf(element) };
  };
  // A reader navigates by tapping a link, not by assigning the address bar: the product records
  // the place being left in the entry the tap leaves (BOOK-209), and only a real activation goes
  // through that path. The harness taps when the page holds such a link and says so.
  const tapLink = (href) => {
    for (const link of document.querySelectorAll('a[href]')) {
      if (link.getAttribute('href') !== href) continue;
      link.click();
      return { tapped: true, href };
    }
    return { tapped: false, href };
  };
  const hash = (value) => { window.location.hash = value; return window.location.hash; };
  const back = () => { window.history.back(); return true; };
  window.__position = {
    measure,
    jump,
    settle,
    placeAt,
    locate,
    locateById,
    placeRow,
    readingLine,
    hash,
    tapLink,
    back,
    ensureChapter,
    placeKeys,
    frames,
  };
  return true;
})()`;

export function install() {
  return INSTALL;
}

/** Reset to the top of the page, then tap contents row `n` and sample the landing. */
export function jump(n) {
  return `window.__position.jump(${String(n)})`;
}

/** Park the sentence at `index` of chapter `chapter` at the middle of the viewport. */
export function place(chapter, index) {
  return `window.__position.placeAt(${String(chapter)}, ${String(index)})`;
}

/** Where the sentence with this 40-character prefix is now (chapter first, then the document). */
export function locate(prefix, chapter) {
  return `window.__position.locate(${JSON.stringify(prefix)}, ${String(chapter)})`;
}

/** The device's own place rows (`book.place.v1`), if the layer keeps any: the AC3 signal. */
export function placeKeys() {
  return 'window.__position.placeKeys()';
}

/** The product's own place row (key + parsed value), or null: the row the second device gets. */
export function placeRow() {
  return 'window.__position.placeRow()';
}

/** Where the element an anchor key names stands now; `found: false` when the page lacks it. */
export function locateById(sentenceId) {
  return `window.__position.locateById(${JSON.stringify(sentenceId)})`;
}

/** Wait until the scroll offset and the document's height hold still for three frames. */
export function settle(options = {}) {
  return `window.__position.settle(${JSON.stringify(options)})`;
}

/** The sentence at the reading line — what a reader looks at after a reload. */
export function readingLine() {
  return 'window.__position.readingLine()';
}

export function hash(value) {
  return `window.__position.hash(${JSON.stringify(value)})`;
}

/** A real tap on the page's own `<a href="#…">`, or `{tapped:false}` when the page has none. */
export function tapLink(href) {
  return `window.__position.tapLink(${JSON.stringify(href)})`;
}

export function back() {
  return 'window.__position.back()';
}

/** How many contents rows the page has — the harness's own readiness gate. */
export function rowCount() {
  return "document.querySelectorAll('a.toc-link').length";
}
