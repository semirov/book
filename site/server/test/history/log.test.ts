import { describe, expect, it } from 'vitest';

import { listRevisions } from '../../src/db/repo/revisions.ts';
import type { Db } from '../../src/db/db.ts';
import { appendEvent } from '../../src/history/log.ts';
import { listEventRows } from '../../src/history/events.ts';
import { chapterFile, historyFixture, ingest, lastHseq } from './helpers.ts';

const AT = '2026-10-25T09:00:00Z';
const EXPIRES = '2026-10-25T09:10:00Z';

function seedReaderChange(db: Db, options: { chapter: number; cascadeId?: string } = { chapter: 5 }): { changeId: string; leaseId: string; stepId: string } {
  db.prepare(
    `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
     VALUES ('idt_1', 'sub-1', 'Аня', '2026-10-20T09:00:00Z', '2026-10-25T08:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at)
     VALUES ('cmt_1', 'idt_1', ?, 'Аня', 'половик слишком часто', 'sha', 'iph', 'accepted', '2026-10-24T09:00:00Z')`,
  ).run(options.chapter);
  db.prepare(
    `INSERT INTO changes (id, kind, chapter, intent, source_comment, base_rev, base_sha256, base_blocks,
                          scope_hint, status, enqueued_at)
     VALUES ('chg_1', 'accepted_comment', ?, 'убрать второе упоминание половика', 'cmt_1', 1, 'sha', '[]',
             'phrase', 'processing', '2026-10-25T08:00:00Z')`,
  ).run(options.chapter);
  if (options.cascadeId !== undefined) {
    db.prepare(
      `INSERT INTO cascades (id, change_id, status, budget, opened_at)
       VALUES (?, 'chg_1', 'open', '{}', '2026-10-25T08:30:00Z')`,
    ).run(options.cascadeId);
    db.prepare(`UPDATE changes SET cascade_id = ? WHERE id = 'chg_1'`).run(options.cascadeId);
  }
  db.prepare(
    `INSERT INTO steps (step_id, cascade_id, seq, wave, lane, pass, chapter, boundary, at)
     VALUES ('stp_1', ?, 1, 1, 'forward', 'change', ?, '5', '2026-10-25T08:50:00Z')`,
  ).run(options.cascadeId ?? null, options.chapter);
  db.prepare(
    `INSERT INTO leases (id, step_id, change_id, cascade_id, lane, chapter, is_front, kind, session,
                         expected_rev, acquired_at, heartbeat_at, expires_at)
     VALUES ('lea_1', 'stp_1', 'chg_1', ?, 'forward', ?, 0, ?, 'writer-fwd', 1, ?, ?, ?)`,
  ).run(options.cascadeId ?? null, options.chapter, options.cascadeId === undefined ? 'change' : 'cascade', AT, AT, EXPIRES);
  return { changeId: 'chg_1', leaseId: 'lea_1', stepId: 'stp_1' };
}

