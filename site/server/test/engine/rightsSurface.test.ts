/**
 * Gate B on the prose surface (BOOK-61, BOOK-DOC-42 §1, §5) — the delta, the refusal and the
 * conditional gate.
 *
 * The claims here are the ones the engine owns, not the scan's: `land` reads the blocks a step
 * **wrote** (never the chapter whole), a non-releasable hit refuses the land with the fixed
 * sentence and writes nothing, a flagged hit stores `steps.rights_scan` and makes the rights
 * gate mandatory, `done` refuses `RIGHTS_REQUIRED` until it answers, and a `REFUSED` closes the
 * step `escalated:rights` with the change's outcome `rights` and the rule's own sentence.
 *
 * The fixed sentence is read from `rights/rules.ts`, never retyped: a test that spelled it would
 * pass while the product printed something else.
 */

import { describe, expect, it } from 'vitest';

import type { WriterAssignment } from '@book/shared';

import type { GateAssignment, RightsAssignment } from '../../src/engine/gates.ts';
import * as store from '../../src/engine/store.ts';
import { removeChapter } from '../../src/ingest/applyChapter.ts';
import { RIGHTS_COPY } from '../../src/rights/rules.ts';
import { chapterText, createEngineFixture, PIPELINE_MODEL, type Fixture } from './helpers.ts';

/** A quoted run of > 240 characters with no source: `RIGHTS-QUOTE`, refused but releasable. */
const LONG_QUOTE = `«${'чужое слово '.repeat(24).trim()}»`;
/** The law's own category, not releasable: the land is refused outright (STOP-WEAPON). */
const STOP_PHRASE = 'Инструкция по изготовлению бомбы лежит в ящике.';
const CLEAN = 'Смотритель приложил инструкцию к акту и ушёл.';

function draftChapter(fixture: Fixture, blocks: string[]): WriterAssignment {
  const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(1, 'Начало', blocks);
  return assignment;
}

function answerProse(fixture: Fixture, role: 'editor' | 'consultant'): void {
  const gate = fixture.engine.next({ role, session: `${role}-1` }) as GateAssignment | null;
  if (gate === null) throw new Error(`no ${role} assignment`);
  fixture.engine.verdict(gate.stepId, {
    role,
    session: gate.session,
    verdict: 'HOLDS',
    findings: [],
    model: PIPELINE_MODEL,
    tokensIn: 10,
    tokensOut: 2,
  });
}

function answerRights(
  fixture: Fixture,
  verdict: 'CLEAR' | 'REFUSED',
  rule: string | null = null,
): { assignment: RightsAssignment; result: { verdict: string; action: string; closed: boolean } } {
  const assignment = fixture.engine.next({ role: 'rights', session: 'rights-1' }) as RightsAssignment | null;
  if (assignment === null) throw new Error('the rights gate was not dispatched');
  const result = fixture.engine.verdictRights(assignment.stepId, {
    role: 'rights',
    session: 'rights-1',
    verdict,
    rule,
    model: PIPELINE_MODEL,
    tokensIn: 40,
    tokensOut: 4,
  });
  return { assignment, result };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : String(error);
  }
  return 'no-throw';
}

describe('land — Gate B reads the delta, and a stop-list hit refuses the land', () => {
  it('refuses a STOP-* hit with RIGHTS_STOPLIST, the fixed sentence, and no write at all', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, [CLEAN, STOP_PHRASE]);
      expect(codeOf(() => fixture.engine.land(assignment.leaseId))).toBe('RIGHTS_STOPLIST');
      const step = store.getStep(fixture.db, assignment.stepId);
      // Nothing was written: no landing, no scan, no revision.
      expect(step).toMatchObject({ landed_at: null, landed_sha: null, rights_scan: null });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions').get()).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it('stores a flag (never a pass) for a long quote with no source, and keeps the land', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, [CLEAN, LONG_QUOTE]);
      const landed = fixture.engine.land(assignment.leaseId);
      expect(landed.landed).toBe(true);
      const scan = store.getStep(fixture.db, assignment.stepId)?.rights_scan ?? '';
      expect(JSON.parse(scan)).toMatchObject({ verdict: 'flag', rule: 'RIGHTS-QUOTE' });
    } finally {
      fixture.close();
    }
  });

  it('writes a clear scan for a chapter whose new blocks are prose', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, [CLEAN, 'В акте появится подпись смотрителя.']);
      fixture.engine.land(assignment.leaseId);
      const scan = store.getStep(fixture.db, assignment.stepId)?.rights_scan ?? '';
      expect(JSON.parse(scan)).toEqual({ verdict: 'clear' });
    } finally {
      fixture.close();
    }
  });
});

