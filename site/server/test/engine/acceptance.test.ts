import { FRAME_FIRST_SENTENCE } from '@book/shared';
import type { GateVerdict, StepTrace, WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { databaseFile, openDatabase } from '../../src/db/db.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createEngine } from '../../src/engine/service.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import { FakeClock, PIPELINE_MODEL, chapterText, createEngineFixture, runStubStep } from './helpers.ts';

function gates(trace: StepTrace): GateVerdict[] {
  return trace.gates as GateVerdict[];
}

describe('M3 acceptance — the scripted session', () => {
  it('drafts ch01 through writer → editor → consultant, then a change at ch01 cascades to ch02', () => {
    const fixture = createEngineFixture();
    try {
      // 1. draft ch01: the first job of the forward lane on an empty book.
      const draft = runStubStep(fixture, {
        title: 'Тестовая глава',
        blocks: ['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.', 'Это служебный текст.'],
      });
      expect(draft).not.toBeNull();
      expect(draft?.assignment.pass).toBe('draft');
      expect(draft?.assignment.chapter).toBe(1);
      expect(draft?.result.outcome).toBe('rewritten');
      expect(fixture.readChapter(1)).toContain('Тестовая глава');

      const draftTrace = fixture.engine.trace(draft?.stepId ?? '');
      expect(draftTrace?.kind).toBe('step');
      if (draftTrace?.kind !== 'step') throw new Error('expected a step trace');
      expect(gates(draftTrace.step).map((gate) => gate.role)).toEqual(['editor', 'consultant']);
      expect(gates(draftTrace.step).every((gate) => gate.verdict === 'HOLDS')).toBe(true);
      expect(gates(draftTrace.step).every((gate) => gate.model === PIPELINE_MODEL)).toBe(true);
      // BOOK-62: the writer's model is on the step itself, so the trace answers «which model
      // wrote this chapter» without grepping.
      expect(draftTrace.step.step.model).toBe(PIPELINE_MODEL);

      // 2. draft ch02, so the change has somewhere to ripple to.
      const second = runStubStep(fixture, {
        title: 'Вторая глава',
        blocks: ['Ещё один служебный абзац для проверки.', 'Тестовый абзац номер два. Это служебный текст, он не является текстом книги.'],
      });
      expect(second?.assignment.chapter).toBe(2);

      // 3. a reader's accepted comment becomes a change in the FIFO lane.
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 1,
        intent: 'убрать второе упоминание абзаца, оставить одно',
      });
      expect(change.status).toBe('pending');

      // 4. the origin step writes ch01 and reports the 1|2 seam.
      const origin = runStubStep(fixture, {
        title: 'Тестовая глава',
        blocks: ['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.'],
        seams: [{ boundary: 2, reason: 'соседняя глава начинается с того же абзаца' }],
      });
      expect(origin?.assignment.pass).toBe('change');
      expect(origin?.assignment.chapter).toBe(1);
      expect(origin?.result.outcome).toBe('rewritten');
      expect(origin?.result.cascadeId).toBeTruthy();

      // 5. the ripple goes upward to ch02 (the downward side reached chapter 1 at once).
      const repair = runStubStep(fixture, {
        title: 'Вторая глава',
        blocks: ['Ещё один служебный абзац для проверки.', 'Тестовый абзац номер два. Это служебный текст, он не является текстом книги.', 'Добавленный абзац номер два.'],
        seams: [],
      });
      expect(repair?.assignment.pass).toBe('cascade');
      expect(repair?.assignment.chapter).toBe(2);
      expect(repair?.assignment.seamsIn[0]?.boundary).toBe(2);
      expect(repair?.result.outcome).toBe('rewritten');

      // 6. the ripple reached the first sheet: one front step rewrites title and annotation.
      const front = runStubStep(fixture, {
        title: 'Другое название',
        blocks: [
          'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.',
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
      expect(trace.change.change.model).toBe(PIPELINE_MODEL);
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
        // BOOK-137: ch01 opens on the canon frame, and the ripple keeps it below.
        1: chapterText('Начало', [`${FRAME_FIRST_SENTENCE} Тестовый абзац.`]),
        2: chapterText('Вторая', ['Служебная строка.']),
      },
    });
    try {
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 2, intent: 'уточнить абзац' });
      runStubStep(fixture, {
        title: 'Вторая',
        blocks: ['Ещё один служебный абзац для проверки.'],
        seams: [{ boundary: 3, reason: 'следующая глава продолжает абзац' }],
      });
      const down = runStubStep(
        fixture,
        { title: 'Начало', blocks: ['Тестовый абзац.'], seams: [] },
        'bwd',
      );
      expect(down?.result.outcome).toBe('holds');
      const front = runStubStep(fixture, {
        title: 'Без названия',
        blocks: [
          'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.',
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

  it('admits an ordinary change on a written ch67 (BOOK-137)', () => {
    const fixture = createEngineFixture({
      chapters: { 66: chapterText('Пролог', ['Служебная строка.']), 67: chapterText('Финал', ['Свет погас.']) },
    });
    try {
      // The ending is prose like any other chapter: the frame is guarded at the landing, not by
      // refusing a reader's change merely because its chapter number is 67.
      const reader = fixture.engine.enqueue({ kind: 'reader_edit', chapter: 67, intent: 'пусть кто-то спасётся' });
      expect(reader.status).toBe('pending');
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
      chapters: { 1: chapterText('Начало', ['Тестовый абзац.', 'Это служебный текст.']) },
    });
    try {
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 1,
        intent: 'абзац должен измениться не в четверг, а в среду',
      });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      expect(assignment.pass).toBe('change');
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapterBlocks(1, 'Начало', ['Изменённый абзац.', 'Это служебный текст.']);
      const landed = fixture.engine.land(assignment.leaseId);
      expect(landed.revAfter).toBe(1);

      const editor = fixture.engine.next({ role: 'editor', session: 'editor-1' }) as GateAssignment;
      fixture.engine.verdict(editor.stepId, {
        role: 'editor',
        session: 'editor-1',
        verdict: 'HOLDS',
        findings: [],
        model: PIPELINE_MODEL,
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
        model: PIPELINE_MODEL,
        tokensIn: 90,
        tokensOut: 8,
      });
      const done = second.done(assignment.leaseId, { seams: [], note: 'resumed after a crash', model: PIPELINE_MODEL });
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
      chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) },
    });
    try {
      // A session writes and dies before `land`; the lease expires.
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда вместо четверга' });
      const a = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      fixture.engine.start(a.leaseId);
      fixture.writeChapterBlocks(1, 'Начало', ['Изменённый абзац.']);
      fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
      const report = fixture.engine.reap();
      expect(report.recovered).toEqual([a.stepId]);

      const after = fixture.engine.next({ for: 'fwd', session: 'writer-2' }) as WriterAssignment;
      expect(after.stepId).toBe(a.stepId);
      expect(after.landed).toBe(true);

      // A second change whose session dies *before* writing: the job is re-issued, not lost.
      const editor = fixture.engine.next({ role: 'editor', session: 'editor-1' }) as GateAssignment;
      fixture.engine.verdict(editor.stepId, {
        role: 'editor', session: 'editor-1', verdict: 'HOLDS', findings: [], model: PIPELINE_MODEL, tokensIn: 1, tokensOut: 1,
      });
      const consultant = fixture.engine.next({ role: 'consultant', session: 'consultant-1' }) as GateAssignment;
      fixture.engine.verdict(consultant.stepId, {
        role: 'consultant', session: 'consultant-1', verdict: 'HOLDS', findings: [], model: PIPELINE_MODEL, tokensIn: 1, tokensOut: 1,
      });
      const done = fixture.engine.done(after.leaseId, { seams: [], note: 'recovered', model: PIPELINE_MODEL });
      expect(done.outcome).toBe('rewritten');
      expect((fixture.db.prepare('SELECT status FROM changes WHERE id = ?').get(change.id) as { status: string }).status).toBe('done');
    } finally {
      fixture.close();
    }
  });
});
