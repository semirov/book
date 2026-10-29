import { describe, expect, it } from 'vitest';

import { appendCommentEvent, insertComment } from '../src/comments/repo.ts';
import { appendEvent } from '../src/history/log.ts';
import { insertStep, updateStep } from '../src/engine/store.ts';
import { liveSnapshot } from '../src/ws/live.ts';
import { first, engineRig, siteRig, T0 } from './frameRig.ts';

/**
 * BOOK-DOC-84 §10 — the now state's own fields: `live.reading`, `live.lastCost`, and the ladder
 * on `pass:accepted` (attempt, ceiling, widening, retry, the desperate sixth). Split from
 * `frameCoverageEngine.test.ts` at the arch bound; the rigs are the same ones.
 */

describe('§10.1 — the live block restores the reading', () => {
  it('carries the open reading and the last price from rows only', () => {
    const { fixture } = siteRig();
    try {
      const at = new Date(T0).toISOString();
      fixture.db
        .prepare(`INSERT INTO identities (id, yandex_sub, display_name, created_at, last_seen_at) VALUES ('idt_l','sub','Аня',?,?)`)
        .run(at, at);
      insertComment(fixture.db, {
        id: 'cmt_live',
        identityId: 'idt_l',
        chapter: 6,
        blockId: null,
        blockIndex: null,
        baseRev: null,
        quote: null,
        prefix: null,
        suffix: null,
        author: 'Аня',
        body: 'Служебная правка для живого чтения.',
        proposedText: null,
        interventionKind: null,
        bodySha: '1'.repeat(64),
        flags: [],
        ipHash: '2'.repeat(64),
        status: 'new',
        guard: null,
        reason: null,
        createdAt: at,
        idemKey: null,
      });
      fixture.db.prepare(`UPDATE comments SET rights_verdict = 'CLEAR' WHERE id = 'cmt_live'`).run();
      fixture.db
        .prepare(`INSERT INTO comment_attempts (comment_id, n, at, day, body_sha, anchor_sha, outcome, tries, claim_until)
                  VALUES ('cmt_live', 1, ?, ?, 'sha', 'anchor', 'submitted', 1, ?)`)
        .run(at, at.slice(0, 10), new Date(T0 + 900_000).toISOString());
      appendCommentEvent(fixture.db, 'cmt_live', 'triage.claimed', at, { attempt: 1, try: 1 });
      fixture.db
        .prepare(
          `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, change_id, model, tokens_in, tokens_out, usd, priced, provenance)
           VALUES (?, ?, 'stp_last', 6, 'draft', NULL, 'm', 10, 5, 0.25, 1, 'pipeline')`,
        )
        .run(at, at.slice(0, 10));

      const live = liveSnapshot(
        { db: fixture.db, dataDir: fixture.dataDir, now: () => T0, queueSoftCap: 33, maxPasses: 4 },
        'idt_l',
      );
      expect(live.reading).toMatchObject({
        commentId: 'cmt_live',
        chapter: 6,
        phase: 'claimed',
        attempt: 1,
        maxAttempts: 5,
        since: T0,
        deadlineAt: T0 + 900_000,
        reason: null,
      });
      expect(live.lastCost).toEqual({ kind: 'pass', usd: 0.25, at: T0, estimated: false, dayUsd: 0.25 });
    } finally {
      fixture.close();
    }
  });

});

describe('§10.8 — the ladder on the pass frame', () => {
  it('#14 pass:accepted carries the attempt, the ceiling, the widening and the retry', () => {
    const { fixture, frames, bridge } = engineRig();
    try {
      insertStep(fixture.db, {
        stepId: 'stp_widened',
        cascadeId: null,
        seq: 3,
        wave: 0,
        lane: 'forward',
        pass: 'draft',
        chapter: 6,
        boundary: '6',
        seamsIn: '[]',
        revBefore: 1,
        at: new Date(T0).toISOString(),
      });
      updateStep(fixture.db, 'stp_widened', { widened: 'wider-edit', mode: 'rewrite' });
      // Two leases = the second attempt (the first session died); §10.8 names it.
      for (const [id, at] of [
        ['lea_w1', T0],
        ['lea_w2', T0 + 60_000],
      ] as const) {
        fixture.db
          .prepare(
            `INSERT INTO leases (id, step_id, change_id, lane, chapter, is_front, kind, session, expected_rev, acquired_at, heartbeat_at, expires_at, released_at, release_reason)
             VALUES (?, 'stp_widened', NULL, 'forward', 6, 0, 'draft', 'writer', 1, ?, ?, ?, ?, 'expired')`,
          )
          .run(id, new Date(at).toISOString(), new Date(at).toISOString(), new Date(at + 120_000).toISOString(), new Date(at + 120_000).toISOString());
      }
      appendEvent(fixture.db, { kind: 'step.opened', stepId: 'stp_widened', chapter: 6, payload: { pass: 'draft', reissued: true } }, T0 + 60_000);
      bridge.tick();
      const accepted = first(frames, 'pass:accepted');
      expect(accepted.data).toMatchObject({
        stepId: 'stp_widened',
        attempt: 2,
        maxAttempts: 5,
        widened: { code: 'wider-edit', sentence: 'правим шире: не строку, а абзац' },
        desperate: false,
        retryAt: T0 + 60_000,
        deadlineAt: T0 + 60_000 + 225 * 60_000,
      });
    } finally {
      fixture.close();
    }
  });

  it('#14 a desperate attempt is 6 of 6 with its own short bound', () => {
    const { fixture, frames, bridge } = engineRig();
    try {
      insertStep(fixture.db, {
        stepId: 'stp_desperate',
        cascadeId: null,
        seq: 4,
        wave: 0,
        lane: 'forward',
        pass: 'draft',
        chapter: 7,
        boundary: '7',
        seamsIn: '[]',
        revBefore: 1,
        at: new Date(T0).toISOString(),
      });
      updateStep(fixture.db, 'stp_desperate', { desperate: 1, widened: 'whole-chapter' });
      appendEvent(fixture.db, { kind: 'step.opened', stepId: 'stp_desperate', chapter: 7, payload: { pass: 'draft', reissued: true, desperate: true } }, T0);
      bridge.tick();
      const accepted = first(frames, 'pass:accepted');
      expect(accepted.data).toMatchObject({
        attempt: 6,
        maxAttempts: 6,
        desperate: true,
        deadlineAt: T0 + 180_000,
      });
    } finally {
      fixture.close();
    }
  });

});
