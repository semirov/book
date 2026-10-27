import { afterEach, describe, expect, it } from 'vitest';

import { bootComments, commentBody, type Harness } from './comments/helpers.ts';

/**
 * BOOK-111 — the chapter-level filing, and the refusal that names it.
 *
 * The owner's prod row: `chapter 65, block_id NULL, base_rev 0, status 'new'`, no change, body
 * «А как?». `toCommentDto` derived `premise` only from a linked change, so the DTO said
 * `premise: false`; the empty chapter kept reading as an empty slot and the reader's second tap
 * came back 409 with no way to the filing that already existed.
 *
 * These cases live apart from `commentsApi.test.ts` for the arch gate's 500-line limit; they use
 * the same harness and the same `post` shape.
 */

let harness: Harness | null = null;

async function boot(): Promise<Harness> {
  harness = await bootComments();
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function post(h: Harness, body: unknown) {
  return h.app.inject({ method: 'POST', url: '/api/comments', headers: h.headers(), payload: body as object });
}

describe('a chapter-level filing is the premise of an unwritten chapter (BOOK-111)', () => {
  it('answers the DTO as the premise, with no change yet', async () => {
    const h = await boot();
    const response = await post(h, commentBody({ chapter: 9, body: 'К девятой главе есть замечание.' }));
    expect(response.statusCode).toBe(201);
    expect(response.json().comment).toMatchObject({
      premise: true,
      status: 'new',
      changeId: null,
      anchor: { blockId: null, resolved: true },
    });
    expect(h.db.prepare('SELECT change_id, status FROM comments').get()).toEqual({ change_id: null, status: 'new' });
  });

  it('does not read a chapter-level comment on a written chapter as a premise', async () => {
    const h = await boot();
    const response = await post(h, commentBody({ chapter: 8, body: 'Ко всей восьмой главе есть замечание.' }));
    expect(response.statusCode).toBe(201);
    const comment = response.json().comment as { premise: boolean; anchor: { blockId: string | null } };
    expect(comment.premise).toBe(false);
    expect(comment.anchor.blockId).toBeNull();
    // The definition is the schema's own: a premise has `base_rev 0`, and this chapter has text.
    const row = h.db.prepare('SELECT base_rev FROM comments').get() as { base_rev: number };
    expect(row.base_rev).toBeGreaterThan(0);
  });
});

describe('a duplicate refusal names the filing that already exists (BOOK-111)', () => {
  it('answers 409 with the first comment’s id, and stores one row', async () => {
    // The same empty chapter, tapped twice: the second is refused, and the reader must be able
    // to reach the first. The id is the same identity's own row, found by identity and body hash.
    const h = await boot();
    const first = await post(h, commentBody({ chapter: 9, body: 'А как?' }));
    expect(first.statusCode).toBe(201);
    const firstId = (first.json().comment as { id: string }).id;

    const duplicate = await post(h, commentBody({ chapter: 9, body: 'А как?' }));
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'DUPLICATE', commentId: firstId });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 1 });
  });
});
