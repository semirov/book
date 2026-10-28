/**
 * BOOK-174 — the author's side: an escalated filing is decided, listed and closed.
 *
 * Split from `dispositionAccept.test.ts` (the 500-line gate): that file proves what a decision
 * stores and how it reaches the page, this one proves that the row the ladder could not place is
 * still a row somebody can answer — placed by the author (a change), ended by the author (the one
 * refusal that needs no lock), and shown in the inbox that asks for that answer.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { insertComment, readCommentRow, toCommentDto } from '../../src/comments/repo.ts';
import { runFeedback } from '../../src/feedback/cli.ts';
import { DecisionsTailer } from '../../src/feedback/decisions.ts';
import { disposeRejection } from '../../src/feedback/dispositionStore.ts';
import { bootComments, commentBody, type Harness } from '../comments/helpers.ts';

let harness: Harness | null = null;
let dir: string | null = null;

const INTENT = 'в абзаце дважды «слово» — оставить одно';
const QUOTE = 'Тестовый абзац номер один.';

afterEach(async () => {
  await harness?.close();
  harness = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function boot(): Promise<Harness> {
  harness = await bootComments();
  dir = mkdtempSync(join(tmpdir(), 'book-disposition-author-'));
  return harness;
}

function cli(h: Harness, ...argv: string[]): { code: number; out: string[] } {
  const out: string[] = [];
  const code = runFeedback(argv, { db: h.db, dir: dir ?? '', now: h.clock.now, print: (line) => out.push(line) });
  return { code, out };
}

/** A filed intervention on the first paragraph of ch08, audited and so ready for a decision. */
async function filed(h: Harness): Promise<string> {
  const block = h.db.prepare('SELECT id FROM blocks WHERE chapter = 8 ORDER BY idx LIMIT 1').get() as { id: string };
  const posted = await h.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: h.headers(),
    payload: commentBody({
      chapter: 8,
      blockId: block.id,
      quote: QUOTE,
      body: 'Бумага вместо сцены.',
      proposedText: 'В регистратуре выдают уведомление: срок тридцать дней и подпись.',
    }),
  });
  expect(posted.statusCode).toBe(201);
  const id = posted.json().comment.id as string;
  expect(cli(h, 'audit', id, '--verdict', 'FITS').code).toBe(0);
  return id;
}

