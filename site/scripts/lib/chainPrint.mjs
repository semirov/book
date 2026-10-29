/**
 * lib/chainPrint.mjs — the machinery `scripts/chain-print-cdp.mjs` measures with.
 *
 * Two halves, both local-only:
 *   • **the store**: one write in the temp copy — the block rows and the chapter row the API
 *     serves, the content-addressed snapshot, and the `revisions` row the bridge narrates as
 *     `chapter:applied` (`engineState/applied.ts` derives the patch from rev and rev−1);
 *   • **the page**: one sampler (the paragraph, the run's first glyph, both carets, the ink, the
 *     frame the page received) and the numbers the contract is made of — caret onset, px/s,
 *     the chain gap.
 *
 * The parser is the server's own (`server/dist/ingest/parseChapter.js`), installed after the
 * build: the block ids and `chars` the snapshot is written with are the ones the site reads.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { setTimeout as sleep } from 'node:timers/promises';

// ── the store ──────────────────────────────────────────────────────────────────────────────

export function openDb(dir) {
  const db = new DatabaseSync(join(dir, 'data', 'book.db'));
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/** A step to attribute the replayed write to: the chapter's own, else any (the frame needs one). */
export function pickStepId(dir, chapter) {
  const db = openDb(dir);
  try {
    const own = db.prepare('SELECT step_id FROM steps WHERE chapter = ? ORDER BY at DESC LIMIT 1').get(chapter);
    if (own !== undefined) return own.step_id;
    const any = db.prepare('SELECT step_id FROM steps ORDER BY at DESC LIMIT 1').get();
    if (any === undefined) throw new Error('the copy has no `steps` row to attribute a write to');
    return any.step_id;
  } finally {
    db.close();
  }
}

let parseChapter = null;

/** The server's own chapter parser, from the bundle the run just built. */
export function installParser(module) {
  if (typeof module.parseChapter !== 'function') throw new Error('parseChapter.js exports no parseChapter');
  parseChapter = module.parseChapter;
}

/**
 * The copy's pre-image for the chapter's latest revision. This volume keeps no `versions/`
 * directory at all (the rows name snapshots that are not on disk), so `readApplied` would call
 * every frame truncated and the page would print nothing. The text is rebuilt from the block
 * rows the API itself serves — title line, then the paragraphs — and written at the path the
 * row names; the parse of it is then compared with those rows, so a rebuild that drifts fails
 * loudly instead of printing a delta against a sentence nobody wrote.
 */
export function ensureLatestSnapshot(dir, chapter) {
  if (parseChapter === null) throw new Error('installParser() must run before the first write');
  const db = openDb(dir);
  try {
    const latest = db.prepare('SELECT rev, snapshot FROM revisions WHERE chapter = ? ORDER BY rev DESC LIMIT 1').get(chapter);
    if (latest === undefined) throw new Error(`chapter ${chapter} has no revision`);
    const chapterRow = db.prepare('SELECT title FROM chapters WHERE n = ?').get(chapter);
    const rows = db.prepare('SELECT id, text FROM blocks WHERE chapter = ? ORDER BY idx').all(chapter);
    const text =
      (chapterRow?.title ? `${chapterRow.title}\n\n` : '') + rows.map((row) => row.text).join('\n\n');
    const parsed = parseChapter(chapter, text);
    const same =
      parsed.blocks.length === rows.length &&
      parsed.blocks.every((block, index) => block.id === rows[index].id && block.text === rows[index].text);
    const file = join(dir, 'data', latest.snapshot);
    const restored = !existsSync(file);
    if (restored) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, 'utf8');
    }
    return {
      rev: latest.rev,
      snapshot: latest.snapshot,
      restored,
      blocks: rows.length,
      rebuiltMatchesServedRows: same,
      rebuiltDiff: same
        ? null
        : { parsed: parsed.blocks.slice(0, 3).map((block) => block.id), served: rows.slice(0, 3).map((row) => row.id) },
    };
  } finally {
    db.close();
  }
}

/**
 * One write in one transaction: the snapshot of the new text, the block rows and the chapter
 * row the API serves, then the `revisions` row. Nothing outside `dir` is touched.
 */
