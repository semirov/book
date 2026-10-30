/**
 * BOOK-187 AC5–AC7, the disk half — the lane's own directories are gone, and the writer does not
 * make one.
 *
 * `writer/state.json`, `writer/pre/` and `writer/transcripts/` were the lane's three files. Two are
 * deleted code (`pre` was never written since the landing carries the text); the counter and the
 * receipt are rows now. This test is the negative image of all three: it runs a whole pass — draft,
 * two gates, a landing and a close — against a temp data dir and then walks it, naming the path in
 * the assertion if anything of the writer's is there.
 *
 * The data dir's *full* allow-list is the next step's guard (`server/test/dataHome.test.ts`); this
 * test asks only the writer's own question.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { chapterAnswer, createHarness } from './harness.ts';

describe('the writer on disk — nothing of its own', () => {
  it('runs a full pass and leaves no writer/ tree under the data dir', async () => {
    const harness = await createHarness();
    try {
      harness.premised(40, 'в главе 40 появляется документ о допуске');
      harness.script.push(chapterAnswer(), 'HOLDS', 'HOLDS');

      const result = await harness.run({ chapter: 40 });
      expect(result.status).toBe('closed');
      // The pass really happened: the chapter is a row and the receipt is a row.
      expect(harness.fixture.readChapter(40)).not.toBeNull();
      expect(harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM pass_transcripts').get()).toEqual({ n: 3 });

      for (const path of ['writer', 'writer/state.json', 'writer/pre', 'writer/transcripts']) {
        const full = join(harness.dataDir, path);
        expect(existsSync(full), `the writer wrote ${full}`).toBe(false);
      }
    } finally {
      await harness.close();
    }
  });

  it('keeps the pre-image a row too: a stopped pass writes no file', async () => {
    const harness = await createHarness();
    try {
      harness.script.push('Извините, я не могу написать эту главу.', 'Извините, я не могу.');
      const result = await harness.run({ chapter: 41 });
      expect(result.status).toBe('refused');
      // A pass that never landed and never wrote: the counter is the only row it owns.
      expect(existsSync(join(harness.dataDir, 'writer'))).toBe(false);
      expect(harness.fixture.db.prepare('SELECT COUNT(*) AS n FROM writer_state').get()).toEqual({ n: 0 });
    } finally {
      await harness.close();
    }
  });
});
