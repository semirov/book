import { FRAME_FIRST_SENTENCE } from '@book/shared';
import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { openDispatch, normalizeFindings } from '../../src/engine/gates.ts';
import { acquireLease, releaseLease } from '../../src/engine/leases.ts';
import * as store from '../../src/engine/store.ts';
import type { StepRow } from '../../src/engine/store.ts';
import { sha256Hex } from '../../src/util/hash.ts';
import { PIPELINE_MODEL, chapterText, createEngineFixture, DEFAULT_ABOUT } from './helpers.ts';

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
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
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
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
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

describe('the reaper gives up only after the ladder (§6A.11, BOOK-DOC-84 §10.8)', () => {
  it('escalates a change whose session never lands anything', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
    try {
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
      expect(assignment.pass).toBe('change');
      // BOOK-44: the reader's goal sentence reaches the writer marked, not as bare prose.
      expect(assignment.intent).toEqual({ value: 'среда', untrusted: true });
      // Five ordinary attempts, then the desperate sixth, then the close: six leases.
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        if (attempt > 1) fixture.engine.next({ for: 'fwd', session: `fwd-${attempt}` });
        fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
        fixture.engine.reap();
        const step = fixture.db.prepare('SELECT desperate FROM steps WHERE step_id = ?').get(assignment.stepId) as {
          desperate: number;
        };
        if (attempt === 5) expect(step.desperate).toBe(1);
      }
      const row = fixture.db.prepare('SELECT status, outcome, attempts, reason FROM changes WHERE id = ?').get(change.id) as {
        status: string;
        outcome: string;
        attempts: number;
        reason: string;
      };
      expect(row.status).toBe('escalated');
      expect(row.outcome).toBe('gate_timeout');
      expect(row.attempts).toBe(6);
      expect(row.reason).toMatch(/^не дошло: /u);
      expect(fixture.alerts.map((alert) => alert.kind)).toContain('gate_timeout');
      expect(fixture.db.prepare('SELECT holder FROM lane WHERE id = 1').get()).toEqual({ holder: null });
    } finally {
      fixture.close();
    }
  });
});

describe('gate dispatch bookkeeping (§6B.3)', () => {
  it('refuses a dispatch before landing, after closing, and to a second session', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
    try {
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      const step = store.getStep(fixture.db, assignment.stepId);
      if (!step) throw new Error('step missing');
      expect(() => openDispatch(fixture.deps, step, 'editor', 'editor-1')).toThrow(/no landed text/u);

      fixture.writeChapterBlocks(1, 'Начало', ['Изменённый абзац.']);
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
        model: PIPELINE_MODEL,
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
    ).toEqual([{ severity: 'major', location: '', defect: expect.stringMatching(/…$/u), fix: '', mode: null }]);
    expect(normalizeFindings([{ severity: 'blocker', defect: 'bad' }])[0]?.severity).toBe('blocker');
  });

  it('keeps only one of the three retroactive modes, and drops any other word', () => {
    const [mode] = normalizeFindings([{ defect: 'причина появилась позже', mode: 'оформление' }]);
    expect(mode?.mode).toBe('оформление');
    const [amended] = normalizeFindings([{ defect: 'пункт 4', mode: 'поправка' }]);
    expect(amended?.mode).toBe('поправка');
    const [diverged] = normalizeFindings([{ defect: 'сцена не подчиняется', mode: 'расхождение' }]);
    expect(diverged?.mode).toBe('расхождение');
    for (const hostile of ['исправление', 'retcon', '', 42, null, { mode: 'оформление' }, ['оформление']]) {
      expect(normalizeFindings([{ defect: 'x', mode: hostile }])[0]?.mode).toBeNull();
    }
  });
});

describe('land — shapes the engine refuses to bless (§6A.11)', () => {
  it('records an unchanged file as a hold, not a revision', () => {
    // BOOK-137: a landing on ch01 keeps the canon frame, so the fixture's chapter opens on it.
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', [`${FRAME_FIRST_SENTENCE} Тестовый абзац.`]) },
    });
    try {
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      const landed = fixture.engine.land(assignment.leaseId);
      expect(landed.changed).toBe(false);
      // A hold keeps the revision the seeded chapter already had.
      expect(landed.revAfter).toBe(1);
      fixture.engine.next({ role: 'editor', session: 'editor-1' });
      fixture.engine.verdict(assignment.stepId, {
        role: 'editor', session: 'editor-1', verdict: 'HOLDS', findings: [], model: PIPELINE_MODEL, tokensIn: 1, tokensOut: 1,
      });
      fixture.engine.next({ role: 'consultant', session: 'consultant-1' });
      fixture.engine.verdict(assignment.stepId, {
        role: 'consultant', session: 'consultant-1', verdict: 'HOLDS', findings: [], model: PIPELINE_MODEL, tokensIn: 1, tokensOut: 1,
      });
      expect(fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL }).outcome).toBe('holds');
    } finally {
      fixture.close();
    }
  });

  it('refuses an empty write and an over-long chapter', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
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
      // The annotation is the published basis, so only the title can fail here.
      fixture.writeFront('З'.repeat(81), DEFAULT_ABOUT);
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
      // The seeded first sheet is revision 1; the wave publishes 2.
      expect(landed.revAfter).toBe(2);
    } finally {
      fixture.close();
    }
  });
});