export function writeRevision(dir, chapter, { phrase, replacement, at, stepId }) {
  if (parseChapter === null) throw new Error('installParser() must run before the first write');
  const db = openDb(dir);
  try {
    const latest = db
      .prepare('SELECT rev, snapshot FROM revisions WHERE chapter = ? ORDER BY rev DESC LIMIT 1')
      .get(chapter);
    if (latest === undefined) throw new Error(`chapter ${chapter} has no revision to write against`);
    const previous = readFileSync(join(dir, 'data', latest.snapshot), 'utf8');
    const occurrences = previous.split(phrase).length - 1;
    if (occurrences !== 1) throw new Error(`"${phrase}" occurs ${occurrences} times in chapter ${chapter}, expected once`);
    const text = previous.replace(phrase, replacement);
    const parsed = parseChapter(chapter, text);
    const snapshot = join(dirname(latest.snapshot), `${parsed.sha256}.md`);
    writeFileSync(join(dir, 'data', snapshot), text, 'utf8');
    const rev = latest.rev + 1;
    const atIso = new Date(at).toISOString();

    db.exec('BEGIN IMMEDIATE');
    const firstRev = new Map(
      db.prepare('SELECT id, first_rev FROM blocks WHERE chapter = ?').all(chapter).map((row) => [row.id, row.first_rev]),
    );
    db.prepare('DELETE FROM blocks WHERE chapter = ?').run(chapter);
    const insertBlock = db.prepare(
      'INSERT INTO blocks (id, chapter, idx, text, hash, first_rev, last_rev) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const block of parsed.blocks) {
      insertBlock.run(block.id, chapter, block.i, block.text, block.hash, firstRev.get(block.id) ?? rev, rev);
    }
    db.prepare('UPDATE chapters SET rev = ?, sha256 = ?, chars = ?, block_count = ?, updated_at = ? WHERE n = ?').run(
      rev,
      parsed.sha256,
      parsed.chars,
      parsed.blocks.length,
      atIso,
      chapter,
    );
    db.prepare(`INSERT INTO revisions
        (chapter, rev, at, kind, cause_kind, change_id, cascade_id, step_id, added, changed, removed,
         snapshot, attributed, hseq)
        VALUES (?, ?, ?, 'edit', 'change', NULL, NULL, ?, 0, 1, 0, ?, 1, NULL)`).run(
      chapter,
      rev,
      atIso,
      stepId,
      snapshot,
    );
    db.exec('COMMIT');
    return { rev, at, atIso, snapshot, chars: parsed.chars, blocks: parsed.blocks.length, phrase, replacement };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* nothing open */
    }
    throw error;
  } finally {
    db.close();
  }
}

