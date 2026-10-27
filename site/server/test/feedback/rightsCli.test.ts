/**
 * `feedback.mjs rights` and the two views around it (BOOK-61, BOOK-DOC-42 §3, §5).
 *
 * The rights gate's write is bound to the closed table: a refusal names an id, a `CLEAR` names
 * none, and `RIGHTS-PARAPHRASE` needs a named source — an unnamed suspicion is not a refusal,
 * so the row stays undecided and escalates. `release` lifts exactly the one refusal a person
 * can overturn (`RIGHTS-QUOTE`); a stop-list or real-person refusal is fixed by editing the
 * list. Nothing here calls a model.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { insertComment, readCommentRow } from '../../src/comments/repo.ts';
import { upsertIdentity } from '../../src/db/repo/identities.ts';
import { createBatch, readBatchLines } from '../../src/feedback/batches.ts';
import { runFeedback } from '../../src/feedback/cli.ts';
import { RIGHTS_COPY } from '../../src/rights/rules.ts';
import { createFixture, type Fixture } from '../helpers.ts';

const BODY = 'В абзаце дважды «абзац» — оставить одно упоминание.';

let fixture: Fixture | null = null;
let dir: string | null = null;

function boot(): { fixture: Fixture; dir: string } {
  fixture = createFixture({ 'ch01.md': 'Глава\n\nТестовый абзац номер один.' });
  dir = mkdtempSync(join(tmpdir(), 'book-rights-'));
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

type SeedOptions = {
  id?: string;
  body?: string;
  status?: 'new' | 'rejected' | 'quarantined';
  verdict?: 'CLEAR' | 'REFUSED' | null;
  rule?: string | null;
  flags?: string[];
};

function seed(options: SeedOptions = {}): string {
  if (fixture === null) throw new Error('no fixture');
  const id = options.id ?? 'cmt_rights';
  const identity = upsertIdentity(fixture.db, {
    yandexSub: `yandex-${id}`,
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
    body: options.body ?? BODY,
    proposedText: null,
    interventionKind: null,
    bodySha: 'a'.repeat(64),
    flags: options.flags ?? [],
    ipHash: 'f'.repeat(64),
    status: options.status ?? 'new',
    guard: null,
    reason: null,
    createdAt: '2026-10-27T09:01:00Z',
    idemKey: null,
  });
  if (options.verdict !== undefined && options.verdict !== null) {
    fixture.db
      .prepare(
        `UPDATE comments SET rights_verdict = ?, rights_rule = ?, rights_at = ?, rights_source = 'scan'
          WHERE id = ?`,
      )
      .run(options.verdict, options.rule ?? null, '2026-10-27T09:02:00Z', id);
  }
  if (options.status === 'rejected') {
    fixture.db
      .prepare(`UPDATE comments SET status = 'rejected', decided_at = ?, reason = ? WHERE id = ?`)
      .run('2026-10-27T09:02:00Z', RIGHTS_COPY.quote, id);
  }
  return id;
}

function events(commentId: string): Array<{ type: string; meta: string | null }> {
  if (fixture === null) throw new Error('no fixture');
  return fixture.db
    .prepare('SELECT type, meta FROM comment_events WHERE comment_id = ? ORDER BY id')
    .all(commentId) as Array<{ type: string; meta: string | null }>;
}

describe('feedback.mjs rights — the write is bound to the table', () => {
  it('records a refusal with its rule, the fixed sentence and a rights event', () => {
    const { fixture } = boot();
    const id = seed();
    const result = cli('rights', id, '--verdict', 'REFUSED', '--rule', 'RIGHTS-QUOTE', '--by', 'rights-1');
    expect(result.code).toBe(0);
    expect(result.out.join('\n')).toContain('REFUSED RIGHTS-QUOTE');

    const row = readCommentRow(fixture.db, id);
    expect(row).toMatchObject({
      status: 'rejected',
      rights_verdict: 'REFUSED',
      rights_rule: 'RIGHTS-QUOTE',
      rights_by: 'rights-1',
      rights_source: 'model',
      reason: RIGHTS_COPY.quote,
    });
    expect(typeof row?.rights_at).toBe('string');
    // A quote refusal is about provenance: the body is not hidden as unlawful content.
    expect(JSON.parse(row?.flags ?? '[]')).not.toContain('illegal-content');
    const event = events(id).find((entry) => entry.type === 'rights');
    expect(event?.meta).toContain('RIGHTS-QUOTE');
    expect(event?.meta).toContain('model');
  });

  it('records a clearance without a rule and leaves the body as it was', () => {
    const { fixture } = boot();
    const id = seed({ flags: ['rights-flag'] });
    const result = cli('rights', id, '--verdict', 'CLEAR', '--by', 'rights-1');
    expect(result.code).toBe(0);
    expect(result.out.join('\n')).toContain('CLEAR');
    expect(readCommentRow(fixture.db, id)).toMatchObject({
      status: 'new',
      rights_verdict: 'CLEAR',
      rights_rule: null,
      rights_source: 'model',
    });
    // The scan's flag stays: it records why the gate was asked, not what it answered.
    expect(JSON.parse(readCommentRow(fixture.db, id)?.flags ?? '[]')).toContain('rights-flag');
  });

  it('refuses a paraphrase with no named source and leaves the row undecided', () => {
    const { fixture } = boot();
    const id = seed();
    const result = cli('rights', id, '--verdict', 'REFUSED', '--rule', 'RIGHTS-PARAPHRASE', '--by', 'rights-1');
    expect(result.code).toBe(1);
    expect(result.out.join('\n')).toContain('RIGHTS_SOURCE_REQUIRED');
    expect(readCommentRow(fixture.db, id)).toMatchObject({ status: 'new', rights_verdict: null });
    expect(events(id)).toHaveLength(0);
  });

  it('records a paraphrase when the verdict names the source', () => {
    const { fixture } = boot();
    const id = seed();
    const result = cli(
      'rights',
      id,
      '--verdict',
      'REFUSED',
      '--rule',
      'RIGHTS-PARAPHRASE',
      '--source',
      'Иван Бунин, «Тёмные аллеи»',
    );
    expect(result.code).toBe(0);
    const row = readCommentRow(fixture.db, id);
    expect(row).toMatchObject({ rights_rule: 'RIGHTS-PARAPHRASE', reason: RIGHTS_COPY.paraphrase });
    expect(events(id).find((entry) => entry.type === 'rights')?.meta).toContain('Тёмные аллеи');
  });

  it('refuses a CLEAR with a rule, an unknown rule, a held row and a second verdict', () => {
    const { fixture } = boot();
    const id = seed();
    expect(cli('rights', id, '--verdict', 'CLEAR', '--rule', 'RIGHTS-QUOTE').code).toBe(2);
    expect(cli('rights', id, '--verdict', 'REFUSED', '--rule', 'RIGHTS-NONSENSE').code).toBe(1);
    expect(cli('rights', id, '--verdict', 'REFUSED', '--rule', 'STOP-DRUGS').code).toBe(0);
    expect(cli('rights', id, '--verdict', 'REFUSED', '--rule', 'STOP-DRUGS').code).toBe(1);

    const held = seed({ id: 'cmt_held_rights', status: 'quarantined' });
    const refused = cli('rights', held, '--verdict', 'CLEAR');
    expect(refused.code).toBe(1);
    expect(refused.out.join('\n')).toContain('RIGHTS_HELD');
    expect(readCommentRow(fixture.db, held)?.rights_verdict).toBeNull();
  });
});

describe('feedback.mjs inbox --rights', () => {
  it('lists the rows a scan flagged and nothing else', () => {
    boot();
    seed({ id: 'cmt_flagged', flags: ['rights-flag'] });
    seed({ id: 'cmt_clear', flags: [] });
    seed({ id: 'cmt_decided', flags: ['rights-flag'], verdict: 'CLEAR' });

    const result = cli('inbox', '--rights');
    expect(result.code).toBe(0);
    const text = result.out.join('\n');
    expect(text).toContain('cmt_flagged');
    expect(text).toContain('rights-flag');
    expect(text).not.toContain('cmt_clear');
    expect(text).not.toContain('cmt_decided');
  });

  it('says so when nothing is waiting', () => {
    boot();
    const result = cli('inbox', '--rights');
    expect(result.code).toBe(0);
    expect(result.out.join('\n')).toContain('no comments waiting for a rights verdict');
  });
});

describe('feedback.mjs release — one releasable rights refusal', () => {
  it('releases a RIGHTS-QUOTE refusal and the row reaches the next batch', () => {
    const { fixture } = boot();
    const id = seed({ status: 'rejected', verdict: 'REFUSED', rule: 'RIGHTS-QUOTE' });

    const released = cli('release', id, '--reason', 'источник назван в следующем абзаце', '--by', 'operator-1');
    expect(released.code).toBe(0);
    expect(released.out.join('\n')).toContain('released RIGHTS-QUOTE');
    expect(readCommentRow(fixture.db, id)).toMatchObject({
      status: 'new',
      decided_at: null,
      rights_verdict: 'CLEAR',
      rights_source: 'operator',
      rights_rule: 'RIGHTS-QUOTE',
    });
    const event = events(id).find((entry) => entry.type === 'released');
    expect(event?.meta).toContain('RIGHTS-QUOTE');

    const batch = createBatch({ db: fixture.db, dir: dir ?? '', now: () => new Date('2026-10-27T12:05:00Z') });
    if ('error' in batch) throw new Error(`the batch was refused: ${batch.error}`);
    expect(readBatchLines(dir ?? '', batch.batchId).map((item) => item.itemId)).toEqual([id]);
  });

  it('releases a RIGHTS-PARAPHRASE refusal too (B5), keeping the rule on the row', () => {
    const { fixture } = boot();
    const id = seed({ status: 'rejected', verdict: 'REFUSED', rule: 'RIGHTS-PARAPHRASE' });

    const released = cli('release', id, '--reason', 'источник назван: Бунин, «Тёмные аллеи»', '--by', 'operator-1');
    expect(released.code).toBe(0);
    expect(released.out.join('\n')).toContain('released RIGHTS-PARAPHRASE');
    expect(readCommentRow(fixture.db, id)).toMatchObject({
      status: 'new',
      decided_at: null,
      rights_verdict: 'CLEAR',
      rights_source: 'operator',
      rights_rule: 'RIGHTS-PARAPHRASE',
    });
    expect(events(id).find((entry) => entry.type === 'released')?.meta).toContain('RIGHTS-PARAPHRASE');
  });

  it('refuses a stop-list or a real-person refusal and changes nothing', () => {
    const { fixture } = boot();
    for (const [index, rule] of ['STOP-EXTREMISM', 'RIGHTS-PERSON', 'STOP-PERSON'].entries()) {
      const id = seed({ id: `cmt_list_${index}`, status: 'rejected', verdict: 'REFUSED', rule });
      const result = cli('release', id, '--reason', 'мне кажется, это ошибка');
      expect(result.code, rule).toBe(1);
      expect(result.out.join('\n'), rule).toContain('RIGHTS_STOPLIST');
      expect(readCommentRow(fixture.db, id)?.status, rule).toBe('rejected');
      expect(readCommentRow(fixture.db, id)?.rights_verdict, rule).toBe('REFUSED');
    }
  });
});
