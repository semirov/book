import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { TOTAL_CHAPTERS, type WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { acquireLease } from '../../src/engine/leases.ts';
import * as store from '../../src/engine/store.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import { readIndex } from '../../src/index/store.ts';
import type { IndexSlice } from '../../src/index/types.ts';
import { applyFrontFile } from '../../src/ingest/applyFront.ts';
import { chapterText, createEngineFixture, DEFAULT_ABOUT, PIPELINE_MODEL, type Fixture } from './helpers.ts';

function landOneChapter(fixture: Fixture): { chapter: number; gate: GateAssignment } {
  const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
  const chapter = assignment.chapter as number;
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(chapter, `Глава ${chapter}`, ['Инженер Ковалёв вошёл в комнату.']);
  fixture.engine.land(assignment.leaseId);
  const gate = fixture.engine.next({ role: 'editor', session: 'editor-1' }) as GateAssignment;
  return { chapter, gate };
}

function seedFrontBasis(fixture: Fixture): void {
  applyFrontFile({
    db: fixture.db,
    dataDir: fixture.dataDir,
    raw: readFileSync(join(fixture.root, 'manuscript', '00-front.md'), 'utf8'),
    mtimeMs: fixture.clock.now(),
    nowMs: fixture.clock.now(),
  });
}

function openFrontLease(fixture: Fixture, id: string): string {
  store.insertStep(fixture.db, {
    stepId: id,
    cascadeId: null,
    seq: 0,
    wave: 0,
    lane: null,
    pass: 'front',
    chapter: null,
    boundary: 'front',
    seamsIn: '[]',
    revBefore: 0,
    at: new Date(fixture.clock.now()).toISOString(),
  });
  const step = store.getStep(fixture.db, id);
  if (!step) throw new Error('step insert failed');
  const lease = acquireLease(fixture.deps, { step, session: 'w1', expectedRev: 0, changeId: null });
  fixture.engine.start(lease.id);
  return lease.id;
}

describe('the editor assignment carries an index slice (BOOK-18 §2)', () => {
  it('points at the step’s chapter and its neighbours, never at the whole book', () => {
    const fixture = createEngineFixture({ chapters: { 2: chapterText('Глава 2', ['Приказ № 4 выдан.']) } });
    try {
      const { chapter, gate } = landOneChapter(fixture);
      expect(gate.role).toBe('editor');
      expect(gate.indexSlice).toBe(join(fixture.dataDir, 'index', 'slices', `ch${String(chapter).padStart(2, '0')}.json`));
      const slice = JSON.parse(readFileSync(gate.indexSlice ?? '', 'utf8')) as IndexSlice;
      expect(slice.chapter).toBe(chapter);
      expect(slice.chapters.map((entry) => entry.n)).toEqual(
        [chapter - 1, chapter, chapter + 1].filter((n) => n >= 1 && n <= TOTAL_CHAPTERS),
      );
      expect(slice.chapters.length).toBeLessThan(TOTAL_CHAPTERS);
      // The dispatch is also where the artifact is rebuilt (never inside a close).
      expect(readIndex(fixture.dataDir)?.manuscriptHash).toBe(slice.manuscriptHash);
    } finally {
      fixture.close();
    }
  });

  it('hands the slice to the editor only: the consultant judges physics, not continuity', () => {
    const fixture = createEngineFixture();
    try {
      const { gate } = landOneChapter(fixture);
      fixture.engine.verdict(gate.stepId, {
        role: 'editor',
        session: gate.session,
        verdict: 'HOLDS',
        findings: [],
        model: PIPELINE_MODEL,
        tokensIn: 1,
        tokensOut: 1,
      });
      const consultant = fixture.engine.next({ role: 'consultant', session: 'consultant-1' }) as GateAssignment;
      expect(consultant.role).toBe('consultant');
      expect(consultant.indexSlice).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('gives a front step no slice — page 2 is basis, not a chapter to index', () => {
    const fixture = createEngineFixture({ front: { title: 'Без названия', about: DEFAULT_ABOUT } });
    try {
      seedFrontBasis(fixture);
      const leaseId = openFrontLease(fixture, 'stp_front_1');
      fixture.writeFront('Другое название', DEFAULT_ABOUT);
      fixture.engine.land(leaseId);
      const gate = fixture.engine.next({ role: 'editor', session: 'editor-front' }) as GateAssignment;
      expect(gate.pass).toBe('front');
      expect(gate.indexSlice).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('still hands out the assignment when the index cannot be written', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      const chapter = assignment.chapter as number;
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapterBlocks(chapter, 'Глава', ['Инженер Ковалёв вошёл.']);
      fixture.engine.land(assignment.leaseId);
      // The data directory cannot hold a slice any more: the file now stands where it was.
      const blocked = join(fixture.root, 'not-a-directory');
      writeFileSync(blocked, 'occupied', 'utf8');
      fixture.deps.config.dataDir = blocked;
      const gate = fixture.engine.next({ role: 'editor', session: 'editor-1' }) as GateAssignment;
      expect(gate.stepId).toBe(assignment.stepId);
      expect(gate.indexSlice).toBeNull();
      // The failure is recorded once (kind 'index') so a mis-set DATA_DIR is not silent.
      expect(fixture.alerts.filter((alert) => alert.kind === 'index')).toHaveLength(1);
      // A missing slice is not a gate failure: both verdicts and the close still happen.
      fixture.engine.verdict(gate.stepId, {
        role: 'editor',
        session: gate.session,
        verdict: 'HOLDS',
        findings: [],
        model: PIPELINE_MODEL,
        tokensIn: 1,
        tokensOut: 1,
      });
      const consultant = fixture.engine.next({ role: 'consultant', session: 'consultant-1' }) as GateAssignment;
      fixture.engine.verdict(consultant.stepId, {
        role: 'consultant',
        session: consultant.session,
        verdict: 'HOLDS',
        findings: [],
        model: PIPELINE_MODEL,
        tokensIn: 1,
        tokensOut: 1,
      });
      expect(fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL }).outcome).toBe('rewritten');
    } finally {
      fixture.close();
    }
  });
});
