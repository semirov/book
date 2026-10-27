import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { bootComments, commentBody, type Harness } from './helpers.ts';

/**
 * BOOK-7 — the door to an intervention on a chapter with no text.
 *
 * The frozen frame (ch01's opening, ch67's finale) is never a target. A basis slot is
 * projected with a row (rev 0, one block), so the guard must read the slot, not the absence
 * of a row: this fixture writes the real basis files and lets the ingest project them.
 * Every other empty slot takes a chapter-level intervention with base revision 0; a
 * paragraph quoted from no text is still a stale anchor.
 */

let harness: Harness | null = null;

async function boot(): Promise<Harness> {
  harness = await bootComments({
    chapters: {
      'ch01.md': FRAME_FIRST_SENTENCE,
      'ch67.md': FRAME_LAST_SENTENCE,
      'ch08.md': 'Заголовок\n\nСлужебный абзац восьмой главы.',
    },
  });
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function post(h: Harness, body: unknown) {
  return h.app.inject({ method: 'POST', url: '/api/comments', headers: h.headers(), payload: body as object });
}

describe('POST /api/comments on an empty chapter', () => {
  it('has real basis rows to be refused — a row, not missing text', async () => {
    const h = await boot();
    expect(h.db.prepare('SELECT n, rev, basis, block_count FROM chapters WHERE n IN (1, 67) ORDER BY n').all()).toEqual([
      { n: 1, rev: 0, basis: 1, block_count: 1 },
      { n: 67, rev: 0, basis: 1, block_count: 1 },
    ]);
  });

  it('answers STALE_ANCHOR for a paragraph quoted from a chapter with no text, and stores nothing', async () => {
    const h = await boot();
    const response = await post(
      h,
      commentBody({ chapter: 9, blockId: 'ch09#00000000', quote: 'Этого абзаца нет.', body: 'К девятой главе есть замечание.' }),
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'STALE_ANCHOR' });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 0 });
  });

  it('refuses a note or a proposed intervention on the frozen frame (FROZEN_FRAME)', async () => {
    const h = await boot();
    for (const chapter of [1, 67]) {
      const note = await post(h, commentBody({ chapter, body: 'К этой главе есть замысел.' }));
      expect(note.statusCode, `note ch${chapter}`).toBe(403);
      expect(note.json(), `note ch${chapter}`).toMatchObject({ code: 'FROZEN_FRAME' });
      expect(note.json().message).toContain('неподвижна');
    }
    const first = await post(
      h,
      commentBody({ chapter: 1, body: 'Начать иначе.', proposedText: 'Первая фраза иначе.', interventionKind: 'decision' }),
    );
    expect(first.statusCode).toBe(403);
    expect(first.json()).toMatchObject({ code: 'FROZEN_FRAME' });
    // ch67's proposed text keeps its older, equally public refusal.
    const finale = await post(
      h,
      commentBody({ chapter: 67, body: 'Закончить иначе.', proposedText: 'Последняя фраза иначе.', interventionKind: 'decision' }),
    );
    expect(finale.statusCode).toBe(403);
    expect(finale.json()).toMatchObject({ code: 'ENDING_FROZEN' });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 0 });
  });
});
