import type { ChangeDto, ChangeSummaryDto, CommentDto, MyDecisionsDto } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { bootComments, type Harness } from './comments/helpers.ts';
import { longProse } from './helpers.ts';

/**
 * One state per filing, derived from the comment row plus one fact: does its
 * chapter have text.
 *
 * The prod contradiction this file pins: chapter 34 was written, its premise's linked change
 * ended `void`/`dropped` with «модель не ответила: PROVIDER_SHAPE», and every public surface
 * printed the engine's code as the reader's answer — «замысел не взят» over a chapter that
 * exists. A failed attempt is not a state: it leaves the filing where it was and reaches the
 * reader as one human sentence. The chapter's own text is the only fact a landing is read from.
 *
 * Fixtures are temp databases built by the harness — never the production data dir.
 */

const SHAPE_CODE = 'PROVIDER_SHAPE';
const TIMEOUT_CODE = 'ENGINE_TIMEOUT';
const ACCEPTED_LINE = 'принято: глава 34 отвечает на вопрос процедурой, а не объяснением';
const SHAPE_REASON = `модель не ответила: ${SHAPE_CODE}`;
const TIMEOUT_REASON = `движок отказал: ${TIMEOUT_CODE}: the engine did not answer within 10000 ms`;

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** Chapter 34 is written here; chapter 9 is not — the two facts the state is read from. */
async function boot(): Promise<Harness> {
  harness = await bootComments({
    chapters: {
      'ch08.md': longProse(['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.']),
      'ch34.md': longProse(['Тестовый абзац главы тридцать четыре. Служебный текст, не книга.']),
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

/** The prod shape: an accepted premise, a failed attempt behind it, chapter 34 written. */
function seedLandedPremise(h: Harness): void {
  seedFiling(h, {
    id: 'cmt_34',
    chapter: 34,
    status: 'accepted',
    reason: ACCEPTED_LINE,
  });
  seedChange(h, {
    id: 'chg_34',
    chapter: 34,
    premise: 1,
    status: 'void',
    outcome: 'dropped',
    reason: SHAPE_REASON,
    commentId: 'cmt_34',
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
    const filing = first(await listComments(h, 34));
    expect(filing).toMatchObject({
      id: 'cmt_34',
      premise: true,
      status: 'applied',
      applied: { chapter: 34, rev: chapterRev(h, 34) },
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
    // A row that refused the filing said the last word: the attempt behind it is not an echo of
    // that refusal, and the page prints the row's own sentence, never «модель … не по форме».
    expect(filing.attempt).toBeNull();
  });

  it('leaves every own-decision state without an attempt line', async () => {
    const h = await boot();
    // `hidden` is a moderation state and never listed; the three public own-decision states are.
    const states = ['rejected', 'quarantined', 'superseded'] as const;
    for (const state of states) {
      seedFiling(h, { id: `cmt_own_${state}`, chapter: 9, status: state, reason: 'вне рамок: канон' });
      seedChange(h, {
        id: `chg_own_${state}`,
        chapter: 9,
        premise: 1,
        status: 'void',
        outcome: 'dropped',
        reason: SHAPE_REASON,
        commentId: `cmt_own_${state}`,
      });
    }
    const byState = new Map((await listComments(h, 9)).map((filing) => [filing.status, filing.attempt]));
    for (const state of states) expect(byState.get(state), state).toBeNull();
  });

  it('carries no receipt when a premise decided against a written chapter', async () => {
    const h = await boot();
    // Chapter 34 has text, but this row refused the filing: the row's own word is the state, and
    // a receipt would claim the reader's words entered an edition they did not shape.
    seedFiling(h, { id: 'cmt_34r', chapter: 34, status: 'rejected', reason: 'вне рамок: канон' });
    seedChange(h, {
      id: 'chg_34r',
      chapter: 34,
      premise: 1,
      status: 'void',
      outcome: 'dropped',
      reason: SHAPE_REASON,
      commentId: 'cmt_34r',
    });
    expect(first(await listComments(h, 34))).toMatchObject({ status: 'rejected', applied: null, attempt: null });
  });

  it('carries no receipt when a human sentence superseded a premise on a written chapter', async () => {
    const h = await boot();
    seedFiling(h, { id: 'cmt_34s', chapter: 34, status: 'accepted', reason: ACCEPTED_LINE });
    seedChange(h, {
      id: 'chg_34s',
      chapter: 34,
      premise: 1,
      status: 'void',
      outcome: 'superseded',
      reason: 'у главы уже есть замысел',
      commentId: 'cmt_34s',
    });
    expect(first(await listComments(h, 34))).toMatchObject({
      status: 'superseded',
      applied: null,
      reason: 'у главы уже есть замысел',
    });
  });

  it('a silent change decides nothing: the written chapter still lands the premise', async () => {
    const h = await boot();
    // `void` with no reason is not a refusal: the writer said nothing, and the chapter's text
    // is the answer — the attempt-free counterpart of the prod shape above.
    seedFiling(h, { id: 'cmt_34q', chapter: 34, status: 'accepted', reason: ACCEPTED_LINE });
    seedChange(h, {
      id: 'chg_34q',
      chapter: 34,
      premise: 1,
      status: 'void',
      outcome: 'dropped',
      reason: null,
      commentId: 'cmt_34q',
    });
    expect(first(await listComments(h, 34))).toMatchObject({
      status: 'applied',
      applied: { chapter: 34, rev: chapterRev(h, 34) },
      attempt: null,
      reason: ACCEPTED_LINE,
    });
  });

  it('a silent change over an empty chapter leaves the premise waiting', async () => {
    const h = await boot();
    seedFiling(h, { id: 'cmt_09q', chapter: 9, status: 'accepted', reason: null });
    seedChange(h, {
      id: 'chg_09q',
      chapter: 9,
      premise: 1,
      status: 'void',
      outcome: 'dropped',
      reason: null,
      commentId: 'cmt_09q',
    });
    expect(first(await listComments(h, 9))).toMatchObject({
      status: 'accepted',
      applied: null,
      attempt: null,
    });
  });

  it('reads an ordinary filing’s receipt from its change, and the row’s own columns as the fallback', async () => {
    // BOOK-189 — a landing has no receipt columns of its own: the change names the chapter it
    // entered and that chapter's live revision is the receipt (the row's stored `applied_*` is
    // the second source, never the first).
    const h = await boot();
    seedFiling(h, { id: 'cmt_note', chapter: 8, status: 'applied', reason: null });
    seedChange(h, { id: 'chg_note', chapter: 8, status: 'done', outcome: 'applied', commentId: 'cmt_note' });
    h.db.prepare('UPDATE comments SET applied_chapter = 8, applied_rev = 3 WHERE id = ?').run('cmt_note');
    expect(first(await listComments(h, 8))).toMatchObject({
      id: 'cmt_note',
      premise: false,
      status: 'applied',
      applied: { chapter: 8, rev: chapterRev(h, 8) },
    });

    // Chapter 9 has no chapter row at all, so nothing is invented: the stored columns stand.
    seedFiling(h, { id: 'cmt_09note', chapter: 9, status: 'applied', reason: null });
    seedChange(h, { id: 'chg_09note', chapter: 9, status: 'done', outcome: 'applied', commentId: 'cmt_09note' });
    h.db.prepare('UPDATE comments SET applied_chapter = 9, applied_rev = 3 WHERE id = ?').run('cmt_09note');
    expect(first(await listComments(h, 9))).toMatchObject({
      id: 'cmt_09note',
      premise: false,
      status: 'applied',
      applied: { chapter: 9, rev: 3 },
    });
  });
});

describe('the public reason of a change is a sentence, never a code', () => {
  /** Two prod-like changes: a premise whose attempt came back off-shape, and a timeout. */
  function seedTwo(h: Harness): void {
    seedLandedPremise(h);
    seedFiling(h, { id: 'cmt_34b', chapter: 34, status: 'accepted', reason: null });
    seedChange(h, {
      id: 'chg_34b',
      chapter: 34,
      status: 'escalated',
      outcome: 'gate_timeout',
      reason: TIMEOUT_REASON,
      commentId: 'cmt_34b',
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

    for (const id of ['chg_34', 'chg_34b']) {
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
    const landed = summaries.find((row) => row.id === 'chg_34');
    const failed = summaries.find((row) => row.id === 'chg_34b');
    // The premise's chapter has text; the escalated ordinary change claims nothing.
    expect(landed?.premiseLanded).toBe(true);
    expect(failed?.premiseLanded).toBe(false);
  });

  it('names the filing a summary was made from, and null for a change with none (BOOK-137)', async () => {
    // The thread folds an attempt into the entry of its filing by this key. A change the author
    // raised alone carries no filing, and the reader's thread lists no row for it.
    const h = await boot();
    seedTwo(h);
    const summaries = (await h.app.inject({ method: 'GET', url: '/api/changes' })).json() as ChangeSummaryDto[];
    expect(summaries.find((row) => row.id === 'chg_34')?.sourceCommentId).toBe('cmt_34');
    expect(summaries.find((row) => row.id === 'chg_34b')?.sourceCommentId).toBe('cmt_34b');
    seedFiling(h, { id: 'cmt_authorless', chapter: 9, status: 'accepted' });
    seedChange(h, { id: 'chg_authorless', chapter: 9, status: 'done', outcome: 'applied', commentId: null });
    const again = (await h.app.inject({ method: 'GET', url: '/api/changes' })).json() as ChangeSummaryDto[];
    expect(again.find((row) => row.id === 'chg_authorless')?.sourceCommentId).toBeNull();
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
      commentId: 'cmt_34',
      premise: true,
      outcome: 'applied',
      chapters: [34],
      reason: ACCEPTED_LINE,
    });
    expect(JSON.stringify(record)).not.toContain(SHAPE_CODE);
  });
});
