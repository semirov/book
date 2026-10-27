import type { WriterAssignment } from '@book/shared';
import { FRAME_FIRST_SENTENCE } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { buildControl } from '../../src/engine/control.ts';
import { createEngine } from '../../src/engine/service.ts';
import * as store from '../../src/engine/store.ts';
import { databaseFile, openDatabase } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { chapterText, createEngineFixture, driveStub, runStubStep, FakeClock } from './helpers.ts';

function bookBlocks(n: number): string[] {
  return Array.from({ length: 8 }, (_, index) => {
    const tail = 'Служебный абзац для проверки объёма. Это предложение повторяется, чтобы набрать нужную длину, и не является текстом книги.';
    return `Абзац ${index + 1} главы ${n}. ${tail}`;
  });
}

function book(fixture: ReturnType<typeof createEngineFixture>, from: number, to: number): void {
  for (let n = from; n <= to; n += 1) fixture.writeChapterBlocks(n, `Глава ${n}`, bookBlocks(n));
}

function edited(n: number, index: number, text: string): string[] {
  const blocks = bookBlocks(n);
  return blocks.map((block, position) => (position === index ? text : block));
}

function changeOfLease(fixture: ReturnType<typeof createEngineFixture>, leaseId: string): string {
  const row = fixture.db.prepare('SELECT change_id FROM leases WHERE id = ?').get(leaseId) as {
    change_id: string | null;
  };
  if (!row.change_id) throw new Error('lease has no change');
  return row.change_id;
}

