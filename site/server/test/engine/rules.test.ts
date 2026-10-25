import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { openDispatch, normalizeFindings } from '../../src/engine/gates.ts';
import { acquireLease, releaseLease } from '../../src/engine/leases.ts';
import * as store from '../../src/engine/store.ts';
import type { StepRow } from '../../src/engine/store.ts';
import { chapterText, createEngineFixture, DEFAULT_ABOUT } from './helpers.ts';

function addStep(
  fixture: ReturnType<typeof createEngineFixture>,
  options: { id: string; chapter: number; pass?: string; lane?: 'forward' | null; chapterForBoundary?: number },
): StepRow {
  store.insertStep(fixture.db, {
    stepId: options.id,
    cascadeId: null,
    seq: 0,
    wave: 0,
    lane: options.lane ?? null,
    pass: options.pass ?? 'change',
    chapter: options.chapter,
    boundary: options.chapter === 1 ? 'front' : '2',
    seamsIn: '[]',
    revBefore: 0,
    at: new Date(fixture.clock.now()).toISOString(),
  });
  const step = store.getStep(fixture.db, options.id);
  if (!step) throw new Error('step insert failed');
  return step;
}

describe('leases — the write lock (§6A.11)', () => {
  it('refuses a second live lease on the same chapter', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Половик намок.']) } });
    try {
      const a = addStep(fixture, { id: 'stp_a', chapter: 1 });
      const b = addStep(fixture, { id: 'stp_b', chapter: 1 });
      acquireLease(fixture.deps, { step: a, session: 'w1', expectedRev: 0, changeId: null });
      expect(() => acquireLease(fixture.deps, { step: b, session: 'w2', expectedRev: 0, changeId: null })).toThrow(
        /already has a live lease/u,
      );
    } finally {
      fixture.close();
    }
  });

  it('applies the step and process ceilings (ADR-030)', () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('A', ['a']), 2: chapterText('B', ['b']), 3: chapterText('C', ['c']) },
      env: { ENGINE_MAX_CONCURRENT_STEPS: '2', ENGINE_MAX_CONCURRENT_PROCESSES: '2' },
    });
    try {
      acquireLease(fixture.deps, {
        step: addStep(fixture, { id: 'stp_1', chapter: 1 }),
        session: 'w1',
        expectedRev: 0,
        changeId: null,
      });
      acquireLease(fixture.deps, {
        step: addStep(fixture, { id: 'stp_2', chapter: 2 }),
        session: 'w2',
        expectedRev: 0,
        changeId: null,
      });
      // A third ripple step crosses MAX_CONCURRENT_STEPS (2) *and* the process bound (2).
      expect(() =>
        acquireLease(fixture.deps, {
          step: addStep(fixture, { id: 'stp_3', chapter: 3 }),
          session: 'w3',
          expectedRev: 0,
          changeId: null,
        }),
      ).toThrow(/at most 2 ripple steps/u);
    } finally {
      fixture.close();
    }
  });

  it('dies on expiry and cannot be beaten after release', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Половик намок.']) } });
    try {
      const step = addStep(fixture, { id: 'stp_exp', chapter: 1 });
      const lease = acquireLease(fixture.deps, { step, session: 'w1', expectedRev: 0, changeId: null });
      fixture.clock.advance(fixture.config.leaseTtlMs + 1);
      expect(() => fixture.engine.beat(lease.id)).toThrow(/expired/u);
      fixture.engine.reap();

      const fresh = acquireLease(fixture.deps, { step, session: 'w2', expectedRev: 0, changeId: null });
      releaseLease(fixture.db, fresh.id, 'done', fixture.clock.now());
      expect(() => fixture.engine.beat(fresh.id)).toThrow(/released/u);
      expect(() => fixture.engine.beat('lea_missing')).toThrow(/no lease/u);
    } finally {
      fixture.close();
    }
  });
});

