import { describe, expect, it } from 'vitest';

import { isUniqueViolation } from '../../src/comments/service.ts';
import { insertComment } from '../../src/comments/repo.ts';
import { upsertIdentity } from '../../src/db/repo/identities.ts';
import { createFixture } from '../helpers.ts';

/**
 * The one shape a test cannot stage through the service: the driver's UNIQUE error. The
 * predicate is checked against a *real* `better-sqlite3` error, not a hand-written object,
 * because its message text (`UNIQUE constraint failed: comments.idem_key`) is the contract.
 */

function newRow(id: string, idemKey: string | null, identityId = 'idt_1') {
  return {
    id,
    identityId,
    chapter: 8,
    blockId: null,
    blockIndex: null,
    baseRev: 1,
    quote: null,
    prefix: null,
    suffix: null,
    author: 'Аня',
    body: 'Замечание с ключом идемпотентности.',
    proposedText: null,
    interventionKind: null,
    bodySha: 'sha',
    flags: [],
    ipHash: 'hash',
    status: 'new' as const,
    guard: null,
    reason: null,
    createdAt: '2026-10-25T12:00:00.000Z',
    idemKey,
  };
}

describe('isUniqueViolation', () => {
  it('recognises the real duplicate-key error of the comments table', () => {
    const fixture = createFixture();
    try {
      const identity = upsertIdentity(fixture.db, {
        yandexSub: 'yandex-idem',
        displayName: 'Аня',
        at: '2026-10-25T12:00:00.000Z',
      });
      insertComment(fixture.db, newRow('cmt_one', 'same-key', identity.id));
      let caught: unknown = null;
      try {
        insertComment(fixture.db, newRow('cmt_two', 'same-key', identity.id));
      } catch (error) {
        caught = error;
      }
      expect(caught).not.toBeNull();
      expect(isUniqueViolation(caught)).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it('refuses to swallow any other failure', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: comments.idem_key'))).toBe(false);
    expect(isUniqueViolation({ code: 'SQLITE_BUSY', message: 'database is locked' })).toBe(false);
    // A key collision on the primary key is not a replay: it must surface, not be answered
    // with someone else's comment.
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY', message: 'UNIQUE constraint failed: comments.id' })).toBe(
      false,
    );
  });
});
