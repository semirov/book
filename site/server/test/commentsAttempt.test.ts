import type { ChangeDto, ChangeSummaryDto, CommentDto, MyDecisionsDto } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { bootComments, type Harness } from './comments/helpers.ts';
import { longProse } from './helpers.ts';

/**
 * One state per filing, derived from the comment row plus one fact: does its
 * chapter have text.
 *
 * The prod contradiction this file pins: chapter 65 was written, its premise's linked change
 * ended `void`/`dropped` with «модель не ответила: PROVIDER_SHAPE», and every public surface
 * printed the engine's code as the reader's answer — «замысел не взят» over a chapter that
 * exists. A failed attempt is not a state: it leaves the filing where it was and reaches the
 * reader as one human sentence. The chapter's own text is the only fact a landing is read from.
 *
 * Fixtures are temp databases built by the harness — never the production data dir.
 */

const SHAPE_CODE = 'PROVIDER_SHAPE';
const TIMEOUT_CODE = 'ENGINE_TIMEOUT';
const ACCEPTED_LINE = 'принято: глава 65 отвечает на вопрос процедурой, а не объяснением';
const SHAPE_REASON = `модель не ответила: ${SHAPE_CODE}`;
const TIMEOUT_REASON = `движок отказал: ${TIMEOUT_CODE}: the engine did not answer within 10000 ms`;

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** Chapter 65 is written here; chapter 9 is not — the two facts the state is read from. */
async function boot(): Promise<Harness> {
  harness = await bootComments({
    chapters: {
      'ch08.md': longProse(['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.']),
      'ch65.md': longProse(['Тестовый абзац главы шестьдесят пять. Служебный текст, не книга.']),
    },
  });
  return harness;
}

type FilingSeed = {
  id: string;
  chapter: number;
  status?: string;
  reason?: string | null;
  decidedAt?: string | null;
};

/** A reader's filing, inserted the way triage writes it: decided, then linked to its change. */
function seedFiling(h: Harness, seed: FilingSeed): void {
  h.db
    .prepare(
      `INSERT INTO comments
         (id, identity_id, chapter, block_id, block_idx, base_rev, author, body, body_sha, flags,
          ip_hash, status, guard, created_at, decided_at, reason)
       VALUES (?, ?, ?, NULL, NULL, 0, 'Аня', 'А как?', ?, '[]', 'ip', ?, NULL,
               '2026-10-25T11:00:00Z', ?, ?)`,
    )
    .run(
      seed.id,
      h.identity.id,
      seed.chapter,
      `sha_${seed.id}`,
      seed.status ?? 'accepted',
      seed.decidedAt === undefined ? '2026-10-25T12:00:00Z' : seed.decidedAt,
      seed.reason ?? null,
    );
}

type ChangeSeed = {
  id: string;
  chapter: number;
  premise?: 0 | 1;
  status: string;
  outcome?: string | null;
  reason?: string | null;
  commentId?: string | null;
  finishedAt?: string | null;
};

function seedChange(h: Harness, seed: ChangeSeed): void {
  h.db
    .prepare(
      `INSERT INTO changes
         (id, kind, chapter, intent, source_comment, base_rev, base_sha256, base_blocks, scope_hint,
          premise, status, outcome, reason, tokens_in, tokens_out, enqueued_at, finished_at, attempts)
       VALUES (?, 'accepted_comment', ?, 'написать главу так, чтобы ответ был процедурой', ?, ?, 'sha', '[]',
               ?, ?, ?, ?, ?, 0, 0, '2026-10-25T11:00:00Z', ?, 1)`,
    )
    .run(
      seed.id,
      seed.chapter,
      seed.commentId ?? null,
      seed.premise === 1 ? 0 : 2,
      seed.premise === 1 ? 'chapter' : 'phrase',
      seed.premise ?? 0,
      seed.status,
      seed.outcome ?? null,
      seed.reason ?? null,
      seed.finishedAt ?? null,
    );
  if (seed.commentId !== undefined && seed.commentId !== null) {
    h.db.prepare('UPDATE comments SET change_id = ? WHERE id = ?').run(seed.id, seed.commentId);
  }
}

/** The prod shape: an accepted premise, a failed attempt behind it, chapter 65 written. */
function seedLandedPremise(h: Harness): void {
  seedFiling(h, {
    id: 'cmt_65',
    chapter: 65,
    status: 'accepted',
    reason: ACCEPTED_LINE,
  });
  seedChange(h, {
    id: 'chg_65',
    chapter: 65,
    premise: 1,
    status: 'void',
    outcome: 'dropped',
    reason: SHAPE_REASON,
    commentId: 'cmt_65',
    finishedAt: '2026-10-25T12:10:00Z',
  });
}

function chapterRev(h: Harness, chapter: number): number {
  const row = h.db.prepare('SELECT rev FROM chapters WHERE n = ?').get(chapter) as { rev: number };
  return row.rev;
}

/** The one row a single-filing test expects, without a non-null assertion in every case. */
function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('expected at least one row');
  return item;
}

async function listComments(h: Harness, chapter: number): Promise<CommentDto[]> {
  const response = await h.app.inject({ method: 'GET', url: `/api/comments?chapter=${chapter}` });
  expect(response.statusCode).toBe(200);
  return (response.json() as { items: CommentDto[] }).items;
}