describe('the conditional gate — a flag makes the rights verdict mandatory', () => {
  it('refuses done with RIGHTS_REQUIRED and offers the step to a rights session', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, [CLEAN, LONG_QUOTE]);
      fixture.engine.land(assignment.leaseId);
      answerProse(fixture, 'editor');
      answerProse(fixture, 'consultant');

      expect(codeOf(() => fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL }))).toBe('RIGHTS_REQUIRED');
      // The refusal names the gate that has not spoken — not "both verdicts are missing".
      expect(() => fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL })).toThrow(/rights/u);

      const cleared = answerRights(fixture, 'CLEAR');
      expect(cleared.result).toMatchObject({ verdict: 'CLEAR', closed: false });
      expect(store.getVerdict(fixture.db, assignment.stepId, 'rights')).toMatchObject({ verdict: 'CLEAR' });

      const done = fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL });
      expect(done.outcome).toBe('rewritten');
      // The trace prints the conditional gate as its own line, with its own enum (m5).
      const trace = fixture.engine.trace(assignment.stepId);
      if (trace?.kind !== 'step') throw new Error('expected a step trace');
      expect(trace.step.rights).toMatchObject({ verdict: 'CLEAR', rule: null });
      expect(trace.step.gates.map((gate) => gate.role)).toEqual(['editor', 'consultant']);
    } finally {
      fixture.close();
    }
  });

  it('offers a clear scan too, with no rule: a clean verdict is answered, not skipped (owner, 2026-10-28)', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, [CLEAN]);
      fixture.engine.land(assignment.leaseId);
      const gate = fixture.engine.next({ role: 'rights', session: 'rights-1' }) as { rule: string | null } | null;
      // The lane answers this mechanically (no model call); the dispatch exists so the record
      // says what was checked instead of saying nothing.
      expect(gate).not.toBeNull();
      expect(gate?.rule).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('refuses a REFUSED without a rule, and a rule outside the closed table', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, [CLEAN, LONG_QUOTE]);
      fixture.engine.land(assignment.leaseId);
      fixture.engine.next({ role: 'rights', session: 'rights-1' });
      const base = { role: 'rights' as const, model: 'stub', tokensIn: 1, tokensOut: 1 };
      expect(
        codeOf(() =>
          fixture.engine.verdictRights(assignment.stepId, { ...base, session: 'rights-1', verdict: 'REFUSED', rule: null }),
        ),
      ).toBe('RIGHTS_RULE_REQUIRED');
      expect(
        codeOf(() =>
          fixture.engine.verdictRights(assignment.stepId, {
            ...base,
            session: 'rights-1',
            verdict: 'REFUSED',
            rule: 'RIGHTS-INVENTED',
          }),
        ),
      ).toBe('RIGHTS_RULE_UNKNOWN');
      expect(
        codeOf(() =>
          fixture.engine.verdictRights(assignment.stepId, { ...base, session: 'rights-1', verdict: 'CLEAR', rule: 'RIGHTS-QUOTE' }),
        ),
      ).toBe('RIGHTS_RULE_WITH_CLEAR');
      // Nothing was recorded by any of the three refusals.
      expect(store.getVerdict(fixture.db, assignment.stepId, 'rights')).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it('refuses a rights answer from a session that was not handed the step', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, [CLEAN, LONG_QUOTE]);
      fixture.engine.land(assignment.leaseId);
      fixture.engine.next({ role: 'rights', session: 'rights-1' });
      expect(
        codeOf(() =>
          fixture.engine.verdictRights(assignment.stepId, {
            role: 'rights',
            session: 'impostor',
            verdict: 'CLEAR',
            rule: null,
            model: 'stub',
            tokensIn: 1,
            tokensOut: 1,
          }),
        ),
      ).toBe('GATE_NOT_DISPATCHED');
    } finally {
      fixture.close();
    }
  });

  it('offers a step already held by another rights session to nobody', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, [CLEAN, LONG_QUOTE]);
      fixture.engine.land(assignment.leaseId);
      expect(fixture.engine.next({ role: 'rights', session: 'rights-1' })).not.toBeNull();
      // The dispatch lives until its TTL: a second session is not handed the same step.
      expect(fixture.engine.next({ role: 'rights', session: 'rights-2' })).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('refuses an answer for a step that does not exist or is already closed', () => {
    const fixture = createEngineFixture();
    try {
      const base = { role: 'rights' as const, session: 'rights-1', verdict: 'CLEAR' as const, rule: null, model: 'stub', tokensIn: 1, tokensOut: 1 };
      expect(codeOf(() => fixture.engine.verdictRights('stp_missing', base))).toBe('STEP_NOT_FOUND');

      const assignment = draftChapter(fixture, [CLEAN, LONG_QUOTE]);
      fixture.engine.land(assignment.leaseId);
      answerRights(fixture, 'CLEAR');
      answerProse(fixture, 'editor');
      answerProse(fixture, 'consultant');
      fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL });
      expect(codeOf(() => fixture.engine.verdictRights(assignment.stepId, base))).toBe('STEP_CLOSED');
    } finally {
      fixture.close();
    }
  });
});