describe('the reaper gives up only after three attempts (§6A.11)', () => {
  it('escalates a change whose session never lands anything', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Половик намок.']) } });
    try {
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
      expect(assignment.pass).toBe('change');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) fixture.engine.next({ for: 'fwd', session: `fwd-${attempt}` });
        fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
        fixture.engine.reap();
      }
      const row = fixture.db.prepare('SELECT status, outcome, attempts, reason FROM changes WHERE id = ?').get(change.id) as {
        status: string;
        outcome: string;
        attempts: number;
        reason: string;
      };
      expect(row.status).toBe('escalated');
      expect(row.outcome).toBe('gate_timeout');
      expect(row.attempts).toBe(3);
      expect(row.reason).toContain('вовремя');
      expect(fixture.alerts.map((alert) => alert.kind)).toContain('gate_timeout');
      expect(fixture.db.prepare('SELECT holder FROM lane WHERE id = 1').get()).toEqual({ holder: null });
    } finally {
      fixture.close();
    }
  });
});

describe('gate dispatch bookkeeping (§6B.3)', () => {
  it('refuses a dispatch before landing, after closing, and to a second session', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Половик намок.']) } });
    try {
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      const step = store.getStep(fixture.db, assignment.stepId);
      if (!step) throw new Error('step missing');
      expect(() => openDispatch(fixture.deps, step, 'editor', 'editor-1')).toThrow(/no landed text/u);

      fixture.writeChapterBlocks(1, 'Начало', ['Половик намок в среду.']);
      fixture.engine.land(assignment.leaseId);
      const landed = store.getStep(fixture.db, assignment.stepId);
      if (!landed) throw new Error('step missing');
      openDispatch(fixture.deps, landed, 'editor', 'editor-1');
      expect(() => openDispatch(fixture.deps, landed, 'editor', 'editor-2')).toThrow(/another editor session/u);
      expect(() => openDispatch(fixture.deps, landed, 'consultant', 'consultant-1')).toThrow(/before the science/u);

      const editor = fixture.engine.next({ role: 'editor', session: 'editor-1' });
      expect(editor).not.toBeNull();
      fixture.engine.verdict(assignment.stepId, {
        role: 'editor',
        session: 'editor-1',
        verdict: 'HOLDS',
        findings: [],
        model: 'stub',
        tokensIn: 1,
        tokensOut: 1,
      });
      expect(() => openDispatch(fixture.deps, landed, 'editor', 'editor-1')).toThrow(/already answered/u);
    } finally {
      fixture.close();
    }
  });

  it('normalises hostile findings instead of trusting their shape', () => {
    expect(normalizeFindings('not-an-array')).toEqual([]);
    expect(normalizeFindings([null, 42, { severity: 'blocker' }])).toEqual([]);
    expect(
      normalizeFindings([{ severity: 'urgent', defect: 'x'.repeat(2_000), location: 7, fix: null }]),
    ).toEqual([{ severity: 'major', location: '', defect: expect.stringMatching(/…$/u), fix: '' }]);
    expect(normalizeFindings([{ severity: 'blocker', defect: 'bad' }])[0]?.severity).toBe('blocker');
  });
});

