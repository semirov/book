/**
 * scripts/lib/frame.mjs — the frozen frame (F029) read where the reader meets it (BOOK-107).
 *
 * The canon lives once, in `shared/src/book.ts`; this module imports those two sentences and
 * never restates them. Three sources are checked, each on the text the reader actually gets:
 * the manuscript file, the running site's `/api/chapters/:n` answer, and the data dir's
 * `blocks` table. Every check is a plain object `{label, ok, parts}`, so the CLI and the tests
 * print the same words and no reader of the output has to know which source failed.
 *
 * Read-only by construction: `readFileSync`, `fetch` and a sqlite connection opened
 * `{readonly: true, fileMustExist: true}` — nothing here writes, creates or migrates.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, parseChapterTitle } from '../../shared/src/book.ts';

/** The two sentences, under the names the checks use. */
export const FRAME = {
  first: FRAME_FIRST_SENTENCE,
  last: FRAME_LAST_SENTENCE,
};

/** One attempt per request: a health check has no retry loop (deploy.sh runs this once). */
export const CHAPTER_TIMEOUT_MS = 10_000;
/**
 * The whole check's budget. Two chapters at 10 s each would fit in 20 s, and the deploy allows
 * 30 s including node's start; one deadline makes that arithmetic hold even if a request hangs
 * past its own bound, and a chapter that starts with nothing left is reported as `timeout`.
 */
export const TOTAL_TIMEOUT_MS = 25_000;