describe('the FIFO lane (§6A.3)', () => {
  // 50 sequential polls through the public control route; the default 5 s is tight under a
  // fully parallel suite (the loop takes ~3.5 s on an idle machine).
  it('keeps the admission order under 50 concurrent enqueues and hands heads out by seq', async () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) }, env: { QUEUE_SOFT_CAP: '100' } });
    const app = await buildControl({ engine: fixture.engine, token: 'test-token', logger: false });
    try {
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          app.inject({
            method: 'POST',
            url: '/internal/changes',
            headers: { authorization: 'Bearer test-token' },
            payload: { kind: 'reader_edit', chapter: 1, intent: `правка ${index}` },
          }),
        ),
      );
      for (const response of responses) {
        expect(response.statusCode).toBe(200);
      }
      const seqs = (fixture.db.prepare('SELECT seq FROM changes ORDER BY seq').all() as Array<{ seq: number }>).map(
        (row) => row.seq,
      );
      expect(seqs).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));

      for (let position = 1; position <= 50; position += 1) {
        const assignment = fixture.engine.next({ for: 'fwd', session: `s-${position}` }) as WriterAssignment;
        expect(assignment.pass).toBe('change');
        expect(changeOfLease(fixture, assignment.leaseId)).toBeTruthy();
        const row = fixture.db
          .prepare('SELECT seq FROM changes WHERE id = ?')
          .get(changeOfLease(fixture, assignment.leaseId)) as { seq: number };
        expect(row.seq).toBe(position);
        fixture.engine.start(assignment.leaseId, {
          decision: 'void',
          reason: 'в главе уже одно упоминание абзаца',
        });
      }
      expect(fixture.db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'pending'`).get()).toEqual({ n: 0 });
      expect(fixture.db.prepare('SELECT holder FROM lane WHERE id = 1').get()).toEqual({ holder: null });
    } finally {
      await app.close();
      fixture.close();
    }
  }, 15_000);

  it('refuses admission past the soft cap rather than letting the queue lie about its depth', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) }, env: { QUEUE_SOFT_CAP: '2' } });
    try {
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'раз' });
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'два' });
      expect(() => fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'три' })).toThrow(
        /очередь правок заполнена/u,
      );
    } finally {
      fixture.close();
    }
  });

  it('refuses a change on a slot that holds only its basis sentence (BOOK-6, BOOK-7)', () => {
    // Chapter 1 exists and holds one paragraph — the frozen frame — and is still unwritten:
    // a change must not be admitted against it, or it would be enqueued over baseRev 0. The
    // frozen sentence is never a target: ch01's slot is refused by name, with a public reason.
    const fixture = createEngineFixture({ chapters: { 1: FRAME_FIRST_SENTENCE, 2: chapterText('Начало', ['Тестовый абзац.']) } });
    try {
      expect(() => fixture.engine.enqueue({ kind: 'operator', chapter: 1, intent: 'поправить первую строку' })).toThrow(
        /неподвижна/u,
      );
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
      // A written neighbour still admits, so the refusal is about the slot, not the queue.
      expect(() => fixture.engine.enqueue({ kind: 'operator', chapter: 2, intent: 'уточнить абзац' })).not.toThrow();
    } finally {
      fixture.close();
    }
  });

  it('refuses to start a non-draft pass on a chapter emptied to its basis sentence (BOOK-6)', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
    try {
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
      expect(assignment.pass).toBe('change');
      // The file is emptied down to its basis sentence while the step is open.
      fixture.writeChapter(1, FRAME_FIRST_SENTENCE);

      expect(() => fixture.engine.start(assignment.leaseId)).toThrow(/ещё не написана/u);
      // Nothing was captured as a pre-image of a chapter that has no prose.
      const step = fixture.db.prepare('SELECT start_sha FROM steps WHERE step_id = ?').get(assignment.stepId) as {
        start_sha: string | null;
      };
      expect(step.start_sha).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('holds the lane for one change at a time, even across two engine processes', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
    const db2 = openDatabase(databaseFile(fixture.dataDir));
    migrate(db2);
    const second = createEngine({
      db: db2,
      config: fixture.config,
      bookRoot: fixture.root,
      clock: new FakeClock(fixture.clock.now()),
      alert: () => undefined,
    });
    try {
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'первая' });
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'вторая' });

      const first = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
      expect(first.pass).toBe('change');
      // The other process may draft in the gaps, but it can never take a second change.
      const rival = second.next({ for: 'fwd', session: 'fwd-2' }) as WriterAssignment | null;
      expect(rival?.pass).not.toBe('change');
      expect((fixture.db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'processing'`).get() as { n: number }).n).toBe(1);
    } finally {
      db2.close();
      fixture.close();
    }
  });

  it('keeps the lane on live work after a killed process and re-issues one step, not two', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
    try {
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда' });
      const first = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
      expect((fixture.db.prepare('SELECT holder FROM lane WHERE id = 1').get() as { holder: string }).holder).toBe(change.id);

      fixture.clock.advance(fixture.config.laneTtlMs + fixture.config.leaseTtlMs + 5_000);
      const report = fixture.engine.reap();
      expect(report.expiredLeases).toBe(1);
      // The lane is reclaimed by the live engine, not lost: one change is still in processing.
      expect(fixture.db.prepare('SELECT holder FROM lane WHERE id = 1').get()).toEqual({ holder: change.id });
      expect(fixture.db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'processing'`).get()).toEqual({ n: 1 });
      expect(fixture.db.prepare(`SELECT status, attempts FROM changes WHERE id = ?`).get(change.id)).toEqual({
        status: 'processing',
        attempts: 1,
      });
      const open = fixture.db.prepare('SELECT COUNT(*) AS n FROM steps WHERE outcome IS NULL').get() as { n: number };
      expect(open.n).toBe(1);

      const resumed = fixture.engine.next({ for: 'fwd', session: 'fwd-2' }) as WriterAssignment;
      expect(resumed.pass).toBe('change');
      expect(resumed.stepId).toBe(first.stepId);
      const steps = fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get() as { n: number };
      expect(steps.n).toBe(1);
      expect(fixture.db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'processing'`).get()).toEqual({ n: 1 });
    } finally {
      fixture.close();
    }
  });
});

