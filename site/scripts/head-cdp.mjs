#!/usr/bin/env node
/**
 * scripts/head-cdp.mjs — BOOK-DOC-84 §11.1: the head, measured in a browser.
 *
 * The head has two states and three promises that jsdom cannot see:
 *
 *   a. **the running head keeps its three facts** — brand, chapter number + title, page number —
 *      in both states, at 390 and at 1440, fully inside the viewport and not clipped;
 *   b. **the status line is an additional row in the head's flow** — when it exists it sits under
 *      the running head with no intersecting box, and the head measures the height it adds;
 *   c. **`--offset-top` follows that height** — idle and active, at both widths, and a scrolled
 *      chapter heading lands under the sticky head, never beneath it.
 *
 * Idle renders **no line node at all** (owner, 2026-10-29). Four screenshots —
 * `390-idle.png`, `390-active.png`, `1440-idle.png`, `1440-active.png` — go to `shots/live/head/`;
 * the seven live states are re-measured for the line's text, its rows and the box rules.
 *
 * What it drives: `web/harness/head.html`, the real `Header` with the page's own frame fold, and
 * two chapters (the second far down: the scrolled case).
 *
 *   node scripts/head-cdp.mjs [--out DIR] [--verbose]
 *
 * Exit codes: 0 — every invariant holds; 1 — at least one violation, with the numbers on stderr;
 * 2 — the harness could not run (no browser, no dev server, nothing painted).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { Cdp, chromiumBinary, killTree, launchChromium, portIsFree } from './lib/cdp.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
const PAGE = '/harness/head.html';
const CDP_PORT = 9336;
/** The seven states §11.1 names, in the order the page builds them. */
const STATES = ['reading', 'approach', 'waiting', 'writing', 'checking', 'fixing', 'applied'];
/** The state the four screenshots show: one line, a filing and a chapter. */
const ACTIVE = 'writing';
/** §11.1's phone step and the desktop it is measured against. */
const WIDTHS = [390, 1440];
const PHONE = 390;
const MAX_PHONE_ROWS = 2;
/** `headerOffset.ts`'s `BREATHING_PX`: the site's air between the head and an anchor. */
const BREATHING_PX = 8;
const DELTA_PX = 1;

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const outFlag = args.indexOf('--out');
const OUT = outFlag === -1 ? join(ROOT, 'shots/live/head') : resolve(args[outFlag + 1]);

function bail(message) {
  process.stderr.write(`head:cdp: ${message}\n`);
  process.exit(2);
}

