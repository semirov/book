/**
 * scripts/lib/frame.mjs — the frozen frame (F029) checked against the three places it now lives
 * (BOOK-107, BOOK-187 / ADR-043 G6).
 *
 * The canon lives once, in `shared/src/book.ts`; this module imports those two sentences and never
 * restates them. Since v23 there is no file in the chain — the manuscript leg is deleted with the
 * prose, because the volume is the book (ADR-043 G2):
 *
 *   1. **the letters** — the sentence the image compiles in, against the `book_frame` row the
 *      volume holds, by `text` *and* by `sha256`. Exact: no whitespace flattening, the letters are
 *      the letters;
 *   2. **that both rows are there** — `book_frame` holds exactly `1/first` and `42/last`;
 *   3. **that it is where it belongs** — ch01's first block opens with `1/first` and ch42's last
 *      block closes with `42/last`, offsets counted in code points, plus the frame's mention span
 *      when a row marks it (the block's text at those offsets must be the row's text);
 *   4. **what a reader gets** — `checkServer` asks the running site the same two questions.
 *
 * A fresh database has the two rows before it has prose, so legs 3 and 4 have nothing to say about
 * an empty chapter and must not fail: an empty slot is a basis slot, not a broken frame.
 *
 * Every check is a plain object `{label, ok, parts}`, so the CLI and the tests print the same words
 * and no reader of the output has to know which source failed. Read-only by construction: the
 * connection is opened `{readonly: true, fileMustExist: true}` — nothing here writes, creates or
 * migrates.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, OPENING_CHAPTER, TOTAL_CHAPTERS } from '../../shared/src/book.ts';

/** The two sentences, under the names the checks use. */
export const FRAME = {
  first: FRAME_FIRST_SENTENCE,
  last: FRAME_LAST_SENTENCE,
};

/** The two rows the frame is, in the order the checks report them. */
const FRAME_ROWS = [
  { chapter: OPENING_CHAPTER, position: 'first', text: FRAME_FIRST_SENTENCE },
  { chapter: TOTAL_CHAPTERS, position: 'last', text: FRAME_LAST_SENTENCE },
];

/** One attempt per request: a health check has no retry loop (deploy.sh runs this once). */
export const CHAPTER_TIMEOUT_MS = 10_000;
/**
 * The whole check's budget. Two chapters at 10 s each would fit in 20 s, and the deploy allows
 * 30 s including node's start; one deadline makes that arithmetic hold even if a request hangs
 * past its own bound, and a chapter that starts with nothing left is reported as `timeout`.
 */
export const TOTAL_TIMEOUT_MS = 25_000;

/** `sha256` in hex, the same digest the migration writes into `book_frame.sha256`. */
export function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/** A string's length and slices in **code points**, the unit `book_frame` offsets are written in. */
function codePoints(text) {
  return Array.from(String(text ?? ''));
}

function sliceCp(text, start, end) {
  return codePoints(text).slice(start, end).join('');
}

/** `ch01`/`ch42` — the chapter names the labels print. */
function chapterName(n) {
  return `ch${String(n).padStart(2, '0')}`;
}

function mismatch(label, expected, actual) {
  return { label, ok: false, parts: [{ expected, actual }] };
}

function rowName(chapter, position) {
  return `${String(chapter)}/${position}`;
}

/**
 * Leg 1 and 2: the compiled sentence against the row the volume holds, and both rows present.
 * A row is compared exactly — text first, then its hash — because a row that carries the same
 * hash and different text (or the reverse) is a row nobody wrote from this image.
 */