describe('cascade stops that are not geometry (§6A.6)', () => {
  function seeded(): ReturnType<typeof createEngineFixture> {
    const fixture = createEngineFixture();
    book(fixture, 1, 6);
    return fixture;
  }

  // BOOK-DOC-4 rule 3: the wave bound is the public promise now, so the end-to-end stop lives
  // in `waveBound.test.ts` (on the shipped budget) instead of an env override.
  it('escalates a chapter that would be written twice in one cascade', () => {
    const fixture = seeded();
    try {
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 3, intent: 'связать сцены' });
      runStubStep(fixture, {
        title: 'Глава 3',
        blocks: edited(3, 0, 'Правленый первый абзац главы 3.'),
        seams: [{ boundary: 4, reason: 'соседняя глава продолжает сцену' }],
      });
      const down = fixture.engine.next({ for: 'bwd', session: 'fwd-1' }) as WriterAssignment;
      expect(down.pass).toBe('cascade');

      const cascade = fixture.db.prepare('SELECT id FROM cascades WHERE change_id = ?').get(change.id) as {
        id: string;
      };
      // A previous build wrote chapter 2 in this same ripple: the guard must stop it.
      store.insertStep(fixture.db, {
        stepId: 'stp_earlier',
        cascadeId: cascade.id,
        seq: 90,
        wave: 1,
        lane: 'backward',
        pass: 'cascade',
        chapter: 2,
        boundary: '3',
        seamsIn: '[]',
        revBefore: 0,
        at: new Date(fixture.clock.now()).toISOString(),
      });
      store.updateStep(fixture.db, 'stp_earlier', {
        outcome: 'rewritten',
        seams_out: '[{"boundary":2,"reason":"r"}]',
        closed_at: new Date(fixture.clock.now()).toISOString(),
      });

      const run = driveStub(fixture, down, {
        title: 'Глава 2',
        blocks: edited(2, 0, 'Правленый первый абзац главы 2.'),
        seams: [],
      });
      expect(run.result.outcome).toBe('escalated');
      const row = fixture.db.prepare('SELECT status, outcome FROM changes WHERE id = ?').get(change.id) as {
        status: string;
        outcome: string;
      };
      expect(row).toEqual({ status: 'escalated', outcome: 'oscillation' });
    } finally {
      fixture.close();
    }
  });

  it('escalates a repair that needs a chapter outside its reach (C2)', () => {
    const fixture = seeded();
    try {
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 5, intent: 'связать сцены' });
      runStubStep(fixture, {
        title: 'Глава 5',
        blocks: edited(5, 0, 'Правленый первый абзац главы 5.'),
        seams: [{ boundary: 6, reason: 'соседняя глава продолжает сцену' }],
      });
      const down = fixture.engine.next({ for: 'bwd', session: 'fwd-1' }) as WriterAssignment;
      expect(down.pass).toBe('cascade');
      expect(down.chapter).toBe(4);
      const run = driveStub(fixture, down, {
        title: 'Глава 4',
        blocks: ['Правка, которой нужна глава 6.'],
        seams: [{ boundary: 6, reason: 'без главы 6 починка невозможна' }],
      });
      expect(run.result.outcome).toBe('escalated');
      const row = fixture.db.prepare('SELECT status, outcome, reason FROM changes WHERE id = ?').get(change.id) as {
        status: string;
        outcome: string;
        reason: string;
      };
      expect(row.status).toBe('escalated');
      expect(row.outcome).toBe('origin');
      expect(row.reason).toContain('позади волны');
    } finally {
      fixture.close();
    }
  });

  it('escalates a cascade step that replaced too much of its chapter (MAX_DELTA_RATIO)', () => {
    const fixture = seeded();
    try {
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 5, intent: 'связать сцены' });
      runStubStep(fixture, {
        title: 'Глава 5',
        blocks: edited(5, 0, 'Правленый первый абзац главы 5.'),
        seams: [{ boundary: 6, reason: 'соседняя глава продолжает сцену' }],
      });
      const down = fixture.engine.next({ for: 'bwd', session: 'fwd-1' }) as WriterAssignment;
      const run = driveStub(fixture, down, {
        title: 'Глава 4',
        blocks: [
          'Совершенно новый текст, который не имеет ничего общего с прежними абзацами этой главы. Он заменяет всё.',
          'И второй новый абзац тоже.',
        ],
        seams: [],
      });
      expect(run.result.outcome).toBe('escalated');
      const row = fixture.db.prepare('SELECT status, outcome FROM changes WHERE id = ?').get(change.id) as {
        status: string;
        outcome: string;
      };
      expect(row).toEqual({ status: 'escalated', outcome: 'delta' });
      expect(fixture.alerts.map((alert) => alert.kind)).toContain('delta');
    } finally {
      fixture.close();
    }
  });
});