describe('T-history — every revision is a fact with a clock (§6F.1)', () => {
  it('writes one event per revision, and the revision carries its hseq', () => {
    const fixture = historyFixture();
    try {
      ingest(fixture, 'ch01.md', chapterFile(1, ['Первый абзац.'], 'Половик в тамбуре'));
      ingest(fixture, 'ch01.md', chapterFile(1, ['Первый абзац.', 'Второй абзац.'], 'Половик в тамбуре'));
      ingest(fixture, '00-front.md', 'Земля, которая больше не кормит\n\nКнига о том, как вещи научились обходиться без тех, кто их завёл.');

      const revisions = listRevisions(fixture.db, 1) as Array<{ rev: number; hseq: number }>;
      expect(revisions).toHaveLength(2);
      for (const revision of revisions) {
        expect(typeof revision.hseq).toBe('number');
        const event = fixture.db
          .prepare(`SELECT chapter, rev, kind FROM events WHERE hseq = ?`)
          .get(revision.hseq) as { chapter: number; rev: number; kind: string };
        expect(event).toEqual({ chapter: 1, rev: revision.rev, kind: revision.rev === 1 ? 'chapter.created' : 'chapter.revised' });
      }

      const front = fixture.db.prepare('SELECT rev, hseq, title FROM front_revisions').get() as {
        rev: number;
        hseq: number;
        title: string;
      };
      const frontEvent = fixture.db.prepare('SELECT kind, is_front, rev FROM events WHERE hseq = ?').get(front.hseq) as {
        kind: string;
        is_front: number;
        rev: number;
      };
      expect(frontEvent).toEqual({ kind: 'front.revised', is_front: 1, rev: front.rev });
      expect(front.title).toBe('Земля, которая больше не кормит');
    } finally {
      fixture.close();
    }
  });

  it('orders by hseq and chains prev_hseq, never by a timestamp', () => {
    const fixture = historyFixture();
    try {
      ingest(fixture, 'ch01.md', chapterFile(1, ['Первый абзац.']));
      ingest(fixture, 'ch02.md', chapterFile(2, ['Второй абзац.']));
      const rows = listEventRows(fixture.db, { limit: 10 }).reverse();
      expect(rows.length).toBeGreaterThanOrEqual(2);
      let previous: number | null = null;
      for (const row of rows) {
        expect(row.prev_hseq).toBe(previous);
        previous = row.hseq;
      }
      expect(lastHseq(fixture.db)).toBe(previous);
    } finally {
      fixture.close();
    }
  });

  it('refuses UPDATE and DELETE on the log, at the database level', () => {
    const fixture = historyFixture();
    try {
      ingest(fixture, 'ch01.md', chapterFile(1, ['Первый абзац.']));
      const hseq = lastHseq(fixture.db);
      expect(() => fixture.db.prepare("UPDATE events SET author_label = 'x' WHERE hseq = ?").run(hseq)).toThrow(
        /append-only/u,
      );
      expect(() => fixture.db.prepare('DELETE FROM events WHERE hseq = ?').run(hseq)).toThrow(/append-only/u);
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM events WHERE hseq = ?').get(hseq)).toEqual({ n: 1 });
      // A correction is a new event: the log keeps both.
      appendEvent(fixture.db, { kind: 'operator.release', chapter: 1, authorKind: 'operator' }, Date.parse(AT));
      expect(lastHseq(fixture.db)).toBe(hseq + 1);
    } finally {
      fixture.close();
    }
  });

  it('attributes a write to the reader whose change holds the lease', () => {
    const fixture = historyFixture();
    try {
      seedReaderChange(fixture.db, { chapter: 5 });
      ingest(fixture, 'ch05.md', chapterFile(5, ['Половик в тамбуре намок ещё в четверг.', 'След от колеса остался с ночи.']), new Date(AT));

      const revision = (listRevisions(fixture.db, 5) as Array<Record<string, unknown>>).at(-1);
      expect(revision).toMatchObject({ rev: 1, cause_kind: 'change', change_id: 'chg_1', step_id: 'stp_1', attributed: 1 });

      const event = listEventRows(fixture.db, { kind: 'chapter.created' })[0];
      expect(event).toMatchObject({
        kind: 'chapter.created',
        chapter: 5,
        change_id: 'chg_1',
        step_id: 'stp_1',
        author_kind: 'reader',
        identity_id: 'idt_1',
        author_label: 'Аня',
      });
    } finally {
      fixture.close();
    }
  });

  it('records a cascade rewrite as a cascade, still on the reader’s change', () => {
    const fixture = historyFixture();
    try {
      seedReaderChange(fixture.db, { chapter: 5, cascadeId: 'csc_1' });
      ingest(fixture, 'ch05.md', chapterFile(5, ['Половик в тамбуре намок ещё в четверг.']), new Date(AT));
      const revision = (listRevisions(fixture.db, 5) as Array<Record<string, unknown>>).at(-1);
      expect(revision).toMatchObject({ cause_kind: 'cascade', cascade_id: 'csc_1', change_id: 'chg_1', attributed: 1 });
      const overwrite = listEventRows(fixture.db, { kind: 'overwrite' });
      expect(overwrite.every((row) => row.cascade_id === 'csc_1' && row.author_label === 'Аня')).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it('marks a hand write with no lease as «правка вне процесса»', () => {
    const fixture = historyFixture();
    try {
      ingest(fixture, 'ch07.md', chapterFile(7, ['Рука сама написала этот абзац.']) );
      const event = listEventRows(fixture.db, { kind: 'chapter.created' })[0];
      expect(event).toMatchObject({ author_kind: 'unattributed', author_label: 'правка вне процесса' });
      const revision = (listRevisions(fixture.db, 7) as Array<Record<string, unknown>>)[0];
      expect(revision).toMatchObject({ attributed: 0, cause_kind: 'draft' });
    } finally {
      fixture.close();
    }
  });

  it('ignores an expired lease: a stale writer does not own the text', () => {
    const fixture = historyFixture();
    try {
      const { leaseId } = seedReaderChange(fixture.db, { chapter: 4 });
      fixture.db.prepare('UPDATE leases SET expires_at = ? WHERE id = ?').run('2026-10-25T08:59:00Z', leaseId);
      ingest(fixture, 'ch04.md', chapterFile(4, ['Поздняя запись после истечения аренды.']), new Date(AT));
      const event = listEventRows(fixture.db, { kind: 'chapter.created' })[0];
      expect(event?.author_kind).toBe('unattributed');
    } finally {
      fixture.close();
    }
  });
});
