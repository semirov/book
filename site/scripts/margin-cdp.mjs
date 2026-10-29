#!/usr/bin/env node
/**
 * scripts/margin-cdp.mjs — BOOK-208: the margin's geometry, measured in a browser.
 *
 * The owner's defect is horizontal and jsdom cannot see it: the note was glued to the prose, and
 * a page that lost the token block laid it shrink-to-fit **inside** the text (215.4 px wide,
 * 215.4 px in). So this script measures, per width and per paragraph, the prose's **content
 * box** against every margin object the page renders — `.margin-note`, `.filing-mark` — plus
 * `.sentence-block`, which is reported and exempt — and decides pass/fail from the rectangles,
 * never from a list of expected numbers:
 *
 *   a. no margin object intersects the prose box at any width (0 px of overlap);
 *   b. at ≥1024 every object starts right of the prose box by its own air: the mark by
 *      `--mark-air` (16), the note by `--note-gap` (16 + the mark's 40 = 56);
 *   c. a displayed note is never a zero-width or sub-floor note: its used width is > 0 and
 *      ≥ `--note-min` (120);
 *   d. ≥1024 the page shows at least one `.margin-note` (and it is displayed, with no
 *      `.phone-strip` row inside that paragraph); <1024 at least one note is **mounted** (hidden
 *      is correct there) and at least one `.phone-strip-row` is shown — the two regimes, each
 *      in its place, and a page with no note at all cannot pass by having nothing to measure;
 *   e. no margin object leaves the viewport's horizontal edges: the tick must not overflow a
 *      390 px phone, and a note that ends past the frame is the clip `body { overflow-x: hidden }`
 *      used to hide — the tokens' fallbacks must narrow it, not draw it past the edge;
 *   f. the emulated viewport is the width asked for (`window.innerWidth === width`): an
 *      override that did not take effect measured the wrong page, and is not a pass.
 *
 * **What is not a margin object.** `.sentence-block` is in the flow since BOOK-128 #3852
 * (`reader.css`: `position: static`), so its box *is* the paragraph's width and it cannot be
 * laid beside the prose. It is measured and reported, and is not held to (a)/(b) — the rule is
 * about what stands *outside* the text, and a block inside it is the paragraph, not a
 * neighbour. Being in the report is what keeps the exemption honest: a block that came back
 * into the channel would appear at a delta of its own instead of disappearing.
 *
 *   node scripts/margin-cdp.mjs [--url <url> [--wait-selector <css>]] [--shots <dir>] [--verbose]
 *
 * The default page is `web/harness/margin.html` — the real `ProseParagraph` with two filings (so
 * two notes and two marks) and an open `SentenceBlock` — served by the SAME Vite config the site
 * is built with (`web/vite.config.ts`, `root: web`), so the real sheets are what gets measured.
 * `--url` measures any other page instead (a dev server, a preview build); `--wait-selector`
 * makes that page wait (bounded, 10 s) for the surface under test, because an empty shell is not
 * a clean page. A page with no `.margin-note` at all is exit 2 in `--url` mode: the note's
 * geometry is the defect this guard exists for, and a page without one cannot answer it.
 *
 * Widths: 1440, 1280, 1100, 1024, 900, 768, 390 at height 900 — the two lanes the design names
 * (≥1024 the channel, <1024 the strip) and the steps where the channel narrows.
 *
 * The check is **one-shot**: it owns no state, writes only the `--shots` PNGs, and leaves no
 * browser profile behind. Exit codes: 0 — every invariant holds at every width; 1 — at least
 * one violation, with the measured rectangles on stderr; 2 — the harness could not run (no
 * browser, no page, no `.margin-note` to measure, nothing painted), or `--wait-selector` never
 * appeared. The browser comes from `$MARGIN_CHROME`, `$LINE_FONTS_CHROME`, `$ACCORDION_CHROME`,
 * the Playwright cache, or a system Chrome/Chromium.
 *
 * JSON on stdout is `{ page, chrome, pass, widths: [{ width, height, paragraphs, objects,
 * violations, notes, strip }] }`, where `notes`/`strip` are `{ mounted, shown }` for the page at
 * that width: one `{objects}` array per viewport, each object carrying the prose's right edge and
 * its own delta, so a changed number is visible in the report before it is a gate.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { Cdp, chromiumBinary, killTree, launchChromium, portIsFree } from './lib/cdp.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
const PAGE = '/harness/margin.html';
/** The two regimes, and the widths at which the channel's own arithmetic changes. */
const WIDTHS = [1440, 1280, 1100, 1024, 900, 768, 390];
const HEIGHT = 900;
/** `--mark-air` / `--note-gap` / `--note-min`: the design's numbers, used only as assertions. */
const MARK_AIR = 16;
const NOTE_GAP = 56;
const NOTE_MIN = 120;
/** Half a pixel of slack: a used width is fractional, a token is not. */
const EPS = 0.5;

