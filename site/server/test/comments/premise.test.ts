import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { bootComments, commentBody, type Harness } from './helpers.ts';

/**
 * BOOK-7 — the door to an intervention on a chapter with no text.
 *
 * BOOK-137 amends the old rule: the frozen frame (ch01's opening, the finale's close) is no longer
 * a closed door. A filing may anchor on the canon sentence's own paragraph — the letters are
 * kept by the land guard, and an accepted filing on it becomes paperwork. A basis slot is
 * projected with a row (rev 0, one block), so the anchor is resolved against the slot's own
 * paragraph, never against a missing row; only a **chapter-level** filing of such a slot takes
 * the premise branch. A paragraph quoted from no text is still a stale anchor.
 */

let harness: Harness | null = null;

async function boot(): Promise<Harness> {
  harness = await bootComments({
    chapters: {
      'ch01.md': FRAME_FIRST_SENTENCE,
      'ch42.md': FRAME_LAST_SENTENCE,
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
    expect(
      h.db.prepare('SELECT n, rev, basis, block_count FROM chapters WHERE n IN (1, ?) ORDER BY n').all(TOTAL_CHAPTERS),
    ).toEqual([
      { n: 1, rev: 0, basis: 1, block_count: 1 },
      { n: TOTAL_CHAPTERS, rev: 0, basis: 1, block_count: 1 },
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

  it('accepts a note or a proposed intervention on the frozen frame — as a filing, not a change', async () => {
    const h = await boot();
    // BOOK-137: trying is allowed. The sentence's letters are kept by the land guard, and an
    // accepted filing on it becomes paperwork — so the door is open and the thread says so.
    for (const chapter of [1, TOTAL_CHAPTERS]) {
      const note = await post(h, commentBody({ chapter, body: `К главе ${chapter} есть замысел.` }));
      expect(note.statusCode, `note ch${chapter}`).toBe(201);
      expect(note.json().comment, `note ch${chapter}`).toMatchObject({ status: 'new' });
    }
    const first = await post(
      h,
      commentBody({ chapter: 1, body: 'Начать иначе.', proposedText: 'Первая фраза иначе.', interventionKind: 'decision' }),
    );
    expect(first.statusCode).toBe(201);
    // A chapter-level filing of a basis slot is that slot's premise, exactly as BOOK-7 says.
    expect(first.json().comment.frame).toBe('untouched');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 3 });
    // Nothing was written: the slot is still the slot.
    expect(
      h.db.prepare('SELECT n, rev, basis FROM chapters WHERE n IN (1, ?) ORDER BY n').all(TOTAL_CHAPTERS),
    ).toEqual([
      { n: 1, rev: 0, basis: 1 },
      { n: TOTAL_CHAPTERS, rev: 0, basis: 1 },
    ]);
  });

  it('resolves a block anchor on a basis slot like prose, and marks it touched', async () => {
    const h = await boot();
    // BOOK-137: the frame's own paragraph is the reader's target, not a stale anchor.
    const block = h.db.prepare('SELECT id, text FROM blocks WHERE chapter = 1').get() as { id: string; text: string };
    const response = await post(
      h,
      commentBody({ chapter: 1, blockId: block.id, quote: block.text, body: 'Первая фраза держит всю книгу.' }),
    );
    expect(response.statusCode).toBe(201);
    expect(response.json().comment.frame).toBe('touched');
    expect(response.json().comment.anchor).toMatchObject({ blockId: block.id, blockIndex: 0, resolved: true });
  });
});
