/**
 * A batch written before v14 is still readable (BOOK-61 review B3).
 *
 * The exchange directory outlives a deploy: a file written by the previous build has no fence
 * and holds one raw item per line. `feedback.mjs read <batchId>` must not throw on it — triage
 * may still be holding such a batch open — so the parser wraps each raw item in an envelope on
 * the fly, under the same batch id. A file that *opens* a fence with a foreign id is still a
 * tamper signal, and an envelope without its fence is still refused: only the legacy shape is
 * read leniently.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readBatchLines } from '../../src/feedback/batches.ts';
import { runFeedback } from '../../src/feedback/cli.ts';
import { parseBatchFile } from '../../src/feedback/envelope.ts';
import { createFixture } from '../helpers.ts';

const BATCH = 'bat_01JB7LEGACY000000000000';
const ITEM = {
  id: 'cmt_01JB7LEGACY0000000000000A',
  chapter: 8,
  block: null,
  rev: 1,
  quote: null,
  text: 'Тестовое замечание: в абзаце дважды «слово».',
  proposed: null,
  kind: null,
  author: 'Аня',
  at: '2026-10-25T12:00:00Z',
  flags: [],
};

function legacyFile(fixture: ReturnType<typeof createFixture>, body: string): string {
  const dir = join(fixture.dataDir, 'feedback');
  mkdirSync(join(dir, 'batches'), { recursive: true });
  writeFileSync(join(dir, 'batches', `${BATCH}.jsonl`), body, 'utf8');
  fixture.db
    .prepare(
      `INSERT INTO feedback_batches (id, created_at, chapter, loop, count, path, comment_ids)
       VALUES (?, '2026-10-25T12:00:00Z', NULL, NULL, 1, ?, ?)`,
    )
    .run(BATCH, join('batches', `${BATCH}.jsonl`), JSON.stringify([ITEM.id]));
  return dir;
}

describe('a pre-v14 batch file', () => {
  it('is read as its items, each wrapped in an envelope under the batch id', () => {
    const fixture = createFixture();
    try {
      const parsed = parseBatchFile(`${JSON.stringify(ITEM)}\n`, BATCH);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.envelopes).toHaveLength(1);
      expect(parsed.envelopes[0]).toMatchObject({
        envelope: 'book.filing/v1',
        itemId: ITEM.id,
        chapter: 8,
        author: { value: 'Аня', untrusted: true },
        text: { value: ITEM.text, untrusted: true },
      });
      // The same file is what triage reads, so the two paths cannot disagree.
      const dir = legacyFile(fixture, `${JSON.stringify(ITEM)}\n`);
      expect(readBatchLines(dir, BATCH).map((envelope) => envelope.itemId)).toEqual([ITEM.id]);
    } finally {
      fixture.close();
    }
  });

  it('reads through feedback.mjs read instead of throwing', () => {
    const fixture = createFixture();
    try {
      const dir = legacyFile(fixture, `${JSON.stringify(ITEM)}\n`);
      const out: string[] = [];
      const code = runFeedback(['read', BATCH], {
        db: fixture.db,
        dir,
        now: () => new Date('2026-10-25T12:05:00Z'),
        print: (line) => out.push(line),
      });
      expect(code).toBe(0);
      expect(out.join('\n')).toContain('1 in the file');
    } finally {
      fixture.close();
    }
  });

  it('still refuses a foreign fence and a fence-less envelope', () => {
    const fixture = createFixture();
    try {
      expect(parseBatchFile(`<<<DATA bat_other>>>\n${JSON.stringify(ITEM)}\n<<<DATA bat_other>>>`, BATCH)).toMatchObject(
        { ok: false },
      );
      // An envelope outside its fence is not a legacy item: the reader does not guess.
      const envelope = '{"envelope":"book.filing/v1","itemId":"cmt_x","chapter":8,"rev":1}';
      expect(parseBatchFile(`${envelope}\n`, BATCH)).toMatchObject({ ok: false });
    } finally {
      fixture.close();
    }
  });
});
