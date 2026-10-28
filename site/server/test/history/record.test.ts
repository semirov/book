import type { HistoryKind } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { readCommentRow } from '../../src/comments/repo.ts';
import type { Db } from '../../src/db/db.ts';
import { acceptComment } from '../../src/feedback/accept.ts';
import { appendEvent } from '../../src/history/log.ts';
import { readRecord } from '../../src/history/record.ts';
import { createFixture, longProse, type Fixture } from '../helpers.ts';
import { ingest, seedChange } from './helpers.ts';

/**
 * BOOK-65 — the public record is one change a person made, once.
 *
 * These tests seed the log directly: the point is not the engine's flow but the projection's
 * rule. A reader change is `changes.source_comment IS NOT NULL`; every log row that is not
 * attached to such a change is machinery and must leave the record empty.
 */

/** The order the engine writes for one change, oldest fact first (§6F.1). */
const CHANGE_EVENTS: readonly HistoryKind[] = [
  'change.queued',
  'change.processing',
  'step.opened',
  'step.landed',
  'step.closed',
  'cascade.opened',
  'cascade.closed',
  'gate.recorded',
  'change.decided',
  'document.status',
];

const BASE_MS = Date.parse('2026-10-25T09:00:00Z');

/** `index` spaces one change's events an hour apart, so ordering is never a tie. */
function appendChangeLog(db: Db, changeId: string, chapter: number, index: number): number {
  let last = 0;
  CHANGE_EVENTS.forEach((kind, position) => {
    last = appendEvent(
      db,
      { kind, changeId, chapter, payload: { seq: index } },
      BASE_MS + index * 3_600_000 + position * 60_000,
    );
  });
  return last;
}

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

describe('one entry per reader change (AC1)', () => {
  it('turns N changes with many events each into exactly N rows, never a chain', () => {
    fixture = createFixture();
    const db = fixture.db;
    const seeded = [1, 2, 3].map((index) => seedChange(db, { index, chapter: index, label: `Читатель ${index}` }));
    const lastHseqs = seeded.map((change, position) => appendChangeLog(db, change.changeId, position + 1, position));

    // N changes wrote N × |CHANGE_EVENTS| log rows…
    const events = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(events.n).toBe(seeded.length * CHANGE_EVENTS.length);

    const page = readRecord(db);

    expect(page.items).toHaveLength(3);
    // Exactly one row per change: the change id appears once, and no event produced a row.
    expect(page.items.map((record) => record.changeId).sort()).toEqual(seeded.map((change) => change.changeId).sort());
    // Newest first by the change's **last** log entry, not by the first and not by `seq`.
    expect(page.items.map((record) => record.changeId)).toEqual([...seeded].reverse().map((change) => change.changeId));
    expect(page.items.map((record) => record.hseq)).toEqual([...lastHseqs].reverse());
    // Every row is the change's own last fact, not any event of the chain.
    for (const record of page.items) {
      const last = db
        .prepare('SELECT MAX(hseq) AS hseq FROM events WHERE change_id = ?')
        .get(record.changeId) as { hseq: number };
      expect(record.hseq).toBe(last.hseq);
    }
  });

  it('carries the six facts of the change and its last entry’s own moment', () => {
    fixture = createFixture();
    const db = fixture.db;
    const seeded = seedChange(db, { index: 1, chapter: 8, label: 'Аня' });
    const last = appendEvent(db, { kind: 'change.decided', changeId: seeded.changeId, chapter: 8 }, BASE_MS);

    const record = readRecord(db).items[0];
    expect(record).toEqual({
      id: seeded.changeId,
      hseq: last,
      at: '2026-10-25T09:00:00Z',
      seq: 1,
      chapter: 8,
      chapterTitle: null,
      premise: false,
      premiseLanded: false,
      alias: 'Аня',
      cause: 'reader',
      status: 'processing',
      outcome: null,
      reason: null,
      sourceCommentId: seeded.commentId,
      changeId: seeded.changeId,
      recordHref: `#правка-${seeded.changeId}`,
      span: null,
    });
  });

  it('marks a chapter’s premise as a premise, not as an edit', () => {
    fixture = createFixture();
    const db = fixture.db;
    const seeded = seedChange(db, { index: 1, chapter: 2, label: 'Аня' });
    db.prepare('UPDATE changes SET premise = 1 WHERE id = ?').run(seeded.changeId);
    appendEvent(db, { kind: 'change.queued', changeId: seeded.changeId, chapter: 2 }, BASE_MS);

    expect(readRecord(db).items[0]?.premise).toBe(true);
  });
});

