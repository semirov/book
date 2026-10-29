/**
 * Types for `scripts/lib/position-fixture.mjs` (BOOK-209) — the fixture manuscript the position
 * guard writes when no real book is named. Only the surface the test and the boot use: the
 * counts, the canon the fixture reads, and the files it writes.
 */

export type FixtureCanon = {
  /** `TOTAL_CHAPTERS` — 42. */
  chapters: number;
  /** `FRAME_FIRST_SENTENCE`: ch01 opens on it. */
  first: string;
  /** `FRAME_LAST_SENTENCE`: ch42 closes on it. */
  last: string;
};

export type FixtureFile = { name: string; text: string };

export type FixtureStats = {
  /** 43: the first sheet and 42 chapters. */
  files: number;
  chapters: number;
  /** One block per paragraph, the first sheet's annotation included. */
  blocks: number;
  /** UTF-8 bytes of every file. */
  bytes: number;
};

export const FIXTURE_PARAGRAPHS: number;
export const FIXTURE_LONG_CHAPTERS: ReadonlyArray<{ chapter: number; paragraphs: number }>;

export function paragraphsOf(n: number): number;
export function sentencesOf(n: number, p: number): number;
export function sentenceOf(n: number, p: number, index: number): string;
export function paragraphOf(n: number, p: number, options?: { numbered?: boolean }): string;
export function canonOf(): Promise<FixtureCanon>;
export function chapterFile(n: number, canon: FixtureCanon): FixtureFile;
export function frontFile(canon: FixtureCanon): FixtureFile;
export function fixtureFiles(canon: FixtureCanon): FixtureFile[];
export function fixtureStats(files: FixtureFile[]): FixtureStats;
export function writeFixture(dir: string): Promise<FixtureStats>;
