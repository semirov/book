import type { HistoryKind } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/db.ts';
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
      hseq: last,
      at: '2026-10-25T09:00:00Z',
      seq: 1,
      chapter: 8,
      premise: false,
      alias: 'Аня',
      status: 'processing',
      outcome: null,
      reason: null,
      changeId: seeded.changeId,
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
  });
});

describe('a machine-only pass adds no entry (AC3)', () => {
  it('rewrites the text with no source comment and prints zero rows', () => {
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
    // The pass is in the log, unattributed and belonging to no change…
    expect(revised?.change_id).toBeNull();
    // …and the record still has nothing to show.
    expect(readRecord(local.db).items).toEqual([]);
  });
});

describe('a change with no log row has no place on the clock', () => {
  it('lists nothing for a hand-seeded change, which the engine cannot produce', () => {
    fixture = createFixture();
    // `seedChange` inserts the row directly. Every engine path appends `change.queued` in the
    // same transaction (`engine/queue.ts`), so a reader change never reaches this state.
    seedChange(fixture.db, { index: 1, chapter: 5, label: 'Аня' });

    expect(readRecord(fixture.db).items).toEqual([]);
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
    const machine = appendEvent(db, { kind: 'chapter.revised', chapter: 1 }, BASE_MS + 99_000);
    const afterMachinePass = readRecord(db);
    expect(afterMachinePass.lastHseq).toBe(machine);
    expect(afterMachinePass.lastHseq).toBeGreaterThan(afterMachinePass.items[0]?.hseq ?? 0);
    expect(afterMachinePass.items).toHaveLength(3);
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
});