function log(...parts) {
  if (verbose) process.stderr.write(`${parts.join(' ')}\n`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ---------- the dev server and the browser ---------- */

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

/** One screenshot of the whole viewport. */
async function shot(cdp, name) {
  const answer = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(OUT, name);
  writeFileSync(path, Buffer.from(answer.data, 'base64'));
  return relative(ROOT, path);
}

/** The page's own numbers: the two boxes, the head's height, the offset, the facts. */
const PROBE = `(() => {
  const round = (value) => Math.round(value * 10) / 10;
  const rectOf = (element) => {
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return { top: round(rect.top), bottom: round(rect.bottom), left: round(rect.left), right: round(rect.right), width: round(rect.width), height: round(rect.height) };
  };
  const visibleOf = (element) => {
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    let clipped = false;
    for (let node = element; node !== null && node !== document.documentElement; node = node.parentElement) {
      const parent = getComputedStyle(node);
      if (/hidden|clip|scroll|auto/.test(parent.overflowX + parent.overflowY)) {
        const frame = node.getBoundingClientRect();
        if (rect.left < frame.left - 0.5 || rect.right > frame.right + 0.5 || rect.top < frame.top - 0.5 || rect.bottom > frame.bottom + 0.5) clipped = true;
      }
    }
    return {
      text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim(),
      rect: rectOf(element),
      display: style.display,
      visibility: style.visibility,
      visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
      clipped,
      inViewport: rect.left >= -0.5 && rect.right <= innerWidth + 0.5 && rect.top >= -0.5 && rect.bottom <= innerHeight + 0.5,
    };
  };
  const header = document.querySelector('.top');
  const row = document.querySelector('.top-row');
  const line = document.querySelector('.head-line');
  const rowRect = rectOf(row);
  let rows = null;
  let fragments = [];
  if (line !== null) {
    const range = document.createRange();
    range.selectNodeContents(line);
    fragments = [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => ({ top: round(rect.top), bottom: round(rect.bottom), left: round(rect.left), right: round(rect.right) }));
    rows = new Set(fragments.map((rect) => Math.round(rect.top))).size;
  }
  const lineRect = fragments.length === 0 ? null : {
    top: Math.min(...fragments.map((rect) => rect.top)),
    bottom: Math.max(...fragments.map((rect) => rect.bottom)),
    left: Math.min(...fragments.map((rect) => rect.left)),
    right: Math.max(...fragments.map((rect) => rect.right)),
  };
  const headHeight = header === null ? null : round(header.getBoundingClientRect().height);
  const chapterTwo = document.querySelector('#ch-2');
  const heading = document.querySelector('#ch-2 .ch-h');
  return {
    lineNode: line !== null,
    line: line === null ? null : (line.innerText || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim(),
    rows,
    fragments,
    lineRect,
    rowRect,
    rowInViewport: rowRect !== null && rowRect.left >= -0.5 && rowRect.right <= innerWidth + 0.5 && rowRect.top >= -0.5 && rowRect.bottom <= innerHeight + 0.5,
    // The area the two boxes share; 0 is the contract (a line over the running head is not).
    overlap: rowRect === null || lineRect === null ? 0 : Math.max(0, Math.min(rowRect.right, lineRect.right) - Math.max(rowRect.left, lineRect.left)) * Math.max(0, Math.min(rowRect.bottom, lineRect.bottom) - Math.max(rowRect.top, lineRect.top)),
    lineBelowRow: rowRect === null || lineRect === null ? true : lineRect.top >= rowRect.bottom - 0.5,
    headHeight,
    headBottom: header === null ? null : round(header.getBoundingClientRect().bottom),
    offsetTop: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--offset-top')),
    brand: visibleOf(document.querySelector('.brand')),
    chapterN: visibleOf(document.querySelector('.top-chapter-n')),
    chapterW: visibleOf(document.querySelector('.top-chapter-w')),
    folio: visibleOf(document.querySelector('.folio')),
    firstTop: document.querySelector('#first') === null ? null : round(document.querySelector('#first').getBoundingClientRect().top),
    scrolled: round(window.scrollY),
    articleTop: chapterTwo === null ? null : round(chapterTwo.getBoundingClientRect().top),
    headingTop: heading === null ? null : round(heading.getBoundingClientRect().top),
    href: line === null ? null : (line.querySelector('a')?.getAttribute('href') ?? null),
  };
})()`;

async function settle(cdp) {
  await cdp.evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))))');
}

async function measure(cdp, name) {
  await cdp.evaluate(`window.__head.show(${JSON.stringify(name)}); true`);
  await settle(cdp);
  return cdp.evaluate(PROBE);
}

async function idle(cdp) {
  await cdp.evaluate('window.__head.hide(); true');
  await settle(cdp);
  return cdp.evaluate(PROBE);
}

/** Does every promise hold for these facts? Returns the violation lines (empty is clean). */
function factsViolations(where, facts) {
  const bad = [];
  for (const [name, fact] of [
    ['brand', facts.brand],
    ['chapter number', facts.chapterN],
    ['chapter title', facts.chapterW],
    ['page number', facts.folio],
  ]) {
    if (fact === null) bad.push(`${where}: the ${name} is absent from the head`);
    else if (!fact.visible) bad.push(`${where}: the ${name} is not visible (${JSON.stringify(fact)})`);
    else if (fact.clipped) bad.push(`${where}: the ${name} is clipped by an ancestor’s overflow`);
    else if (!fact.inViewport) bad.push(`${where}: the ${name} is outside the viewport (${JSON.stringify(fact.rect)})`);
  }
  return bad;
}