const ARGS = process.argv.slice(2);
const VERBOSE = ARGS.includes('--verbose');

function flag(name) {
  const at = ARGS.indexOf(name);
  if (at === -1) return null;
  const value = ARGS[at + 1];
  if (value === undefined || value.startsWith('--')) {
    bail(`${name} needs a value`);
  }
  return value;
}

const EXPLICIT_URL = flag('--url');
const WAIT_SELECTOR = flag('--wait-selector');
const SHOT_DIR = flag('--shots');
if (WAIT_SELECTOR !== null && EXPLICIT_URL === null) {
  bail('--wait-selector is for --url; the harness page has its own ready flag');
}
/** How long `--wait-selector` may wait before the run is a failure, not a measurement. */
const WAIT_MS = 10_000;
/** How long the harness may take to mount and place every object. */
const READY_MS = 20_000;

function log(...parts) {
  if (VERBOSE) process.stderr.write(`${parts.join(' ')}\n`);
}

function bail(message) {
  process.stderr.write(`margin: ${message}\n`);
  process.exit(2);
}

/* ---------- the browser ---------- */

function chromeFor() {
  for (const name of ['MARGIN_CHROME', 'LINE_FONTS_CHROME', 'ACCORDION_CHROME']) {
    const explicit = process.env[name];
    if (explicit !== undefined && explicit !== '' && existsSync(explicit)) return explicit;
  }
  try {
    return chromiumBinary();
  } catch {
    /* no Playwright cache: a system browser is the last resort */
  }
  for (const candidate of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/* ---------- the server ---------- */

async function serve() {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: join(WEB, 'vite.config.ts'),
    root: WEB,
    server: { port: 0, host: '127.0.0.1', strictPort: false },
    logLevel: 'silent',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || typeof address !== 'object') bail('the dev server did not bind a port');
  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
}

/* ---------- the page's own measurement ---------- */

/**
 * The collector, evaluated in the page. It answers boxes, never a verdict: the rules are in
 * `violationsOf` below, so a green run is the absence of a measured fault, not a hardcoded one.
 * `margin` is true for an object laid **outside** the prose (absolute positioning); a static one
 * is in the flow and is reported for the same reason.
 */
const COLLECT = `(() => {
  const round = (value) => Math.round(value * 100) / 100;
  const pad = (el, side) => Number.parseFloat(getComputedStyle(el)['padding' + side]) || 0;
  const boxOf = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      left: round(rect.left),
      right: round(rect.right),
      top: round(rect.top),
      bottom: round(rect.bottom),
      width: round(rect.width),
      height: round(rect.height),
    };
  };
  const contentBox = (el) => {
    const rect = el.getBoundingClientRect();
    const left = pad(el, 'Left');
    const right = pad(el, 'Right');
    const top = pad(el, 'Top');
    const bottom = pad(el, 'Bottom');
    return {
      left: round(rect.left + left),
      right: round(rect.right - right),
      top: round(rect.top + top),
      bottom: round(rect.bottom - bottom),
      width: round(rect.width - left - right),
      height: round(rect.height - top - bottom),
    };
  };
  const shown = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const kinds = [
    ['.margin-note', 'note'],
    ['.filing-mark', 'mark'],
    ['.sentence-block', 'sentence-block'],
  ];
  const count = (selector) => {
    const all = [...document.querySelectorAll(selector)];
    return { mounted: all.length, shown: all.filter(shown).length };
  };
  const paragraphs = [...document.querySelectorAll('.p')].map((paragraph) => {
    const prose = contentBox(paragraph);
    const objects = [];
    for (const [selector, kind] of kinds) {
      for (const element of paragraph.querySelectorAll(selector)) {
        if (!shown(element)) continue;
        const position = getComputedStyle(element).position;
        const box = boxOf(element);
        objects.push({
          kind,
          position,
          margin: position === 'absolute',
          left: box.left,
          right: box.right,
          top: box.top,
          width: box.width,
          height: box.height,
          proseRight: prose.right,
          delta: round(box.left - prose.right),
        });
      }
    }
    const note = paragraph.querySelector('.margin-note');
    return {
      blockId: paragraph.dataset.blockId || paragraph.id || null,
      prose,
      hasNote: note !== null,
      noteShown: note !== null && shown(note),
      stripRows: [...paragraph.querySelectorAll('.phone-strip-row')].filter(shown).length,
      objects,
    };
  });
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    paragraphs,
    notes: count('.margin-note'),
    strip: count('.phone-strip-row'),
    documents: {
      notes: document.querySelectorAll('.margin-note').length,
      marks: document.querySelectorAll('.filing-mark').length,
      blocks: document.querySelectorAll('.sentence-block').length,
      margins: document.querySelectorAll('.p[data-margin]').length,
    },
  };
})()`;

/** Two boxes share a pixel: a zero-width object on the edge is not an overlap. */
const intersects = (a, b) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > EPS &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > EPS;

const rect = (label, box) =>
  `${label} ${String(box.left)}..${String(box.right)} (top ${String(box.top)})`;

/**
 * The invariants, one paragraph at a time. Everything a failure prints comes from here, so the
 * message and the number can never disagree.
 */
function violationsOf(width, collected) {
  const out = [];
  const desktop = width >= 1024;
  // The page-level note (BOOK-208 review): a run where nothing was measured is not a pass. At
  // ≥1024 the channel's own object must be on the page and shown; below 1024 the note is
  // mounted but hidden, and the strip is what the reader sees.
  const notes = collected.notes ?? { mounted: 0, shown: 0 };
  const strip = collected.strip ?? { mounted: 0, shown: 0 };
  if (desktop && notes.shown === 0) {
    out.push(
      `the page shows no .margin-note at ${String(width)} px (${String(notes.mounted)} mounted) — the channel's object is not there to measure`,
    );
  }
  if (!desktop) {
    if (notes.mounted === 0) {
      out.push(`the page mounts no .margin-note at ${String(width)} px — there is nothing to demote to the strip`);
    }
    if (strip.shown === 0) {
      out.push(`the page shows no .phone-strip-row at ${String(width)} px (${String(strip.mounted)} mounted) — the filing is unreachable`);
    }
  }
  for (const paragraph of collected.paragraphs) {
    const where = paragraph.blockId === null ? 'a paragraph' : `paragraph ${paragraph.blockId}`;
    if (!desktop && paragraph.prose.right > width + EPS) {
      out.push(`${where}: the prose box ends at ${String(paragraph.prose.right)}, past the ${String(width)} px viewport`);
    }
    for (const object of paragraph.objects) {
      const at = `${where} · ${object.kind} at ${rect('left/right', object)} (delta ${String(object.delta)})`;
      // An in-flow block is not the channel: see the header.
      if (!object.margin) continue;
      if (intersects(object, paragraph.prose)) {
        out.push(`${at} intersects the prose box ${rect('', paragraph.prose)} — the margin is on the text`);
      }
      if (desktop) {
        const need = object.kind === 'mark' ? MARK_AIR : NOTE_GAP;
        if (object.delta < need - EPS) {
          out.push(`${at} starts ${String(object.delta)} px right of the prose — the air is ${String(need)}`);
        }
      }
      if (object.left < -EPS || object.right > width + EPS) {
        out.push(`the ${String(width)} px viewport: ${at} leaves it — ${String(Math.round((object.right - width) * 100) / 100)} px past its right edge, the clip \`overflow-x: hidden\` used to hide`);
      }
      if (object.kind === 'note') {
        if (object.width <= EPS) out.push(`${at} is displayed ${String(object.width)} px wide — a zero-width note`);
        if (object.width < NOTE_MIN - EPS) {
          out.push(`${at} is ${String(object.width)} px — under the ${String(NOTE_MIN)} px floor`);
        }
      }
    }
    if (!paragraph.hasNote) continue;
    if (desktop) {
      if (!paragraph.noteShown) out.push(`${where}: the note is hidden at ${String(width)} — the channel is there`);
      if (paragraph.stripRows > 0) {
        out.push(`${where}: ${String(paragraph.stripRows)} strip row(s) are displayed at ${String(width)} — the strip is the phone's`);
      }
    } else {
      if (paragraph.noteShown) out.push(`${where}: the note is displayed at ${String(width)} — there is no channel`);
      if (paragraph.stripRows === 0) out.push(`${where}: no strip row is displayed at ${String(width)} — the filing is unreachable`);
    }
  }
  return out;
}

/* ---------- one viewport ---------- */

async function measure(cdp, page, width) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  await cdp.send('Page.navigate', { url: page });
  await settle(cdp);
  const collected = await cdp.evaluate(COLLECT);
  if (collected === undefined || !Array.isArray(collected.paragraphs)) {
    throw new Error('the page answered no paragraphs');
  }
  if (collected.paragraphs.length === 0) {
    throw new Error(`the page laid out no .p at ${String(width)} — nothing was measured`);
  }
  // The emulation is the measurement: a viewport that did not take effect measured another page.
  if (collected.viewport.width !== width) {
    throw new Error(
      `the viewport is ${String(collected.viewport.width)} px wide after asking for ${String(width)} — the emulation did not take effect`,
    );
  }
  if (collected.documents.notes + collected.documents.marks + collected.documents.blocks === 0) {
    throw new Error(`the page rendered no margin object at ${String(width)} — nothing was measured`);
  }
  // In `--url` mode a page without a note cannot answer this ticket's question: the note's
  // geometry is the defect, and a page that has none has nothing to check. Exit 2, not a pass.
  if (EXPLICIT_URL !== null && collected.documents.notes === 0) {
    throw new Error(`the page renders no .margin-note — nothing to measure (${page})`);
  }
  const violations = violationsOf(width, collected);
  const objects = collected.paragraphs.flatMap((paragraph) =>
    paragraph.objects.map((object) => ({
      kind: object.kind,
      paragraph: paragraph.blockId,
      position: object.position,
      margin: object.margin,
      left: object.left,
      right: object.right,
      top: object.top,
      width: object.width,
      proseRight: object.proseRight,
      delta: object.delta,
    })),
  );
  if (SHOT_DIR !== null) {
    mkdirSync(SHOT_DIR, { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(SHOT_DIR, `${String(width)}.png`), Buffer.from(shot.data, 'base64'));
  }
  return {
    width,
    height: HEIGHT,
    paragraphs: collected.paragraphs.length,
    objects,
    violations,
    notes: collected.notes,
    strip: collected.strip,
    documents: collected.documents,
    prose: collected.paragraphs.map((paragraph) => ({ blockId: paragraph.blockId, ...paragraph.prose })),
  };
}

/** Wait for a settled page: the harness's own flag, or the selected surface, then the webfonts. */
async function settle(cdp) {
  if (EXPLICIT_URL !== null) {
    if (WAIT_SELECTOR !== null) {
      const deadline = Date.now() + WAIT_MS;
      let found = false;
      while (Date.now() < deadline) {
        found = await cdp
          .evaluate(`document.querySelector(${JSON.stringify(WAIT_SELECTOR)}) !== null`, false)
          .catch(() => false);
        if (found === true) break;
        await sleep(100);
      }
      if (found !== true) throw new Error(`--wait-selector "${WAIT_SELECTOR}" did not appear within ${String(WAIT_MS)} ms`);
    }
  } else {
    const deadline = Date.now() + READY_MS;
    let ready = false;
    while (Date.now() < deadline) {
      ready = await cdp.evaluate('document.body.dataset.harnessReady === "true"', false).catch(() => false);
      if (ready === true) break;
      await sleep(50);
    }
    if (!ready) throw new Error('the harness did not place its margin (data-harness-ready never became true)');
  }
  // Metrics after a webfont swap are metrics of a different page: nothing is measured before.
  await cdp.evaluate('document.fonts.ready.then(() => true)');
  await cdp.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))');
}

