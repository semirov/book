import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { readCommentRow, toCommentDto } from '../../src/comments/repo.ts';
import { readMyDecisions } from '../../src/authors/decisions.ts';
import { readQueue } from '../../src/engineState/reader.ts';
import { reconcile as ingestReconcile } from '../../src/ingest/reconcile.ts';
import { settleDraftPremise } from '../../src/engine/premise.ts';
import * as store from '../../src/engine/store.ts';
import { driveStub } from './helpers.ts';
import { AT, accept, change, fixtureOf, fourWritten, seed } from './premiseHelpers.ts';

/**
 * BOOK-7 — an intervention on a chapter that has no text.
 *
 * The product loop must start from an empty book: the reader's change becomes the chapter's
 * **premise** (base revision 0, no anchor), waits for that chapter's first draft pass outside
 * the FIFO lane, rides on the writer's assignment, and closes into the first edition — or is
 * refused with a public reason. The frozen frame (ch01, ch67) is not a closed door (BOOK-137):
 * a chapter-level filing on it is that slot's premise, and its sentence is kept at a landing.
 */

describe('BOOK-7 — an intervention becomes the chapter’s premise', () => {
  it('accepts a FITS intervention on an empty ch05 as a premise: baseRev 0, no anchor, not in the queue', () => {
    const fixture = fixtureOf();
    try {
      const id = seed(fixture.db, { chapter: 5, proposedText: 'Документ о допуске к сенсору.', kind: 'document' });
      const accepted = accept(fixture.db, id, 'в главе 5 появляется документ о допуске');
      if ('error' in accepted) throw new Error(accepted.error);

      expect(change(fixture.db, accepted.changeId)).toMatchObject({
        chapter: 5,
        premise: 1,
        base_rev: 0,
        base_sha256: '',
        anchor: null,
        scope_hint: 'chapter',
        status: 'pending',
        intervention_kind: 'document',
      });

      // The thread derives the promise from the change, not from a second stored status.
      const dto = toCommentDto(fixture.db, readCommentRow(fixture.db, id)!);
      expect(dto).toMatchObject({ status: 'accepted', premise: true, changeId: accepted.changeId });

      // The lane is empty: a premise is not a queued change and cannot become its head.
      const queue = readQueue(fixture.db, Date.parse(AT));
      expect(queue.depth).toBe(0);
      expect(queue.head).toBeNull();
      expect(queue.byState.pending).toBe(0);
      expect(fixture.engine.state().queue.pending).toBe(0);

      // The operator sees it by name.
      const trace = fixture.engine.trace(accepted.changeId);
      if (trace?.kind !== 'change') throw new Error('expected a change trace');
      expect(trace.change.change.premise).toBe(true);
      expect(trace.change.change.status).toBe('pending');
      expect(trace.change.cascade).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('never claims the lane and does not block the change behind it', () => {
    const fixture = fixtureOf();
    try {
      const id = seed(fixture.db, { chapter: 5, proposedText: 'Документ о допуске.', kind: 'document' });
      const accepted = accept(fixture.db, id, 'в главе 5 появляется документ о допуске');
      if ('error' in accepted) throw new Error(accepted.error);

      // A written chapter takes an ordinary change through the same lane, after the premise.
      fixture.writeChapterBlocks(10, 'Глава 10', ['Служебный абзац десятой главы. Он не служит текстом книги.']);
      const normal = fixture.engine.enqueue({ kind: 'reader_edit', chapter: 10, intent: 'уточнить абзац' });
      expect(normal.status).toBe('pending');

      expect((readQueue(fixture.db, Date.parse(AT)).head as { id: string }).id).toBe(normal.id);
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      expect(assignment.pass).toBe('change');
      expect(assignment.chapter).toBe(10);
      expect(assignment.changeId).toBe(normal.id);
      expect(assignment.premise).toBeNull();

      // The premise is still waiting for its own chapter, untouched by the lane.
      expect(change(fixture.db, accepted.changeId)).toMatchObject({ status: 'pending', premise: 1 });
    } finally {
      fixture.close();
    }
  });

  it('carries the premise on the chapter’s first draft assignment and applies it when the edition lands', () => {
    const fixture = fixtureOf();
    try {
      fourWritten(fixture);
      const id = seed(fixture.db, { chapter: 5, proposedText: 'Документ о допуске.', kind: 'document' });
      const accepted = accept(fixture.db, id, 'в главе 5 появляется документ о допуске');
      if ('error' in accepted) throw new Error(accepted.error);

      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      expect(assignment.pass).toBe('draft');
      expect(assignment.chapter).toBe(5);
      expect(assignment.premise).toEqual({ intent: 'в главе 5 появляется документ о допуске', kind: 'document' });

      const run = driveStub(fixture, assignment, {
        title: 'Глава 5',
        blocks: ['Пятая глава начинается с документа о допуске.', 'Служебный абзац.'],
      });
      expect(run.result.outcome).toBe('rewritten');

      const row = change(fixture.db, accepted.changeId);
      expect(row).toMatchObject({ status: 'done', outcome: 'applied', reason: 'вошло в первую редакцию главы 5' });
      expect(typeof row.finished_at).toBe('string');
      // No ripple was claimed for a premise.
      expect(row.cascade_id).toBeNull();
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM cascades').get()).toEqual({ n: 0 });

      const dto = toCommentDto(fixture.db, readCommentRow(fixture.db, id)!);
      expect(dto).toMatchObject({ status: 'applied', premise: true, changeId: accepted.changeId });
    } finally {
      fixture.close();
    }
  });

  it('keeps one premise per chapter: the earliest wins, the later is superseded with its reason', () => {
    const fixture = fixtureOf();
    try {
      fourWritten(fixture);
      const firstId = seed(fixture.db, { chapter: 5, proposedText: 'Документ о допуске.', kind: 'document' });
      const secondId = seed(fixture.db, { chapter: 5, proposedText: 'Свидетельство о потере.', kind: 'testimony' });
      const first = accept(fixture.db, firstId, 'в главе 5 появляется документ о допуске');
      const second = accept(fixture.db, secondId, 'в главе 5 появляется свидетельство');
      if ('error' in first) throw new Error(first.error);
      if ('error' in second) throw new Error(second.error);
      expect(second).toMatchObject({ superseded: true });

      expect(change(fixture.db, second.changeId)).toMatchObject({
        premise: 1,
        status: 'void',
        outcome: 'superseded',
        reason: 'у главы уже есть замысел',
      });
      expect(toCommentDto(fixture.db, readCommentRow(fixture.db, secondId)!)).toMatchObject({
        status: 'superseded',
        premise: true,
        reason: 'у главы уже есть замысел',
      });

      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      expect(assignment.premise?.intent).toBe('в главе 5 появляется документ о допуске');
      driveStub(fixture, assignment, { title: 'Глава 5', blocks: ['Пятая глава.', 'Служебный абзац.'] });

      expect(change(fixture.db, first.changeId)).toMatchObject({ status: 'done', outcome: 'applied' });
      expect(change(fixture.db, second.changeId)).toMatchObject({ status: 'void', outcome: 'superseded' });

      // The reader's own record tells both truths, without invented waves or blocks.
      const record = readMyDecisions(fixture.db, 'idn_viewer');
      const applied = record.items.find((item) => item.commentId === firstId);
      const superseded = record.items.find((item) => item.commentId === secondId);
      expect(applied).toMatchObject({ outcome: 'applied', premise: true, waves: null, blocks: null, chapters: [5] });
      expect(applied?.reason).toBe('вошло в первую редакцию главы 5');
      expect(superseded).toMatchObject({
        outcome: 'superseded',
        premise: true,
        waves: null,
        blocks: null,
        reason: 'у главы уже есть замысел',
      });
    } finally {
      fixture.close();
    }
  });

  it('leaves a written chapter’s ordinary change exactly as before', () => {
    const fixture = fixtureOf();
    try {
      fixture.writeChapterBlocks(8, 'Глава 8', ['Служебный абзац восьмой главы. Он не является текстом книги.']);
      ingestReconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
      const id = seed(fixture.db, { chapter: 8, proposedText: 'Уточнить абзац.', kind: 'testimony' });
      const accepted = accept(fixture.db, id, 'в главе 8 уточнить абзац');
      if ('error' in accepted) throw new Error(accepted.error);

      const row = change(fixture.db, accepted.changeId);
      expect(row).toMatchObject({ premise: 0, status: 'pending', chapter: 8 });
      expect(row.base_rev).toBe(1);
      expect(row.base_sha256).not.toBe('');
      expect(row.anchor).not.toBeNull();
      expect(toCommentDto(fixture.db, readCommentRow(fixture.db, id)!)).toMatchObject({
        status: 'accepted',
        premise: false,
      });

      const queue = readQueue(fixture.db, Date.parse(AT));
      expect(queue.depth).toBe(1);
      expect(queue.head?.id).toBe(accepted.changeId);
    } finally {
      fixture.close();
    }
  });

  it('reconcile closes a premise stranded by a write outside its first pass, and keeps one its own step owns', () => {
    const fixture = fixtureOf();
    try {
      fourWritten(fixture);
      const ownedId = seed(fixture.db, { chapter: 5, proposedText: 'Документ о допуске.', kind: 'document' });
      const strandedId = seed(fixture.db, { chapter: 9, proposedText: 'Документ о допуске.', kind: 'document' });
      const owned = accept(fixture.db, ownedId, 'в главе 5 появляется документ');
      const stranded = accept(fixture.db, strandedId, 'в главе 9 появляется документ');
      if ('error' in owned) throw new Error(owned.error);
      if ('error' in stranded) throw new Error(stranded.error);

      // The draft for chapter 5 opens and takes its premise; then the owner hand-writes the
      // chapter while the step is still open — that premise is owned, not stranded.
      const draft = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      expect(draft.premise?.intent).toBe('в главе 5 появляется документ');
      fixture.writeChapterBlocks(5, 'Глава 5', ['Пятая глава, написанная рукой автора.', 'Служебный абзац.']);

      // Chapter 9 was written with no step at all: its premise can never enter an edition.
      fixture.writeChapterBlocks(9, 'Глава 9', ['Девятая глава написана рукой автора.', 'Служебный абзац.']);
      // A written ch01 can no more take a premise than any other written chapter — the freeze is
      // the basis-only slot's shape, so a hand-inserted row here is closed as stale (BOOK-137).
      fixture.db
        .prepare(
          `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint, premise, status, enqueued_at)
           VALUES ('chg_bad_frame', 'accepted_comment', 1, 'переписать первую фразу', 0, '', '[]', 'chapter', 1, 'pending', ?)`,
        )
        .run(AT);

      const report = fixture.engine.reconcile();
      expect(report.premisesSettled).toBe(2);

      expect(change(fixture.db, stranded.changeId)).toMatchObject({
        status: 'void',
        outcome: 'dropped',
        reason: 'глава написана без этого замысла',
      });
      expect(toCommentDto(fixture.db, readCommentRow(fixture.db, strandedId)!)).toMatchObject({
        status: 'rejected',
        premise: true,
        reason: 'глава написана без этого замысла',
      });
      expect(change(fixture.db, 'chg_bad_frame')).toMatchObject({
        status: 'void',
        outcome: 'dropped',
        reason: 'глава написана без этого замысла',
      });
      // The open draft still owns its premise: reconcile does not touch another step's job.
      expect(change(fixture.db, owned.changeId)).toMatchObject({ status: 'pending' });
    } finally {
      fixture.close();
    }
  });

  it('marks the premise rejected when the writer refuses it, and the next pass no longer carries it', () => {
    const fixture = fixtureOf();
    try {
      fourWritten(fixture);
      const id = seed(fixture.db, { chapter: 5, proposedText: 'Документ о допуске.', kind: 'document' });
      const accepted = accept(fixture.db, id, 'в главе 5 появляется документ о допуске');
      if ('error' in accepted) throw new Error(accepted.error);

      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      expect(assignment.premise).not.toBeNull();
      fixture.engine.start(assignment.leaseId);
      // The only refusal in the unchanged protocol: escalate with one plain reason.
      const refused = fixture.engine.escalate(assignment.leaseId, 'не беру: документ не из этой сцены');
      expect(refused.outcome).toBe('escalated');

      const row = change(fixture.db, accepted.changeId);
      expect(row).toMatchObject({
        status: 'void',
        outcome: 'dropped',
        reason: 'не беру: документ не из этой сцены',
      });
      expect(toCommentDto(fixture.db, readCommentRow(fixture.db, id)!)).toMatchObject({
        status: 'rejected',
        premise: true,
        reason: 'не беру: документ не из этой сцены',
      });

      // The refusal is final: the next first pass writes the chapter without a premise.
      const second = fixture.engine.next({ for: 'fwd', session: 'writer-fwd-2' }) as WriterAssignment;
      expect(second.pass).toBe('draft');
      expect(second.chapter).toBe(5);
      expect(second.premise).toBeNull();
      expect(change(fixture.db, accepted.changeId)).toMatchObject({ status: 'void', outcome: 'dropped' });
    } finally {
      fixture.close();
    }
  });

  it('leaves the premise queued when the first pass is interrupted, and consumes it on the next pass', () => {
    const fixture = fixtureOf();
    try {
      fourWritten(fixture);
      const id = seed(fixture.db, { chapter: 5, proposedText: 'Документ о допуске.', kind: 'document' });
      const accepted = accept(fixture.db, id, 'в главе 5 появляется документ о допуске');
      if ('error' in accepted) throw new Error(accepted.error);

      const first = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      expect(first.premise).not.toBeNull();
      // The writer's session dies before start: the lease expires and the step is re-issued.
      fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
      fixture.engine.reap();
      expect(change(fixture.db, accepted.changeId)).toMatchObject({ status: 'pending' });

      const resumed = fixture.engine.next({ for: 'fwd', session: 'writer-fwd-2' }) as WriterAssignment;
      expect(resumed.stepId).toBe(first.stepId);
      expect(resumed.premise?.intent).toBe('в главе 5 появляется документ о допуске');
      expect(change(fixture.db, accepted.changeId)).toMatchObject({ status: 'pending' });
    } finally {
      fixture.close();
    }
  });

  it('does not apply a premise the writer never acknowledged, and reconcile closes it as not taken', () => {
    const fixture = fixtureOf();
    try {
      fourWritten(fixture);
      const id = seed(fixture.db, { chapter: 5, proposedText: 'Документ о допуске.', kind: 'document' });
      const accepted = accept(fixture.db, id, 'в главе 5 появляется документ о допуске');
      if ('error' in accepted) throw new Error(accepted.error);

      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      expect(assignment.premise).not.toBeNull();
      // The writer lands a chapter but says nothing about the premise: text is not consent.
      const run = driveStub(fixture, assignment, {
        title: 'Глава 5',
        blocks: ['Пятая глава.', 'Служебный абзац.'],
        note: '',
      });
      expect(run.result.outcome).toBe('rewritten');
      expect(change(fixture.db, accepted.changeId)).toMatchObject({ status: 'pending', premise: 1 });

      const report = fixture.engine.reconcile();
      expect(report.premisesSettled).toBe(1);
      expect(change(fixture.db, accepted.changeId)).toMatchObject({
        status: 'void',
        outcome: 'dropped',
        reason: 'глава написана без этого замысла',
      });
    } finally {
      fixture.close();
    }
  });

  it('a refusal beats a landing: an escalated writer cannot publish «замысел учтён»', () => {
    const fixture = fixtureOf();
    try {
      fourWritten(fixture);
      const id = seed(fixture.db, { chapter: 5, proposedText: 'Документ о допуске.', kind: 'document' });
      const accepted = accept(fixture.db, id, 'в главе 5 появляется документ о допуске');
      if ('error' in accepted) throw new Error(accepted.error);

      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      // The file exists, and the report carries a note — but the writer escalated: a refusal.
      fixture.writeChapterBlocks(5, 'Глава 5', ['Пятая глава.', 'Служебный абзац.']);
      fixture.engine.land(assignment.leaseId);
      const refused = fixture.engine.escalate(assignment.leaseId, 'не беру: документ не из этой сцены');
      expect(refused.outcome).toBe('escalated');

      expect(change(fixture.db, accepted.changeId)).toMatchObject({
        status: 'void',
        outcome: 'dropped',
        reason: 'не беру: документ не из этой сцены',
      });
      expect(toCommentDto(fixture.db, readCommentRow(fixture.db, id)!)).toMatchObject({
        status: 'rejected',
        premise: true,
        reason: 'не беру: документ не из этой сцены',
      });
    } finally {
      fixture.close();
    }
  });

  it('settles an applied premise exactly once: a late settle and reconcile write one decision and one impact', () => {
    const fixture = fixtureOf();
    try {
      fourWritten(fixture);
      const id = seed(fixture.db, { chapter: 5, proposedText: 'Документ о допуске.', kind: 'document' });
      const accepted = accept(fixture.db, id, 'в главе 5 появляется документ о допуске');
      if ('error' in accepted) throw new Error(accepted.error);

      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment;
      driveStub(fixture, assignment, {
        title: 'Глава 5',
        blocks: ['Пятая глава начинается с документа о допуске.', 'Служебный абзац.'],
        note: 'беру замысел',
      });
      expect(change(fixture.db, accepted.changeId)).toMatchObject({ status: 'done', outcome: 'applied' });

      // A late caller (a second settle, the guard's real job) changes nothing.
      const step = store.getStep(fixture.db, assignment.stepId) as store.StepRow;
      expect(settleDraftPremise(fixture.deps, step, 'rewritten', null, 'беру замысел', fixture.clock.now())).toBeNull();
      const report = fixture.engine.reconcile();
      expect(report.premisesSettled).toBe(0);

      expect(
        fixture.db.prepare(`SELECT COUNT(*) AS n FROM change_events WHERE change_id = ? AND type = 'decided'`).get(
          accepted.changeId,
        ),
      ).toEqual({ n: 1 });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM change_impact WHERE change_id = ?').get(accepted.changeId)).toEqual({
        n: 1,
      });
    } finally {
      fixture.close();
    }
  });

  it('maps a real one-premise index race to superseded, not an error', () => {
    const fixture = fixtureOf();
    try {
      // A competing pending row appears inside the loser's own INSERT, so SQLite raises its
      // **real** partial-index error: code SQLITE_CONSTRAINT_UNIQUE, message
      // «UNIQUE constraint failed: changes.chapter» — not the index name, and not a string
      // this test wrote. The trigger's row belongs to the aborted statement and rolls back,
      // so the mapping must branch on the driver's code alone.
      fixture.db.exec(`CREATE TRIGGER book7_race BEFORE INSERT ON changes
        WHEN NEW.premise = 1 AND NEW.status = 'pending' AND NEW.id <> 'chg_race_winner'
        BEGIN
          INSERT INTO changes
            (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint, premise, status, enqueued_at)
          VALUES
            ('chg_race_winner', 'accepted_comment', NEW.chapter, 'race', 0, '', '[]', 'chapter', 1, 'pending', NEW.enqueued_at);
        END`);
      const id = seed(fixture.db, { chapter: 5, proposedText: 'Документ о допуске.', kind: 'document' });
      const accepted = accept(fixture.db, id, 'в главе 5 появляется документ о допуске');
      if ('error' in accepted) throw new Error(accepted.error);
      expect(accepted).toMatchObject({ superseded: true });
      expect(change(fixture.db, accepted.changeId)).toMatchObject({
        status: 'void',
        outcome: 'superseded',
        reason: 'у главы уже есть замысел',
      });
      expect(toCommentDto(fixture.db, readCommentRow(fixture.db, id)!)).toMatchObject({
        status: 'superseded',
        premise: true,
      });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });
    } finally {
      fixture.close();
    }
  });
});
