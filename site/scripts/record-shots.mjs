#!/usr/bin/env node
/**
 * scripts/record-shots.mjs — the §11.3 record and margin, in a real browser, at both widths.
 *
 * The owner's screenshot showed one filing three times on one screen and two `вмешаться`. The
 * jsdom claims are in `recordRules.dom.test.tsx`; this script takes the pictures and prints the
 * same counts from the painted page, so the claim is not only asserted but seen.
 *
 *   node scripts/record-shots.mjs [--verbose]
 *
 * Writes `shots/live/record/{390,1440}-{margin,record}.png` and one JSON report. The harness
 * answers with a real filing of ours that did not reach the text (`?state=refused`), its
 * change's number and the pass's roll-back sentence.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Cdp, chromiumBinary, killTree, launchChromium } from './lib/cdp.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');
const PAGE = '/harness/accordion.html?rows=1&state=refused';
const SHOT_DIR = join(ROOT, 'shots', 'live', 'record');
const WIDTHS = [390, 1440];
const HEIGHT = 900;
const VERBOSE = process.argv.includes('--verbose');

function log(...parts) {
  if (VERBOSE) process.stderr.write(`${parts.join(' ')}\n`);
}

/** One port nothing listens on: Chromium's debugging endpoint needs a number, not `0`. */
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

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
  if (address === null || typeof address !== 'object') throw new Error('the dev server did not bind a port');
  return { server, origin: `http://127.0.0.1:${String(address.port)}` };
}

async function shoot(cdp, width, name) {
  mkdirSync(SHOT_DIR, { recursive: true });
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(SHOT_DIR, `${String(width)}-${name}.png`);
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  return path;
}

/** The painted page's own counts: the mark, the act and the filing's one mention. */
const COUNTS = `(() => {
  const text = (node) => (node.textContent ?? '').trim();
  const painted = (node) => { const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
  const nodes = [...document.querySelectorAll('body *')].filter(painted);
  const acts = nodes.filter((node) => text(node) === 'вмешаться' && node.children.length === 0);
  // The number is painted only where its own element has a box: at 390 the mark is a tick and
  // the numeral lives in the strip; at 1440 the numeral is the mark and the strip is hidden.
  const numerals = [...document.querySelectorAll('p.p .filing-mark-num, p.p .phone-strip-n')].filter(painted);
  const marginNodes = [...document.querySelectorAll('p.p .margin-note')].filter(painted);
  const margin = [...numerals, ...marginNodes].map((node) => {
    const copy = node.cloneNode(true);
    for (const hidden of [...copy.querySelectorAll('.filing-mark-num, .phone-strip-n')]) if (!painted(hidden)) hidden.remove();
    return (copy.textContent ?? '').trim();
  }).join(' ');
  return {
    acts: acts.length,
    marks: [...document.querySelectorAll('p.p .filing-mark')].filter(painted).map((node) => {
      const numeral = node.querySelector('.filing-mark-num');
      return numeral !== null && painted(numeral) ? text(numeral) : 'tick';
    }),
    notes: [...document.querySelectorAll('p.p .margin-note')].filter(painted).map((node) => text(node)),
    strip: [...document.querySelectorAll('p.p .phone-strip-row')].filter(painted).map((node) => text(node)),
    marginText: margin,
    numberMentions: (margin.match(/004/gu) ?? []).length,
    idTokens: (margin.match(/№/gu) ?? []).length,
    record: document.querySelector('.rec')?.getAttribute('data-situation') ?? null,
    head: text(document.querySelector('.rec-state') ?? document.createElement('i')),
    stateLine: text(document.querySelector('.rec-state-line') ?? document.createElement('i')),
    sections: [...document.querySelectorAll('.rec-section-label')].map((node) => text(node)),
  };
})()`;

const report = { pass: true, widths: {}, shots: [] };

let browser = null;
let vite = null;
let profile = null;
try {
  ({ server: vite, origin: report.origin } = await serve());
  profile = mkdtempSync(join(tmpdir(), 'record-shots-'));
  const binary = chromiumBinary();
  const launched = await launchChromium({
    binary,
    cdpPort: await freePort(),
    profileDir: profile,
    windowSize: `${String(WIDTHS[0])},${String(HEIGHT)}`,
  });
  browser = launched.child;
  const cdp = await Cdp.open(launched.pageUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  for (const width of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: width < 1024,
    });
    await cdp.send('Page.navigate', { url: `${report.origin}${PAGE}` });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const ready = await cdp.evaluate('window.__accordion?.ready?.() === true', false).catch(() => false);
      if (ready === true) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    await cdp.evaluate('document.fonts.ready.then(() => true)');
    await cdp.evaluate('window.scrollTo(0, 0)');
    await cdp.evaluate('window.__accordion.wait(120)');
    report.shots.push(await shoot(cdp, width, 'margin'));

    // The record opens on the first sentence: the margin's act hides, the record's stands.
    await cdp.evaluate('window.__accordion.open(1)');
    await cdp.evaluate('window.__accordion.wait(600)');
    const counts = await cdp.evaluate(COUNTS);
    report.widths[width] = counts;
    log(String(width), JSON.stringify(counts));
    if (counts.acts !== 1) {
      report.pass = false;
      report.fail = `${String(width)}: ${String(counts.acts)} «вмешаться» nodes`;
    }
    if (counts.marks.length !== 1) {
      report.pass = false;
      report.fail = `${String(width)}: ${String(counts.marks.length)} margin marks`;
    }
    if (counts.numberMentions > 1 || counts.idTokens !== 0) {
      report.pass = false;
      report.fail = `${String(width)}: the filing is named ${String(counts.numberMentions)} times in the margin, tokens ${String(counts.idTokens)}`;
    }
    // The record in view, under the sentence it speaks about.
    await cdp.evaluate(`(() => { const block = document.querySelector('.rec'); if (block !== null) window.scrollTo(0, block.getBoundingClientRect().top + window.scrollY - 24); return true; })()`);
    await cdp.evaluate('window.__accordion.wait(200)');
    report.shots.push(await shoot(cdp, width, 'record'));
  }
  cdp.close();
} catch (error) {
  report.pass = false;
  report.fail = error instanceof Error ? error.message : String(error);
} finally {
  if (browser !== null) killTree(browser);
  if (vite !== null) await vite.close();
  if (profile !== null) {
    // The profile is still being flushed when the browser's group dies: give it a moment, and
    // a locked file is not a reason to lose the report.
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* a scratch profile left in the temp dir is not a failure of the shots */
    }
  }
}

mkdirSync(SHOT_DIR, { recursive: true });
writeFileSync(join(SHOT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.pass ? 0 : 1);