describe('no technical event reaches the record (AC2)', () => {
  it('drives one of each machinery fact and prints zero rows', () => {
    fixture = createFixture();
    const db = fixture.db;
    const technical: Array<HistoryKind> = [
      'front.revised',
      'gate.recorded',
      'cascade.opened',
      'cascade.closed',
      'step.opened',
      'step.landed',
      'step.closed',
      'overwrite',
      'operator.restore',
      'operator.release',
      'operator.hide',
      'document.status',
    ];
    technical.forEach((kind, index) => {
      appendEvent(db, { kind, chapter: 3, cascadeId: 'csc_1', stepId: 'stp_1' }, BASE_MS + index * 1_000);
    });

    // The log has every row it was given…
    const events = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(events.n).toBe(technical.length);
    // …and none of them is a change a person made through the interface.
    const page = readRecord(db);
    expect(page.items).toEqual([]);
    expect(page.nextBefore).toBeNull();
    // The surface is empty but the clock is not: the rest position still has a logged moment.
    expect(page.lastAt).toBe('2026-10-25T09:00:11Z');
  });
});

/**
 * An ingest is not a pass: it writes the text and the log row, but no `pass_stages` row, so it
 * is not one of the book's changes and adds no entry. A *pass* is (the old AC3 claimed the
 * opposite — «a machine-only pass adds no entry» — and that rule is what hid a written chapter
 * from the chronicle; `recordMerged.test.ts` proves the new one).
 */
describe('an ingest is not a change to the record (AC3, amended)', () => {
  it('rewrites the text with no source comment and no landed stage, and prints zero rows', () => {
    fixture = createFixture();
    const local = fixture;
    ingest(local, 'ch01.md', longProse(['Первый абзац. Это служебный текст, он не является текстом книги.'], 'Глава 1'));
    // A real rewrite: the chapter's body changes and a `chapter.revised` row is written.
    ingest(
      local,
      'ch01.md',
      longProse(['Первый абзац переписан. Это служебный текст, он не является текстом книги.'], 'Глава 1'),
    );

    const revised = local.db
      .prepare("SELECT change_id FROM events WHERE kind = 'chapter.revised'")
      .get() as { change_id: string | null } | undefined;
    // The row is in the log, unattributed and belonging to no change…
    expect(revised?.change_id).toBeNull();
    // …and no pass claimed it, so the record has nothing to show.
    expect(readRecord(local.db).items).toEqual([]);
  });
});

/**
 * A comment filed through the interface and accepted by the real path: ingest a written chapter,
 * store an audited filing, then call `acceptComment` — the function the CLI and the decisions
 * tailer call. No hand-written `changes` row, no hand-written event.
 */
function acceptThroughInterface(local: Fixture, at = '2026-10-25T10:00:00Z'): { changeId: string; at: string } {
  ingest(local, 'ch08.md', longProse(['Первый абзац. Это служебный текст, он не является текстом книги.'], 'Глава 8'));
  local.db
    .prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idt_1', 'sub-1', 'Аня', '2026-10-20T09:00:00Z', '2026-10-25T08:00:00Z')`,
    )
    .run();
  local.db
    .prepare(
      `INSERT INTO comments (id, identity_id, chapter, block_id, author, body, body_sha, ip_hash, status,
                             created_at, audit_verdict, rights_verdict)
       VALUES ('cmt_iface', 'idt_1', 8, 'ch08#aa11bb22', 'Аня', 'абзац слишком часто', 'sha-1', 'iph',
               'new', '2026-10-24T09:00:00Z', 'FITS', 'CLEAR')`,
    )
    .run();
  const comment = readCommentRow(local.db, 'cmt_iface');
  if (comment === undefined) throw new Error('the filing was not stored');
  const result = acceptComment(local.db, {
    comment,
    intent: 'убрать второе упоминание абзаца',
    at,
    reason: 'принято',
  });
  if ('error' in result) throw new Error(result.error);
  return { changeId: result.changeId, at };
}

