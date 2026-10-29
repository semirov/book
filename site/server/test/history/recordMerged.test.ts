import { PASS_RECORD_PREFIX, TOTAL_CHAPTERS } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from '../../src/db/db.ts';
import { appendEvent } from '../../src/history/log.ts';
import { readRecord } from '../../src/history/record.ts';
import { createFixture, longProse, type Fixture } from '../helpers.ts';
import { ingest, seedChange } from './helpers.ts';

/**
 * The chronicle lists **changes to the book**, whoever caused them (owner's defect: «я с кареткой
 * попал в историю которой нет в хрониках»).
 *
 * The live database holds eight `changes` rows — one reader's, seven machine ones — and fifteen
 * `landed` pass stages, most of them carrying no change row at all. The old record joined
 * `changes` to a visible comment, so only the reader's row was a line, chapter 65 was dropped by
 * the book's range, and every chapter a pass wrote without a change row was invisible. The
 * record is a union now: a change row is an entry (a reader's filing or a machine pass), a landed
 * stage with no change row is an entry of its own, and never both for one act.
 */

const BASE_MS = Date.parse('2026-10-25T09:00:00Z');

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

type LandedInput = {
  passId: string;
  chapter: number;
  changeId?: string | null;
  at: string;
  before?: string;
  after?: string;
  stageSeq?: number;
};

/** One `landed` stage row — the shape the lane writes when a pass put words in a chapter. */
function landed(db: Db, input: LandedInput): void {
  const span =
    input.before === undefined
      ? null
      : JSON.stringify([{ blockId: null, before: input.before, after: input.after ?? '', truncated: false }]);
  db.prepare(
    `INSERT INTO pass_stages (pass_id, chapter, stage_seq, stage, at, actor_process, change_id, summary, span)
     VALUES (?, ?, ?, 'landed', ?, 'writer', ?, 'глава переписана', ?)`,
  ).run(input.passId, input.chapter, input.stageSeq ?? 5, input.at, input.changeId ?? null, span);
}

/** A machine change: no filing behind it — a pass the engine raised on its own. */
function machineChange(db: Db, id: string, chapter: number, at: string): void {
  db.prepare(
    `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks,
                          scope_hint, status, outcome, enqueued_at)
     VALUES (?, 'continuity', ?, 'поправить сцену', 1, 'sha', '[]', 'phrase', 'done', 'applied', ?)`,
  ).run(id, chapter, at);
}

/** The chapter's first paragraph, as the live projection holds it. */
function firstBlock(db: Db, chapter: number): { id: string; text: string } {
  return db.prepare('SELECT id, text FROM blocks WHERE chapter = ? ORDER BY idx LIMIT 1').get(chapter) as {
    id: string;
    text: string;
  };
}

/** The version a change wrote: the record reads it to know the applied text is still live. */
function wroteBlock(db: Db, changeId: string, stepId: string, chapter: number, hseq: number): string {
  const block = firstBlock(db, chapter);
  db.prepare(
    `INSERT INTO block_versions
       (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
        change_id, step_id, actor_kind, actor_label, identity_id, at)
     VALUES (?, 1, ?, 1, ?, ?, 'hash', ?, 'revised', NULL, NULL, ?, ?, 'reader', 'Аня', 'idt_1',
             '2026-10-25T09:10:00Z')`,
  ).run(`bkd_${changeId}`, chapter, hseq, block.id, block.text.length, changeId, stepId);
  return block.id;
}

