/**
 * Acceptance requires three columns (BOOK-61, BOOK-DOC-42 §1 point 4, §5).
 *
 * `status <> 'quarantined'` (A), `rights_verdict = 'CLEAR'` (B), `audit_verdict = 'FITS'` (C) —
 * three writers, no default. Both creators of a `changes` row read the same three: this test
 * asks `acceptComment` and the internal queue route the same questions, and proves that inside
 * one column the first verdict wins.
 */

import { describe, expect, it } from 'vitest';

import { insertComment, readCommentRow } from '../../src/comments/repo.ts';
import { upsertIdentity } from '../../src/db/repo/identities.ts';
import { acceptComment } from '../../src/feedback/accept.ts';
import { recordRights, flagRights } from '../../src/rights/record.ts';
import { createEngineFixture } from '../engine/helpers.ts';

const AT = '2026-10-27T12:00:00Z';

type Fixture = ReturnType<typeof createEngineFixture>;

function boot(): Fixture {
  return createEngineFixture({ chapters: { 1: 'Глава\n\nТестовый абзац номер один.' } });
}

function seed(fixture: Fixture, id: string): string {
  const identity = upsertIdentity(fixture.db, { yandexSub: 'yandex-1', displayName: 'Аня', at: AT });
  insertComment(fixture.db, {
    id,
    identityId: identity.id,
    chapter: 8,
    blockId: null,
    blockIndex: null,
    baseRev: 1,
    quote: null,
    prefix: null,
    suffix: null,
    author: 'Аня',
    body: 'В абзаце дважды «абзац» — оставить одно упоминание.',
    proposedText: null,
    interventionKind: null,
    bodySha: 'a'.repeat(64),
    flags: [],
    ipHash: 'f'.repeat(64),
    status: 'new',
    guard: null,
    reason: null,
    createdAt: '2026-10-27T09:00:00Z',
    idemKey: null,
  });
  return id;
}

function stamp(fixture: Fixture, id: string, sql: string, ...args: Array<string>): void {
  fixture.db.prepare(`UPDATE comments SET ${sql} WHERE id = ?`).run(...args, id);
}

function accept(fixture: Fixture, id: string) {
  return acceptComment(fixture.db, {
    comment: readCommentRow(fixture.db, id)!,
    intent: 'в абзаце дважды «абзац» — оставить одно упоминание',
    at: AT,
    reason: 'повтор',
  });
}

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'THROWN';
  }
}