describe('one state per filing: the row plus one fact', () => {
  it('a premise whose chapter is written is applied, not rejected by a failed attempt', async () => {
    const h = await boot();
    seedLandedPremise(h);
    const filing = first(await listComments(h, 65));
    expect(filing).toMatchObject({
      id: 'cmt_65',
      premise: true,
      status: 'applied',
      applied: { chapter: 65, rev: chapterRev(h, 65) },
      attempt: null,
      reason: ACCEPTED_LINE,
    });
    // The acceptance sentence is the reader's answer — the attempt's code is nowhere near it.
    expect(JSON.stringify(filing)).not.toContain(SHAPE_CODE);
  });

  it('a failed attempt leaves the filing waiting with a human line and no code', async () => {
    const h = await boot();
    // Chapter 9 has no text: the premise never landed, and the lane's attempt failed.
    seedFiling(h, { id: 'cmt_09', chapter: 9, status: 'accepted', reason: null });
    seedChange(h, {
      id: 'chg_09',
      chapter: 9,
      premise: 1,
      status: 'void',
      outcome: 'dropped',
      reason: SHAPE_REASON,
      commentId: 'cmt_09',
      finishedAt: '2026-10-25T12:10:00Z',
    });
    const filing = first(await listComments(h, 9));
    expect(filing).toMatchObject({ id: 'cmt_09', premise: true, status: 'accepted', attempt: 'failed' });
    // The filing has no line of its own and the attempt is not one: `attempt` carries the fact,
    // and the page prints the deck's sentence from it.
    expect(filing.reason).toBeNull();
    expect(JSON.stringify(filing)).not.toContain(SHAPE_CODE);
  });

  it('keeps a row that decided itself, whatever the linked change says', async () => {
    const h = await boot();
    // Chapter 9 has no text, so the premise's own row is the only state there is — and a
    // `void` attempt may not upgrade (or downgrade) it.
    seedFiling(h, { id: 'cmt_09b', chapter: 9, status: 'rejected', reason: 'вне рамок: канон' });
    seedChange(h, {
      id: 'chg_09b',
      chapter: 9,
      premise: 1,
      status: 'void',
      outcome: 'superseded',
      reason: SHAPE_REASON,
      commentId: 'cmt_09b',
    });
    const filing = first(await listComments(h, 9));
    expect(filing).toMatchObject({ status: 'rejected', reason: 'вне рамок: канон' });
    expect(filing.attempt).toBe('failed');
  });
});

describe('the public reason of a change is a sentence, never a code', () => {
  /** Two prod-like changes: a premise whose attempt came back off-shape, and a timeout. */
  function seedTwo(h: Harness): void {
    seedLandedPremise(h);
    seedFiling(h, { id: 'cmt_65b', chapter: 65, status: 'accepted', reason: null });
    seedChange(h, {
      id: 'chg_65b',
      chapter: 65,
      status: 'escalated',
      outcome: 'gate_timeout',
      reason: TIMEOUT_REASON,
      commentId: 'cmt_65b',
      finishedAt: '2026-10-25T12:20:00Z',
    });
  }

  it('holds on the list, the card and the reader’s own record', async () => {
    const h = await boot();
    seedTwo(h);
    const list = await h.app.inject({ method: 'GET', url: '/api/changes' });
    expect(list.statusCode).toBe(200);
    const summaries = list.json() as ChangeSummaryDto[];
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary.reason).not.toBeNull();
      expect(summary.reason ?? '').not.toMatch(/PROVIDER_SHAPE|ENGINE_TIMEOUT/u);
    }

    for (const id of ['chg_65', 'chg_65b']) {
      const card = await h.app.inject({ method: 'GET', url: `/api/changes/${id}` });
      expect(card.statusCode).toBe(200);
      const change = card.json() as ChangeDto;
      expect(change.reason ?? '').not.toMatch(/PROVIDER_SHAPE|ENGINE_TIMEOUT/u);
      expect(JSON.stringify(change)).not.toMatch(/PROVIDER_SHAPE|ENGINE_TIMEOUT/u);
    }

    const mine = await h.app.inject({
      method: 'GET',
      url: '/api/me/decisions',
      headers: { cookie: `book_session=${h.cookie}` },
    });
    expect(mine.statusCode).toBe(200);
    expect(JSON.stringify(mine.json())).not.toMatch(/PROVIDER_SHAPE|ENGINE_TIMEOUT/u);
  });

  it('marks a landed premise on both change shapes, and never claims a landing otherwise', async () => {
    const h = await boot();
    seedTwo(h);
    const summaries = (await h.app.inject({ method: 'GET', url: '/api/changes' })).json() as ChangeSummaryDto[];
    const landed = summaries.find((row) => row.id === 'chg_65');
    const failed = summaries.find((row) => row.id === 'chg_65b');
    // The premise's chapter has text; the escalated ordinary change claims nothing.
    expect(landed?.premiseLanded).toBe(true);
    expect(failed?.premiseLanded).toBe(false);
  });

  it('the own decision of a landed premise is applied', async () => {
    const h = await boot();
    seedLandedPremise(h);
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/me/decisions',
      headers: { cookie: `book_session=${h.cookie}` },
    });
    expect(response.statusCode).toBe(200);
    const record = response.json() as MyDecisionsDto;
    expect(record.items[0]).toMatchObject({
      commentId: 'cmt_65',
      premise: true,
      outcome: 'applied',
      chapters: [65],
      reason: ACCEPTED_LINE,
    });
    expect(JSON.stringify(record)).not.toContain(SHAPE_CODE);
  });
});