describe('the record is the union of changes and landed passes (the fix)', () => {
  /**
   * Three entries, one per act: a reader's change that wrote a paragraph (with its span), a pass
   * that has a change row (its change is the entry), and a landed pass with no change row (the
   * stage is the entry).
   */
  function seedThree(db: Db): {
    reader: string;
    machine: string;
    bare: string;
    text: string;
    readerHseq: number;
    machineHseq: number;
    bareHseq: number;
  } {
    ingest(
      fixture!,
      'ch02.md',
      longProse(['Первый абзац главы два. Это служебный текст, он не является текстом книги.'], 'Глава 2'),
    );
    const reader = seedChange(db, { index: 1, chapter: 2, label: 'Аня' });
    const readerHseq = appendEvent(db, { kind: 'change.decided', changeId: reader.changeId, chapter: 2 }, BASE_MS);
    const blockId = wroteBlock(db, reader.changeId, reader.stepId, 2, readerHseq);
    const text = (db.prepare('SELECT text FROM blocks WHERE id = ?').get(blockId) as { text: string }).text;
    db.prepare("UPDATE changes SET status = 'done', outcome = 'applied', anchor = ? WHERE id = ?").run(
      JSON.stringify({ blockIds: [blockId], quote: 'Первый абзац главы два.' }),
      reader.changeId,
    );

    // A machine change whose pass landed: the change row is the entry, the stage is not.
    machineChange(db, 'chg_m', 3, '2026-10-25T09:20:00Z');
    const machineHseq = appendEvent(
      db,
      { kind: 'change.queued', changeId: 'chg_m', chapter: 3, stepId: 'stp_m' },
      BASE_MS + 60_000,
    );
    landed(db, { passId: 'stp_m', chapter: 3, changeId: 'chg_m', at: '2026-10-25T09:21:00Z', before: 'старый', after: 'новый' });

    // A pass that wrote chapter 4 and left no change row at all.
    const bareHseq = appendEvent(db, { kind: 'step.landed', chapter: 4, stepId: 'stp_bare' }, BASE_MS + 120_000);
    landed(db, {
      passId: 'stp_bare',
      chapter: 4,
      at: '2026-10-25T09:02:00Z',
      before: 'было так',
      after: 'стало иначе',
    });

    return {
      reader: reader.changeId,
      machine: 'chg_m',
      bare: 'stp_bare',
      text,
      readerHseq,
      machineHseq,
      bareHseq,
    };
  }

  it('returns exactly three entries, each once, each with its cause', () => {
    fixture = createFixture();
    const db = fixture.db;
    const seeded = seedThree(db);

    const items = readRecord(db).items;
    expect(items).toHaveLength(3);
    // One entry per act: the ids are distinct and each appears once.
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
    expect(items.map((item) => item.cause)).toEqual(['pass', 'pass', 'reader']);
    expect(items.map((item) => item.id)).toEqual([`pass:${seeded.bare}`, seeded.machine, seeded.reader]);
    // The machine change is the pass with a change row; its landed stage is not a second line.
    expect(items.filter((item) => item.changeId === seeded.machine)).toHaveLength(1);
    expect(items.some((item) => item.id === `pass:${seeded.machine}`)).toBe(false);
    // The bare pass has no change and no number.
    const bare = items[0];
    expect(bare?.changeId).toBeNull();
    expect(bare?.seq).toBeNull();
    expect(bare?.alias).toBeNull();
    expect(bare?.status).toBeNull();
  });

  it('gives each entry its own moment, place and door', () => {
    fixture = createFixture();
    const db = fixture.db;
    const seeded = seedThree(db);
    const items = readRecord(db).items;
    const byId = new Map(items.map((item) => [item.id, item]));

    const reader = byId.get(seeded.reader);
    expect(reader).toMatchObject({
      hseq: seeded.readerHseq,
      at: '2026-10-25T09:00:00Z',
      seq: 1,
      chapter: 2,
      chapterTitle: 'Глава 2',
      alias: 'Аня',
      cause: 'reader',
      status: 'done',
      recordHref: `?change=${seeded.reader}`,
    });

    const machine = byId.get(seeded.machine);
    expect(machine).toMatchObject({
      hseq: seeded.machineHseq,
      chapter: 3,
      cause: 'pass',
      alias: null,
      changeId: seeded.machine,
      recordHref: `#${PASS_RECORD_PREFIX}${seeded.machine}`,
    });

    const bare = byId.get(`pass:${seeded.bare}`);
    expect(bare).toMatchObject({
      hseq: seeded.bareHseq,
      at: '2026-10-25T09:02:00Z',
      chapter: 4,
      cause: 'pass',
      // The bare pass has no change row, so its chapter is part of the door's key: the page has
      // nothing else to find it by.
      recordHref: `#${PASS_RECORD_PREFIX}4-${seeded.bare}`,
    });
  });

  it('prints a reader’s span only from the words they pointed at and the live paragraph', () => {
    fixture = createFixture();
    const db = fixture.db;
    const seeded = seedThree(db);
    const reader = readRecord(db).items.find((item) => item.id === seeded.reader);

    expect(reader?.span).toEqual({ before: 'Первый абзац главы два.', after: seeded.text });
  });

  it('takes a pass’s span from the landed stage, and never invents one', () => {
    fixture = createFixture();
    const db = fixture.db;
    seedThree(db);
    const items = readRecord(db).items;

    expect(items.find((item) => item.changeId === 'chg_m')?.span).toEqual({ before: 'старый', after: 'новый' });
    expect(items.find((item) => item.id === 'pass:stp_bare')?.span).toEqual({
      before: 'было так',
      after: 'стало иначе',
    });
  });

  it('keeps the reader’s span out when the paragraph was rewritten since', () => {
    fixture = createFixture();
    const db = fixture.db;
    const seeded = seedThree(db);
    // Another writer's version of the same paragraph is the latest one now.
    db.prepare("UPDATE block_versions SET change_id = 'chg_other' WHERE change_id = ?").run(seeded.reader);

    const reader = readRecord(db).items.find((item) => item.id === seeded.reader);
    expect(reader?.span).toBeNull();
  });

  it('never lists one landing twice: the lane may emit the same stage again', () => {
    fixture = createFixture();
    const db = fixture.db;
    seedThree(db);
    // The live book holds exactly this shape: two `landed` rows for one pass, one of them bare.
    landed(db, { passId: 'stp_bare', chapter: 4, at: '2026-10-25T09:03:00Z', before: 'было так', after: 'стало иначе', stageSeq: 6 });
    landed(db, { passId: 'stp_bare', chapter: 4, at: '2026-10-25T09:04:00Z', stageSeq: 7 });

    const bare = readRecord(db).items.filter((item) => item.id === 'pass:stp_bare');
    expect(bare).toHaveLength(1);
    // The row with the span is the one the entry keeps: the reader's pair is not lost to a
    // later, emptier emission.
    expect(bare[0]?.span).toEqual({ before: 'было так', after: 'стало иначе' });
  });
});

