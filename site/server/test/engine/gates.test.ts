import type { Finding, WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { acquireLease } from '../../src/engine/leases.ts';
import * as store from '../../src/engine/store.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import { PIPELINE_MODEL, chapterText, createEngineFixture, runStubStep } from './helpers.ts';

const blocker = (defect = 'the chapter contradicts its neighbour'): Finding[] => [
  { severity: 'blocker', location: 'глава 1, абзац 1', defect, fix: 'name the cause earlier' },
];

function draftOnce(fixture: ReturnType<typeof createEngineFixture>): WriterAssignment {
  const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(1, 'Начало', ['Тестовый абзац.', 'Это служебный текст.']);
  fixture.engine.land(assignment.leaseId);
  return assignment;
}

function answer(
  fixture: ReturnType<typeof createEngineFixture>,
  role: 'editor' | 'consultant',
  verdict: 'HOLDS' | 'GAP',
  findings: Finding[] = [],
  session = `${role}-1`,
) {
  const gate = fixture.engine.next({ role, session }) as GateAssignment;
  return fixture.engine.verdict(gate.stepId, {
    role,
    session: gate.session,
    verdict,
    findings,
    model: PIPELINE_MODEL,
    tokensIn: 100,
    tokensOut: 10,
  });
}

describe('the required-verdict rule (§6B.4)', () => {
  it('refuses to close a step with one verdict or none, and names what is missing', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftOnce(fixture);
      expect(() => fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL })).toThrow(
        /cannot close without both verdicts; missing: editor, consultant/u,
      );
      answer(fixture, 'editor', 'HOLDS');
      expect(() => fixture.engine.seen(assignment.leaseId, 'read', { model: PIPELINE_MODEL })).toThrow(
        /missing: consultant/u,
      );

      answer(fixture, 'consultant', 'HOLDS');
      const done = fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL });
      expect(done.outcome).toBe('rewritten');
    } finally {
      fixture.close();
    }
  });

  it('refuses a verdict for a file that has not landed', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      // The writer has not landed anything yet: no gate may be dispatched.
      expect(fixture.engine.next({ role: 'editor', session: 'editor-1' })).toBeNull();
      expect(() =>
        fixture.engine.verdict(assignment.stepId, {
          role: 'editor',
          session: 'editor-1',
          verdict: 'HOLDS',
          findings: [],
          model: PIPELINE_MODEL,
          tokensIn: 1,
          tokensOut: 1,
        }),
      ).toThrow(/NOT_DISPATCHED|no editor was dispatched/u);
      expect(() => fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL })).toThrow(/land first/u);
    } finally {
      fixture.close();
    }
  });

  it('enforces the fixed gate order and the dispatched session', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftOnce(fixture);
      // A consultant poll gets nothing until the editor has answered…
      expect(fixture.engine.next({ role: 'consultant', session: 'consultant-1' })).toBeNull();
      // …and a consultant verdict offered anyway is refused in order, 422.
      expect(() =>
        fixture.engine.verdict(assignment.stepId, {
          role: 'consultant',
          session: 'consultant-1',
          verdict: 'HOLDS',
          findings: [],
          model: PIPELINE_MODEL,
          tokensIn: 1,
          tokensOut: 1,
        }),
      ).toThrow(/before the editor/u);
      expect(() =>
        fixture.engine.verdict(assignment.stepId, {
          role: 'editor',
          session: 'someone-else',
          verdict: 'HOLDS',
          findings: [],
          model: PIPELINE_MODEL,
          tokensIn: 1,
          tokensOut: 1,
        }),
      ).toThrow(/dispatched/u);
    } finally {
      fixture.close();
    }
  });

  it('downgrades a GAP without a blocker to HOLDS (a matter of taste cannot stall a step)', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftOnce(fixture);
      const editor = answer(fixture, 'editor', 'GAP', [
        { severity: 'major', location: 'глава 1', defect: 'would read better shorter', fix: 'cut' },
      ]);
      expect(editor).toMatchObject({ action: 'close', verdict: 'HOLDS', downgraded: true });
      const row = fixture.db
        .prepare(`SELECT verdict FROM gate_verdicts WHERE step_id = ? AND role = 'editor'`)
        .get(assignment.stepId) as { verdict: string };
      expect(row.verdict).toBe('HOLDS');
    } finally {
      fixture.close();
    }
  });
});