describe('acceptance — three columns, three writers, no default', () => {
  it('refuses a row the rights gate has not cleared', () => {
    const fixture = boot();
    try {
      const id = seed(fixture, 'cmt_no_rights');
      stamp(fixture, id, `audit_verdict = 'FITS'`);
      expect(accept(fixture, id)).toMatchObject({ code: 'RIGHTS_REQUIRED' });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it('refuses a held row even with a clearance and a FITS', () => {
    const fixture = boot();
    try {
      const id = seed(fixture, 'cmt_held');
      stamp(
        fixture,
        id,
        `status = 'quarantined', held_rule = 'INJ-IMPERATIVE', held_by = 'filter',
         rights_verdict = 'CLEAR', audit_verdict = 'FITS'`,
      );
      expect(accept(fixture, id)).toMatchObject({ code: 'QUARANTINED' });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it('refuses a cleared row the auditor has not fitted', () => {
    const fixture = boot();
    try {
      const id = seed(fixture, 'cmt_no_audit');
      stamp(fixture, id, `rights_verdict = 'CLEAR'`);
      expect(accept(fixture, id)).toMatchObject({ code: 'AUDIT_REQUIRED' });
    } finally {
      fixture.close();
    }
  });

  it('accepts only the row that carries all three, and records the change', () => {
    const fixture = boot();
    try {
      const id = seed(fixture, 'cmt_all');
      stamp(fixture, id, `rights_verdict = 'CLEAR', audit_verdict = 'FITS'`);
      const accepted = accept(fixture, id);
      expect(accepted).toMatchObject({ created: true });
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });
      expect(readCommentRow(fixture.db, id)?.status).toBe('accepted');
    } finally {
      fixture.close();
    }
  });

  it('keeps the first verdict inside the rights column', () => {
    const fixture = boot();
    try {
      const id = seed(fixture, 'cmt_first');
      const first = recordRights(fixture.db, {
        commentId: id,
        verdict: 'REFUSED',
        rule: 'STOP-DRUGS',
        source: 'scan',
        by: null,
        at: AT,
      });
      expect(first).toEqual({ ok: true, verdict: 'REFUSED' });
      const second = recordRights(fixture.db, {
        commentId: id,
        verdict: 'CLEAR',
        rule: null,
        source: 'model',
        by: null,
        at: AT,
      });
      expect(second).toMatchObject({ code: 'RIGHTS_ALREADY_RECORDED' });
      const row = readCommentRow(fixture.db, id);
      expect(row).toMatchObject({ rights_verdict: 'REFUSED', rights_rule: 'STOP-DRUGS', status: 'rejected' });
      // The refusal is the reader's own line and the body never represents it.
      expect(row?.reason).toBe('не принято: содержимое вне закона');
      expect(JSON.parse(row?.flags ?? '[]')).toContain('illegal-content');
    } finally {
      fixture.close();
    }
  });

  it('refuses a refusal without a rule, and a CLEAR that names one', () => {    const fixture = boot();
    try {
      const id = seed(fixture, 'cmt_rules');
      const refused = recordRights(fixture.db, {
        commentId: id,
        verdict: 'REFUSED',
        rule: null,
        source: 'model',
        by: null,
        at: AT,
      });
      const cleared = recordRights(fixture.db, {
        commentId: id,
        verdict: 'CLEAR',
        rule: 'RIGHTS-QUOTE',
        source: 'model',
        by: null,
        at: AT,
      });
      expect(refused).toMatchObject({ ok: false, code: 'RIGHTS_RULE_REQUIRED' });
      expect(cleared).toMatchObject({ ok: false, code: 'RIGHTS_RULE_WITH_CLEAR' });
      expect(readCommentRow(fixture.db, id)?.rights_verdict).toBeNull();
    } finally {
      fixture.close();
    }
  });
  it('refuses an unknown rule, a missing row and a label past its bound', () => {
    const fixture = boot();
    try {
      const id = seed(fixture, 'cmt_guards');
      expect(
        recordRights(fixture.db, {
          commentId: id,
          verdict: 'REFUSED',
          rule: 'STOP-NOPE' as never,
          source: 'operator',
          by: null,
          at: AT,
        }),
      ).toMatchObject({ code: 'RIGHTS_RULE_UNKNOWN' });
      expect(
        recordRights(fixture.db, {
          commentId: 'cmt_absent',
          verdict: 'CLEAR',
          rule: null,
          source: 'scan',
          by: null,
          at: AT,
        }),
      ).toMatchObject({ code: 'RIGHTS_UNKNOWN_COMMENT' });
      expect(
        recordRights(fixture.db, {
          commentId: id,
          verdict: 'CLEAR',
          rule: null,
          source: 'operator',
          by: 'я'.repeat(80),
          at: AT,
        }),
      ).toMatchObject({ code: 'RIGHTS_LABEL_TOO_LONG' });
      expect(readCommentRow(fixture.db, id)?.rights_verdict).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('flags once per row: a second attempt writes no second event', () => {
    const fixture = boot();
    try {
      const id = seed(fixture, 'cmt_flag');
      expect(flagRights(fixture.db, { commentId: id, detail: 'a long name', at: AT })).toBe(true);
      expect(flagRights(fixture.db, { commentId: id, detail: 'a long name', at: AT })).toBe(false);
      const events = fixture.db
        .prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE comment_id = ? AND type = 'rights'`)
        .get(id) as { n: number };
      expect(events.n).toBe(1);
      // A verdict, once written, closes the column to a flag.
      recordRights(fixture.db, { commentId: id, verdict: 'CLEAR', rule: null, source: 'model', by: null, at: AT });
      expect(flagRights(fixture.db, { commentId: id, detail: 'again', at: AT })).toBe(false);
    } finally {
      fixture.close();
    }
  });
});

describe('the internal queue route asks the same three questions', () => {  it('refuses a held row and a row without a rights verdict, and takes the cleared one', () => {
    const fixture = boot();
    try {
      const held = seed(fixture, 'cmt_q_held');
      stamp(fixture, held, `status = 'quarantined', rights_verdict = 'CLEAR', audit_verdict = 'FITS'`);
      const noRights = seed(fixture, 'cmt_q_rights');
      stamp(fixture, noRights, `audit_verdict = 'FITS'`);
      const ready = seed(fixture, 'cmt_q_ready');
      stamp(fixture, ready, `rights_verdict = 'CLEAR', audit_verdict = 'FITS'`);

      const enqueue = (commentId: string) =>
        fixture.engine.enqueue({
          kind: 'accepted_comment',
          chapter: 1,
          intent: 'убрать абзац',
          commentId,
        });

      expect(codeOf(() => enqueue(held))).toBe('QUARANTINED');
      expect(codeOf(() => enqueue(noRights))).toBe('RIGHTS_REQUIRED');
      expect(enqueue(ready)).toMatchObject({ status: 'pending' });
    } finally {
      fixture.close();
    }
  });
});