describe('what the record leaves out', () => {
  it('has no entries on an empty database', () => {
    fixture = createFixture();
    const page = readRecord(fixture.db);

    expect(page.items).toEqual([]);
    expect(page.firstAt).toBeNull();
  });

  it('has no entries over a written chapter nobody changed through a pass', () => {
    // The web's quiet line reads this answer, and only this answer: a book ingested from files
    // is written and has no change row and no landed stage, so there is nothing to rewind yet.
    fixture = createFixture();
    const local = fixture;
    ingest(local, 'ch01.md', longProse(['Первый абзац. Это служебный текст, он не является текстом книги.'], 'Глава 1'));

    const page = readRecord(local.db);
    expect(page.items).toEqual([]);
    // The book began, though: the starting record still has its date.
    expect(page.firstAt).not.toBeNull();
  });

  it('drops a hidden filing and keeps the pass that has no filing at all', () => {
    fixture = createFixture();
    const db = fixture.db;
    const reader = seedChange(db, { index: 1, chapter: 2, label: 'Скрытый Читатель' });
    appendEvent(db, { kind: 'change.queued', changeId: reader.changeId, chapter: 2 }, BASE_MS);
    landed(db, { passId: 'stp_ok', chapter: 5, at: '2026-10-25T09:10:00Z', before: 'а', after: 'б' });
    db.prepare("UPDATE comments SET status = 'hidden' WHERE id = ?").run(reader.commentId);

    const items = readRecord(db).items;
    expect(items.map((item) => item.id)).toEqual(['pass:stp_ok']);
    expect(JSON.stringify(items)).not.toContain('Скрытый Читатель');
  });

  it('drops a change and a landing outside the book’s range (BOOK-155)', () => {
    fixture = createFixture();
    const db = fixture.db;
    machineChange(db, 'chg_65', 65, '2026-10-25T09:20:00Z');
    appendEvent(db, { kind: 'change.queued', changeId: 'chg_65', chapter: 65 }, BASE_MS);
    landed(db, { passId: 'stp_65', chapter: 65, at: '2026-10-25T09:02:00Z', before: 'а', after: 'б' });

    expect(readRecord(db).items).toEqual([]);
    // The bound is the book's own range, the same one every other surface applies.
    expect(TOTAL_CHAPTERS).toBe(42);
  });
});

