/**
 * lib/theatrePage.mjs — the page surface `scripts/theatre-cdp.mjs` and the theatre's checks
 * drive: one CDP connection, `window.__theatre`'s three commands, and the plates.
 *
 * The harness is the page; this file never reaches into the DOM itself — every number comes from
 * `window.__theatre.snapshot()`, so the driver and the check list can never disagree about what
 * was measured. `openPage` is the only place a width and a media query are set.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** The harness page, relative to the Vite root (`web/`). */
export const PAGE = '/harness/theatre.html';

/* ------------------------------------------------------------------- the page ---- */

export const call = (cdp, expression) => cdp.evaluate(expression);
export const snapshot = (cdp, options) =>
  call(cdp, `window.__theatre.snapshot(${options === undefined ? '' : JSON.stringify(options)})`);
export const act = (cdp, name, options) =>
  call(cdp, `window.__theatre.act(${JSON.stringify(name)}, ${JSON.stringify(options ?? {})})`);

export async function openPage(cdp, origin, width, height, reduced = false) {
  await cdp.send('Emulation.setEmulatedMedia', {
    features: reduced ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [],
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp.send('Page.navigate', { url: `${origin}${PAGE}` });
  const deadline = Date.now() + 25_000;
  for (;;) {
    const ready = await call(cdp, 'document.body.dataset.harnessReady === "true"').catch(() => false);
    if (ready === true) break;
    if (Date.now() > deadline) throw new Error('the harness never became ready');
    await sleep(60);
  }
  await call(cdp, 'document.fonts.ready.then(() => true)');
  await call(cdp, 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))');
  // The brand row proves the real page shell is up; the head's own word is main's `HeadLine`,
  // which prints only while a frame gives it something true to say — a plate reads it then.
  const shell = await call(cdp, 'document.querySelector(".top-row .brand")?.textContent ?? null');
  if (shell === null) throw new Error('the page shell never mounted — the harness is not the real page');
  return call(cdp, 'document.querySelector(".head-line")?.textContent ?? null');
}

export const sameGrid = (left, right, eps = 0.01) => {
  if (left === null || right === null) return false;
  if (left.tops.length !== right.tops.length) return false;
  return left.tops.every((top, index) => Math.abs(top - (right.tops[index] ?? 0)) <= eps)
    && left.lefts.every((leftEdge, index) => Math.abs(leftEdge - (right.lefts[index] ?? 0)) <= eps);
};

const gridDelta = (left, right) => Math.max(
  0,
  ...left.tops.map((top, index) => Math.abs(top - (right.tops[index] ?? Number.NaN))),
  ...left.lefts.map((edge, index) => Math.abs(edge - (right.lefts[index] ?? Number.NaN))),
);

export const stats = (values) => {
  if (values.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] * 100) / 100;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: Math.round(sorted.at(-1) * 100) / 100 };
};

/* ---------------------------------------------------------------- the plates ---- */

/**
 * The eight acts, plus the arrival after its fill (and under reduced motion), and the writing
 * act under reduced motion. The **writing** plate is main's print (`PrintPass`), inked from the
 * write's own `appliedAt`; the theatre adds the spine and the margin, never a second print.
 */
export const PLATES = [
  { name: 'arrival', act: 'arrival', options: { back: 4_000 } },
  /**
   * After the fill. 57 words are a 14 869 ms sweep: mounting 869 ms before its end and waiting
   * 1.5 s is the settled state, not a late reader — the chain ran and stopped on its own frame.
   */
  { name: 'arrival-settled', act: 'arrival', options: { back: 14_000 }, wait: 1_500 },
  { name: 'thinking', act: 'thinking' },
  { name: 'verdict', act: 'verdict' },
  { name: 'queue', act: 'queue' },
  { name: 'writing', act: 'writing', options: { back: 250 } },
  { name: 'checking', act: 'checking' },
  /** The rule is still standing: the lift starts 120 ms after the sink, the plate stops at 60. */
  { name: 'landing', act: 'landing', options: { freeze: true }, wait: 60 },
  { name: 'landing-lifted', act: 'landing' },
  { name: 'failure-fault', act: 'failure-fault' },
  { name: 'failure-verdict', act: 'failure-verdict' },
  { name: 'arrival-reduced', act: 'arrival', options: { back: 1_200 }, reduced: true },
  { name: 'writing-reduced', act: 'writing', options: { back: 250 }, reduced: true },
];

export async function plate(cdp, origin, width, height, plateSpec, shots) {
  await openPage(cdp, origin, width, height, plateSpec.reduced === true);
  const snap = await act(cdp, plateSpec.act, plateSpec.options);
  if (plateSpec.wait !== undefined) await sleep(plateSpec.wait);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = `${plateSpec.name}-${String(width)}.png`;
  writeFileSync(join(shots, file), Buffer.from(shot.data, 'base64'));
  const lines = snap.grid?.lines ?? snap.theatre?.lines ?? 0;
  return {
    file,
    act: snap.act?.kind ?? null,
    outcome: snap.act?.outcome ?? null,
    cause: snap.act?.cause ?? null,
    lines,
    overlay: snap.theatre?.nodes ?? 0,
    tallies: snap.theatre?.tallies.length ?? 0,
    head: snap.head,
  };
}

/** A contact sheet of the individual captures: the states at 1:1, never composed onto one page. */
export async function contactSheet(cdp, entries, width, height, file, shots) {
  const tiles = entries.map((entry) => {
    const path = join(shots, entry.label);
    return { label: entry.label, data: existsSync(path) ? readFileSync(path).toString('base64') : '' };
  });
  const columns = width < 600 ? 3 : 2;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#cfd3d2;font:12px/1.4 'PT Mono',monospace;color:#4e5455}
    .sheet{display:grid;grid-template-columns:repeat(${String(columns)},${String(width)}px);gap:18px;padding:18px}
    figure{margin:0}figcaption{padding:4px 0 0}
    img{display:block;width:${String(width)}px;height:${String(height)}px;outline:1px solid #a6adac}
  </style></head><body><div class="sheet">${tiles
    .map((tile) => `<figure><img src="data:image/png;base64,${tile.data}"><figcaption>${tile.label.replace(/\.png$/u, '')}</figcaption></figure>`)
    .join('')}</div></body></html>`;
  const rows = Math.ceil(tiles.length / columns);
  const sheetWidth = columns * width + 18 * (columns + 1);
  const sheetHeight = rows * (height + 26) + 18 * (rows + 1);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: sheetWidth, height: sheetHeight, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.setDocumentContent', { frameId: (await cdp.send('Page.getFrameTree')).frameTree.frame.id, html });
  await sleep(400);
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: sheetWidth, height: sheetHeight, scale: 1 },
  });
  writeFileSync(join(shots, file), Buffer.from(shot.data, 'base64'));
  return { file, width: sheetWidth, height: sheetHeight };
}
