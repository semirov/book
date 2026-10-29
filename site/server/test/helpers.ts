import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGE_COOKIE, ageDateOf, frameSentenceOf, parseChapterTitle } from '@book/shared';

import { databaseFile, openDatabase, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { frameIntact } from '../src/ingest/frameGuard.ts';

export type Fixture = {
  root: string;
  dataDir: string;
  db: Db;
  manuscript: string;
  /** Write (or overwrite) a manuscript file. A chapter keeps the canon frame (BOOK-137). */
  write: (name: string, text: string) => void;
  close: () => void;
};

/**
 * BOOK-225 — an acknowledged reader, as a suite that is not about the gate sees one: the cookie
 * a browser carries after `POST /api/age`, written with today's day. A suite about prose, ETags,
 * cache headers or the frame must not be a suite about the rating: `ageGate.test.ts` is the one
 * that asks without it, and it never uses this constant.
 */
export const AGE_ACK_COOKIE = `${AGE_COOKIE}=${ageDateOf(new Date())}`;

/**
 * The same acknowledgement on a **named** day — for a suite that pins the app's clock: a cookie
 * for today would be a day in the server's future there, which the gate reads as "not answered"
 * (the site writes its own clock, so a later day was not written here).
 */
export function ageAckAt(day: Date): string {
  return `${AGE_COOKIE}=${ageDateOf(day)}`;
}

const CHAPTER_FILE = /^ch(\d{2})\.md$/u;

/**
 * BOOK-137 — a fixture's chapter file is a manuscript file, and the two that carry the frame
 * open (ch01) and close (ch42) on the canon sentence. The ingest refuses to publish any other
 * shape (`frame-rejected`), so the frame rides the file's first paragraph on ch01 and its last
 * one on ch42: the title line, the paragraph count and the paragraph indices stay as written.
 * An already-intact file is returned untouched, so a test that writes the frame itself is not
 * quietly rewritten.
 */
export function withFrame(n: number, text: string): string {
  const frame = frameSentenceOf(n);
  // An empty file is a torn save, not a manuscript: the §6.2 guard must see it as empty.
  if (frame === null || text.trim().length === 0 || frameIntact(n, text)) return text;
  const parsed = parseChapterTitle(n, text);
  const body = parsed.body.replace(/^\n+/u, '');
  const framed =
    n === 1
      ? `${frame} ${body}`.trim()
      : `${body.replace(/\n+$/u, '')} ${frame}`.trim();
  return parsed.title === null ? framed : `${parsed.title}\n\n${framed}`;
}

export function createFixture(chapters: Record<string, string> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'book-root-'));
  const manuscript = join(root, 'manuscript');
  mkdirSync(manuscript, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), 'book-data-'));
  const db = openDatabase(databaseFile(dataDir));
  migrate(db);

  const write = (name: string, text: string): void => {
    const n = Number(CHAPTER_FILE.exec(name)?.[1] ?? Number.NaN);
    const raw = Number.isInteger(n) && n > 0 ? withFrame(n, text) : text;
    mkdirSync(manuscript, { recursive: true });
    writeFileSync(join(manuscript, name), raw, 'utf8');
  };

  for (const [name, text] of Object.entries(chapters)) write(name, text);

  return {
    root,
    dataDir,
    db,
    manuscript,
    write,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Prose inside the band, with the title line the chapter format requires (§6C.3).
 * The filler is deliberately neutral: fixtures never carry book prose, and the live
 * untitled name in fixtures is «Без названия».
 */
export function longProse(paragraphs: string[] = [], title = 'Заголовок главы'): string {
  const filler =
    'Служебный абзац для проверки объёма. Это предложение повторяется, чтобы набрать нужную длину, и не является текстом книги. ' +
    'Служебный абзац для проверки объёма. Это предложение повторяется, чтобы набрать нужную длину, и не является текстом книги.';
  const blocks = [...paragraphs];
  while (blocks.join('\n\n').length < 6500) blocks.push(filler.repeat(2));
  return `${title}\n\n${blocks.join('\n\n')}`;
}
