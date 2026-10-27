/**
 * HELD is not a black hole (BOOK-61, BOOK-43 M1): the operator can hold and release, and a
 * released row is in the next batch.
 *
 * The hold is the A pass's write, so its evidence passes the same post-check a model's verdict
 * does; the release is the operator's undo, with the reason in the event and the guard's own
 * flags untouched. Nothing here calls a model, writes prose or touches the manuscript.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { insertComment, readCommentRow } from '../../src/comments/repo.ts';
import { upsertIdentity } from '../../src/db/repo/identities.ts';
import { createBatch, readBatchLines } from '../../src/feedback/batches.ts';
import { runFeedback } from '../../src/feedback/cli.ts';
import { createFixture, type Fixture } from '../helpers.ts';

const BODY = 'В абзаце дважды «абзац» — оставить одно упоминание.';

let fixture: Fixture | null = null;
let dir: string | null = null;

function boot(): { fixture: Fixture; dir: string } {
  fixture = createFixture({ 'ch01.md': 'Глава\n\nТестовый абзац номер один.' });
  dir = mkdtempSync(join(tmpdir(), 'book-held-'));
  return { fixture, dir };
}

afterEach(() => {
  fixture?.close();
  fixture = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function cli(...argv: string[]): { code: number; out: string[] } {
  if (fixture === null) throw new Error('no fixture');
  const out: string[] = [];
  const code = runFeedback(argv, {
    db: fixture.db,
    dir: dir ?? '',
    now: () => new Date('2026-10-27T12:00:00Z'),
    print: (line) => out.push(line),
  });
  return { code, out };
}

function seed(status: 'new' | 'quarantined', body = BODY, id = 'cmt_hold'): string {
  if (fixture === null) throw new Error('no fixture');
  const identity = upsertIdentity(fixture.db, {
    yandexSub: 'yandex-1',
    displayName: 'Аня',
    at: '2026-10-27T09:00:00Z',
  });
  insertComment(fixture.db, {
    id,
    identityId: identity.id,
    chapter: 1,
    blockId: null,
    blockIndex: null,
    baseRev: 1,
    quote: null,
    prefix: null,
    suffix: null,
    author: 'Аня',
    body,
    proposedText: null,
    interventionKind: null,
    bodySha: 'a'.repeat(64),
    flags: ['possible-instruction'],
    ipHash: 'f'.repeat(64),
    status,
    guard: status === 'quarantined' ? 'instruction' : null,
    reason: status === 'quarantined' ? 'проверяется: возможная инструкция' : null,
    createdAt: '2026-10-27T09:01:00Z',
    idemKey: null,
  });
  if (status === 'quarantined') {
    fixture.db
      .prepare(`UPDATE comments SET held_rule = 'INJ-IMPERATIVE', held_by = 'filter', held_at = ? WHERE id = ?`)
      .run('2026-10-27T09:02:00Z', id);
  }
  return id;
}

function events(commentId: string): Array<{ type: string; meta: string | null }> {
  if (fixture === null) throw new Error('no fixture');
  return fixture.db
    .prepare('SELECT type, meta FROM comment_events WHERE comment_id = ? ORDER BY id')
    .all(commentId) as Array<{ type: string; meta: string | null }>;
}

describe('feedback.mjs hold — the A pass writes it once', () => {
  it('quarantines a new row with the rule, the author of the act and a held event', () => {
    const { fixture } = boot();
    const id = seed('new');
    const result = cli('hold', id, '--rule', 'INJ-IMPERATIVE', '--evidence', `text:${BODY}`, '--by', 'triage-1');
    expect(result.code).toBe(0);
    expect(result.out.join('\n')).toContain('held INJ-IMPERATIVE');

    const row = readCommentRow(fixture.db, id);
    expect(row).toMatchObject({
      status: 'quarantined',
      held_rule: 'INJ-IMPERATIVE',
      held_by: 'classifier',
      held_at: '2026-10-27T12:00:00.000Z',
    });
    // The guard's flags and taxonomy are kept: the reader's status is public, this is not.
    expect(row?.guard).toBeNull();
    expect(JSON.parse(row?.flags ?? '[]')).toEqual(['possible-instruction']);
    expect(events(id)).toEqual([
      { type: 'held', meta: JSON.stringify({ rule: 'INJ-IMPERATIVE', field: 'text', quote: BODY, by: 'triage-1' }) },
    ]);

    // A held row never enters a batch, and the operator can see why.
    expect(createBatch({ db: fixture.db, dir: dir ?? '' })).toMatchObject({ code: 'EMPTY' });
    const held = cli('inbox', '--held');
    expect(held.code).toBe(0);
    expect(held.out.join('\n')).toContain('INJ-IMPERATIVE');
    expect(held.out.join('\n')).toContain('classifier');
  });

  it('is idempotent: a second hold keeps the first rule and writes no second event', () => {
    const { fixture } = boot();
    const id = seed('new');
    expect(cli('hold', id, '--rule', 'INJ-IMPERATIVE', '--evidence', `text:${BODY}`).code).toBe(0);
    const again = cli('hold', id, '--rule', 'INJ-VERDICT', '--evidence', `text:${BODY}`);
    expect(again.code).toBe(0);
    expect(again.out.join('\n')).toContain('already held');
    expect(readCommentRow(fixture.db, id)?.held_rule).toBe('INJ-IMPERATIVE');
    expect(events(id)).toHaveLength(1);
  });

  it('refuses an evidence quote the filing does not contain, and leaves the row new', () => {
    const { fixture } = boot();
    const id = seed('new');
    const refused = cli('hold', id, '--rule', 'INJ-IMPERATIVE', '--evidence', 'text:этого в замечании нет');
    expect(refused.code).toBe(1);
    expect(refused.out.join('\n')).toContain('POSTCHECK_FAILED');
    expect(readCommentRow(fixture.db, id)?.status).toBe('new');
    expect(events(id)).toHaveLength(0);
  });

  it('refuses an unknown rule, a bad evidence form, a decided row and a missing comment', () => {
    const { fixture } = boot();
    const id = seed('new');
    fixture.db.prepare(`UPDATE comments SET decided_at = ? WHERE id = ?`).run('2026-10-27T11:00:00Z', id);

    expect(cli('hold', id, '--rule', 'INJ-NONSENSE', '--evidence', `text:${BODY}`).code).toBe(1);
    expect(cli('hold', id, '--rule', 'INJ-IMPLEMENTIVE', '--evidence', `text:${BODY}`).code).toBe(1);
    expect(cli('hold', id, '--rule', 'INJ-IMPERATIVE', '--evidence', `flags:${BODY}`).code).toBe(2);
    // No colon at all, and a `--by` longer than the recorded label may be.
    expect(cli('hold', id, '--rule', 'INJ-IMPERATIVE', '--evidence', BODY).code).toBe(2);
    expect(
      cli('hold', id, '--rule', 'INJ-IMPERATIVE', '--evidence', `text:${BODY}`, '--by', 'я'.repeat(80)).code,
    ).toBe(1);
    expect(cli('hold', id, '--rule', 'INJ-IMPERATIVE').code).toBe(2);
    expect(cli('hold', id, '--rule', 'INJ-IMPERATIVE', '--evidence', `text:${BODY}`).code).toBe(1);
    expect(cli('hold', 'cmt_absent', '--rule', 'INJ-IMPERATIVE', '--evidence', `text:${BODY}`).code).toBe(1);
  });
});

describe('feedback.mjs release — HELD back to new, and into the next batch', () => {
  it('releases with a reason, keeps the guard, and the row is batched next time', () => {
    const { fixture } = boot();
    const id = seed('quarantined');

    const released = cli('release', id, '--by', 'operator-1', '--reason', 'это описание акта, не указание');
    expect(released.code).toBe(0);
    const row = readCommentRow(fixture.db, id);
    expect(row).toMatchObject({ status: 'new', held_by: 'operator', guard: 'instruction' });
    expect(JSON.parse(row?.flags ?? '[]')).toEqual(['possible-instruction']);
    const releasedEvent = events(id).find((event) => event.type === 'released');
    expect(releasedEvent?.meta).toContain('это описание акта, не указание');

    // A released row appears in the next batch — that is the whole point of the undo.
    const batch = createBatch({ db: fixture.db, dir: dir ?? '', now: () => new Date('2026-10-27T12:05:00Z') });
    if ('error' in batch) throw new Error(`the batch was refused: ${batch.error}`);
    const [envelope] = readBatchLines(dir ?? '', batch.batchId);
    expect(envelope?.itemId).toBe(id);
    expect(envelope?.text.value).toBe(BODY);
    expect(readCommentRow(fixture.db, id)?.status).toBe('batched');
  });

  it('refuses a row that is not held, a missing reason and a missing comment', () => {
    boot();
    const id = seed('new');
    expect(cli('release', id, '--reason', 'нечего снимать').code).toBe(1);
    expect(cli('release', id).code).toBe(2);
    expect(cli('release', 'cmt_absent', '--reason', 'нет такой строки').code).toBe(1);
  });

  it('reports an empty held inbox without an error', () => {
    boot();
    const result = cli('inbox', '--held');
    expect(result.code).toBe(0);
    expect(result.out.join('\n')).toContain('no held comments');
  });
});