/** The offset contract: `--offset-top` is the measured head plus the site's breathing space. */
function offsetViolations(where, facts) {
  if (facts.headHeight === null || !Number.isFinite(facts.offsetTop)) return [`${where}: no head or no --offset-top`];
  if (Math.abs(facts.offsetTop - (facts.headHeight + BREATHING_PX)) > DELTA_PX) {
    return [
      `${where}: --offset-top is ${String(facts.offsetTop)} px, the head is ${String(facts.headHeight)} px (+${String(BREATHING_PX)} expected)`,
    ];
  }
  return [];
}

function nonOverlapViolations(where, facts) {
  const bad = [];
  if (facts.overlap > 0) bad.push(`${where}: the status line overlaps the running head by ${String(facts.overlap)} px`);
  if (!facts.lineBelowRow) bad.push(`${where}: the status line is not below the running head`);
  if (facts.lineRect !== null && facts.firstTop !== null && facts.lineRect.bottom > facts.firstTop + DELTA_PX) {
    bad.push(`${where}: the status line (bottom ${String(facts.lineRect.bottom)}) overlays the prose (top ${String(facts.firstTop)})`);
  }
  return bad;
}

/* ---------- main ---------- */

const { server, origin } = await serve();
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'head-cdp-'));
const violations = [];
let browser = null;
let cdp = null;

