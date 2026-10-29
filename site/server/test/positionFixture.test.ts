/**
 * BOOK-209 — the fixture manuscript the position guard writes when no real book is named.
 *
 * The guard needs a book: since ADR-043 the text lives in the database, `manuscript/` left the
 * checkout, and a measurement whose seed can only be found on one machine is not a guard. So the
 * harness writes its own — and this test pins what makes it usable rather than merely present:
 *
 *   - it is a manuscript the product's own import accepts (43 files, valid first sheet, a title
 *     line and a blank line per chapter, paragraphs as blocks);
 *   - it is the book's frame, character for character — ch01 opens on the canon sentence and
 *     ch42 closes on it, so neither is refused as `frame-rejected` and both count as written;
 *   - it has the geometry the measurement needs: all 42 chapters written (a heading per contents
 *     row), and the two chapters the harness parks a sentence in carry more sentences than the
 *     index it asks for (60 in ch07, 150 in ch09);
 *   - its bytes are a function of the numbers alone: two builds are identical, and the file a
 *     run writes lands in the directory it was given and nowhere else.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FRAME_FIRST_SENTENCE,
  FRAME_LAST_SENTENCE,
  TOTAL_CHAPTERS,
  parseChapterTitle,
  splitSentences,
} from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { FixtureCanon, FixtureFile } from '../../scripts/lib/position-fixture.mjs';
import {
  FIXTURE_PARAGRAPHS,
  canonOf,
  chapterFile,
  fixtureFiles,
  fixtureStats,
  frontFile,
  paragraphsOf,
  writeFixture,
} from '../../scripts/lib/position-fixture.mjs';
import { bookRoot, seedVolume } from '../../scripts/lib/position-boot.mjs';
import { parseFront } from '../src/ingest/parseFront.ts';
import { frameIntact } from '../src/ingest/frameGuard.ts';
import { parseChapter } from '../src/ingest/parseChapter.ts';

/** The indices the harness parks a sentence at: `place(7, 60)` and `place(9, 150)`. */
const PARKED = { chapter: 7, index: 60, deep: { chapter: 9, index: 150 } };

const canon: FixtureCanon = {
  chapters: TOTAL_CHAPTERS,
  first: FRAME_FIRST_SENTENCE,
  last: FRAME_LAST_SENTENCE,
};

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'position-fixture-test-'));
  made.push(dir);
  return dir;
}

function fileNamed(files: FixtureFile[], name: string): FixtureFile {
  const found = files.find((file) => file.name === name);
  if (found === undefined) throw new Error(`the fixture has no ${name}`);
  return found;
}

/** A chapter's paragraphs as the ingest splits them: blocks on blank lines, title line excluded. */
function paragraphsOfFile(n: number, text: string): string[] {
  return parseChapterTitle(n, text)
    .body.trim()
    .split(/\n\s*\n/u)
    .filter((block) => block.trim().length > 0);
}

/** Sentences the page will carry for a chapter — the `[data-s]` spans `place()` indexes. */
function sentencesIn(n: number, text: string): string[] {
  return paragraphsOfFile(n, text).flatMap((paragraph) => splitSentences(paragraph).map((sentence) => sentence.text.trim()));
}

describe('the fixture is a manuscript the product accepts', () => {
  it('writes the first sheet and one file per chapter', () => {
    const files = fixtureFiles(canon);
    expect(files).toHaveLength(TOTAL_CHAPTERS + 1);
    expect(files[0]?.name).toBe('00-front.md');
    expect(files.slice(1).map((file) => file.name)).toEqual(
      Array.from({ length: TOTAL_CHAPTERS }, (_, index) => `ch${String(index + 1).padStart(2, '0')}.md`),
    );
    expect(fixtureStats(files)).toMatchObject({ files: TOTAL_CHAPTERS + 1, chapters: TOTAL_CHAPTERS });
  });

  it('gives every chapter a valid title line, a blank second line and its paragraphs as blocks', () => {
    const files = fixtureFiles(canon);
    for (let n = 1; n <= TOTAL_CHAPTERS; n += 1) {
      const file = fileNamed(files, `ch${String(n).padStart(2, '0')}.md`);
      const [title = '', second = ''] = file.text.split('\n');
      expect(title.length, `ch${String(n)} title line`).toBeGreaterThan(0);
      expect(second, `ch${String(n)} line 2 must be blank`).toBe('');
      const parsed = parseChapterTitle(n, file.text);
      expect(parsed.title, `ch${String(n)} title`).not.toBeNull();
      expect(parsed.problems, `ch${String(n)} title problems`).toEqual([]);
      expect(paragraphsOfFile(n, file.text), `ch${String(n)} blocks`).toHaveLength(paragraphsOf(n));
      expect(parseChapter(n, file.text).basis, `ch${String(n)} is written prose`).toBe(false);
    }
  });

  it('writes a valid first sheet: title, blank line, an annotation inside F021 bands', () => {
    const front = parseFront(fileNamed(fixtureFiles(canon), '00-front.md').text);
    expect(front.problems).toEqual([]);
    expect(front.title).not.toBeNull();
    expect(front.about).not.toBeNull();
    expect(front.blocks.length).toBeGreaterThanOrEqual(1);
    expect(front.blocks.length).toBeLessThanOrEqual(12);
    expect(front.chars).toBeGreaterThanOrEqual(300);
    expect(front.chars).toBeLessThanOrEqual(4_000);
  });

  it('keeps the canon frame where BOOK-137 requires it, so neither ch01 nor ch42 is refused', () => {
    const files = fixtureFiles(canon);
    const first = fileNamed(files, 'ch01.md').text;
    const last = fileNamed(files, 'ch42.md').text;
    expect(parseChapterTitle(1, first).body.trimStart().startsWith(FRAME_FIRST_SENTENCE)).toBe(true);
    expect(parseChapterTitle(TOTAL_CHAPTERS, last).body.trimEnd().endsWith(FRAME_LAST_SENTENCE)).toBe(true);
    expect(frameIntact(1, first)).toBe(true);
    expect(frameIntact(TOTAL_CHAPTERS, last)).toBe(true);
    // Every other chapter has no frame to move.
    for (const n of [2, 21, 22, 41]) {
      expect(frameIntact(n, fileNamed(files, `ch${String(n).padStart(2, '0')}.md`).text)).toBe(true);
    }
  });
});