describe('a change accepted through the interface (BOOK-65 B1)', () => {
  it('is one record entry with its alias and date — the interface path, not a seeded row', () => {
    fixture = createFixture();
    const { changeId, at } = acceptThroughInterface(fixture);

    const items = readRecord(fixture.db).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      changeId,
      alias: 'Аня',
      at,
      chapter: 8,
      status: 'pending',
      premise: false,
    });
  });

  it('carries its clock row, written by acceptance itself', () => {
    fixture = createFixture();
    const { changeId } = acceptThroughInterface(fixture);

    // The invariant every insert path must keep: a change is never written without
    // `change.queued` in the same transaction (`engine/queue.ts`, `admitPremise`, `accept.ts`).
    const rows = fixture.db.prepare('SELECT kind FROM events WHERE change_id = ? ORDER BY hseq').all(changeId) as Array<{
      kind: string;
    }>;
    expect(rows.map((row) => row.kind)).toEqual(['change.queued']);
    expect(readRecord(fixture.db).items.map((item) => item.changeId)).toEqual([changeId]);
  });

  it('does not throw on a corrupt decision line: a non-time `at` still writes one clock row', () => {
    fixture = createFixture();
    let accepted: { changeId: string; at: string } | undefined;
    // The tailer advances its offset before this call, so a junk `at` must not throw.
    expect(() => {
      accepted = acceptThroughInterface(fixture!, 'не время');
    }).not.toThrow();
    expect(accepted).toBeDefined();
    const { changeId } = accepted!;

    const clockRows = fixture.db.prepare('SELECT COUNT(*) AS n FROM events WHERE change_id = ?').get(changeId) as {
      n: number;
    };
    expect(clockRows.n).toBe(1);
    const items = readRecord(fixture.db).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.changeId).toBe(changeId);
    // The stored string is untouched: only the clock fell back to now.
    const change = fixture.db.prepare('SELECT enqueued_at FROM changes WHERE id = ?').get(changeId) as {
      enqueued_at: string;
    };
    expect(change.enqueued_at).toBe('не время');
  });
});

describe('the record’s page and cursor (§6F.2)', () => {
  it('pages by the change’s last hseq, keeps the clamp, and stops on a short page', () => {
    fixture = createFixture();
    const db = fixture.db;
    const seeded = [1, 2, 3].map((index) => seedChange(db, { index, chapter: index, label: `Читатель ${index}` }));
    seeded.forEach((change, position) => appendChangeLog(db, change.changeId, position + 1, position));

    // A short page reaches the oldest record: nothing lies before it.
    const short = readRecord(db);
    expect(short.items).toHaveLength(3);
    expect(short.nextBefore).toBeNull();
    expect(short.lastHseq).toBeGreaterThanOrEqual(short.items[0]?.hseq ?? 0);

    // A full page ends on its last row’s hseq, and `before` is exclusive.
    const first = readRecord(db, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextBefore).toBe(first.items[1]?.hseq);
    const second = readRecord(db, { before: first.nextBefore ?? 0, limit: 2 });
    expect(second.items.map((record) => record.changeId)).toEqual([seeded[0]?.changeId]);
    expect(second.nextBefore).toBeNull();

    // `limit: 0` is a page of one row, not zero — the same clamp the event reader documents.
    const clamped = readRecord(db, { limit: 0 });
    expect(clamped.items).toHaveLength(1);
    expect(clamped.nextBefore).toBe(clamped.items[0]?.hseq);

    // The page's clock is the book's, not the newest record's: a machine pass moves time and
    // adds no row, so the scrubber's right edge stays honest while the list does not grow.
    const machine = appendEvent(db, { kind: 'chapter.revised', chapter: 1 }, BASE_MS + 120_000);
    const afterMachinePass = readRecord(db);
    expect(afterMachinePass.lastHseq).toBe(machine);
    expect(afterMachinePass.lastAt).toBe('2026-10-25T09:02:00Z');
    expect(afterMachinePass.lastHseq).toBeGreaterThan(afterMachinePass.items[0]?.hseq ?? 0);
    expect(afterMachinePass.items).toHaveLength(3);
    // The record's own newest moment did not move with the clock.
    expect(afterMachinePass.items[0]?.at).not.toBe(afterMachinePass.lastAt);
  });
});

