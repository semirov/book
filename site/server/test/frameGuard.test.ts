import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { getChapterRow, listBlocks } from '../src/db/repo/chapters.ts';
import { applyChapterFile, type ApplyChapterResult } from '../src/ingest/applyChapter.ts';
import { frameIntact } from '../src/ingest/frameGuard.ts';
import { createFixture, type Fixture } from './helpers.ts';

/**
 * BOOK-137 — the frame is guarded where a file becomes **published**, not only where a landing
 * answers (F029).
 *
 * The engine writes the manuscript, and the watcher publishes what it finds about a second
 * later; a `land` that refuses afterwards cannot take back the text the site already serves.
 * These tests call the one publisher directly: a file whose frame moved publishes **nothing** —
 * no chapter row, no `rev`, no blocks, no revision, no log entry, no snapshot — and the file
 * that holds the canon sentence plus new prose publishes exactly as before.
 */

/** The one word a file must not be allowed to change. */
const WEAKENED_FIRST = FRAME_FIRST_SENTENCE.replace('яркий', 'тусклый');
const WEAKENED_LAST = FRAME_LAST_SENTENCE.replace('глаз', 'окон');

function publish(f: Fixture, n: number, raw: string, at = 1_000): ApplyChapterResult {
  return applyChapterFile({ db: f.db, dataDir: f.dataDir, n, raw, mtimeMs: at, nowMs: at });
}

function revisionCount(f: Fixture, n: number): number {
  return (f.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = ?').get(n) as { n: number }).n;
}

function eventCount(f: Fixture): number {
  return (f.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
}

describe('frameIntact — the canon sentence, character for character (BOOK-137)', () => {
  it('accepts ch01 with a title line and with no title line at all', () => {
    expect(frameIntact(1, `${FRAME_FIRST_SENTENCE}\n\nЯ постоял и вышел.\n`)).toBe(true);
    // The real `manuscript/ch01.md` shape: line 1 is the sentence itself, no heading above it.
    expect(frameIntact(1, `Начало\n\n${FRAME_FIRST_SENTENCE}\n\nЯ постоял и вышел.\n`)).toBe(true);
    // The sentence may open the paragraph and the prose may go on inside it (BOOK-32).
    expect(frameIntact(1, `${FRAME_FIRST_SENTENCE} Я постоял и вышел.\n`)).toBe(true);
  });

  it('refuses a letter moved anywhere inside the sentence, and a line break inside it', () => {
    expect(frameIntact(1, `${WEAKENED_FIRST}\n\nЯ постоял и вышел.\n`)).toBe(false);
    // One character: «Её» → «Ее» is not the same sentence.
    expect(frameIntact(1, `${FRAME_FIRST_SENTENCE.replace('Её', 'Ее')}\n\nТекст.\n`)).toBe(false);
    // A hard line break inside the sentence is a different paragraph the reader would get:
    // the comparison is character-exact, and inner whitespace is never collapsed.
    expect(frameIntact(1, `${FRAME_FIRST_SENTENCE.replace('Её', 'Её\n')}\n\nТекст.\n`)).toBe(false);
  });

  it('closes ch67 on the last sentence, and leaves a chapter with no frame alone', () => {
    expect(frameIntact(67, `Финал\n\nОн сел.\n\n${FRAME_LAST_SENTENCE}\n`)).toBe(true);
    expect(frameIntact(67, `Финал\n\nОн сел.\n\n${WEAKENED_LAST}\n`)).toBe(false);
    // The closer is the *last* thing: prose after it would move the sentence away from the end.
    expect(frameIntact(67, `Финал\n\n${FRAME_LAST_SENTENCE}\n\nОн сел.\n`)).toBe(false);
    expect(frameIntact(2, 'Глава\n\nЛюбой текст, даже без рамки.\n')).toBe(true);
  });
});

describe('applyChapterFile — a moved frame publishes nothing (BOOK-137)', () => {
  it('refuses a weakened ch01 before any write: no row, no rev, no blocks, no revision, no log, no snapshot', () => {
    const f = createFixture();
    try {
      const raw = `${FRAME_FIRST_SENTENCE}\n\nЯ постоял и вышел.\n`;
      // The canon file is published first, so the refusal is about a **revision**, not a first sight.
      expect(publish(f, 1, raw)).toMatchObject({ status: 'created', rev: 1 });
      const events = eventCount(f);

      expect(publish(f, 1, `${WEAKENED_FIRST}\n\nЯ постоял и вышел.\n`, 2_000)).toEqual({ status: 'frame-rejected', n: 1 });

      // The projection is exactly what it was: same `rev`, same rows, same served sentence.
      expect(getChapterRow(f.db, 1)).toMatchObject({ rev: 1 });
      expect(listBlocks(f.db, 1).map((block) => block.text)).toEqual([FRAME_FIRST_SENTENCE, 'Я постоял и вышел.']);
      expect(revisionCount(f, 1)).toBe(1);
      expect(eventCount(f)).toBe(events);
      // The snapshot store holds the published bytes and nothing else: the refused file was
      // never written to `data/versions/`.
      expect(readdirSync(join(f.dataDir, 'versions', 'ch01'))).toHaveLength(1);
      // The same canon bytes are the published text: the refusal left nothing half-done.
      expect(publish(f, 1, raw, 3_000)).toMatchObject({ status: 'unchanged' });
    } finally {
      f.close();
    }
  });

  it('refuses a weakened ch67 with no chapter row at all (a first sight)', () => {
    const f = createFixture();
    try {
      expect(publish(f, 67, `Финал\n\n${WEAKENED_LAST}\n`)).toEqual({ status: 'frame-rejected', n: 67 });
      expect(getChapterRow(f.db, 67)).toBeUndefined();
      expect(revisionCount(f, 67)).toBe(0);
      expect(eventCount(f)).toBe(0);
    } finally {
      f.close();
    }
  });

  it('publishes the canon sentence plus new prose: `created`, then `revised`', () => {
    const f = createFixture();
    try {
      const first = publish(f, 1, `${FRAME_FIRST_SENTENCE}\n\nЯ постоял и вышел.\n`);
      expect(first).toMatchObject({ status: 'created', rev: 1, title: null });
      const second = publish(f, 1, `${FRAME_FIRST_SENTENCE}\n\nЯ постоял и вышел.\n\nИ закрыл дверь.\n`, 2_000);
      expect(second).toMatchObject({ status: 'revised', rev: 2 });
      expect(revisionCount(f, 1)).toBe(2);
      expect(listBlocks(f.db, 1)[0]?.text).toBe(FRAME_FIRST_SENTENCE);
    } finally {
      f.close();
    }
  });

  it('still projects a basis slot as its one paragraph — the file *is* the sentence', () => {
    const f = createFixture();
    try {
      expect(publish(f, 1, FRAME_FIRST_SENTENCE)).toEqual({ status: 'emptied', n: 1 });
      expect(getChapterRow(f.db, 1)).toMatchObject({ basis: 1, rev: 0 });
      expect(listBlocks(f.db, 1).map((block) => block.text)).toEqual([FRAME_FIRST_SENTENCE]);
      expect(revisionCount(f, 1)).toBe(0);
      // The closer behaves the same way.
      expect(publish(f, 67, `${FRAME_LAST_SENTENCE}\n`, 2_000)).toEqual({ status: 'emptied', n: 67 });
    } finally {
      f.close();
    }
  });
});