describe('land — the length floor is a limit, not a hint (BOOK-24, F007)', () => {
  /**
   * A chapter file of exactly `chars` characters of prose. ch01 opens on the canon frame
   * (BOOK-137), so the filler follows it and the sentence is left untouched by the test.
   */
  const page = (chars: number): string =>
    `Начало\n\n${FRAME_FIRST_SENTENCE} ${'а'.repeat(chars - FRAME_FIRST_SENTENCE.length - 1)}\n`;

  /** A draft lease on chapter 1, started, with nothing landed yet. */
  function draft(fixture: ReturnType<typeof createEngineFixture>): string {
    const step = addStep(fixture, { id: 'stp_floor', chapter: 1, pass: 'draft' });
    const lease = acquireLease(fixture.deps, { step, session: 'w1', expectedRev: 0, changeId: null });
    fixture.engine.start(lease.id);
    return lease.id;
  }

  it('refuses a written chapter of 1 599 characters and names the rule and the count', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      const lease = draft(fixture);
      fixture.writeChapter(1, page(1_599));
      expect(() => fixture.engine.land(lease)).toThrowError(/1599 characters; the minimum is 1600 \(F007\)/u);
      // Nothing was published: no revision, no landed sha, and the file is still the file.
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = 1').get()).toEqual({ n: 0 });
      const step = store.getStep(fixture.db, 'stp_floor');
      expect(step?.landed_at).toBeNull();
      // A refused landing publishes nothing: the slot still has no text.
      expect(fixture.readChapter(1)).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('accepts exactly 1 600 characters', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      const lease = draft(fixture);
      fixture.writeChapter(1, page(1_600));
      const landed = fixture.engine.land(lease);
      expect(landed.changed).toBe(true);
      expect(landed.revAfter).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('exempts a slot holding only the frozen frame: the refusal is emptiness, not length', () => {
    const fixture = createEngineFixture({ chapters: { 1: FRAME_FIRST_SENTENCE }, front: null });
    try {
      const lease = draft(fixture);
      // The frame is not prose (§BOOK-6), so a basis-only slot is never a short chapter.
      fixture.writeChapter(1, FRAME_FIRST_SENTENCE);
      const refusal = ((): string => {
        try {
          fixture.engine.land(lease);
        } catch (error) {
          return (error as Error).message;
        }
        return '';
      })();
      expect(refusal).toMatch(/not written|holds no paragraphs/u);
      // The refusal is about the absence of prose, never about the frozen frame being short.
      expect(refusal).not.toMatch(/minimum is 1600/u);
    } finally {
      fixture.close();
    }
  });

  it('cannot shrink a written chapter below the floor on a re-land', () => {
    const fixture = createEngineFixture({ front: null });
    try {
      const lease = draft(fixture);
      fixture.writeChapter(1, page(1_700));
      expect(fixture.engine.land(lease).changed).toBe(true);

      // The writer answers a gate by cutting the page down to a slot: refused, not published.
      fixture.writeChapter(1, page(1_599));
      expect(() => fixture.engine.land(lease)).toThrowError(/minimum is 1600 \(F007\)/u);

      const revisions = fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = 1').get();
      expect(revisions).toEqual({ n: 1 });
      const step = store.getStep(fixture.db, 'stp_floor');
      expect(step?.landed_sha).toBe(sha256Hex(page(1_700)));
      // What is published is still the page: the engine never edits the file, so the refused
      // 1 599-character draft stays the writer's own business, not a revision.
      const published = fixture.db.prepare('SELECT sha256 FROM chapters WHERE n = 1').get();
      expect(published).toEqual({ sha256: sha256Hex(page(1_700)) });
      // The rows still serve the published page: the refused draft never became text.
      expect(fixture.readChapter(1)).toBe(page(1_700));
    } finally {
      fixture.close();
    }
  });
});

describe('a malformed report is refused, never read as silence', () => {
  it('refuses a seam with an unknown boundary and a drop of a fresh change', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
    try {
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapterBlocks(1, 'Начало', ['Изменённый абзац.']);
      fixture.engine.land(assignment.leaseId);
      expect(() =>
        fixture.engine.done(assignment.leaseId, { seams: [{ boundary: 999, reason: 'x' }], model: PIPELINE_MODEL }),
      ).toThrow(
        /unknown seam boundary/u,
      );
      expect(() => fixture.engine.done(assignment.leaseId, { seams: 'nope', model: PIPELINE_MODEL })).toThrow(
        /must be an array/u,
      );
    } finally {
      fixture.close();
    }
  });

  it('a fresh change cannot be dropped without a citation of what made it unnecessary', () => {
    const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
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
      const fixture = createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) } });
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