describe('the record never invents a span', () => {
  it('reads no pair out of an empty side, malformed JSON or a stale shape', () => {
    fixture = createFixture();
    const db = fixture.db;
    landed(db, { passId: 'stp_empty', chapter: 4, at: '2026-10-25T09:10:00Z' });
    db.prepare("UPDATE pass_stages SET span = '[{\"blockId\":null,\"before\":\"\",\"after\":\"новый\"}]' WHERE pass_id = ?").run(
      'stp_empty',
    );
    landed(db, { passId: 'stp_junk', chapter: 5, at: '2026-10-25T09:11:00Z' });
    db.prepare("UPDATE pass_stages SET span = 'not json' WHERE pass_id = ?").run('stp_junk');
    landed(db, { passId: 'stp_shape', chapter: 6, at: '2026-10-25T09:12:00Z' });
    db.prepare("UPDATE pass_stages SET span = '\"a string\"' WHERE pass_id = ?").run('stp_shape');

    const items = readRecord(db).items;
    expect(items).toHaveLength(3);
    // An empty «было» is not a pair, and a broken shape is no evidence: no row claims one.
    expect(items.every((item) => item.span === null)).toBe(true);
  });

  it('reads no pair out of a reader’s malformed anchor', () => {
    fixture = createFixture();
    const db = fixture.db;
    const reader = seedChange(db, { index: 1, chapter: 8, label: 'Аня' });
    db.prepare("UPDATE changes SET anchor = '{' WHERE id = ?").run(reader.changeId);
    appendEvent(db, { kind: 'change.queued', changeId: reader.changeId, chapter: 8 }, BASE_MS);
    // An anchor that is a JSON string is not an object either.
    const other = seedChange(db, { index: 2, chapter: 9, label: 'Марк' });
    db.prepare('UPDATE changes SET anchor = ? WHERE id = ?').run('"просто строка"', other.changeId);
    appendEvent(db, { kind: 'change.queued', changeId: other.changeId, chapter: 9 }, BASE_MS + 1_000);

    const items = readRecord(db).items;
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.span === null)).toBe(true);
  });
});

describe('the record’s page, now over two sources', () => {
  it('pages by the entry’s moment across both sources and ends where they end', () => {
    fixture = createFixture();
    const db = fixture.db;
    const reader = seedChange(db, { index: 1, chapter: 2, label: 'Аня' });
    appendEvent(db, { kind: 'change.queued', changeId: reader.changeId, chapter: 2 }, BASE_MS);
    appendEvent(db, { kind: 'step.landed', chapter: 5, stepId: 'stp_a' }, BASE_MS + 60_000);
    landed(db, { passId: 'stp_a', chapter: 5, at: '2026-10-25T09:30:00Z', before: 'а', after: 'б' });
    appendEvent(db, { kind: 'step.landed', chapter: 6, stepId: 'stp_b' }, BASE_MS + 120_000);
    landed(db, { passId: 'stp_b', chapter: 6, at: '2026-10-25T09:40:00Z', before: 'в', after: 'г' });

    const first = readRecord(db, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(['pass:stp_b', 'pass:stp_a']);
    expect(first.nextBefore).toBe(first.items[1]?.hseq);
    const second = readRecord(db, { before: first.nextBefore ?? 0, limit: 2 });
    expect(second.items.map((item) => item.id)).toEqual([reader.changeId]);
    expect(second.nextBefore).toBeNull();
  });

  it('counts a pass with no log row at zero without hiding it from the list', () => {
    fixture = createFixture();
    const db = fixture.db;
    landed(db, { passId: 'stp_silent', chapter: 7, at: '2026-10-25T09:50:00Z', before: 'а', after: 'б' });

    const page = readRecord(db);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: 'pass:stp_silent', hseq: 0, at: '2026-10-25T09:50:00Z' });
    // The list holds it; the book's clock does not move for it.
    expect(page.lastHseq).toBe(0);
  });
});