describe('the record’s own ends on the book’s clock (BOOK-56)', () => {
  it('has no first moment on an empty log', () => {
    fixture = createFixture();
    const page = readRecord(fixture.db);

    expect(page.firstAt).toBeNull();
    expect(page.lastAt).toBeNull();
    expect(page.items).toEqual([]);
  });

  it('names the log’s first row as the starting record, whatever the record holds', () => {
    fixture = createFixture();
    const db = fixture.db;
    const seeded = seedChange(db, { index: 1, chapter: 8, label: 'Аня' });
    appendEvent(db, { kind: 'change.queued', changeId: seeded.changeId, chapter: 8 }, BASE_MS);
    appendEvent(db, { kind: 'change.decided', changeId: seeded.changeId, chapter: 8 }, BASE_MS + 60_000);

    const page = readRecord(db);
    // The first event of the change is the book's beginning; the change's last entry is not.
    expect(page.firstAt).toBe('2026-10-25T09:00:00Z');
    expect(page.items[0]?.at).toBe('2026-10-25T09:01:00Z');
    expect(page.lastAt).toBe('2026-10-25T09:01:00Z');
    // The starting record is not an entry of the record: `items` stays one row per change.
    expect(page.items.map((record) => record.changeId)).toEqual([seeded.changeId]);
  });

  it('names a machine pass as the beginning without adding it to the record', () => {
    fixture = createFixture();
    const db = fixture.db;
    appendEvent(db, { kind: 'front.revised', isFront: true, rev: 1 }, BASE_MS);
    appendEvent(db, { kind: 'chapter.created', chapter: 1 }, BASE_MS + 60_000);

    const page = readRecord(db);
    expect(page.firstAt).toBe('2026-10-25T09:00:00Z');
    expect(page.items).toEqual([]);
  });
});

describe('the public reason a row may print', () => {
  it('normalises and bounds the change’s reason, and treats an empty one as absent', () => {
    fixture = createFixture();
    const db = fixture.db;
    const first = seedChange(db, { index: 1, chapter: 1, label: 'Аня' });
    const second = seedChange(db, { index: 2, chapter: 2, label: 'Марк' });
    db.prepare("UPDATE changes SET status = 'void', outcome = 'dropped', reason = ? WHERE id = ?").run(
      '  текст\nуспел измениться  ',
      first.changeId,
    );
    db.prepare("UPDATE changes SET status = 'void', outcome = 'dropped', reason = '   ' WHERE id = ?").run(second.changeId);
    appendEvent(db, { kind: 'change.decided', changeId: first.changeId, chapter: 1 }, BASE_MS);
    appendEvent(db, { kind: 'change.decided', changeId: second.changeId, chapter: 2 }, BASE_MS + 1_000);

    const [newest, oldest] = readRecord(db).items;
    expect(newest?.changeId).toBe(second.changeId);
    expect(newest?.reason).toBeNull();
    expect(oldest?.reason).toBe('текст успел измениться');
  });

  it('never prints an engine code: the attempt becomes the reader’s sentence', () => {
    // A failed attempt is not a verdict on the filing, and its handle is not copy.
    fixture = createFixture();
    const db = fixture.db;
    const row = seedChange(db, { index: 1, chapter: 34, label: 'Аня' });
    db.prepare("UPDATE changes SET status = 'void', outcome = 'dropped', reason = ? WHERE id = ?").run(
      'модель не ответила: PROVIDER_SHAPE',
      row.changeId,
    );
    appendEvent(db, { kind: 'change.decided', changeId: row.changeId, chapter: 34 }, BASE_MS);

    const [item] = readRecord(db).items;
    expect(item?.reason).toBe('модель ответила не по форме — заявка остаётся в очереди');
    expect(item?.reason ?? '').not.toMatch(/PROVIDER_SHAPE|ENGINE_TIMEOUT/u);
  });
});