describe('the cycle cap (§6B.4 rules 2–3)', () => {
  it('sends the writer back on a blocker, re-asks after a revision, and publishes after the cap', () => {
    const fixture = createEngineFixture({
      chapters: {
        5: chapterText('Перед', ['Служебная строка.']),
        6: chapterText('Середина', ['Тестовый абзац.']),
        7: chapterText('После', ['Тестовый абзац номер два. Это служебный текст, он не является текстом книги.']),
      },
    });
    try {
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 6, intent: 'убрать абзац' });
      const origin = runStubStep(fixture, {
        title: 'Середина',
        blocks: ['Тестовый абзац.'],
        seams: [{ boundary: 7, reason: 'соседняя глава продолжает сцену' }],
      });
      expect(origin?.result.cascadeId).toBeTruthy();

      // The downward wing first: chapter 5 holds.
      const down = runStubStep(fixture, { title: 'Перед', blocks: ['Служебная строка.'], seams: [] }, 'bwd');
      expect(down?.assignment.chapter).toBe(5);

      // Three revisions are allowed; the fourth blocker publishes with its finding and
      // escalates the ripple (the text is never hidden — §6B.4 rule 3).
      const repair = runStubStep(fixture, {
        title: 'После',
        blocks: ['Тестовый абзац номер два. Это служебный текст, он не является текстом книги.'],
        seams: [],
        editor: { verdict: 'GAP', findings: blocker('the neighbour still mentions the rug') },
      });
      expect(repair?.assignment.chapter).toBe(7);
      expect(repair?.revisions).toBe(3);
      expect(repair?.result.outcome).toBe('published_with_finding');

      const trace = fixture.engine.trace(change.id);
      if (trace?.kind !== 'change') throw new Error('expected a change trace');
      const repairStep = trace.change.cascade?.steps.find(
        (step) => step.step.pass === 'cascade' && step.step.chapter === 7,
      );
      expect(repairStep?.step.outcome).toBe('published_with_finding');
      expect(repairStep?.step.cycle).toBe(3);
      expect(repairStep?.gates.find((gate) => gate.role === 'editor')?.verdict).toBe('GAP');
      expect(trace.change.cascade?.outcome).toBe('escalated:finding');
      expect(trace.change.change.status).toBe('escalated');
      expect(trace.change.change.outcome).toBe('finding');
      expect(fixture.alerts.map((alert) => alert.kind)).toContain('finding');
    } finally {
      fixture.close();
    }
  });

  it('keeps the editor cap publishing with its finding — the mirror of the science stop', () => {
    // BOOK-76: the split is deliberate. A prose judgement that survived the cap publishes
    // (today's case above); a physics claim that does not hold stops the step instead.
    const fixture = createEngineFixture();
    try {
      const assignment = draftOnce(fixture);
      const actions: string[] = [];
      for (let cycle = 0; cycle <= fixture.config.gateCycles; cycle += 1) {
        const editor = answer(fixture, 'editor', 'GAP', blocker('the corridor contradicts its neighbour'));
        actions.push(editor.action);
        if (editor.action !== 'revise') break;
        // The writer revises and the verdicts are re-asked on the new text.
        fixture.writeChapterBlocks(1, 'Начало', ['Тестовый абзац.', `Правка ${cycle + 1}.`]);
        fixture.engine.land(assignment.leaseId);
      }
      expect(actions).toEqual(['revise', 'revise', 'revise', 'publish_with_finding']);
    } finally {
      fixture.close();
    }
  });

  it('stops the step on a consultant blocker at the cap instead of publishing it', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftOnce(fixture);
      const actions: string[] = [];
      for (let cycle = 0; cycle <= fixture.config.gateCycles; cycle += 1) {
        answer(fixture, 'editor', 'HOLDS');
        const consultant = answer(fixture, 'consultant', 'GAP', blocker('no carrier for the signal'));
        actions.push(consultant.action);
        if (consultant.action !== 'revise') break;
        fixture.writeChapterBlocks(1, 'Начало', ['Тестовый абзац.', `Правка ${cycle + 1}.`]);
        fixture.engine.land(assignment.leaseId);
      }
      expect(actions).toEqual(['revise', 'revise', 'revise', 'close']);
    } finally {
      fixture.close();
    }
  });

  it('drops the verdict that described the previous revision', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapterBlocks(1, 'Начало', ['Первый вариант.']);
      fixture.engine.land(assignment.leaseId);
      const editor = answer(fixture, 'editor', 'GAP', blocker());
      expect(editor.action).toBe('revise');
      expect(store.getVerdict(fixture.db, assignment.stepId, 'editor')).toBeDefined();

      // The writer revises: the old editor verdict must not survive the new text.
      fixture.writeChapterBlocks(1, 'Начало', ['Первый вариант. Правка 1.']);
      fixture.engine.land(assignment.leaseId);
      expect(store.getVerdict(fixture.db, assignment.stepId, 'editor')).toBeUndefined();
      const resumed = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      expect(resumed.cycle).toBe(1);
      expect(resumed.findings?.length).toBeGreaterThan(0);
    } finally {
      fixture.close();
    }
  });

  it('escalates a gate that never answers (GATE_TTL_MS)', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftOnce(fixture);
      fixture.engine.next({ role: 'editor', session: 'editor-1' });
      fixture.clock.advance(fixture.config.gateTtlMs + 1_000);
      const report = fixture.engine.reap();
      expect(report.gateTimeouts).toEqual([assignment.stepId]);
      const trace = fixture.engine.trace(assignment.stepId);
      if (trace?.kind !== 'step') throw new Error('expected a step trace');
      expect(trace.step.step.outcome).toBe('escalated');
      expect(trace.step.gates).toHaveLength(0);
      // The lease is gone with the step: a gate that wakes up later cannot answer it.
      expect(() => fixture.engine.beat(assignment.leaseId)).toThrow(/released/u);
    } finally {
      fixture.close();
    }
  });
});