describe('an escalated filing waits for the author, and is decided (BOOK-174)', () => {
  /** Escalate a filing through the operator's own path. */
  function escalate(h: Harness, id: string): void {
    const out = cli(h, 'decide', id, 'rejected', '--reason', 'вне рамок: не про текст');
    expect(out.code).toBe(0);
    expect(readCommentRow(h.db, id)).toMatchObject({ status: 'escalated', disposition: 'escalated' });
  }

  it('places it when the author accepts: a change is created, once', async () => {
    const h = await boot();
    const id = await filed(h);
    escalate(h, id);

    const accepted = cli(h, 'decide', id, 'accepted', '--reason', 'автор: входит', '--intent', INTENT, '--as', 'author');
    expect(accepted.code).toBe(0);
    const row = readCommentRow(h.db, id);
    expect(row).toMatchObject({ status: 'accepted', change_id: expect.any(String) as unknown as string });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });
    // The second decision replaced the chain: the reading is no longer pending.
    expect(row?.disposition).toBe('as_said');
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'escalated'`).get()).toEqual({ n: 1 });

    // A third decision is refused: the first decision wins again once the author has spoken.
    const again = cli(h, 'decide', id, 'accepted', '--reason', 'ещё раз', '--intent', INTENT, '--as', 'author');
    expect(again.code).toBe(1);
    expect(again.out.join('\n')).toContain('already decided');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });
  });

  it('is placed once, and a replay of the line it wrote changes nothing', async () => {
    const h = await boot();
    const id = await filed(h);
    escalate(h, id);
    // The operator's path: the row is written first, the line second — the site then reads it.
    expect(
      cli(h, 'decide', id, 'accepted', '--reason', 'автор: входит', '--intent', INTENT, '--as', 'author').code,
    ).toBe(0);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });

    const emitted: Array<{ type: string; data: unknown }> = [];
    const tailer = new DecisionsTailer({
      db: h.db,
      dir: dir ?? '',
      emit: (type, data) => emitted.push({ type, data }),
      now: h.clock.now,
      replay: true,
    });
    tailer.prime();
    // A replay of the same line: the decision is announced again and nothing is created.
    expect(tailer.poll()).toBeGreaterThan(0);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });
    expect(emitted.find((event) => event.type === 'comment:decision')?.data).toMatchObject({ status: 'accepted' });
    // A second poll reads no new line at all.
    expect(tailer.poll()).toBe(0);
  });

  it('refuses a re-run of the line that escalated it: a retry is not an answer', async () => {
    const h = await boot();
    const id = await filed(h);
    escalate(h, id);
    const retry = cli(h, 'decide', id, 'rejected', '--reason', 'вне рамок: не про текст');
    expect(retry.code).toBe(1);
    expect(retry.out.join('\n')).toContain('waits for the author');
    expect(readCommentRow(h.db, id)?.status).toBe('escalated');
  });

  it('is listed for the author, with the question it asks', async () => {
    const h = await boot();
    const id = await filed(h);
    escalate(h, id);
    const out = cli(h, 'inbox', '--escalated');
    expect(out.code).toBe(0);
    expect(out.out.join('\n')).toContain(id);
    expect(out.out.join('\n')).toContain('потому что эта правка меняет не слово, а исход');
  });

  it('ends when the author says no: the one refusal that needs no lock', async () => {
    const h = await boot();
    const id = await filed(h);
    escalate(h, id);
    expect(cli(h, 'decide', id, 'rejected', '--reason', 'автор: не место', '--as', 'author').code).toBe(0);
    const row = readCommentRow(h.db, id);
    expect(row).toMatchObject({ status: 'rejected', reason: 'автор: не место' });
    // The chain described a question that is no longer pending.
    expect(row).toMatchObject({ disposition: null, lock: null, carrier_kind: null, quote_kept: null });
    expect(toCommentDto(h.db, row!).report).toBeNull();
  });
});

/**
 * Blocker from the review: a stored chain must not survive the fact it rested on. A row whose
 * rights verdict was lifted (or whose legal flag was removed) is judged again, and the reader is
 * not re-refused under a lock the book no longer holds.
 */
describe('a stored lock is re-judged when its premise is gone (BOOK-174)', () => {
  /** A filed row whose rights verdict is still open, so the gate may speak about it. */
  function openRights(h: Harness, id: string, chapter = 8): void {
    insertComment(h.db, {
      id,
      identityId: h.identity.id,
      chapter,
      blockId: null,
      blockIndex: null,
      baseRev: 1,
      quote: null,
      prefix: null,
      suffix: null,
      author: 'Аня',
      body: 'Чужая цитата без источника.',
      proposedText: null,
      interventionKind: null,
      bodySha: 'a'.repeat(64),
      flags: ['rights-flag'],
      ipHash: 'f'.repeat(64),
      status: 'new',
      guard: null,
      reason: null,
      createdAt: '2026-10-25T12:00:00Z',
      idemKey: null,
    });
  }

  it('ignores a rights lock whose verdict was lifted, and answers the new fact', async () => {
    const h = await boot();
    const id = 'cmt_stale_lock';
    openRights(h, id);
    expect(
      cli(h, 'rights', id, '--verdict', 'REFUSED', '--rule', 'RIGHTS-PARAPHRASE', '--source', 'Пелевин').code,
    ).toBe(0);
    const refused = readCommentRow(h.db, id)!;
    expect(refused).toMatchObject({ status: 'rejected', lock: 'rights' });

    // The verdict is lifted — the way `release` does it — but the chain is left behind by a
    // build that did not clear it. The next judgement must not read the stale lock.
    h.db
      .prepare(`UPDATE comments SET status = 'new', decided_at = NULL, rights_verdict = 'CLEAR' WHERE id = ?`)
      .run(id);
    const reopened = readCommentRow(h.db, id)!;
    const result = disposeRejection(h.db, { comment: reopened, at: h.clock.now().toISOString() });
    expect(result.status).toBe('escalated');
    expect(result.decision.lock).toBeNull();
    expect(readCommentRow(h.db, id)).toMatchObject({ status: 'escalated', disposition: 'escalated' });
  });

  it('keeps a lock whose premise still holds', async () => {
    const h = await boot();
    const id = 'cmt_live_lock';
    openRights(h, id);
    expect(
      cli(h, 'rights', id, '--verdict', 'REFUSED', '--rule', 'RIGHTS-PARAPHRASE', '--source', 'Пелевин').code,
    ).toBe(0);
    const row = readCommentRow(h.db, id)!;
    // A second call over the same row keeps the rights lock: nothing was lifted.
    const again = disposeRejection(h.db, { comment: row, at: h.clock.now().toISOString() });
    expect(again.status).toBe('rejected');
    expect(again.decision.lock).toBe('rights');
  });
});
