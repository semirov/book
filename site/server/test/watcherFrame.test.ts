import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { listCatalog } from '../src/db/repo/chapters.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { ManuscriptWatcher, type IngestEvent } from '../src/ingest/watcher.ts';
import { createFixture, type Fixture } from './helpers.ts';

/**
 * BOOK-137 — the frame is guarded where a file becomes **published**, not only at `land`.
 *
 * The engine writes the manuscript and the watcher reads it about a second later, so a late
 * refusal cannot take back the text the site already serves. This is the watcher's own proof:
 * a weakened ch01 in the book root is observed, refused, and the projection keeps the canon
 * sentence, its `rev` and its revisions — the log says so once, and putting the sentence back
 * publishes normally.
 *
 * Split from `watcher.test.ts` (the file's 500-line budget): it needs a log capture, and the
 * rest of that file is about the boot scan, the empty-write guard and the first sheet.
 */

type Line = { message: string; meta?: Record<string, unknown> };

type Harness = {
  fixture: Fixture;
  watcher: ManuscriptWatcher;
  events: IngestEvent[];
  logs: Line[];
  stop: () => Promise<void>;
};

let harness: Harness | null = null;

async function start(): Promise<Harness> {
  const fixture = createFixture({ '00-front.md': 'Без названия\n\nПервая страница.\n' });
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  const state = new StateService(fixture.db);
  const events: IngestEvent[] = [];
  const logs: Line[] = [];
  const watcher = new ManuscriptWatcher({
    db: fixture.db,
    state,
    bookRoot: fixture.root,
    dataDir: fixture.dataDir,
    pollMs: 20,
    stabilityMs: 20,
    coalesceMs: 40,
    emptyGraceMs: 120,
    emit: (event) => events.push(event),
    log: (message, meta) => logs.push({ message, meta }),
  });
  await watcher.start();
  // Polling sees mtime/size: let the initial stat settle before rewriting a file.
  await new Promise((resolve) => setTimeout(resolve, 25));
  harness = {
    fixture,
    watcher,
    events,
    logs,
    stop: async () => {
      await watcher.stop();
      fixture.close();
    },
  };
  return harness;
}

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 8_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the watcher');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The weakened sentence — the one word a file must not be allowed to change. */
const WEAKENED_FIRST = FRAME_FIRST_SENTENCE.replace('яркий', 'тусклый');

/** The fixture keeps the canon frame on a chapter write; a refusal needs the raw bytes. */
function writeRaw(fixture: Fixture, name: string, text: string): void {
  writeFileSync(join(fixture.manuscript, name), text, 'utf8');
}

function blocks(n: number): string[] {
  return (
    harness!.fixture.db.prepare('SELECT text FROM blocks WHERE chapter = ? ORDER BY idx').all(n) as Array<{ text: string }>
  ).map((row) => row.text);
}

function revisionRows(n: number): Array<{ rev: number }> {
  return harness!.fixture.db.prepare('SELECT rev FROM revisions WHERE chapter = ? ORDER BY rev').all(n) as Array<{
    rev: number;
  }>;
}

function frameLogs(): Line[] {
  return harness!.logs.filter((line) => line.message.includes('frame moved'));
}

describe('watcher: a moved frame publishes nothing (BOOK-137)', () => {
  it('keeps serving the canon sentence: same rev, same blocks, no revision, one log line', async () => {
    await start();
    harness!.fixture.write('ch01.md', `${FRAME_FIRST_SENTENCE}\n\nЗаписку оставили на столе.\n`);
    await waitFor(() => harness!.events.find((event) => event.type === 'chapter:created'));
    const before = listCatalog(harness!.fixture.db)[0];
    const revisionsBefore = revisionRows(1);

    // The engine's own failure mode: the file is written with a weakened sentence, and the site
    // reads it a moment later. Nothing of it may reach the projection.
    writeRaw(harness!.fixture, 'ch01.md', `${WEAKENED_FIRST}\n\nЗаписку оставили на столе.\n`);
    await waitFor(() => frameLogs()[0]);

    expect(listCatalog(harness!.fixture.db)[0]).toMatchObject({
      n: 1,
      rev: before?.rev,
      chars: before?.chars,
      written: true,
    });
    expect(blocks(1)[0]).toBe(FRAME_FIRST_SENTENCE);
    expect(revisionRows(1)).toEqual(revisionsBefore);
    expect(harness!.events.filter((event) => event.type === 'chapter:revision')).toHaveLength(0);
    // One line, naming the chapter — the reader was not told anything, because nothing happened.
    expect(frameLogs()).toHaveLength(1);
    expect(frameLogs()[0]?.meta).toMatchObject({ n: 1 });

    // The same bytes again are the same fact: one line per version of the file, not per tick.
    writeRaw(harness!.fixture, 'ch01.md', `${WEAKENED_FIRST}\n\nЗаписку оставили на столе.\n`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(frameLogs()).toHaveLength(1);

    // Putting the sentence back publishes normally: the guard is about the frame, not the file.
    harness!.fixture.write('ch01.md', `${FRAME_FIRST_SENTENCE}\n\nЗаписку оставили на столе.\n\nИ вышел.\n`);
    const revision = await waitFor(() => harness!.events.find((event) => event.type === 'chapter:revision'));
    if (revision.type !== 'chapter:revision') throw new Error('narrowing');
    expect(revision.data).toMatchObject({ n: 1, rev: (before?.rev ?? 0) + 1 });
    expect(blocks(1)[0]).toBe(FRAME_FIRST_SENTENCE);
  }, 10_000);
});