/** Whitespace is not text: a rewrapped line and the frozen sentence compare as one string. */
export function flat(value) {
  return String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The prose starts with the frame — the same rule `isFrameLine` applies to a title line. */
export function startsWithFrame(text, frame = FRAME.first) {
  const actual = flat(text);
  const expected = flat(frame);
  return actual === expected || actual.startsWith(`${expected} `);
}

/** The prose ends with the frame. ch67 closes the book on these words. */
export function endsWithFrame(text, frame = FRAME.last) {
  const actual = flat(text);
  const expected = flat(frame);
  return actual === expected || actual.endsWith(` ${expected}`);
}

/** Paragraphs the way the ingest splits them: blank line, trimmed, empties dropped. */
function paragraphsOf(text) {
  return String(text ?? '')
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

function chapterName(n) {
  return `ch${String(n).padStart(2, '0')}`;
}

function matched(label, kind, frame, text, fallback) {
  if (text.length === 0) return { label, ok: false, parts: [{ expected: frame, actual: fallback }] };
  const ok = kind === 'first' ? startsWithFrame(text, frame) : endsWithFrame(text, frame);
  return { label, ok, parts: ok ? [] : [{ expected: frame, actual: text }] };
}

/**
 * `manuscript/ch01.md` must open with the frame and `manuscript/ch67.md` must close with it.
 * The title line is stripped by `parseChapterTitle`, so a written chapter with a title above
 * the frame still passes; a missing file is a mismatch, never a crash.
 */
export function checkManuscript({ repoRoot, readFile = readFileSync, fileExists = existsSync }) {
  const checks = [];
  for (const { label, n, kind } of [
    { label: 'manuscript ch01 first line', n: 1, kind: 'first' },
    { label: 'manuscript ch67 last line', n: 67, kind: 'last' },
  ]) {
    const name = `manuscript/${chapterName(n)}.md`;
    const frame = kind === 'first' ? FRAME.first : FRAME.last;
    const path = join(repoRoot, name);
    if (!fileExists(path)) {
      checks.push({ label, ok: false, parts: [{ expected: frame, actual: `no such file: ${name}` }] });
      continue;
    }
    const raw = readFile(path, 'utf8');
    const prose = paragraphsOf(parseChapterTitle(n, raw).body);
    // A file whose only line was read as its title has no prose body: then the file's own text
    // is what a mismatch must report, so the operator sees the real words, not "no prose".
    const blocks = prose.length > 0 ? prose : paragraphsOf(raw);
    const block = kind === 'first' ? blocks[0] : blocks[blocks.length - 1];
    checks.push(matched(label, kind, frame, block ?? '', `empty file: ${name}`));
  }
  return checks;
}

/** One chapter answer: its blocks, or the reason the site did not give any. */
async function fetchChapter(baseUrl, n, fetchImpl, deadline) {
  const remaining = deadline - Date.now();
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
  if (answer.error !== undefined) return { label, ok: false, parts: [{ expected: frame, actual: answer.error }] };
  const block = kind === 'first' ? answer.blocks[0] : answer.blocks[answer.blocks.length - 1];
  const text = typeof block?.text === 'string' ? block.text : '';
  return matched(label, kind, frame, text, 'no blocks in the answer');
}

/**
 * The running site serves the frame: ch01's first block opens with it and ch67's last block
 * closes with it. A non-200 answer is a mismatch whose `actual` is the status and the code.
 */
export async function checkServer({ baseUrl, fetchImpl = fetch, budgetMs = TOTAL_TIMEOUT_MS }) {
  const deadline = Date.now() + budgetMs;
  const first = await fetchChapter(baseUrl, 1, fetchImpl, deadline);
  const last = await fetchChapter(baseUrl, 67, fetchImpl, deadline);
  return [
    answerCheck('site /api/chapters/1', 'first', FRAME.first, first),
    answerCheck('site /api/chapters/67', 'last', FRAME.last, last),
  ];
}

function blockText(db, chapter, order) {
  const row = db.prepare(`SELECT text FROM blocks WHERE chapter = ? ORDER BY idx ${order} LIMIT 1`).get(chapter);
  return typeof row?.text === 'string' ? row.text : null;
}

/**
 * The data dir the service reads: `book.db` opened read-only (never created, never written).
 * Returns the three blocks the readout prints, `meta.last_scan_at` (null when absent) and the
 * one combined check the CLI reports as `data dir <dir>`.
 */
export function readDataDirFrame({ dataDir, DatabaseImpl = Database }) {
  const dir = String(dataDir);
  const file = join(dir, 'book.db');
  const failed = (reason) => ({
    dataDir: dir,
    ch01First: null,
    ch67First: null,
    ch67Last: null,
    lastScanAt: null,
    check: { label: `data dir ${dir}`, ok: false, parts: [{ expected: FRAME.first, actual: reason }] },
  });
  let db;
  try {
    db = new DatabaseImpl(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    return failed(`cannot open ${file} read-only: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const ch01First = blockText(db, 1, 'ASC');
    const ch67First = blockText(db, 67, 'ASC');
    const ch67Last = blockText(db, 67, 'DESC');
    const scan = db.prepare(`SELECT v FROM meta WHERE k = 'last_scan_at'`).get();
    const lastScanAt = typeof scan?.v === 'string' ? scan.v : null;

    const parts = [];
    if (!startsWithFrame(ch01First ?? '')) {
      parts.push({ label: 'ch01 first block', expected: FRAME.first, actual: ch01First ?? 'no block for chapter 1' });
    }
    if (!endsWithFrame(ch67Last ?? '')) {
      parts.push({ label: 'ch67 last block', expected: FRAME.last, actual: ch67Last ?? 'no block for chapter 67' });
    }
    // A single failure prints exactly one `expected`/`actual` pair; the label only disambiguates.
    const partList = parts.length > 1 ? parts : parts.map(({ expected, actual }) => ({ expected, actual }));
    return {
      dataDir: dir,
      ch01First,
      ch67First,
      ch67Last,
      lastScanAt,
      check: { label: `data dir ${dir}`, ok: parts.length === 0, parts: partList },
    };
  } catch (error) {
    // A file that is not this book's database is a mismatch with a reason, never a stack trace.
    return failed(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    db.close();
  }
}
