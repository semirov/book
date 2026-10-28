/**
 * The projector keeps a basis slot's heading (owner, 2026-10-28).
 *
 * `manuscript/ch01.md` carries «Замечаний нет» above the frozen first sentence. The chapter
 * is still a basis slot — one paragraph, `chars = 0`, `written = false` — but its heading is
 * `chapters.title`, because that is what the contents row and the chapter header print. A
 * heading is a title, not prose: it adds no characters and no revision.
 */

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { listCatalog } from '../src/db/repo/chapters.ts';
import { listBlocks } from '../src/db/repo/chapters.ts';
import { applyChapterFile } from '../src/ingest/applyChapter.ts';
import { createFixture, type Fixture } from './helpers.ts';

const HEADING = 'Замечаний нет';
const NOW = Date.parse('2026-10-28T09:00:00Z');

let fixture: Fixture | null = null;

function basis(n: number, raw: string) {
  const active = (fixture = createFixture());
  const applied = applyChapterFile({
    db: active.db,
    dataDir: active.dataDir,
    n,
    raw,
    mtimeMs: NOW,
    nowMs: NOW,
  });
  return { fixture: active, applied };
}

afterEach(() => {
  fixture?.close();
  fixture = null;
});

describe('a basis slot with a heading', () => {
  it('projects the heading as the title and the sentence as its one paragraph', () => {
    const { fixture: active } = basis(1, `${HEADING}\n\n${FRAME_FIRST_SENTENCE}\n`);

    const entry = listCatalog(active.db)[0];
    expect(entry).toMatchObject({
      n: 1,
      title: HEADING,
      basis: true,
      written: false,
      chars: 0,
      blocks: 1,
      opening: 'Я вошёл в пустую комнату.…',
    });
    // The reader's paragraph is the frozen sentence, not the heading.
    expect(listBlocks(active.db, 1).map((block) => block.text)).toEqual([FRAME_FIRST_SENTENCE]);
  });

  it('is not a revision: nobody wrote it, and the second scan is a no-op', () => {
    const active = (fixture = createFixture());
    const input = {
      db: active.db,
      dataDir: active.dataDir,
      n: TOTAL_CHAPTERS,
      raw: `Конец учёта\n\n${FRAME_LAST_SENTENCE}\n`,
      mtimeMs: NOW,
      nowMs: NOW,
    };
    expect(applyChapterFile(input).status).toBe('emptied');
    expect(applyChapterFile({ ...input, nowMs: NOW + 60_000 }).status).toBe('unchanged');
    // No revision, no log entry: history belongs to writes, and this is a slot.
    expect(active.db.prepare('SELECT COUNT(*) AS c FROM revisions WHERE chapter = ?').get(TOTAL_CHAPTERS)).toEqual({ c: 0 });
    expect(listCatalog(active.db).at(-1)).toMatchObject({ title: 'Конец учёта', basis: true, chars: 0 });
  });

  it('heals a row projected before the heading existed', () => {
    const active = (fixture = createFixture());
    const bare = { db: active.db, dataDir: active.dataDir, n: 1, raw: FRAME_FIRST_SENTENCE, mtimeMs: NOW, nowMs: NOW };
    expect(applyChapterFile(bare).status).toBe('emptied');
    expect(listCatalog(active.db)[0]?.title).toBeNull();

    // The file now carries its heading: the projection follows without a revision.
    const headed = { ...bare, raw: `${HEADING}\n\n${FRAME_FIRST_SENTENCE}` };
    expect(applyChapterFile(headed).status).toBe('emptied');
    expect(listCatalog(active.db)[0]).toMatchObject({ title: HEADING, basis: true, chars: 0 });
  });
});