/** A free debugging port: the client and the browser must agree on one number. */
async function freePort() {
  for (let port = 9411; port < 9499; port += 1) {
    if (await portIsFree(`http://127.0.0.1:${String(port)}/json/version`)) return port;
  }
  bail('no free port for the browser\'s debugging endpoint');
  return 0;
}

/* ---------- main ---------- */

const chrome = chromeFor();
if (chrome === null) bail('no Chromium found: set $MARGIN_CHROME to a Chrome/Chromium binary');

const served = EXPLICIT_URL === null ? await serve() : null;
const page = EXPLICIT_URL ?? `${served.origin}${PAGE}`;
const profile = mkdtempSync(join(tmpdir(), 'margin-cdp-'));
let cdp = null;
let child = null;
try {
  const port = await freePort();
  const launched = await launchChromium({
    binary: chrome,
    cdpPort: port,
    profileDir: profile,
    windowSize: `${String(WIDTHS[0])},${String(HEIGHT)}`,
  });
  child = launched.child;
  cdp = await Cdp.open(launched.pageUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const widths = [];
  for (const width of WIDTHS) {
    widths.push(await measure(cdp, page, width));
  }

  const total = widths.reduce((sum, entry) => sum + entry.violations.length, 0);
  const report = { page, chrome, pass: total === 0, widths };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  for (const entry of widths) {
    const note = entry.objects.find((object) => object.kind === 'note' && object.margin);
    const mark = entry.objects.find((object) => object.kind === 'mark' && object.margin);
    const prose = entry.prose[0];
    const shape = [
      `prose ${prose === undefined ? '—' : `${String(prose.right)}`}`,
      mark === undefined ? 'mark —' : `mark ${String(mark.left)}..${String(mark.right)}`,
      note === undefined ? 'note —' : `note ${String(note.left)}..${String(note.right)} (${String(note.width)})`,
      `Δ ${note === undefined ? '—' : String(note.delta)}`,
    ].join(' · ');
    process.stderr.write(
      `margin · ${String(entry.width)}×${String(entry.height)} — ${String(entry.paragraphs)} paragraphs, ${String(entry.objects.length)} objects, ${String(entry.violations.length)} violations · notes ${String(entry.notes.shown)}/${String(entry.notes.mounted)} shown, strip rows ${String(entry.strip.shown)}/${String(entry.strip.mounted)} · ${shape}\n`,
    );
    for (const violation of entry.violations) process.stderr.write(`  ${violation}\n`);
  }
  if (SHOT_DIR !== null) process.stderr.write(`margin: ${String(widths.length)} screenshots in ${SHOT_DIR}\n`);
  process.exitCode = total === 0 ? 0 : 1;
} catch (error) {
  process.stderr.write(`margin: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  cdp?.close();
  if (child !== null) killTree(child);
  if (served !== null) await served.server.close();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // The browser may still be flushing its profile: a leftover temp directory is not a gate.
  }
}
