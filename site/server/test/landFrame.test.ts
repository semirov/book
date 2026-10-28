import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS, type WriterAssignment } from '@book/shared';
import { describe, expect, it, vi } from 'vitest';

import type { EngineError } from '../src/engine/types.ts';
import { createEngineFixture, type Fixture } from './engine/helpers.ts';

/**
 * BOOK-137 — the landing's **second** read. `land`'s guard reads the file, and the ingest it
 * publishes through reads it again; a live session may write in between, and then nothing was
 * published at all. The seam is the read itself: the mocked `readChapter` writes the weaker
 * file between the guard's read and the ingest's, which is exactly what a watcher would see.
 */
const seam = vi.hoisted(() => ({ armed: false, reads: 0, path: '', weaker: '' }));

vi.mock('../src/engine/text.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/engine/text.ts')>();
  const { writeFileSync } = await import('node:fs');
  return {
    ...actual,
    readChapter: (bookRoot: string, n: number) => {
      if (seam.armed && actual.chapterPath(bookRoot, n) === seam.path) {
        seam.reads += 1;
        // Read 1 is the guard's; read 2 is the ingest's own — the file moves in between.
        if (seam.reads === 2) writeFileSync(seam.path, seam.weaker, 'utf8');
      }
      return actual.readChapter(bookRoot, n);
    },
  };
});

/**
 * BOOK-137 — the frame check on a landing (F029).
 *
 * A landing is the only way a file becomes a fact, so it is where the sentence's letters are
 * defended: ch01 must open with the canon sentence and the finale must close with it, character for
 * character. The boot scan and the watcher keep applying files (§18: files win); a landing that
 * would move a letter is refused with `FRAME_CHANGED` and publishes nothing. The files here are
 * written raw (`fixture.writeChapter`), because a test of the guard must control every byte.
 */

/** The one word a landing must not be allowed to change. */
const WEAKENED_FIRST = FRAME_FIRST_SENTENCE.replace('яркий', 'тусклый');
const WEAKENED_LAST = FRAME_LAST_SENTENCE.replace('глаз', 'окон');

/** A page of inert prose, above the floor; a landing is refused for shape before it is judged. */
const FILLER =
  'Служебный абзац для проверки объёма страницы. Это предложение повторяется, чтобы набрать нужную длину, и не является текстом книги. '.repeat(
    16,
  ).trimEnd();

function refusal(run: () => unknown): EngineError | null {
  try {
    run();
  } catch (error) {
    return error as EngineError;
  }
  return null;
}