describe('land — shapes the engine refuses to bless (§6A.11)', () => {
  it('records an unchanged file as a hold, not a revision', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Половик намок.']) } });
    try {
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      const landed = fixture.engine.land(assignment.leaseId);
      expect(landed.changed).toBe(false);
      expect(landed.revAfter).toBe(0);
      fixture.engine.next({ role: 'editor', session: 'editor-1' });
      fixture.engine.verdict(assignment.stepId, {
        role: 'editor', session: 'editor-1', verdict: 'HOLDS', findings: [], model: 'stub', tokensIn: 1, tokensOut: 1,
      });
      fixture.engine.next({ role: 'consultant', session: 'consultant-1' });
      fixture.engine.verdict(assignment.stepId, {
        role: 'consultant', session: 'consultant-1', verdict: 'HOLDS', findings: [], model: 'stub', tokensIn: 1, tokensOut: 1,
      });
      expect(fixture.engine.done(assignment.leaseId, { seams: [] }).outcome).toBe('holds');
    } finally {
      fixture.close();
    }
  });

  it('refuses an empty write and an over-long chapter', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Половик намок.']) } });
    try {
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapter(1, 'Начало\n\n');
      expect(() => fixture.engine.land(assignment.leaseId)).toThrow(/no paragraphs/u);

      fixture.writeChapter(1, `Начало\n\n${'а'.repeat(30_001)}\n`);
      expect(() => fixture.engine.land(assignment.leaseId)).toThrow(/maximum is 30000/u);
    } finally {
      fixture.close();
    }
  });

  it('refuses a malformed first sheet (F021 at the lease, not at the reader)', () => {
    const fixture = createEngineFixture();
    try {
      const step = addStep(fixture, { id: 'stp_front', chapter: 1, pass: 'front' });
      store.updateStep(fixture.db, step.step_id, { chapter: null, boundary: 'front' });
      const front = store.getStep(fixture.db, step.step_id);
      if (!front) throw new Error('step missing');
      const lease = acquireLease(fixture.deps, { step: front, session: 'w1', expectedRev: 0, changeId: null });
      fixture.engine.start(lease.id);
      fixture.writeFront('Заголовок', 'Коротко.');
      expect(() => fixture.engine.land(lease.id)).toThrow(/title ≤80 chars/u);
    } finally {
      fixture.close();
    }
  });

  it('a valid first-sheet rewrite lands and closes as a rewrite', () => {
    const fixture = createEngineFixture({ front: { title: 'Старое', about: DEFAULT_ABOUT } });
    try {
      const step = addStep(fixture, { id: 'stp_front_ok', chapter: 1, pass: 'front' });
      store.updateStep(fixture.db, step.step_id, { chapter: null, boundary: 'front' });
      const front = store.getStep(fixture.db, step.step_id);
      if (!front) throw new Error('step missing');
      const lease = acquireLease(fixture.deps, { step: front, session: 'w1', expectedRev: 0, changeId: null });
      fixture.engine.start(lease.id);
      fixture.writeFront('Новое название', DEFAULT_ABOUT);
      const landed = fixture.engine.land(lease.id);
      expect(landed.changed).toBe(true);
      expect(landed.revAfter).toBe(1);
    } finally {
      fixture.close();
    }
  });
});

describe('a malformed report is refused, never read as silence', () => {
  it('refuses a seam with an unknown boundary and a drop of a fresh change', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Половик намок.']) } });
    try {
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapterBlocks(1, 'Начало', ['Половик намок в среду.']);
      fixture.engine.land(assignment.leaseId);
      expect(() => fixture.engine.done(assignment.leaseId, { seams: [{ boundary: 999, reason: 'x' }] })).toThrow(
        /unknown seam boundary/u,
      );
      expect(() => fixture.engine.done(assignment.leaseId, { seams: 'nope' })).toThrow(/must be an array/u);
    } finally {
      fixture.close();
    }
  });

  it('a fresh change cannot be dropped without a citation of what made it unnecessary', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Половик намок.']) } });
    try {
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
      expect(() =>
        fixture.engine.start(assignment.leaseId, { decision: 'drop', reason: 'передумали' }),
      ).toThrow(/cannot be dropped/u);
    } finally {
      fixture.close();
    }
  });
});

describe('escalate — the reason selects the outcome (§6A.6)', () => {
  const cases: Array<[string, string]> = [
    ['не хватило budget', 'budget'],
    ['oscillation detected', 'oscillation'],
    ['delta too large', 'delta'],
    ['ending is soft', 'ending'],
    ['gate timeout', 'gate_timeout'],
    ['something else', 'origin'],
  ];

  for (const [because, outcome] of cases) {
    it(`maps «${because}» to ${outcome}`, () => {
      const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Половик намок.']) } });
      try {
        const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда' });
        const assignment = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
        fixture.engine.escalate(assignment.leaseId, because);
        const row = fixture.db.prepare('SELECT status, outcome, reason FROM changes WHERE id = ?').get(change.id) as {
          status: string;
          outcome: string;
          reason: string;
        };
        expect(row.status).toBe('escalated');
        expect(row.outcome).toBe(outcome);
        expect(row.reason).toContain(because);
        expect(fixture.db.prepare('SELECT holder FROM lane WHERE id = 1').get()).toEqual({ holder: null });
      } finally {
        fixture.close();
      }
    });
  }
});