function frameRowChecks(rows, dbFile) {
  const byKey = new Map(rows.map((row) => [`${String(row.chapter)}/${row.position}`, row]));
  const checks = [];
  for (const wanted of FRAME_ROWS) {
    const key = rowName(wanted.chapter, wanted.position);
    const label = `book_frame ${key}`;
    const row = byKey.get(key);
    if (row === undefined) {
      checks.push(mismatch(label, wanted.text, `no book_frame row for ${key} in ${dbFile}`));
      continue;
    }
    const parts = [];
    if (row.text !== wanted.text) parts.push({ expected: wanted.text, actual: row.text });
    const expectedSha = sha256(wanted.text);
    // The hash is compared only when the letters agree: a row that differs in text is already
    // one mismatch, and its stored hash answers a question this check did not ask.
    if (row.text === wanted.text && row.sha256 !== expectedSha) {
      parts.push({ expected: expectedSha, actual: String(row.sha256) });
    }
    checks.push({ label, ok: parts.length === 0, parts });
  }
  const expected = FRAME_ROWS.map((row) => rowName(row.chapter, row.position)).join(', ');
  const actual = rows.length === 0 ? 'no rows' : rows.map((row) => rowName(row.chapter, row.position)).join(', ');
  checks.push(
    rows.length === FRAME_ROWS.length
      ? { label: 'book_frame rows', ok: true, parts: [] }
      : mismatch('book_frame rows', `${expected} (2 rows)`, `${actual} (${String(rows.length)} rows)`),
  );
  return checks;
}

/**
 * The frame's mention, when one marks it: a row on the frame block whose interval is the frame's
 * interval, or whose `witness` is the canon sentence. Its `start`/`end` must select exactly the
 * row's text from the **live** block — offsets written against other text are how a mention
 * survives an edit and starts pointing at the wrong words.
 */
function mentionChecks(db, chapter, position, block, interval, expectedText) {
  const rows = db.prepare('SELECT id, start, end, witness FROM mentions WHERE block_id = ? ORDER BY start').all(block.id);
  const candidates = rows.filter(
    (row) =>
      (row.start === interval.start && row.end === interval.end) || String(row.witness ?? '') === expectedText,
  );
  const checks = [];
  for (const row of candidates) {
    const selected = sliceCp(block.text, Number(row.start), Number(row.end));
    if (selected !== expectedText) {
      checks.push(
        mismatch(
          `mention ${rowName(chapter, position)} (mention ${String(row.id)})`,
          expectedText,
          `${selected} @ [${String(row.start)}, ${String(row.end)})`,
        ),
      );
    }
  }
  return checks;
}

/**
 * Leg 3: the frame where a reader meets it. ch01's first live block must open with `1/first` and
 * ch42's last block must close with `42/last`; a chapter with no blocks has no span to check and
 * says nothing. The expected words are the **compiled constant**, not the row: the row is leg 1's
 * business, and a check that compared the block with a tampered row would agree with the tampering.
 */
function spanChecks(db) {
  const checks = [];
  for (const wanted of FRAME_ROWS) {
    const hasBlocks = db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE chapter = ?').get(wanted.chapter);
    if (Number(hasBlocks?.n ?? 0) === 0) continue;
    const order = wanted.position === 'first' ? 'ASC' : 'DESC';
    const block = db
      .prepare(`SELECT id, text FROM blocks WHERE chapter = ? ORDER BY idx ${order} LIMIT 1`)
      .get(wanted.chapter);
    if (block === undefined) continue;
    const expected = wanted.text;
    const label = `frame span ${chapterName(wanted.chapter)} ${wanted.position} block`;
    const text = String(block.text ?? '');
    const expectedLength = codePoints(expected).length;
    const start = wanted.position === 'first' ? 0 : codePoints(text).length - expectedLength;
    const interval = { start, end: start + expectedLength };
    const edge =
      wanted.position === 'first'
        ? text.startsWith(expected)
        : text.endsWith(expected);
    checks.push({ label, ok: edge, parts: edge ? [] : [{ expected, actual: text }] });
    // Offsets are only meaningful when the edge is: a block that does not carry the sentence at
    // its edge is already one mismatch, not two.
    if (edge) checks.push(...mentionChecks(db, wanted.chapter, wanted.position, block, interval, expected));
  }
  return checks;
}

function readReadout(db) {
  const first = (chapter, order) => {
    const row = db.prepare(`SELECT text FROM blocks WHERE chapter = ? ORDER BY idx ${order} LIMIT 1`).get(chapter);
    return typeof row?.text === 'string' ? row.text : null;
  };
  const scan = db.prepare(`SELECT v FROM meta WHERE k = 'last_scan_at'`).get();
  return {
    ch01First: first(OPENING_CHAPTER, 'ASC'),
    lastFirst: first(TOTAL_CHAPTERS, 'ASC'),
    lastLast: first(TOTAL_CHAPTERS, 'DESC'),
    lastScanAt: typeof scan?.v === 'string' ? scan.v : null,
  };
}

