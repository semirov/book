import { describe, expect, it } from 'vitest';

import type { Db } from '../src/db/db.ts';
import { EngineBridge } from '../src/engineState/bridge.ts';
import { appendChangeEvent } from '../src/history/log.ts';
import { createFixture, type Fixture } from './helpers.ts';

/**
 * BOOK-219/BOOK-206 B2 — a change's close reaches the filing, not only the change.
 *
 * The audit's B2: an escalated change left the filing `accepted` with `changeStatus: null`, so
 * three surfaces printed three answers about one stop. These are the bridge's own closes, asserted
 * on the frame contract the open page consumes: `applied` for a landing (with the chapter's own
 * receipt), `rejected` for a stop or a drop (with the change's sentence), and no frame at all for
 * a close that left the filing where it was. `change:decided` always arrives beside it.
 */

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);

type Frame = { type: string; data: Record<string, unknown> };

// ── the bridge's own closes: a landing, a stop, and a close that moved nothing ──────────────

/** One reader filing in a fixture database, the way the engine leaves it after triage. */
function bootBridge(): { fixture: Fixture; frames: Frame[]; bridge: EngineBridge } {
  const fixture = createFixture({});
  const frames: Frame[] = [];
  const bridge = new EngineBridge({
    db: fixture.db,
    emit: (type, data) => frames.push({ type, data: data as Record<string, unknown> }),
    replay: true,
    progressThrottleMs: 0,
    now: () => T0,
  });
  bridge.prime();
  return { fixture, frames, bridge };
}