export function storedRevisions(dir, chapter, limit = 12) {
  const db = new DatabaseSync(join(dir, 'data', 'book.db'), { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT rev, at, step_id, snapshot FROM revisions WHERE chapter = ? ORDER BY rev DESC LIMIT ?')
      .all(chapter, limit);
    return rows.map((row) => ({ rev: row.rev, at: row.at, stepId: row.step_id, snapshot: row.snapshot }));
  } finally {
    db.close();
  }
}

let readApplied = null;

/** The server's own frame reader, from the same bundle: the probe the report leans on. */
export function installApplied(module) {
  if (typeof module.readApplied !== 'function') throw new Error('applied.js exports no readApplied');
  readApplied = module.readApplied;
}

/** What the bundled reader makes of one revision, with the copy's own data dir. */
export function probeApplied(dir, chapter, rev) {
  if (readApplied === null) throw new Error('installApplied() must run before the probe');
  const db = openDb(dir);
  try {
    const read = readApplied({ db, dataDir: join(dir, 'data'), chapter, rev });
    if (read === null) return null;
    return {
      rev: read.rev,
      appliedAt: read.appliedAt,
      patchTruncated: read.patchTruncated,
      patch: read.patch.length,
      span: read.span === null ? null : read.span.length,
    };
  } finally {
    db.close();
  }
}

// ── the page ───────────────────────────────────────────────────────────────────────────────

/** One in-page reading: the paragraph, the run's first glyph, both carets, the ink, the frame. */
export const SAMPLE_SOURCE = String.raw`
(locator) => {
  const node = Array.from(document.querySelectorAll('p[data-block-id]'))
    .find((item) => (item.textContent || '').includes(locator)) || null;
  const t = Date.now();
  if (node === null) return { t, found: false };
  const box = node.getBoundingClientRect();
  const caret = (selector) => {
    const el = node.querySelector(selector);
    if (el === null) return { count: 0, opacity: null, left: null, top: null, visible: false };
    const opacity = Number(getComputedStyle(el).opacity);
    const rect = el.getBoundingClientRect();
    return {
      count: 1,
      opacity: Number.isFinite(opacity) ? opacity : null,
      left: Math.round(rect.left * 100) / 100,
      top: Math.round(rect.top * 100) / 100,
      visible:
        Number.isFinite(opacity) && opacity > 0.05 && rect.left >= -2 &&
        rect.left <= window.innerWidth + 2 && rect.top >= -2 && rect.top <= window.innerHeight + 2,
    };
  };
  const first = node.querySelector('.pass-span .pg');
  const firstRect = first === null ? null : first.getBoundingClientRect();
  const frames = window.__frames || [];
  let applied = null;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    if (frames[i].type === 'chapter:applied') { applied = frames[i]; break; }
  }
  return {
    t,
    found: true,
    blockId: node.getAttribute('data-block-id'),
    pass: node.classList.contains('p-pass'),
    beat: node.getAttribute('data-pass'),
    pending: node.querySelectorAll('.pg.is-pending').length,
    clusters: node.querySelectorAll('.pg').length,
    passSpan: node.querySelector('.pass-span') !== null,
    ticks: node.querySelectorAll('.pass-tick').length,
    carets: { read: caret('.caret-read'), write: caret('.caret-write') },
    firstGlyphLeft: firstRect === null ? null : Math.round(firstRect.left * 100) / 100,
    rect: { top: Math.round(box.top * 100) / 100, height: Math.round(box.height * 100) / 100 },
    animations: node.getAnimations({ subtree: true }).filter((item) => item.playState === 'running').length,
    applied: applied === null ? null : { n: applied.n, rev: applied.rev, appliedAt: applied.appliedAt, receivedAt: applied.t },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}`;

/**
 * The frame watcher, injected before any page script: it records **when** `chapter:applied`
 * reached the page. That is the only honest split between the bridge's 500 ms poll (a fixture
 * of a replayed write) and the client's own mount time.
 */
export const WATCH_SOURCE = String.raw`
(() => {
  window.__frames = [];
  const proto = WebSocket.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'onmessage');
  if (desc === undefined || desc.set === undefined) return;
  Object.defineProperty(proto, 'onmessage', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(handler) {
      const wrapped = function (event) {
        try {
          const frame = JSON.parse(String(event.data));
          const entry = { type: frame.type || null, seq: frame.seq ?? null, t: Date.now() };
          if (frame.type === 'chapter:applied' && frame.data) {
            entry.n = frame.data.n;
            entry.rev = frame.data.rev;
            entry.appliedAt = frame.data.appliedAt;
            entry.patchTruncated = frame.data.patchTruncated === true;
            entry.spanLength = Array.isArray(frame.data.span) ? frame.data.span.length : null;
            entry.patchLength = Array.isArray(frame.data.patch) ? frame.data.patch.length : null;
          }
          window.__frames.push(entry);
          if (window.__frames.length > 500) window.__frames.splice(0, 250);
        } catch { /* not our frame */ }
        return handler.call(this, event);
      };
      desc.set.call(this, wrapped);
    },
  });
})();`;

export async function sample(cdp, locator) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(${SAMPLE_SOURCE})(${JSON.stringify(locator)})`,
    returnByValue: true,
  });
  if (result.exceptionDetails !== undefined) {
    throw new Error(`the probe threw: ${result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails)}`);
  }
  return result.result.value;
}

/** Sample every ~50 ms until `done(samples, state)`, then answer the window. `onSample` is
 * awaited after each reading, so a screenshot can be taken inside a live print (the only way
 * to photograph both carets: they are gone at settle). */
export async function collect(cdp, locator, { sampleMs, timeoutMs, done, onSample }) {
  const samples = [];
  const started = Date.now();
  for (;;) {
    const state = await sample(cdp, locator);
    samples.push(state);
    if (onSample !== undefined) await onSample(state, samples);
    if (done(samples, state) === true) return samples;
    if (Date.now() - started > timeoutMs) return samples;
    await sleep(sampleMs);
  }
}

/** The renderer unmounted itself: the pass was seen and is gone again. */
export const untilSettled = (samples, state) =>
  state.found === true && state.pass === false && samples.some((item) => item.pass === true);

/** The last `chapter:applied` the page recorded for one revision, if it arrived. */
export async function frameFor(cdp, rev) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: `(window.__frames || []).filter((frame) => frame.type === 'chapter:applied' && frame.rev === ${Number(rev)}).at(-1) ?? null`,
    returnByValue: true,
  });
  return result.result.value ?? null;
}

export async function waitFrame(cdp, rev, timeoutMs = 3_000) {
  const started = Date.now();
  for (;;) {
    const frame = await frameFor(cdp, rev);
    if (frame !== null) return frame;
    if (Date.now() - started > timeoutMs) return null;
    await sleep(20);
  }
}

// ── numbers out of the samples ─────────────────────────────────────────────────────────────

const round = (value) => (value === null || value === undefined ? null : Math.round(value * 10) / 10);

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * px/s between consecutive samples that both see the caret fully lit. The birth fade-in and the
 * departure fade-out are opacity, not travel (the caret rests at its last line while it fades),
 * so they are not slope samples; a coarse gap is not one either.
 */
export function rateOf(samples, key) {
  const rates = [];
  const lit = (caret) => caret.visible === true && caret.opacity !== null && caret.opacity >= 0.98;
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1].carets[key];
    const after = samples[index].carets[key];
    if (lit(before) !== true || lit(after) !== true) continue;
    const dt = (samples[index].t - samples[index - 1].t) / 1_000;
    if (dt <= 0 || dt > 0.2) continue;
    rates.push((after.top - before.top) / dt);
  }
  const seen = samples.filter((item) => item.carets[key].visible === true);
  const lefts = seen.map((item) => item.carets[key].left);
  const firstTop = seen[0]?.carets[key].top ?? null;
  const lastTop = seen.at(-1)?.carets[key].top ?? null;
  // The write caret's x advances with the ink *on its line*: a wrap puts it back at the line's
  // start, which is travel, not a retreat. So the advance is the largest step taken without
  // changing line, and a wrap is reported beside it instead of being read as a reversal.
  let advancePx = 0;
  let wraps = 0;
  for (let index = 1; index < seen.length; index += 1) {
    const before = seen[index - 1].carets[key];
    const after = seen[index].carets[key];
    const step = after.left - before.left;
    if (Math.abs(after.top - before.top) > 1) {
      if (step < -1) wraps += 1;
      continue;
    }
    if (step > advancePx) advancePx = step;
  }
  return {
    advancePx: round(advancePx),
    wraps,
    medianPxPerSec: round(median(rates)),
    pairs: rates.length,
    leftFirst: round(lefts[0] ?? null),
    leftLast: round(lefts.at(-1) ?? null),
    leftMedian: round(median(lefts)),
    topFirst: firstTop,
    topLast: lastTop,
    travelPx: firstTop === null || lastTop === null ? null : round(lastTop - firstTop),
  };
}

/**
 * The caret window inside one print: onset against the write's clock and against the frame's
 * arrival, both carets' rates, and the run's first glyph (the blue caret's own column).
 */
export function caretWindow(samples, applied) {
  const visibleAt = (key) => samples.find((item) => item.carets[key].visible === true)?.t ?? null;
  const readAt = visibleAt('read');
  const writeAt = visibleAt('write');
  const from = (time, origin) => (time === null || origin === null || origin === undefined ? null : time - origin);
  return {
    onsetFromApplied: {
      read: from(readAt, applied?.appliedAt),
      write: from(writeAt, applied?.appliedAt),
    },
    onsetFromFrame: { read: from(readAt, applied?.receivedAt), write: from(writeAt, applied?.receivedAt) },
    firstGlyphLeft: round(median(samples.map((item) => item.firstGlyphLeft).filter((value) => value !== null))),
    read: rateOf(samples, 'read'),
    write: rateOf(samples, 'write'),
    bothVisibleSamples: samples.filter((item) => item.carets.read.visible && item.carets.write.visible).length,
    goneAtSettle: samples.at(-1)?.pass === false && samples.at(-1)?.carets.read.count === 0 && samples.at(-1)?.carets.write.count === 0,
    settledAt: samples.at(-1)?.t ?? null,
  };
}