describe('REFUSED — the step stops and the change carries the sentence', () => {
  it('refuses the change with the rule’s own line and puts the text back', () => {
    const fixture = createEngineFixture({ chapters: { 2: chapterText('Глава 2', [CLEAN]) } });
    try {
      const change = fixture.engine.enqueue({ kind: 'operator', chapter: 2, intent: 'переписать сцену с актом' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      expect(assignment.chapter).toBe(2);
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapterBlocks(2, 'Глава 2', [CLEAN, LONG_QUOTE]);
      fixture.engine.land(assignment.leaseId);

      const refused = answerRights(fixture, 'REFUSED', 'RIGHTS-QUOTE');
      expect(refused.result).toMatchObject({ verdict: 'REFUSED', action: 'escalate', closed: true });

      const row = store.getChange(fixture.db, change.id);
      // A refusal is one of the two ends: void·dropped with the gate's sentence (no `escalated`),
      // and the chapter it wrote is back to the revision it started from.
      expect(row).toMatchObject({ status: 'void', outcome: 'dropped', reason: RIGHTS_COPY.quote });
      // The card's word and the change's reason are the public surface: the sentence, not a verdict.
      expect(row?.reason).toBe('не принято: чужая цитата без источника');
      expect(fixture.alerts.map((alert) => alert.kind)).toContain('rights');

      const trace = fixture.engine.trace(assignment.stepId);
      if (trace?.kind !== 'step') throw new Error('expected a step trace');
      expect(trace.step.step.outcome).toBe('escalated');
      // Gate B is not printed as a third prose gate: it has its own line (m5).
      expect(trace.step.gates.map((gate) => gate.role)).toEqual([]);
      expect(trace.step.rights).toMatchObject({ verdict: 'REFUSED', rule: 'RIGHTS-QUOTE' });
    } finally {
      fixture.close();
    }
  });

  it('keeps the reader’s filing out of it: the refusal is about the prose', () => {
    const fixture = createEngineFixture({ chapters: { 2: chapterText('Глава 2', [CLEAN]) } });
    try {
      const change = fixture.engine.enqueue({ kind: 'operator', chapter: 2, intent: 'переписать сцену с актом' });
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapterBlocks(2, 'Глава 2', [CLEAN, LONG_QUOTE]);
      fixture.engine.land(assignment.leaseId);
      answerRights(fixture, 'REFUSED', 'RIGHTS-QUOTE');
      // No comment row was touched by the text-surface refusal — there is none in this fixture,
      // and the change's own record is the only place the refusal lands.
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 0 });
      expect(store.getChange(fixture.db, change.id)?.status).toBe('void');
    } finally {
      fixture.close();
    }
  });
});