/**
 * The prod shape of the chronicle: chapter 34 was written, its premise's linked change ended
 * `void`/`dropped` with «модель не ответила: PROVIDER_SHAPE», and the record row said
 * «замысел … снят» with the attempt's line over a chapter that exists. The chapter's own text
 * is the landing (`comments/repo.ts`), so the row carries that fact and no failure copy; the
 * word and the reason are `changeStatus.ts`'s and are pinned in `changeStatus.test.ts`.
 */
describe('a premise the book landed (BOOK-7)', () => {
  it('marks the landed premise and leaves no code or failure line on the entry', () => {
    fixture = createFixture();
    const local = fixture;
    ingest(
      local,
      'ch34.md',
      longProse(['Абзац главы тридцать четыре. Это служебный текст, он не является текстом книги.'], 'Глава 34'),
    );
    const seeded = seedChange(local.db, { index: 1, chapter: 34, label: 'Аня' });
    local.db
      .prepare("UPDATE changes SET premise = 1, status = 'void', outcome = 'dropped', reason = ? WHERE id = ?")
      .run('модель не ответила: PROVIDER_SHAPE', seeded.changeId);
    appendEvent(local.db, { kind: 'change.decided', changeId: seeded.changeId, chapter: 34 }, BASE_MS);

    const [entry] = readRecord(local.db).items;
    expect(entry?.premise).toBe(true);
    // The book says the premise entered the first edition, whatever the attempt behind it said.
    expect(entry?.premiseLanded).toBe(true);
    // No engine handle ever leaves the server, and the failure line the DTO still holds is
    // suppressed by the client's `recordReason` (`changeStatus.test.ts`): the server's job here
    // is the fact, the word is the page's.
    expect(JSON.stringify(entry)).not.toMatch(/PROVIDER_SHAPE|ENGINE_TIMEOUT/u);
  });

  it('claims no landing for a premise whose chapter has no text', () => {
    fixture = createFixture();
    const db = fixture.db;
    const seeded = seedChange(db, { index: 1, chapter: 9, label: 'Аня' });
    db.prepare("UPDATE changes SET premise = 1, status = 'void', outcome = 'dropped', reason = ? WHERE id = ?").run(
      'модель не ответила: PROVIDER_SHAPE',
      seeded.changeId,
    );
    appendEvent(db, { kind: 'change.decided', changeId: seeded.changeId, chapter: 9 }, BASE_MS);

    expect(readRecord(db).items[0]?.premiseLanded).toBe(false);
  });

  it('gives both premises on one chapter the same landing', () => {
    // The page reads a chapter's text once and reuses it: two premise entries on chapter 34
    // both carry the landing, and the second answer comes from the page's own map.
    fixture = createFixture();
    const local = fixture;
    ingest(
      local,
      'ch34.md',
      longProse(['Абзац главы тридцать четыре. Это служебный текст, он не является текстом книги.'], 'Глава 34'),
    );
    const seeded = [
      seedChange(local.db, { index: 1, chapter: 34, label: 'Аня' }),
      // A second live lease on one chapter is impossible by schema; the row is moved after the
      // fact, which is all the record reads.
      seedChange(local.db, { index: 2, chapter: 9, label: 'Марк' }),
    ];
    local.db.prepare('UPDATE changes SET chapter = 34 WHERE id = ?').run(seeded[1]?.changeId);
    seeded.forEach((change, position) => {
      local.db
        .prepare("UPDATE changes SET premise = 1, status = 'void', outcome = 'dropped', reason = ? WHERE id = ?")
        .run('модель не ответила: PROVIDER_SHAPE', change.changeId);
      appendEvent(local.db, { kind: 'change.decided', changeId: change.changeId, chapter: 34 }, BASE_MS + position * 1_000);
    });

    const items = readRecord(local.db).items;
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.premiseLanded)).toBe(true);
  });
});
