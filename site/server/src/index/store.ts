/**
 * Where the derived index lives (BOOK-18 §1, §2; BOOK-187 AC2).
 *
 * One JSON artifact under the data directory — `<data>/index/derived-index.json` — carrying
 * `manuscriptHash` and every chapter's facts. **Storage choice:** a file, not a table, because
 * the index is a cache: the hash of the stored chapter shas keys it, a rebuild replaces it
 * wholesale, and no SQLite write path exists through which a hand edit could pose as canon.
 * The text it summarises is read from rows (`build.ts`), never from a file.
 *
 * The artifact is the whole book, so it is never handed to a session. An editor gets a
 * **slice** — `<data>/index/slices/chNN.json`, one chapter plus its neighbours — written on
 * demand from a freshly built artifact. Every slice carries the hash it was built from, so a
 * reader can tell a stale slice from a current one; the next dispatch overwrites it.
 *
 * If the index cannot be built or written, `ensureSlice` answers `null`: the gate assignment
 * is still handed out, minus the slice. A cache failure never blocks the process.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { TOTAL_CHAPTERS, chapterLabel } from '@book/shared';

import type { Db } from '../db/db.ts';
import { buildIndex } from './build.ts';
import { INDEX_VERSION, SLICE_RADIUS, type DerivedIndex, type IndexSlice } from './types.ts';

export type IndexInput = { db: Db; dataDir: string };

export function artifactPath(dataDir: string): string {
  return join(dataDir, 'index', 'derived-index.json');
}

export function slicePath(dataDir: string, chapter: number): string {
  return join(dataDir, 'index', 'slices', `ch${chapterLabel(chapter)}.json`);
}

/** Canonical serialisation: key order comes from construction, never from a map iteration. */
export function renderIndex(index: DerivedIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/**
 * A replaced-in-place artifact can be read half-written by the editor host: write a sibling
 * `*.tmp` first and rename it over the target, which is atomic on the same filesystem.
 */
function writeIfChanged(path: string, body: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === body) return;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, body, 'utf8');
  renameSync(temporary, path);
}

/** Rebuild from the rows and replace the artifact when its bytes differ. */
export function ensureIndex(input: IndexInput): DerivedIndex {
  const index = buildIndex(input.db);
  writeIfChanged(artifactPath(input.dataDir), renderIndex(index));
  return index;
}

/** The stored artifact, or `null` when it is missing, unreadable or from another version. */
export function readIndex(dataDir: string): DerivedIndex | null {
  try {
    const parsed = JSON.parse(readFileSync(artifactPath(dataDir), 'utf8')) as Partial<DerivedIndex>;
    if (parsed.version !== INDEX_VERSION) return null;
    if (typeof parsed.manuscriptHash !== 'string') return null;
    return Array.isArray(parsed.chapters) ? (parsed as DerivedIndex) : null;
  } catch {
    return null;
  }
}

/** One chapter and its neighbours, clamped to the book — never the whole book. */
export function sliceOf(index: DerivedIndex, chapter: number): IndexSlice {
  const low = Math.max(1, chapter - SLICE_RADIUS);
  const high = Math.min(TOTAL_CHAPTERS, chapter + SLICE_RADIUS);
  return {
    version: INDEX_VERSION,
    manuscriptHash: index.manuscriptHash,
    chapter,
    chapters: index.chapters.filter((entry) => entry.n >= low && entry.n <= high),
  };
}

/**
 * Rebuild from the rows and return the slice's path, or `null` if anything went wrong. The
 * caller (a gate dispatch) must never treat `null` as an error: the slice is optional. A
 * failed build or write is handed to `onError` so the operator hears about it once.
 */
export function ensureSlice(
  input: IndexInput,
  chapter: number,
  onError?: (error: unknown) => void,
): string | null {
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > TOTAL_CHAPTERS) return null;
  try {
    const index = ensureIndex(input);
    const path = slicePath(input.dataDir, chapter);
    writeIfChanged(path, `${JSON.stringify(sliceOf(index, chapter), null, 2)}\n`);
    return path;
  } catch (error) {
    onError?.(error);
    return null;
  }
}