/** One change row, exactly the columns a close reads. */
function insertChange(
  db: Db,
  change: {
    id: string;
    seq: number;
    chapter: number;
    status: string;
    intent: string;
    outcome?: string | null;
    finishedAt?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO changes
       (seq, id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint, premise, status,
        relevance, outcome, cascade_id, model, tokens_in, tokens_out, cost_rub, enqueued_at, started_at,
        finished_at, attempts)
     VALUES (?, ?, 'accepted_comment', ?, ?, 2, 'sha', '[]', 'phrase', 0,
        ?, NULL, ?, NULL, 'deepseek-flash', 0, 0, 0, ?, ?, ?, 0)`,
  ).run(
    change.seq,
    change.id,
    change.chapter,
    change.intent,
    change.status,
    change.outcome ?? null,
    new Date(T0).toISOString(),
    new Date(T0).toISOString(),
    change.finishedAt ?? null,
  );
}

describe('BOOK-219/BOOK-206 B2 — a close reaches the filing, not only the change', () => {
  /** One reader behind the filing; the comments table requires the identity row. */
  function seedIdentity(db: Db): void {
    db.prepare(
      `INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at)
       VALUES ('idn_book219', 'sub-book219', 'Аня', ?, ?)`,
    ).run(new Date(T0).toISOString(), new Date(T0).toISOString());
  }

  /** BOOK-218 — a filing's public number is a column now, unique: every seeded row gets one. */
  let filed = 0;

  function seedComment(db: Db, id: string, chapter: number, disposition: string | null): void {
    filed += 1;
    db.prepare(
      `INSERT INTO comments
         (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at, decided_at,
          reason, batch_id, disposition, number)
       VALUES (?, 'idn_book219', ?, 'Аня', 'в главе дважды «слово»', ?, ?, 'accepted', ?, ?, 'принято · входит в книгу', 'btc_1', ?, ?)`,
    ).run(
      id,
      chapter,
      `sha-${id}`,
      'a'.repeat(64),
      new Date(T0).toISOString(),
      new Date(T0 + 1_000).toISOString(),
      disposition,
      filed,
    );
  }

  /** The chapter and the revision row the landing left: the receipt is read from these. */
  function seedRevision(db: Db, chapter: number, rev: number, changeId: string): void {
    db.prepare(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at)
       VALUES (?, ?, 'Глава', 'sha-ch', 900, 4, 0, ?, ?)`,
    ).run(chapter, rev, new Date(T0).toISOString(), new Date(T0).toISOString());
    db.prepare(
      `INSERT INTO revisions
         (chapter, rev, at, kind, cause_kind, change_id, cascade_id, step_id, added, changed, removed,
          snapshot, attributed)
       VALUES (?, ?, ?, 'edit', 'change', ?, NULL, NULL, 1, 2, 0, 'versions/ch/9.md', 1)`,
    ).run(chapter, rev, new Date(T0 + 60_000).toISOString(), changeId);
  }

  it('emits `comment:decision` for the applied filing, beside `change:decided`, once per close', () => {
    const { fixture, frames, bridge } = bootBridge();
    try {
      seedIdentity(fixture.db);
      seedComment(fixture.db, 'cmt_landed', 9, 'as_said');
      insertChange(fixture.db, {
        id: 'chg_landed',
        seq: 1,
        chapter: 9,
        status: 'done',
        intent: 'убрать второе «слово»',
        outcome: 'applied',
        finishedAt: new Date(T0 + 60_000).toISOString(),
      });
      fixture.db
        .prepare(`UPDATE changes SET source_comment = ?, reason = ? WHERE id = ?`)
        .run('cmt_landed', 'правка внесена в главу 9', 'chg_landed');
      seedRevision(fixture.db, 9, 4, 'chg_landed');
      appendChangeEvent(fixture.db, 'chg_landed', 'queued', {}, T0);
      appendChangeEvent(fixture.db, 'chg_landed', 'decided', { outcome: 'applied' }, T0 + 60_000);

      bridge.tick();

      const types = frames.map((frame) => frame.type);
      expect(types).toContain('change:decided');
      const filing = frames.find((frame) => frame.type === 'comment:decision')?.data as Record<string, unknown>;
      expect(filing).toMatchObject({
        id: 'cmt_landed',
        chapter: 9,
        status: 'applied',
        reason: 'правка внесена в главу 9',
        changeId: 'chg_landed',
        disposition: 'as_said',
      });
      // The receipt is the one storage holds: the landing's chapter and its own revision row.
      const revision = fixture.db
        .prepare('SELECT MAX(rev) AS rev FROM revisions WHERE chapter = 9')
        .get() as { rev: number };
      expect(filing.applied).toEqual({ chapter: 9, rev: revision.rev });
      // The reading travels with the frame, exactly as the row stores it (BOOK-174 §5).
      expect(filing.disposition).toBe('as_said');
      expect(filing.carrierKind).toBeNull();

      // One frame per close: the drain cursor has already passed the row.
      const seen = frames.length;
      bridge.tick();
      expect(frames.slice(seen).filter((frame) => frame.type === 'comment:decision')).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('tells the filing a stopped close — the terminal word, never `applied`', () => {
    const { fixture, frames, bridge } = bootBridge();
    try {
      seedIdentity(fixture.db);
      seedComment(fixture.db, 'cmt_dropped', 8, 'as_said');
      seedComment(fixture.db, 'cmt_escalated', 9, 'as_said');
      insertChange(fixture.db, {
        id: 'chg_dropped',
        seq: 1,
        chapter: 8,
        status: 'void',
        intent: 'убрать второе «слово»',
        outcome: 'dropped',
      });
      insertChange(fixture.db, {
        id: 'chg_escalated',
        seq: 2,
        chapter: 9,
        status: 'escalated',
        intent: 'убрать второе «слово»',
        outcome: 'origin',
      });
      fixture.db
        .prepare(`UPDATE changes SET source_comment = 'cmt_dropped', reason = ? WHERE id = 'chg_dropped'`)
        .run('в главе уже одно упоминание — второе убрано');
      fixture.db
        .prepare(`UPDATE changes SET source_comment = 'cmt_escalated', reason = ? WHERE id = 'chg_escalated'`)
        .run('починка задела слишком много текста — нужно решение');
      appendChangeEvent(fixture.db, 'chg_dropped', 'decided', { outcome: 'dropped' }, T0);
      appendChangeEvent(fixture.db, 'chg_escalated', 'escalated', { outcome: 'origin' }, T0 + 1_000);

      bridge.tick();

      const types = frames.map((frame) => frame.type);
      // The change still narrates its own close — the filing frame is never instead of it.
      expect(types.filter((type) => type === 'change:decided')).toHaveLength(2);
      const decisions = frames
        .filter((frame) => frame.type === 'comment:decision')
        .map((frame) => frame.data as Record<string, unknown>);
      // BOOK-206 B2 — a stop and a drop are the same terminal filing state: `rejected`, with the
      // change's own sentence, and a present `applied: null` (this close moved no text).
      expect(decisions).toHaveLength(2);
      for (const decision of decisions) {
        expect(decision.status).toBe('rejected');
        expect(decision.applied).toBeNull();
      }
      expect(decisions.find((frame) => frame.id === 'cmt_escalated')).toMatchObject({
        reason: 'починка задела слишком много текста — нужно решение',
        changeId: 'chg_escalated',
      });
      expect(decisions.find((frame) => frame.id === 'cmt_dropped')).toMatchObject({
        reason: 'в главе уже одно упоминание — второе убрано',
        changeId: 'chg_dropped',
      });
      expect(JSON.stringify(decisions)).not.toContain('ждёт');

      // One frame per transition: the drain cursor has already passed both rows.
      const seen = frames.length;
      bridge.tick();
      expect(frames.slice(seen).filter((frame) => frame.type === 'comment:decision')).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('says nothing about a close that left the filing where it was', () => {
    const { fixture, frames, bridge } = bootBridge();
    try {
      seedIdentity(fixture.db);
      // A change closed `done` with no landing outcome: the filing keeps its own word, so there
      // is no transition to narrate — and no `comment:decision` may claim one.
      seedComment(fixture.db, 'cmt_pending', 8, 'as_said');
      insertChange(fixture.db, {
        id: 'chg_pending',
        seq: 1,
        chapter: 8,
        status: 'pending',
        intent: 'убрать второе «слово»',
      });
      fixture.db.prepare(`UPDATE changes SET source_comment = 'cmt_pending' WHERE id = 'chg_pending'`).run();
      appendChangeEvent(fixture.db, 'chg_pending', 'decided', { outcome: 'applied' }, T0);

      bridge.tick();

      expect(frames.map((frame) => frame.type)).toContain('change:decided');
      expect(frames.map((frame) => frame.type)).not.toContain('comment:decision');
    } finally {
      fixture.close();
    }
  });

  it('never speaks for a change no reader filed, nor for a withdrawn row', () => {
    const { fixture, frames, bridge } = bootBridge();
    try {
      seedIdentity(fixture.db);
      // A continuity pass or an operator's edit: the author's change, with no reader behind it.
      insertChange(fixture.db, {
        id: 'chg_operator',
        seq: 1,
        chapter: 8,
        status: 'done',
        intent: 'свести главу с соседней',
        outcome: 'applied',
      });
      // A filing the operator withdrew: stored for the operator, never republished (BOOK-101).
      seedComment(fixture.db, 'cmt_hidden', 9, 'as_said');
      fixture.db.prepare(`UPDATE comments SET status = 'hidden' WHERE id = 'cmt_hidden'`).run();
      insertChange(fixture.db, {
        id: 'chg_hidden',
        seq: 3,
        chapter: 9,
        status: 'done',
        intent: 'убрать второе «слово»',
        outcome: 'applied',
      });
      fixture.db.prepare(`UPDATE changes SET source_comment = 'cmt_hidden' WHERE id = 'chg_hidden'`).run();

      for (const [index, id] of ['chg_operator', 'chg_hidden'].entries()) {
        appendChangeEvent(fixture.db, id, 'decided', { outcome: 'applied' }, T0 + index * 1_000);
      }
      bridge.tick();

      expect(frames.filter((frame) => frame.type === 'change:decided')).toHaveLength(2);
      expect(frames.map((frame) => frame.type)).not.toContain('comment:decision');
    } finally {
      fixture.close();
    }
  });

  it('never invents a revision: no chapter row, no receipt — and the stored columns are the last word', () => {
    const { fixture, frames, bridge } = bootBridge();
    try {
      seedIdentity(fixture.db);
      seedComment(fixture.db, 'cmt_noreceipt', 9, null);
      seedComment(fixture.db, 'cmt_rowreceipt', 7, null);
      // BOOK-136 — the receipt a row carries in its own columns is the second source, never a guess.
      fixture.db.prepare(`UPDATE comments SET applied_chapter = 7, applied_rev = 2 WHERE id = 'cmt_rowreceipt'`).run();
      insertChange(fixture.db, {
        id: 'chg_noreceipt',
        seq: 1,
        chapter: 9,
        status: 'done',
        intent: 'убрать второе «слово»',
        outcome: 'applied',
      });
      insertChange(fixture.db, {
        id: 'chg_rowreceipt',
        seq: 2,
        chapter: 7,
        status: 'done',
        intent: 'убрать второе «слово»',
        outcome: 'adapted',
      });
      fixture.db.prepare(`UPDATE changes SET source_comment = 'cmt_noreceipt' WHERE id = 'chg_noreceipt'`).run();
      fixture.db.prepare(`UPDATE changes SET source_comment = 'cmt_rowreceipt' WHERE id = 'chg_rowreceipt'`).run();
      appendChangeEvent(fixture.db, 'chg_noreceipt', 'decided', { outcome: 'applied' }, T0);
      appendChangeEvent(fixture.db, 'chg_rowreceipt', 'decided', { outcome: 'adapted' }, T0 + 1_000);

      bridge.tick();

      const decisions = frames
        .filter((frame) => frame.type === 'comment:decision')
        .map((frame) => frame.data as Record<string, unknown>);
      expect(decisions).toHaveLength(2);
      expect(decisions.find((frame) => frame.id === 'cmt_noreceipt')?.applied).toBeNull();
      expect(decisions.find((frame) => frame.id === 'cmt_rowreceipt')?.applied).toEqual({ chapter: 7, rev: 2 });
    } finally {
      fixture.close();
    }
  });
});

