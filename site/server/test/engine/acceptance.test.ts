import type { GateVerdict, StepTrace, WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { databaseFile, openDatabase } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createEngine } from '../../src/engine/service.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import { FakeClock, chapterText, createEngineFixture, runStubStep } from './helpers.ts';

function gates(trace: StepTrace): GateVerdict[] {
  return trace.gates as GateVerdict[];
}

describe('M3 acceptance — the scripted session', () => {
  it('drafts ch01 through writer → editor → consultant, then a change at ch01 cascades to ch02', () => {
    const fixture = createEngineFixture();
    try {
      // 1. draft ch01: the first job of the forward lane on an empty book.
      const draft = runStubStep(fixture, {
        title: 'Половик в тамбуре',
        blocks: ['Половик в тамбуре намок ещё в четверг.', 'Никто его не поднимал.'],
      });
      expect(draft).not.toBeNull();
      expect(draft?.assignment.pass).toBe('draft');
      expect(draft?.assignment.chapter).toBe(1);
      expect(draft?.result.outcome).toBe('rewritten');
      expect(fixture.readChapter(1)).toContain('Половик в тамбуре');

      const draftTrace = fixture.engine.trace(draft?.stepId ?? '');
      expect(draftTrace?.kind).toBe('step');
      if (draftTrace?.kind !== 'step') throw new Error('expected a step trace');
      expect(gates(draftTrace.step).map((gate) => gate.role)).toEqual(['editor', 'consultant']);
      expect(gates(draftTrace.step).every((gate) => gate.verdict === 'HOLDS')).toBe(true);
      expect(gates(draftTrace.step).every((gate) => gate.model === 'stub/deepseek-flash')).toBe(true);

      // 2. draft ch02, so the change has somewhere to ripple to.
      const second = runStubStep(fixture, {
        title: 'Вторая глава',
        blocks: ['Во дворе стояла доска на двух кирпичах.', 'След от колеса остался с ночи.'],
      });
      expect(second?.assignment.chapter).toBe(2);

      // 3. a reader's accepted comment becomes a change in the FIFO lane.
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 1,
        intent: 'убрать второе упоминание половика, оставить одно',
      });
      expect(change.status).toBe('pending');

      // 4. the origin step writes ch01 and reports the 1|2 seam.
      const origin = runStubStep(fixture, {
        title: 'Половик в тамбуре',
        blocks: ['Половик в тамбуре намок ещё в четверг.'],
        seams: [{ boundary: 2, reason: 'соседняя глава начинается с того же половика' }],
      });
      expect(origin?.assignment.pass).toBe('change');
      expect(origin?.assignment.chapter).toBe(1);
      expect(origin?.result.outcome).toBe('rewritten');
      expect(origin?.result.cascadeId).toBeTruthy();

      // 5. the ripple goes upward to ch02 (the downward side reached chapter 1 at once).
      const repair = runStubStep(fixture, {
        title: 'Вторая глава',
        blocks: ['Во дворе стояла доска на двух кирпичах.', 'След от колеса остался с ночи.', 'Половик унесли.'],
        seams: [],
      });
      expect(repair?.assignment.pass).toBe('cascade');
      expect(repair?.assignment.chapter).toBe(2);
      expect(repair?.assignment.seamsIn[0]?.boundary).toBe(2);
      expect(repair?.result.outcome).toBe('rewritten');

      // 6. the ripple reached the first sheet: one front step rewrites title and annotation.
      const front = runStubStep(fixture, {
        title: 'Земля без половика',
        blocks: [
          'Книга о том, как вещи научились обходиться без тех, кто их завёл. В ней нет героев — есть смены, ' +
            'заявки, очереди и бумаги, которые пережили своих составителей. Земля в ней больше не кормит: ' +
            'её обслуживают. Поля стали участками, участки — строками в реестре, реестр — тем, что закрывают ' +
            'само, без человека. Конец у этой книги один, и он не спрятан: к нему ведут шестьдесят семь глав, ' +
            'и каждая пишется в открытую.',
        ],
        seams: [],
      });
      expect(front?.assignment.pass).toBe('front');
      expect(front?.assignment.chapter).toBe('front');

      // 7. the complete trace: every step has both verdicts, in gate order.
      const trace = fixture.engine.trace(change.id);
      if (trace?.kind !== 'change') throw new Error('expected a change trace');
      expect(trace.change.change.status).toBe('done');
      expect(trace.change.change.outcome).toBe('applied');
      expect(trace.change.change.relevance?.grade).toBe('fresh');
      // The change's cost facts are frozen at close (§6D.5): model + both token directions.
      expect(trace.change.change.model).toBe('stub/deepseek-flash');
      expect(trace.change.change.tokensIn).toBeGreaterThan(0);
      expect(trace.change.change.tokensOut).toBeGreaterThan(0);
      expect(trace.change.cascade?.status).toBe('closed');
      expect(trace.change.cascade?.outcome).toBe('absorbed');
      expect(trace.change.cascade?.depthBackward).toBe(0);
      expect(trace.change.cascade?.depthForward).toBe(1);
      expect(trace.change.cascade?.steps.map((step) => step.step.pass)).toEqual([
        'change',
        'cascade',
        'front',
      ]);
      for (const step of trace.change.cascade?.steps ?? []) {
        expect(step.gates.map((gate) => gate.role)).toEqual(['editor', 'consultant']);
      }
      expect(fixture.db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'processing'`).get()).toEqual({
        n: 0,
      });
      expect(fixture.db.prepare('SELECT holder FROM lane WHERE id = 1').get()).toEqual({ holder: null });
    } finally {
      fixture.close();
    }
  });

  it('records a front step as holds when the first sheet did not change (§6C.2)', () => {
    const fixture = createEngineFixture({
      chapters: {
        1: chapterText('Начало', ['Половик намок ещё в четверг.']),
        2: chapterText('Вторая', ['Во дворе стояла доска.']),
      },
    });
    try {
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 2, intent: 'уточнить двор' });
      runStubStep(fixture, {
        title: 'Вторая',
        blocks: ['Во дворе стояла доска на двух кирпичах.'],
        seams: [{ boundary: 3, reason: 'следующая глава продолжает двор' }],
      });
      const down = runStubStep(
        fixture,
        { title: 'Начало', blocks: ['Половик намок ещё в четверг.'], seams: [] },
        'bwd',
      );
      expect(down?.result.outcome).toBe('holds');
      const front = runStubStep(fixture, {
        title: 'Земля, которая больше не кормит',
        blocks: [
          'Книга о том, как вещи научились обходиться без тех, кто их завёл. В ней нет героев — есть смены, ' +
            'заявки, очереди и бумаги, которые пережили своих составителей. Земля в ней больше не кормит: ' +
            'её обслуживают. Поля стали участками, участки — строками в реестре, реестр — тем, что закрывают ' +
            'само, без человека. Конец у этой книги один, и он не спрятан: к нему ведут шестьдесят семь глав, ' +
            'и каждая пишется в открытую.',
        ],
        seams: [],
      });
      expect(front?.assignment.pass).toBe('front');
      expect(front?.result.outcome).toBe('holds');
      const trace = fixture.engine.trace(change.id);
      if (trace?.kind !== 'change') throw new Error('expected a change trace');
      const frontStep = trace.change.cascade?.steps.find((step) => step.step.pass === 'front');
      expect(frontStep?.step.outcome).toBe('holds');
      // The upward wing stopped at an unwritten chapter, and the trace says so.
      expect(trace.change.cascade?.outcome).toBe('frontier');
    } finally {
      fixture.close();
    }
  });

  it('refuses a change aimed at the fixed ending (ADR-024)', () => {
    const fixture = createEngineFixture({
      chapters: { 66: chapterText('Пролог', ['Снег лежал на подоконнике.']), 67: chapterText('Финал', ['Свет погас.']) },
    });
    try {
      expect(() =>
        fixture.engine.enqueue({ kind: 'reader_edit', chapter: 67, intent: 'пусть кто-то спасётся' }),
      ).toThrow(/финал/u);
      const continuity = fixture.engine.enqueue({ kind: 'operator', chapter: 67, intent: 'поправить пунктуацию' });
      expect(continuity.status).toBe('pending');
    } finally {
      fixture.close();
    }
  });
});

describe('M3 acceptance — a killed engine', () => {
  it('resumes the step, keeps the verdict, and does not duplicate the revision', () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Половик намок ещё в четверг.', 'Никто его не поднимал.']) },
    });
    try {
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 1,
        intent: 'половик должен намокнуть не в четверг, а в среду',
      });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      expect(assignment.pass).toBe('change');
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapterBlocks(1, 'Начало', ['Половик намок ещё в среду.', 'Никто его не поднимал.']);
      const landed = fixture.engine.land(assignment.leaseId);
      expect(landed.revAfter).toBe(1);

      const editor = fixture.engine.next({ role: 'editor', session: 'editor-1' }) as GateAssignment;
      fixture.engine.verdict(editor.stepId, {
        role: 'editor',
        session: 'editor-1',
        verdict: 'HOLDS',
        findings: [],
        model: 'stub/deepseek-flash',
        tokensIn: 100,
        tokensOut: 10,
      });

      // The engine process dies here: a new connection and a new engine object, same file.
      const db = openDatabase(databaseFile(fixture.dataDir));
      migrate(db);
      const second = createEngine({
        db,
        config: fixture.config,
        bookRoot: fixture.root,
        clock: new FakeClock(fixture.clock.now()),
        alert: () => undefined,
      });

      const resumed = second.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      expect(resumed.leaseId).toBe(assignment.leaseId);
      expect(resumed.verdicts.editor).toBe(true);
      expect(resumed.verdicts.consultant).toBe(false);
      expect(resumed.landed).toBe(true);

      // Re-landing the same text is a no-op: one revision, one landed sha.
      const again = second.land(assignment.leaseId);
      expect(again.changed).toBe(false);
      expect(again.revAfter).toBe(landed.revAfter);

      const consultant = second.next({ role: 'consultant', session: 'consultant-1' }) as GateAssignment;
      second.verdict(consultant.stepId, {
        role: 'consultant',
        session: 'consultant-1',
        verdict: 'HOLDS',
        findings: [],
        model: 'stub/deepseek-flash',
        tokensIn: 90,
        tokensOut: 8,
      });
      const done = second.done(assignment.leaseId, { seams: [], note: 'resumed after a crash' });
      expect(done.outcome).toBe('rewritten');

      const steps = db.prepare('SELECT COUNT(*) AS n FROM steps').get() as { n: number };
      expect(steps.n).toBe(1);
      const verdicts = db.prepare('SELECT role FROM gate_verdicts ORDER BY role').all() as Array<{ role: string }>;
      expect(verdicts.map((row) => row.role)).toEqual(['consultant', 'editor']);
      const row = db.prepare('SELECT status, cascade_id FROM changes WHERE id = ?').get(change.id) as {
        status: string;
        cascade_id: string | null;
      };
      expect(row.status).toBe('done');
      expect(row.cascade_id).toBeNull();
      db.close();
    } finally {
      fixture.close();
    }
  });

  it('takes a write that landed before the session died as landed, and re-issues one that did not', () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Половик намок ещё в четверг.']) },
    });
    try {
      // A session writes and dies before `land`; the lease expires.
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда вместо четверга' });
      const a = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      fixture.engine.start(a.leaseId);
      fixture.writeChapterBlocks(1, 'Начало', ['Половик намок ещё в среду.']);
      fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
      const report = fixture.engine.reap();
      expect(report.recovered).toEqual([a.stepId]);

      const after = fixture.engine.next({ for: 'fwd', session: 'writer-2' }) as WriterAssignment;
      expect(after.stepId).toBe(a.stepId);
      expect(after.landed).toBe(true);

      // A second change whose session dies *before* writing: the job is re-issued, not lost.
      const editor = fixture.engine.next({ role: 'editor', session: 'editor-1' }) as GateAssignment;
      fixture.engine.verdict(editor.stepId, {
        role: 'editor', session: 'editor-1', verdict: 'HOLDS', findings: [], model: 'stub', tokensIn: 1, tokensOut: 1,
      });
      const consultant = fixture.engine.next({ role: 'consultant', session: 'consultant-1' }) as GateAssignment;
      fixture.engine.verdict(consultant.stepId, {
        role: 'consultant', session: 'consultant-1', verdict: 'HOLDS', findings: [], model: 'stub', tokensIn: 1, tokensOut: 1,
      });
      const done = fixture.engine.done(after.leaseId, { seams: [], note: 'recovered' });
      expect(done.outcome).toBe('rewritten');
      expect((fixture.db.prepare('SELECT status FROM changes WHERE id = ?').get(change.id) as { status: string }).status).toBe('done');
    } finally {
      fixture.close();
    }
  });
});