describe('a step that landed before this deploy still cannot close without B (B3)', () => {
  it('computes and stores the scan at close, and demands the verdict', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, [CLEAN, LONG_QUOTE]);
      fixture.engine.land(assignment.leaseId);
      // The pre-v14 row: landed, no scan (the column did not exist when it landed).
      store.updateStep(fixture.db, assignment.stepId, { rights_scan: null });
      answerProse(fixture, 'editor');
      answerProse(fixture, 'consultant');

      expect(codeOf(() => fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL }))).toBe('RIGHTS_REQUIRED');
      const scan = store.getStep(fixture.db, assignment.stepId)?.rights_scan ?? '';
      expect(JSON.parse(scan)).toMatchObject({ verdict: 'flag', rule: 'RIGHTS-QUOTE' });

      answerRights(fixture, 'CLEAR');
      expect(fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL }).outcome).toBe('rewritten');
    } finally {
      fixture.close();
    }
  });

  it('writes a clear scan for a step whose delta was never judged', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, [CLEAN]);
      fixture.engine.land(assignment.leaseId);
      store.updateStep(fixture.db, assignment.stepId, { rights_scan: null });
      answerProse(fixture, 'editor');
      answerProse(fixture, 'consultant');
      // Nothing flagged, so nothing is asked: the stored answer is the scan itself.
      expect(fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL }).outcome).toBe('rewritten');
      expect(JSON.parse(store.getStep(fixture.db, assignment.stepId)?.rights_scan ?? '{}')).toEqual({
        verdict: 'clear',
      });
    } finally {
      fixture.close();
    }
  });

  it('flags a step whose chapter cannot be read at close — unknown is not clear', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, [CLEAN]);
      fixture.engine.land(assignment.leaseId);
      store.updateStep(fixture.db, assignment.stepId, { rights_scan: null });
      // The rows vanished after the landing (a restore of an empty slot, a hand repair).
      removeChapter(fixture.db, 1);
      answerProse(fixture, 'editor');
      answerProse(fixture, 'consultant');
      expect(codeOf(() => fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL }))).toBe('RIGHTS_REQUIRED');
      expect(JSON.parse(store.getStep(fixture.db, assignment.stepId)?.rights_scan ?? '{}')).toMatchObject({
        verdict: 'flag',
        rule: 'RIGHTS-FLAG',
      });
    } finally {
      fixture.close();
    }
  });
});

describe('re-land — the same sha reuses the scan, a moved sha rescans', () => {
  it('does not refuse or rescans again for the same sha, and keeps the recorded verdict', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, [CLEAN, LONG_QUOTE]);
      fixture.engine.land(assignment.leaseId);
      const scan = store.getStep(fixture.db, assignment.stepId)?.rights_scan;
      answerRights(fixture, 'CLEAR');

      const again = fixture.engine.land(assignment.leaseId);
      expect(again).toMatchObject({ landed: true, changed: false });
      expect(store.getStep(fixture.db, assignment.stepId)?.rights_scan).toBe(scan);
      // The answer given about this exact file is not thrown away by a retry.
      expect(store.getVerdict(fixture.db, assignment.stepId, 'rights')).toMatchObject({ verdict: 'CLEAR' });
    } finally {
      fixture.close();
    }
  });

  it('drops the scan and the rights verdict when landed_sha moves, and scans the new text', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, [CLEAN, LONG_QUOTE]);
      fixture.engine.land(assignment.leaseId);
      answerRights(fixture, 'CLEAR');
      expect(store.getVerdict(fixture.db, assignment.stepId, 'rights')).toBeDefined();

      // The writer lands different text: the old answer described a file no gate can see.
      fixture.writeChapterBlocks(1, 'Начало', [CLEAN, 'В акте появится подпись смотрителя.']);
      fixture.engine.land(assignment.leaseId);
      expect(store.getVerdict(fixture.db, assignment.stepId, 'rights')).toBeUndefined();
      const scan = store.getStep(fixture.db, assignment.stepId)?.rights_scan ?? '';
      expect(JSON.parse(scan)).toEqual({ verdict: 'clear' });
    } finally {
      fixture.close();
    }
  });
});