describe('the ending is evaluated, never rewritten (ADR-024, §6C.4)', () => {
  function endingFixture() {
    return createEngineFixture({
      chapters: {
        65: chapterText('Перед финалом', ['Свет в коридоре щёлкнул и погас.']),
        66: chapterText('Ночь', ['Служебная строка.', 'Никто не спал.']),
        67: chapterText('Финал', ['Свет погас окончательно.']),
      },
    });
  }

  it('reaches chapter 67 as an evaluation step and records it', () => {
    const fixture = endingFixture();
    try {
      const change = fixture.engine.enqueue({ kind: 'operator', chapter: 66, intent: 'связать ночь с финалом' });
      const origin = runStubStep(fixture, {
        title: 'Ночь',
        blocks: ['Служебная строка.', 'Никто не спал.'],
        seams: [{ boundary: 67, reason: 'финал должен продолжать эту ночь' }],
      });
      expect(origin?.assignment.pass).toBe('change');

      const down = runStubStep(
        fixture,
        { title: 'Перед финалом', blocks: ['Свет в коридоре щёлкнул и погас.'], seams: [] },
        'bwd',
      );
      expect(down?.assignment.chapter).toBe(65);

      const ending = runStubStep(fixture, { seams: [] });
      expect(ending?.assignment.pass).toBe('ending');
      expect(ending?.assignment.chapter).toBe(67);
      expect(ending?.result.outcome).toBe('evaluated');
      expect(fixture.readChapter(67)).toContain('Свет погас окончательно.');

      const trace = fixture.engine.trace(change.id);
      if (trace?.kind !== 'change') throw new Error('expected a change trace');
      const endingStep = trace.change.cascade?.steps.find((step) => step.step.pass === 'ending');
      expect(endingStep?.gates.map((gate) => gate.role)).toEqual(['editor', 'consultant']);
    } finally {
      fixture.close();
    }
  });

  it('lets the backward lane draft the ending — the ending must be written', () => {
    const fixture = endingFixture();
    try {
      // ch67 already exists in this fixture, so the backward lane's next draft is 64.
      const assignment = fixture.engine.next({ for: 'bwd', session: 'writer-bwd' }) as WriterAssignment | null;
      expect(assignment?.pass).toBe('draft');
      expect(assignment?.chapter).toBe(64);
      const fresh = createEngineFixture();
      try {
        const first = fresh.engine.next({ for: 'bwd', session: 'writer-bwd' }) as WriterAssignment;
        expect(first.pass).toBe('draft');
        expect(first.chapter).toBe(67);
      } finally {
        fresh.close();
      }
    } finally {
      fixture.close();
    }
  });

  it('a GAP on the ending escalates instead of revising chapter 67', () => {
    const fixture = endingFixture();
    try {
      fixture.engine.enqueue({ kind: 'operator', chapter: 66, intent: 'связать ночь с финалом' });
      runStubStep(fixture, {
        title: 'Ночь',
        blocks: ['Служебная строка.', 'Никто не спал.'],
        seams: [{ boundary: 67, reason: 'финал должен продолжать эту ночь' }],
      });
      runStubStep(fixture, { title: 'Перед финалом', blocks: ['Свет в коридоре щёлкнул и погас.'], seams: [] }, 'bwd');
      const ending = fixture.engine.next({ for: 'bwd', session: 'writer-bwd' }) as WriterAssignment;
      expect(ending.pass).toBe('ending');
      fixture.engine.start(ending.leaseId);
      expect(() => fixture.engine.land(ending.leaseId)).toThrow(/evaluated, never rewritten/u);
      fixture.engine.land(ending.leaseId, { noWrite: true });
      const editor = answer(fixture, 'editor', 'GAP', blocker('the ending reads as a symbol, not as a death'));
      expect(editor.action).toBe('close');
      answer(fixture, 'consultant', 'HOLDS');
      const done = fixture.engine.done(ending.leaseId, { seams: [], note: 'финал проверен', model: PIPELINE_MODEL });
      expect(done.outcome).toBe('escalated');
      expect(fixture.alerts.some((alert) => alert.kind === 'ending')).toBe(true);
    } finally {
      fixture.close();
    }
  });
});

describe('C3 — a ripple may never lease chapter 67', () => {
  it('refuses a cascade lease on the ending', () => {
    const fixture = createEngineFixture({ chapters: { 67: chapterText('Финал', ['Свет погас.']) } });
    try {
      const stepId = 'stp_frozen';
      store.insertStep(fixture.db, {
        stepId,
        cascadeId: null,
        seq: 9,
        wave: 1,
        lane: 'forward',
        pass: 'cascade',
        chapter: 67,
        boundary: 'ending',
        seamsIn: '[]',
        revBefore: 1,
        at: new Date(fixture.clock.now()).toISOString(),
      });
      const step = store.getStep(fixture.db, stepId);
      if (!step) throw new Error('step was not inserted');
      expect(() =>
        acquireLease(fixture.deps, { step, session: 'fwd', expectedRev: 1, changeId: null }),
      ).toThrow(/never rewritten by a cascade/u);
    } finally {
      fixture.close();
    }
  });
});