/**
 * The three DB legs against `<dataDir>/book.db`, opened read-only. Returns the checks, the three
 * blocks the readout prints and `absent: true` when there is no database at all — a checkout, or
 * CI, has no volume, and "no book here" is a fact to print rather than a frame mismatch.
 */
export function checkFrame({ dataDir, DatabaseImpl = Database }) {
  const dir = String(dataDir);
  const file = join(dir, 'book.db');
  if (!existsSync(file)) return { dataDir: dir, checks: [], readout: null, absent: true };
  const fail = (reason) => ({
    dataDir: dir,
    absent: false,
    readout: null,
    checks: [mismatch(`frame database ${file}`, 'a book.db this check can read', reason)],
  });
  let db;
  try {
    db = new DatabaseImpl(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    return fail(`cannot open ${file} read-only: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'book_frame'`).get();
    if (table === undefined) {
      return fail(`${file} has no book_frame table (schema v22 or older): the frame rows arrive with v23`);
    }
    const rows = db
      .prepare('SELECT chapter, position, text, sha256 FROM book_frame ORDER BY chapter')
      .all();
    const checks = [...frameRowChecks(rows, file), ...spanChecks(db)];
    return { dataDir: dir, absent: false, readout: readReadout(db), checks };
  } catch (error) {
    // A file that is not this book's database is a mismatch with a reason, never a stack trace.
    return fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
  }
}

/** One chapter answer: its blocks, or the reason the site did not give any. */
async function fetchChapter(baseUrl, n, fetchImpl, deadline, now) {
  const remaining = deadline - now();
  // Nothing left of the budget: the deploy must not wait for a third attempt.
  if (remaining <= 0) return { error: 'timeout' };
  const url = `${baseUrl.replace(/\/+$/u, '')}/api/chapters/${String(n)}`;
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(Math.min(CHAPTER_TIMEOUT_MS, remaining)) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    if (timedOut) return { error: 'timeout' };
    return { error: `unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (response.status !== 200) {
    let code = '';
    try {
      const body = await response.json();
      if (typeof body?.code === 'string') code = ` ${body.code}`;
    } catch {
      // A non-JSON error page adds no code, only the status.
    }
    return { error: `${String(response.status)}${code}` };
  }
  try {
    const body = await response.json();
    return { blocks: Array.isArray(body?.blocks) ? body.blocks : [] };
  } catch (error) {
    return { error: `unreadable answer: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function answerCheck(label, kind, frame, answer) {
  if (answer.error !== undefined) return mismatch(label, frame, answer.error);
  const block = kind === 'first' ? answer.blocks[0] : answer.blocks[answer.blocks.length - 1];
  const text = typeof block?.text === 'string' ? block.text : '';
  if (text.length === 0) return mismatch(label, frame, 'no blocks in the answer');
  const ok = kind === 'first' ? text.startsWith(frame) : text.endsWith(frame);
  return { label, ok, parts: ok ? [] : [{ expected: frame, actual: text }] };
}

/**
 * The running site serves the frame: ch01's first block opens with it and the finale's last
 * block closes with it. A non-200 answer is a mismatch whose `actual` is the status and the code.
 * `now` is injected so a test can drive the deadline instead of waiting for a real timer.
 */
export async function checkServer({ baseUrl, fetchImpl = fetch, budgetMs = TOTAL_TIMEOUT_MS, now = () => Date.now() }) {
  const deadline = now() + budgetMs;
  const first = await fetchChapter(baseUrl, OPENING_CHAPTER, fetchImpl, deadline, now);
  const last = await fetchChapter(baseUrl, TOTAL_CHAPTERS, fetchImpl, deadline, now);
  return [
    answerCheck(`site /api/chapters/${String(OPENING_CHAPTER)}`, 'first', FRAME.first, first),
    answerCheck(`site /api/chapters/${String(TOTAL_CHAPTERS)}`, 'last', FRAME.last, last),
  ];
}