/** A first draft lease on the lane's edge chapter, started, with nothing landed yet. */
function draftOf(fixture: Fixture, forLane: 'fwd' | 'bwd'): WriterAssignment {
  const assignment = fixture.engine.next({ for: forLane, session: `writer-${forLane}` }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  return assignment;
}

function revisionsOf(fixture: Fixture, chapter: number): unknown[] {
  return fixture.db.prepare('SELECT rev FROM revisions WHERE chapter = ? ORDER BY rev').all(chapter);
}

describe('land — the frozen frame is character-exact (F029, BOOK-137)', () => {
  it('refuses a landing on ch01 whose frame sentence moved, and publishes nothing', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      const assignment = draftOf(fixture, 'fwd');
      expect(assignment.chapter).toBe(1);
      fixture.writeChapter(1, `Начало\n\n${WEAKENED_FIRST} Я постоял и вышел.\n\n${FILLER}\n`);

      const error = refusal(() => fixture.engine.land(assignment.leaseId));
      expect(error).toMatchObject({ code: 'FRAME_CHANGED', status: 409 });
      expect(error?.message).toBe('рамка книги: фраза этой главы не меняется — правка остаётся бумагой');

      // Nothing became a fact: no revision, and the step carries nothing landed.
      expect(revisionsOf(fixture, 1)).toEqual([]);
      expect(fixture.db.prepare('SELECT landed_at, landed_sha FROM steps WHERE step_id = ?').get(assignment.stepId)).toEqual(
        { landed_at: null, landed_sha: null },
      );
    } finally {
      fixture.close();
    }
  });

  it('lands a ch01 draft whose frame is intact, and publishes the revision', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      const assignment = draftOf(fixture, 'fwd');
      fixture.writeChapter(1, `Начало\n\n${FRAME_FIRST_SENTENCE} Я постоял и вышел.\n\n${FILLER}\n`);

      expect(fixture.engine.land(assignment.leaseId)).toMatchObject({ landed: true, changed: true, revAfter: 1 });
      expect(revisionsOf(fixture, 1)).toEqual([{ rev: 1 }]);
      // The frame is the published text's opening, exactly as the file holds it.
      const block = fixture.db.prepare('SELECT text FROM blocks WHERE chapter = 1 ORDER BY idx LIMIT 1').get() as {
        text: string;
      };
      expect(block.text.startsWith(FRAME_FIRST_SENTENCE)).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it('refuses a landing on the finale whose closing sentence moved, and accepts the canon closer', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      const assignment = draftOf(fixture, 'bwd');
      expect(assignment.chapter).toBe(TOTAL_CHAPTERS);

      fixture.writeChapter(TOTAL_CHAPTERS, `Финал\n\n${FILLER}\n\n${WEAKENED_LAST}\n`);
      expect(refusal(() => fixture.engine.land(assignment.leaseId))).toMatchObject({
        code: 'FRAME_CHANGED',
        status: 409,
      });
      expect(revisionsOf(fixture, TOTAL_CHAPTERS)).toEqual([]);

      // The same file with its last sentence put back: it lands.
      fixture.writeChapter(TOTAL_CHAPTERS, `Финал\n\n${FILLER}\n\n${FRAME_LAST_SENTENCE}\n`);
      expect(fixture.engine.land(assignment.leaseId)).toMatchObject({ changed: true, revAfter: 1 });
      const block = fixture.db
        .prepare('SELECT text FROM blocks WHERE chapter = ? ORDER BY idx DESC LIMIT 1')
        .get(TOTAL_CHAPTERS) as { text: string };
      expect(block.text.endsWith(FRAME_LAST_SENTENCE)).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it('lands the real ch01 shape — no title line, the file opens on the sentence (manuscript/ch01.md)', () => {
    // The book's own file has no heading above the frame: line 1 *is* the sentence (BOOK-32),
    // and the chapter is read as untitled prose. This is the shape the engine writes in prod.
    const fixture = createEngineFixture({ front: null });
    try {
      const assignment = draftOf(fixture, 'fwd');
      fixture.writeChapter(1, `${FRAME_FIRST_SENTENCE}\n\nЯ постоял и вышел.\n\n${FILLER}\n`);

      expect(fixture.engine.land(assignment.leaseId)).toMatchObject({ landed: true, changed: true, revAfter: 1 });
      expect(revisionsOf(fixture, 1)).toEqual([{ rev: 1 }]);
      const first = fixture.db.prepare('SELECT text FROM blocks WHERE chapter = 1 ORDER BY idx LIMIT 1').get() as {
        text: string;
      };
      expect(first.text).toBe(FRAME_FIRST_SENTENCE);
    } finally {
      fixture.close();
    }
  });

  it('refuses a landing on the real ch01 shape when the sentence itself moved', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      const assignment = draftOf(fixture, 'fwd');
      fixture.writeChapter(1, `${WEAKENED_FIRST}\n\nЯ постоял и вышел.\n\n${FILLER}\n`);

      expect(refusal(() => fixture.engine.land(assignment.leaseId))).toMatchObject({
        code: 'FRAME_CHANGED',
        status: 409,
      });
      expect(revisionsOf(fixture, 1)).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('lands a ch01 draft whose title line sits above the frame', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      const assignment = draftOf(fixture, 'fwd');
      fixture.writeChapter(1, `Начало\n\n${FRAME_FIRST_SENTENCE}\n\n${FILLER}\n`);

      expect(fixture.engine.land(assignment.leaseId)).toMatchObject({ landed: true, changed: true, revAfter: 1 });
      expect(revisionsOf(fixture, 1)).toEqual([{ rev: 1 }]);
    } finally {
      fixture.close();
    }
  });

  it('refuses a landing whose file is weakened after the guard read, and records no landing', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      const assignment = draftOf(fixture, 'fwd');
      expect(assignment.chapter).toBe(1);
      fixture.writeChapter(1, `Начало\n\n${FRAME_FIRST_SENTENCE} Я постоял и вышел.\n\n${FILLER}\n`);

      // The guard will read this file intact; the ingest will read the weaker one.
      seam.path = join(fixture.manuscript, 'ch01.md');
      seam.weaker = `Начало\n\n${WEAKENED_FIRST} Я постоял и вышел.\n\n${FILLER}\n`;
      seam.reads = 0;
      seam.armed = true;

      const error = refusal(() => fixture.engine.land(assignment.leaseId));
      seam.armed = false;

      // The guard's read, the ingest's, and the fresh read the refusal is asked of.
      expect(seam.reads).toBeGreaterThanOrEqual(2);
      expect(error).toMatchObject({ code: 'FRAME_CHANGED', status: 409 });
      expect(error?.message).toBe('рамка книги: фраза этой главы не меняется — правка остаётся бумагой');
      // The refusal asked the guard again of the fresh file, which is no longer intact.
      expect(error?.detail).toEqual({ intact: false });

      // The ingest published nothing and the step invents nothing: no revision, no `landed_sha`,
      // no `rev_after` — a landing the site never served is not recorded as one.
      expect(revisionsOf(fixture, 1)).toEqual([]);
      expect(
        fixture.db
          .prepare('SELECT landed_at, landed_sha, rev_after FROM steps WHERE step_id = ?')
          .get(assignment.stepId),
      ).toEqual({ landed_at: null, landed_sha: null, rev_after: null });
    } finally {
      seam.armed = false;
      fixture.close();
    }
  });

  it('leaves a chapter with no frame alone: a landing below the frame chapters is unchanged', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      // ch01 is written, so the forward lane's next draft is chapter 2 — no frame there.
      fixture.writeChapter(1, `Начало\n\n${FRAME_FIRST_SENTENCE} Я постоял и вышел.\n\n${FILLER}\n`);
      const assignment = draftOf(fixture, 'fwd');
      expect(assignment.chapter).toBe(2);
      fixture.writeChapter(2, `Вторая\n\n${FILLER}\n`);
      expect(fixture.engine.land(assignment.leaseId)).toMatchObject({ changed: true, revAfter: 1 });
    } finally {
      fixture.close();
    }
  });
});
