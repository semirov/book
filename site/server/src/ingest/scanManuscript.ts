/**
 * Read the manuscript directory (ARCHITECTURE.md §6.1). Read-only by construction: nothing
 * in this module opens a file for writing.
 *
 * Only `chNN.md` with NN in 01..42 is a chapter, and `00-front.md` is the first sheet
 * (title + annotation). Everything else is reported to the caller (`ignored`) and left to
 * the validator (F001/F002) — the site must never fail to boot because a stray file
 * appeared in the repository.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { FRONT_FILE, TOTAL_CHAPTERS } from '@book/shared';

export type ScannedChapter = {
  n: number;
  fileName: string;
  raw: string;
  /** File mtime: the moment the text was written, not the moment the site first saw it. */
  mtimeMs: number;
};

export type ScannedFront = {
  fileName: string;
  raw: string;
  mtimeMs: number;
};

export type ScanResult = {
  chapters: ScannedChapter[];
  /** `manuscript/00-front.md`, or null while there is no first sheet (F021 is an error). */
  front: ScannedFront | null;
  /** Files in `manuscript/` that are neither chapters nor the front matter (archives are dirs). */
  ignored: string[];
  missing: boolean;
  readErrors: Array<{ fileName: string; message: string }>;
};

const CHAPTER_FILE = /^ch(\d{2})\.md$/u;

export function scanManuscript(bookRoot: string): ScanResult {
  const dir = join(bookRoot, 'manuscript');
  const result: ScanResult = { chapters: [], front: null, ignored: [], missing: false, readErrors: [] };
  if (!existsSync(dir)) {
    result.missing = true;
    return result;
  }

  const names = readdirSync(dir).sort();
  for (const name of names) {
    const path = join(dir, name);
    let stats: ReturnType<typeof statSync> | null = null;
    try {
      stats = statSync(path);
    } catch {
      stats = null;
    }
    if (stats === null || !stats.isFile()) {
      // `archive/` and friends: old drafts are served by nothing (§21.1).
      result.ignored.push(name);
      continue;
    }

    if (name === FRONT_FILE) {
      try {
        result.front = { fileName: name, raw: readFileSync(path, 'utf8'), mtimeMs: stats.mtimeMs };
      } catch (error) {
        result.readErrors.push({ fileName: name, message: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }

    const match = CHAPTER_FILE.exec(name);
    if (!match) {
      result.ignored.push(name);
      continue;
    }
    const n = Number.parseInt(match[1] ?? '', 10);
    // Outside the book: skipped as a stray file, never ingested and never deleted (the file
    // stays where the owner put it, and the validator's F002 reports it).
    if (n < 1 || n > TOTAL_CHAPTERS) {
      result.ignored.push(name);
      continue;
    }
    try {
      result.chapters.push({ n, fileName: name, raw: readFileSync(path, 'utf8'), mtimeMs: stats.mtimeMs });
    } catch (error) {
      result.readErrors.push({ fileName: name, message: error instanceof Error ? error.message : String(error) });
    }
  }

  result.chapters.sort((a, b) => a.n - b.n);
  return result;
}