describe('the fixture carries the geometry the measurement indexes', () => {
  it('has several paragraphs and sentences in every chapter, and 42 headings for 42 rows', () => {
    const files = fixtureFiles(canon);
    for (let n = 1; n <= TOTAL_CHAPTERS; n += 1) {
      const file = fileNamed(files, `ch${String(n).padStart(2, '0')}.md`);
      expect(paragraphsOfFile(n, file.text).length, `ch${String(n)} paragraphs`).toBeGreaterThanOrEqual(
        FIXTURE_PARAGRAPHS,
      );
      expect(sentencesIn(n, file.text).length, `ch${String(n)} sentences`).toBeGreaterThanOrEqual(36);
    }
  });

  it('has the sentence the harness parks at in ch07 and ch09 — the index exists on the page', () => {
    const files = fixtureFiles(canon);
    const seven = sentencesIn(PARKED.chapter, fileNamed(files, 'ch07.md').text);
    const nine = sentencesIn(PARKED.deep.chapter, fileNamed(files, 'ch09.md').text);
    expect(seven.length, 'ch07 must carry sentence 60').toBeGreaterThanOrEqual(PARKED.index + 1);
    expect(nine.length, 'ch09 must carry sentence 150').toBeGreaterThanOrEqual(PARKED.deep.index + 1);
  });

  it('names each parked sentence uniquely inside its chapter: two paragraphs never start alike', () => {
    // `locate()` finds a sentence by its first 40 characters, chapter first. Two sentences that
    // share that prefix would make the back case measure a paragraph the harness never parked.
    for (const [chapter, name] of [
      [PARKED.chapter, 'ch07.md'],
      [PARKED.deep.chapter, 'ch09.md'],
    ] as const) {
      const prefixes = sentencesIn(chapter, fileNamed(fixtureFiles(canon), name).text).map((text) => text.slice(0, 40));
      expect(new Set(prefixes).size, `${name} has ${String(prefixes.length)} sentences`).toBe(prefixes.length);
    }
  });
});

describe('the fixture is deterministic and lands only where it is told', () => {  it('builds the same bytes twice — no clock, no random', () => {
    expect(fixtureFiles(canon)).toEqual(fixtureFiles(canon));
    const first = chapterFile(9, canon);
    expect(chapterFile(9, canon)).toEqual(first);
    expect(fixtureStats(fixtureFiles(canon))).toEqual(fixtureStats(fixtureFiles(canon)));
  });

  it('writes into the directory it is given, and answers what it wrote', async () => {
    const dir = scratch();
    const written = await writeFixture(dir);
    expect(written).toMatchObject({ files: TOTAL_CHAPTERS + 1, chapters: TOTAL_CHAPTERS });
    expect(readdirSync(dir)).toEqual(['manuscript']);
    const names = readdirSync(join(dir, 'manuscript')).sort();
    expect(names).toContain('00-front.md');
    expect(names).toContain('ch42.md');
    expect(readFileSync(join(dir, 'manuscript', 'ch01.md'), 'utf8')).toBe(chapterFile(1, canon).text);
    // A second run over a fresh directory is byte-identical: the run's own book, not a clock.
    const other = scratch();
    await writeFixture(other);
    expect(readFileSync(join(other, 'manuscript', 'ch09.md'), 'utf8')).toBe(
      readFileSync(join(dir, 'manuscript', 'ch09.md'), 'utf8'),
    );
  });

  it('reads the canon from the book model instead of restating it', async () => {
    expect(await canonOf()).toEqual(canon);
  });
});

describe('the harness seeds from the book it is told, and from nowhere else', () => {
  it('discovers nothing when nothing is named: the default is the fixture, not a stray manuscript/', () => {
    expect(bookRoot({})).toBeNull();
    // The owner's working copy is not a source either: a default run must measure the same book
    // on every machine, and a checkout that happens to hold a manuscript/ must not change it.
    expect(bookRoot({ POSITION_BOOK_ROOT: '' })).toBeNull();
    expect(seedVolume({})).toBeNull();
    expect(seedVolume({ POSITION_SEED_VOLUME: '' })).toBeNull();
  });

  it('accepts a named tree and volume, and refuses a name that does not fit', () => {
    const root = scratch();
    mkdirSync(join(root, 'manuscript'), { recursive: true });
    writeFileSync(join(root, 'manuscript', '00-front.md'), frontFile(canon).text, 'utf8');
    expect(bookRoot({ POSITION_BOOK_ROOT: root })).toBe(root);
    expect(() => bookRoot({ POSITION_BOOK_ROOT: scratch() })).toThrow(/holds no manuscript\/00-front\.md/u);

    const volume = scratch();
    expect(() => seedVolume({ POSITION_SEED_VOLUME: volume })).toThrow(/holds no book\.db/u);
    writeFileSync(join(volume, 'book.db'), '', 'utf8');
    expect(seedVolume({ POSITION_SEED_VOLUME: volume })).toBe(volume);
  });
});
