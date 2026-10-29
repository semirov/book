import { mkdirSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { CommentDto } from '@book/shared';

import { insertComment, readCommentRow, toCommentDto } from '../src/comments/repo.ts';
import { commentAddedPayload } from '../src/comments/frame.ts';
import { recordAttempt } from '../src/comments/attempts.ts';
import { DecisionsTailer } from '../src/feedback/decisions.ts';
import { emitFilingUpdate } from '../src/feedback/filingFrame.ts';
import { appendChangeEvent, appendEvent } from '../src/history/log.ts';
import { insertStep, updateStep } from '../src/engine/store.ts';
import { fileOn, runStubStep } from './engine/helpers.ts';
import { first, engineRig, siteRig, T0, type Frame } from './frameRig.ts';

/**
 * BOOK-DOC-84 §2.1 — the pass, filing and engine rows of the frame table: the writer's own path
 * (`step.opened`/`step.closed`), a filing's transition, and the snapshot's own numbers.
 */

describe('§2.1 — the pass rows', () => {
  it('#14/#16 pass:accepted and pass:closed come from step.opened / step.closed', () => {
    const { fixture, frames, bridge } = engineRig();
    try {
      fileOn(fixture, 5);
      const run = runStubStep(fixture, {});
      bridge.tick();
      const accepted = first(frames, 'pass:accepted');
      expect(accepted.data).toMatchObject({
        stepId: run?.stepId,
        chapter: run?.assignment.chapter,
        pass: 'draft',
        ahead: 0,
      });
      expect(Number.isInteger(accepted.data.at)).toBe(true);
      const closed = first(frames, 'pass:closed');
      expect(closed.data).toMatchObject({ stepId: run?.stepId, pass: 'draft', outcome: 'closed' });
      expect(typeof closed.data.sentence).toBe('string');
      expect(closed.data.closeFailed).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it('#14 a theme pass names its own chapter: a `front` step is not announced as chapter 1', () => {
    const { fixture, frames, bridge } = engineRig();
    try {
      insertStep(fixture.db, {
        stepId: 'stp_front',
        cascadeId: null,
        seq: 2,
        wave: 0,
        lane: null,
        pass: 'front',
        chapter: null,
        boundary: 'front',
        seamsIn: '[]',
        revBefore: null,
        at: new Date(T0).toISOString(),
      });
      appendEvent(fixture.db, { kind: 'step.opened', stepId: 'stp_front', isFront: true });
      bridge.tick();
      // No claim: the step has no chapter, and a number invented here would put a title pass in
      // chapter 1 on every reader's page.
      expect(frames.filter((frame) => frame.type === 'pass:accepted')).toHaveLength(0);
      updateStep(fixture.db, 'stp_front', { outcome: 'escalated' });
      appendEvent(fixture.db, { kind: 'step.closed', stepId: 'stp_front', isFront: true });
      bridge.tick();
      const closed = first(frames, 'pass:closed');
      // The close still speaks, with the null chapter the step actually has.
      expect(closed.data).toMatchObject({ stepId: 'stp_front', pass: 'front', chapter: null });
    } finally {
      fixture.close();
    }
  });

  it('#15 pass:stage keeps its shape (the tailer is the emitter)', () => {
    const { fixture, frames, bridge } = engineRig();
    try {
      fileOn(fixture, 5);
      runStubStep(fixture, {});
      bridge.tick();
      // The stage rows are owned by `stages/tailer.ts`; the bridge never emits one (one producer).
      expect(frames.filter((frame) => frame.type === 'pass:stage')).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });
});

describe('§2.1 — the filing and the comment rows', () => {
  it('#17 filing:update carries the state and both counters', () => {
    const { fixture } = siteRig();
    try {
      const identity = fixture.db
        .prepare(`INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at) VALUES ('idt_1','sub','Аня',?,?)`)
        .run(new Date(T0).toISOString(), new Date(T0).toISOString());
      expect(identity.changes).toBe(1);
      insertComment(fixture.db, {
        id: 'cmt_cov',
        identityId: 'idt_1',
        chapter: 5,
        blockId: null,
        blockIndex: null,
        baseRev: null,
        quote: null,
        prefix: null,
        suffix: null,
        author: 'Аня',
        body: 'Служебное замечание для проверки кадра.',
        proposedText: null,
        interventionKind: null,
        bodySha: 'a'.repeat(64),
        flags: [],
        ipHash: 'b'.repeat(64),
        status: 'new',
        guard: null,
        reason: null,
        createdAt: new Date(T0).toISOString(),
        idemKey: null,
      });
      const row = readCommentRow(fixture.db, 'cmt_cov');
      expect(row).toBeDefined();
      recordAttempt(fixture.db, row!, new Date(T0));
      const emitted: Frame[] = [];
      emitFilingUpdate(fixture.db, (type, data) => emitted.push({ type, data: data as Record<string, unknown> }), {
        commentId: 'cmt_cov',
        chapter: 5,
        state: 'held',
        at: T0 + 1_000,
      });
      const frame = first(emitted, 'filing:update');
      expect(frame.data).toMatchObject({
        commentId: 'cmt_cov',
        chapter: 5,
        state: 'held',
        attempts: 1,
        attemptsLeft: 2,
        changeId: null,
        at: T0 + 1_000,
      });
    } finally {
      fixture.close();
    }
  });

  it('#18 comment:added carries the whole DTO, so the thread inserts instead of refetching', () => {
    const { fixture } = siteRig();
    try {
      fixture.db
        .prepare(`INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at) VALUES ('idt_1','sub','Аня',?,?)`)
        .run(new Date(T0).toISOString(), new Date(T0).toISOString());
      insertComment(fixture.db, {
        id: 'cmt_dto',
        identityId: 'idt_1',
        chapter: 5,
        blockId: null,
        blockIndex: null,
        baseRev: null,
        quote: null,
        prefix: null,
        suffix: null,
        author: 'Аня',
        body: 'Ещё одно служебное замечание.',
        proposedText: null,
        interventionKind: null,
        bodySha: 'c'.repeat(64),
        flags: [],
        ipHash: 'd'.repeat(64),
        status: 'new',
        guard: null,
        reason: null,
        createdAt: new Date(T0).toISOString(),
        idemKey: null,
      });
      const dto = toCommentDto(fixture.db, readCommentRow(fixture.db, 'cmt_dto')!, T0);
      const payload = commentAddedPayload(dto);
      expect(payload.comment).toEqual(dto);
      expect(payload).toMatchObject({ id: 'cmt_dto', chapter: 5 });
      const comment: CommentDto = payload.comment;
      expect(comment.id).toBe('cmt_dto');
    } finally {
      fixture.close();
    }
  });

  it('#19 comment:decision carries `attemptsLeft` and `at`', () => {
    const { fixture } = siteRig();
    try {
      fixture.db
        .prepare(`INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at) VALUES ('idt_1','sub','Аня',?,?)`)
        .run(new Date(T0).toISOString(), new Date(T0).toISOString());
      insertComment(fixture.db, {
        id: 'cmt_dec',
        identityId: 'idt_1',
        chapter: 5,
        blockId: null,
        blockIndex: null,
        baseRev: null,
        quote: null,
        prefix: null,
        suffix: null,
        author: 'Аня',
        body: 'Замечание, у которого уже есть решение.',
        proposedText: null,
        interventionKind: null,
        bodySha: 'e'.repeat(64),
        flags: [],
        ipHash: 'f'.repeat(64),
        status: 'new',
        guard: null,
        reason: null,
        createdAt: new Date(T0).toISOString(),
        idemKey: null,
      });
      fixture.db
        .prepare(
          `INSERT INTO changes (seq, id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
             premise, status, relevance, outcome, cascade_id, model, tokens_in, tokens_out, cost_rub, enqueued_at,
             started_at, finished_at, attempts)
           VALUES (1, 'chg_dec', 'accepted_comment', 5, 'принято', 1, 'sha', '[]', 'phrase', 0, 'done', NULL, 'applied', NULL, NULL, 0, 0, 0, ?, NULL, NULL, 0)`,
        )
        .run(new Date(T0).toISOString());
      const row = readCommentRow(fixture.db, 'cmt_dec')!;
      recordAttempt(fixture.db, row, new Date(T0));
      const dir = join(fixture.dataDir, 'decisions');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'decisions.jsonl'), '', 'utf8');
      // The row is decided already: first decision wins, and the re-announce branch is the one
      // that speaks (the CLI writes the row before the line — the normal production path).
      fixture.db
        .prepare(`UPDATE comments SET status = 'accepted', decided_at = ?, change_id = 'chg_dec', reason = ? WHERE id = ?`)
        .run(new Date(T0 + 2_000).toISOString(), 'принято', 'cmt_dec');
      const emitted: Frame[] = [];
      const tailer = new DecisionsTailer({
        db: fixture.db,
        dir,
        emit: (type, data) => emitted.push({ type, data: data as Record<string, unknown> }),
        now: () => new Date(T0 + 3_000),
        replay: true,
      });
      tailer.prime();
      writeFileSync(
        join(dir, 'decisions.jsonl'),
        `${JSON.stringify({ id: 'cmt_dec', status: 'accepted', reason: 'принято', changeId: 'chg_dec', at: new Date(T0 + 2_000).toISOString() })}\n`,
        'utf8',
      );
      tailer.poll();
      const decision = first(emitted, 'comment:decision');
      expect(decision.data).toMatchObject({ id: 'cmt_dec', status: 'accepted', attemptsLeft: 2, at: T0 + 2_000 });
      // …and the filing's own row travels with it (BOOK-DOC-84 #17).
      const filing = first(emitted, 'filing:update');
      expect(filing.data).toMatchObject({ commentId: 'cmt_dec', state: 'accepted' });
    } finally {
      fixture.close();
    }
  });
});

describe('§2.1 — the engine’s own rows', () => {
  it('#3 state:updated carries the queue’s filings and the lane’s day', () => {
    const { fixture, frames, bridge } = siteRig();
    try {
      fixture.db
        .prepare(
          `INSERT INTO changes (seq, id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
             premise, status, relevance, outcome, cascade_id, model, tokens_in, tokens_out, cost_rub, enqueued_at,
             started_at, finished_at, attempts)
           VALUES (1, 'chg_wait', 'accepted_comment', 9, 'ждать', 1, 'sha', '[]', 'phrase', 0, 'pending', NULL, NULL, NULL, NULL, 0, 0, 0, ?, NULL, NULL, 0)`,
        )
        .run(new Date(T0).toISOString());
      fixture.db
        .prepare(`INSERT INTO writer_state (id, day, passes, last_pass_at, pause_until, updated_at) VALUES (1, ?, 2, ?, NULL, ?)`)
        .run(new Date(T0).toISOString().slice(0, 10), new Date(T0).toISOString(), new Date(T0).toISOString());
      fixture.db.prepare(`INSERT INTO meta (k, v) VALUES ('engine.heartbeat', ?)`).run(new Date(T0).toISOString());
      bridge.tick();
      const updated = first(frames, 'state:updated');
      expect(updated.data).toMatchObject({
        reason: 'engine',
        lane: { passesToday: 2, maxPasses: 4, writerAt: new Date(T0).toISOString() },
      });
      const queue = updated.data.queue as { pending: Array<{ id: string; ahead: number }> };
      expect(queue.pending).toEqual([expect.objectContaining({ id: 'chg_wait', ahead: 0 })]);
    } finally {
      fixture.close();
    }
  });

  it('#20 feedback:batch is a tick with the batch’s own numbers', () => {
    const { fixture } = siteRig();
    try {
      const dir = join(fixture.dataDir, 'batches');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'decisions.jsonl'), '', 'utf8');
      fixture.db
        .prepare(`INSERT INTO feedback_batches (id, created_at, closed_at, chapter, loop, count, path, comment_ids)
                  VALUES ('bat_1', ?, NULL, 5, 'main', 2, 'batches/bat_1.jsonl', '[]')`)
        .run(new Date(T0).toISOString());
      const emitted: Frame[] = [];
      const tailer = new DecisionsTailer({
        db: fixture.db,
        dir,
        emit: (type, data) => emitted.push({ type, data: data as Record<string, unknown> }),
        now: () => new Date(T0),
        replay: true,
      });
      tailer.prime();
      tailer.poll();
      const batch = first(emitted, 'feedback:batch');
      expect(batch.data).toMatchObject({ batchId: 'bat_1', count: 2, chapter: 5 });
    } finally {
      fixture.close();
    }
  });

  it('#21 cascade:progress is coalescible and carries the projection', () => {
    const { fixture, frames, bridge } = siteRig();
    try {
      fixture.db
        .prepare(
          `INSERT INTO changes (seq, id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
             premise, status, relevance, outcome, cascade_id, model, tokens_in, tokens_out, cost_rub, enqueued_at,
             started_at, finished_at, attempts)
           VALUES (1, 'chg_cas', 'accepted_comment', 8, 'сдвинуть ключ', 1, 'sha', '[]', 'phrase', 0, 'processing', NULL, NULL, 'csc_1', NULL, 0, 0, 0, ?, NULL, NULL, 0)`,
        )
        .run(new Date(T0).toISOString());
      fixture.db
        .prepare(`INSERT INTO cascades (id, change_id, status, outcome, wave, depth_fwd, depth_bwd, step_count, tokens, budget, opened_at, closed_at)
                  VALUES ('csc_1', 'chg_cas', 'open', NULL, 1, 1, 1, 0, 0, ?, ?, NULL)`)
        .run(JSON.stringify({ maxSteps: 8, maxWallMs: 1_800_000 }), new Date(T0).toISOString());
      fixture.db
        .prepare(`INSERT INTO steps (step_id, cascade_id, seq, wave, lane, pass, chapter, boundary, outcome, rev_before, rev_after,
                    seams_in, seams_out, tokens_in, tokens_out, cost_rub, at, cycle, closed_at)
                  VALUES ('stp_c', 'csc_1', 1, 1, 'forward', 'cascade', 9, '9', NULL, 1, NULL, '[]', '[]', 0, 0, 0, ?, 0, NULL)`)
        .run(new Date(T0).toISOString());
      appendChangeEvent(fixture.db, 'chg_cas', 'processing', {}, T0);
      appendEvent(fixture.db, { kind: 'step.opened', stepId: 'stp_c', cascadeId: 'csc_1', changeId: 'chg_cas', chapter: 9 }, T0 + 1_000);
      bridge.tick();
      const progress = first(frames, 'cascade:progress');
      expect(progress.data).toMatchObject({ cascadeId: 'csc_1', changeId: 'chg_cas', origin: 8 });
    } finally {
      fixture.close();
    }
  });

  it('#22 engine:state announces the day’s pass bound', () => {
    const { fixture, frames, bridge } = siteRig();
    try {
      fixture.db.prepare(`INSERT INTO meta (k, v) VALUES ('engine.heartbeat', ?), ('engine.status', 'running')`).run(
        new Date(T0).toISOString(),
      );
      bridge.tick();
      const state = first(frames, 'engine:state');
      expect(state.data).toMatchObject({ status: 'running', passesToday: 0, maxPasses: 4, writerAt: null, resumeAt: null });
    } finally {
      fixture.close();
    }
  });

  it('#22 a throttled day names its resume time, never a silent stop', () => {
    const { fixture, frames, bridge } = siteRig();
    try {
      fixture.db.prepare(`INSERT INTO meta (k, v) VALUES ('engine.heartbeat', ?), ('engine.status', 'throttled')`).run(
        new Date(T0).toISOString(),
      );
      bridge.tick();
      const state = first(frames, 'engine:state');
      expect(state.data).toMatchObject({ status: 'throttled' });
      expect(state.data.resumeAt).toBe('2026-10-26T00:00:00.000Z');
    } finally {
      fixture.close();
    }
  });

  it('#23 history:event stays a bare tick', () => {
    const { fixture, frames, bridge } = siteRig();
    try {
      appendEvent(fixture.db, { kind: 'document.status', authorKind: 'operator', authorLabel: 'оператор' }, T0);
      bridge.tick();
      const tick = first(frames, 'history:event');
      expect(tick.data).toMatchObject({ at: expect.any(String) });
      expect(Number.isInteger(tick.data.hseq)).toBe(true);
    } finally {
      fixture.close();
    }
  });
});