try {
  if (!(await portIsFree(`http://127.0.0.1:${String(CDP_PORT)}/json/version`))) {
    bail(`the CDP port ${String(CDP_PORT)} is in use`);
  }
  browser = await launchChromium({
    binary: chromiumBinary(),
    cdpPort: CDP_PORT,
    profileDir: profile,
    windowSize: `${String(WIDTHS[0])},900`,
  });
  cdp = await Cdp.open(browser.pageUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error') log('page console error:', JSON.stringify(event.args ?? []));
  });
  await cdp.send('Page.navigate', { url: `${origin}${PAGE}` });

  // The harness's own flag: a page that painted an empty shell has measured nothing.
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
    ready = await cdp.evaluate('window.__head === undefined ? false : window.__head.ready()', false).catch(() => false);
    if (!ready) await sleep(50);
  }
  if (!ready) bail('the harness page did not mount (window.__head.ready() never became true)');
  await cdp.evaluate('document.fonts.ready.then(() => true)');

  const report = { page: PAGE, origin, widths: [] };
  for (const width of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: width < 600 ? 844 : 900,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await sleep(150);
    await cdp.evaluate('window.scrollTo(0, 0); true');
    await cdp.evaluate('window.__head.author(false)');

    // --- idle: no line node, the running head's three facts, the offset from the row alone.
    const idleFacts = await idle(cdp);
    const idleShot = await shot(cdp, `${String(width)}-idle.png`);
    if (idleFacts.lineNode) violations.push(`idle/${String(width)}: the page still holds a .head-line node`);
    if (idleFacts.line !== null) violations.push(`idle/${String(width)}: idle renders a status word «${String(idleFacts.line)}»`);
    if (!idleFacts.rowInViewport) violations.push(`idle/${String(width)}: the running head is not fully inside the viewport`);
    violations.push(...factsViolations(`idle/${String(width)}`, idleFacts), ...offsetViolations(`idle/${String(width)}`, idleFacts));

    // --- active: the line is one/two rows under the row, the head grows, the offset follows.
    const activeFacts = await measure(cdp, ACTIVE);
    const activeExpected = await cdp.evaluate(`window.__head.expected(${JSON.stringify(ACTIVE)}, ${String(width)})`, false);
    const activeShot = await shot(cdp, `${String(width)}-active.png`);
    if (!activeFacts.lineNode) violations.push(`active/${String(width)}: the status line is absent`);
    if (activeFacts.line !== activeExpected) {
      violations.push(`active/${String(width)}: the line reads «${String(activeFacts.line)}», the derived line is «${String(activeExpected)}»`);
    }
    const maxRows = width === PHONE ? MAX_PHONE_ROWS : 1;
    if (activeFacts.rows === null || activeFacts.rows < 1 || activeFacts.rows > maxRows) {
      violations.push(`active/${String(width)}: the line takes ${String(activeFacts.rows)} rows, expected 1..${String(maxRows)}`);
    }
    if (!activeFacts.rowInViewport) violations.push(`active/${String(width)}: the running head is not fully inside the viewport`);
    violations.push(...factsViolations(`active/${String(width)}`, activeFacts), ...offsetViolations(`active/${String(width)}`, activeFacts), ...nonOverlapViolations(`active/${String(width)}`, activeFacts));
    // The line is an addition: the head grew by it, and the prose starts under the grown head.
    const grewBy = (activeFacts.headHeight ?? 0) - (idleFacts.headHeight ?? 0);
    if (grewBy < 10) violations.push(`active/${String(width)}: the head grew ${String(grewBy)} px when the line appeared, expected the line in its flow`);
    const movedBy = (activeFacts.firstTop ?? 0) - (idleFacts.firstTop ?? 0);
    if (Math.abs(movedBy - grewBy) > DELTA_PX) {
      violations.push(`active/${String(width)}: the prose moved ${String(movedBy)} px while the head grew ${String(grewBy)} px — the line is out of the flow`);
    }
    if (activeFacts.headHeight !== null && activeFacts.firstTop !== null && activeFacts.headBottom !== null && activeFacts.firstTop < activeFacts.headBottom - DELTA_PX) {
      violations.push(`active/${String(width)}: the prose starts under the head’s bottom (${String(activeFacts.firstTop)} < ${String(activeFacts.headBottom)})`);
    }
    if (activeFacts.lineRect !== null) {
      if (activeFacts.lineRect.left < -0.5 || activeFacts.lineRect.right > width + 0.5) {
        violations.push(`active/${String(width)}: the line leaves the viewport (${JSON.stringify(activeFacts.lineRect)})`);
      }
    }

    // --- the seven states keep the line's grammar and the same box rules.
    const states = [];
    for (const state of STATES) {
      const facts = await measure(cdp, state);
      const expected = await cdp.evaluate(`window.__head.expected(${JSON.stringify(state)}, ${String(width)})`, false);
      if (facts.line !== expected) {
        violations.push(`${state}/${String(width)}: the line reads «${String(facts.line)}», the derived line is «${String(expected)}»`);
      }
      if (facts.rows === null || facts.rows < 1 || facts.rows > maxRows) {
        violations.push(`${state}/${String(width)}: the line takes ${String(facts.rows)} rows, expected 1..${String(maxRows)}`);
      }
      violations.push(...nonOverlapViolations(`${state}/${String(width)}`, facts), ...factsViolations(`${state}/${String(width)}`, facts), ...offsetViolations(`${state}/${String(width)}`, facts));
      states.push({ state, rows: facts.rows, text: facts.line, expected, offsetTop: facts.offsetTop, headHeight: facts.headHeight, href: facts.href });
      log(`${String(width)} ${state}: ${String(facts.rows)} rows, head ${String(facts.headHeight)}, offset ${String(facts.offsetTop)} — ${String(facts.line)}`);
    }

    // The author's own line is the second row on the phone, never a third.
    let authorRow = null;
    if (width === PHONE) {
      await cdp.evaluate('window.__head.author(true)');
      const withAuthor = await measure(cdp, 'fixing');
      const authorExpected = await cdp.evaluate(`window.__head.expected('fixing', ${String(width)}, true)`, false);
      authorRow = { rows: withAuthor.rows, text: withAuthor.line, expected: authorExpected };
      if (withAuthor.rows === null || withAuthor.rows > MAX_PHONE_ROWS) {
        violations.push(`author/${String(width)}: the line and the author's row take ${String(withAuthor.rows)} rows`);
      }
      if (withAuthor.line !== authorExpected) {
        violations.push(`author/${String(width)}: the line reads «${String(withAuthor.line)}», expected «${String(authorExpected)}»`);
      }
      await cdp.evaluate('window.__head.author(false)');
    }

    // --- the scrolled case: a chapter heading lands under the sticky head, not beneath it.
    await measure(cdp, ACTIVE);
    await cdp.evaluate("document.querySelector('#ch-2').scrollIntoView({ block: 'start', behavior: 'auto' }); true");
    await settle(cdp);
    const scrolled = await cdp.evaluate(PROBE);
    if (scrolled.scrolled <= 0) violations.push(`scrolled/${String(width)}: the page did not scroll`);
    if (scrolled.articleTop === null || scrolled.headingTop === null) {
      violations.push(`scrolled/${String(width)}: no chapter heading to measure`);
    } else {
      // The article lands at `scroll-margin-top: --offset-top`; its heading starts inside it and
      // must be below the sticky head's lower edge — never under the head.
      if (!Number.isFinite(scrolled.offsetTop) || Math.abs(scrolled.articleTop - scrolled.offsetTop) > 2) {
        violations.push(`scrolled/${String(width)}: the chapter (${String(scrolled.articleTop)}) did not land at --offset-top (${String(scrolled.offsetTop)})`);
      }
      if (scrolled.headBottom === null || scrolled.headingTop < scrolled.headBottom - DELTA_PX) {
        violations.push(`scrolled/${String(width)}: the chapter heading (${String(scrolled.headingTop)}) is under the sticky head (${String(scrolled.headBottom)})`);
      }
      // The sticky head is still on screen and keeps its three facts while scrolled.
      violations.push(...offsetViolations(`scrolled/${String(width)}`, scrolled), ...factsViolations(`scrolled/${String(width)}`, scrolled));
    }
    await cdp.evaluate('window.scrollTo(0, 0); true');
    await settle(cdp);

    report.widths.push({
      width,
      idle: { headHeight: idleFacts.headHeight, offsetTop: idleFacts.offsetTop, offsetMinusHead: idleFacts.offsetTop - idleFacts.headHeight, line: idleFacts.lineNode, facts: { brand: idleFacts.brand?.text, chapter: idleFacts.chapterW?.text, page: idleFacts.folio?.text }, shot: idleShot },
      active: {
        headHeight: activeFacts.headHeight,
        offsetTop: activeFacts.offsetTop,
        offsetMinusHead: activeFacts.offsetTop - activeFacts.headHeight,
        grewBy,
        rows: activeFacts.rows,
        line: activeFacts.line,
        rowRect: activeFacts.rowRect,
        lineRect: activeFacts.lineRect,
        overlap: activeFacts.overlap,
        firstTop: activeFacts.firstTop,
        firstTopMovedBy: movedBy,
        shot: activeShot,
      },
      states,
      authorRow,
      scrolled: { scrollY: scrolled.scrolled, articleTop: scrolled.articleTop, headingTop: scrolled.headingTop, headBottom: scrolled.headBottom, offsetTop: scrolled.offsetTop },
    });
  }

  // The idle page has no line at all: no node, no placeholder, nothing reserved.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: PHONE, height: 844, deviceScaleFactor: 1, mobile: true });
  await idle(cdp);
  const empty = await cdp.evaluate("document.querySelector('.head-line') === null");
  if (empty !== true) violations.push('idle: the page still holds a .head-line node');
  report.idleEmpty = empty;
  report.pass = violations.length === 0;
  report.violations = violations;
  report.chrome = chromiumBinary();
  report.shots = ['390-idle.png', '390-active.png', '1440-idle.png', '1440-active.png'];

  writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) {
    for (const violation of violations) process.stderr.write(`head:cdp: ${violation}\n`);
  }
} finally {
  cdp?.close();
  if (browser !== null) killTree(browser.child);
  await server.close();
  // Chromium's own profile files may still be closing: a leftover temp dir is not a failure.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* the OS cleans the temp dir */
  }
}

process.exit(violations.length === 0 ? 0 : 1);
