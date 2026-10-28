import { RIGHTS_ASSIGNMENT, SUBMIT_LINE, TERMS_VERSION, acceptedTermsText } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { insertComment, readCommentRow } from '../../src/comments/repo.ts';
import { closeChange } from '../../src/engine/close.ts';
import * as store from '../../src/engine/store.ts';
import type { EngineDeps } from '../../src/engine/types.ts';
import { acceptComment } from '../../src/feedback/accept.ts';
import { sha256Hex } from '../../src/util/hash.ts';
import { toIso } from '../../src/util/time.ts';
import { bootComments, commentBody, type CommentBody, type Harness } from './helpers.ts';

/**
 * BOOK-58 §10 — the record of what a reader accepted, and of the moment it was entered.
 *
 * Two facts, two moments, never one standing in for the other:
 *   - **the submission** (`terms_version`, `terms_sha`) is written at posting from the shared
 *     copy: the server is the authority on which terms are in force, and no client sends a
 *     version. The hash is of the exact text `acceptedTermsText()` returns;
 *   - **the acceptance** (`accepted_at`, `accepted_terms_version`) is written when a landed
 *     variant is entered into the book — once, and only for a landing of something the reader
 *     could assign. A note transfers nothing, and a rejected or dropped variant stays the
 *     reader's: no acceptance row and no `applied` event for either.
 *
 * The hash is recomputed here from the shared constants, never hardcoded: a test that pinned a
 * literal would agree with a broken build instead of proving the row.
 */

const RECOMPUTED_SHA = sha256Hex(`${RIGHTS_ASSIGNMENT}\n\n${SUBMIT_LINE}`);

/** A filing the reader can assign: anything with a kind (a note has none). */
const FILING: Partial<CommentBody> = { proposedText: 'Свет в комнате ровный, а не мигает.' };

type TermsRecord = {
  terms_version: string | null;
  terms_sha: string | null;
  accepted_at: string | null;
  accepted_terms_version: string | null;
};

/** A real database, a real app and a real session; the terms are the shipped ones. */
async function withHarness(run: (harness: Harness) => Promise<void> | void): Promise<void> {
  const harness = await bootComments();
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

function engineDeps(harness: Harness): EngineDeps {
  return {
    db: harness.db,
    config: harness.config,
    bookRoot: harness.config.bookRoot,
    clock: { now: () => harness.clock.ms },
    alert: () => undefined,
  };
}

async function post(harness: Harness, overrides: Partial<CommentBody> = {}): Promise<string> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: harness.headers(),
    payload: commentBody(overrides),
  });
  expect(response.statusCode).toBe(201);
  return String(response.json().comment.id);
}

/** BOOK-9: triage records `FITS`; the rights scan already wrote its own verdict at posting. */
function fitForTriage(harness: Harness, commentId: string): void {
  harness.db
    .prepare(`UPDATE comments SET audit_verdict = 'FITS', audited_at = ?, audited_by = 'triage-1' WHERE id = ?`)
    .run(harness.clock.now().toISOString(), commentId);
}

/** The acceptance path the decisions tailer and the CLI share. */
function accept(harness: Harness, commentId: string): string {
  const result = acceptComment(harness.db, {
    comment: readCommentRow(harness.db, commentId)!,
    intent: 'в абзаце дважды одно слово — оставить одно упоминание',
    at: harness.clock.now().toISOString(),
    reason: 'входит в книгу',
  });
  if (!('changeId' in result)) throw new Error(`acceptance refused: ${result.code ?? result.error}`);
  return result.changeId;
}

function changeOf(harness: Harness, changeId: string): store.ChangeRow {
  const change = store.getChange(harness.db, changeId);
  if (change === undefined) throw new Error(`no change ${changeId}`);
  return change;
}

function termsRow(harness: Harness, commentId: string): TermsRecord {
  return harness.db
    .prepare('SELECT terms_version, terms_sha, accepted_at, accepted_terms_version FROM comments WHERE id = ?')
    .get(commentId) as TermsRecord;
}

function appliedEvents(harness: Harness, commentId: string): Array<{ at: string; meta: string | null }> {
  return harness.db
    .prepare(`SELECT at, meta FROM comment_events WHERE comment_id = ? AND type = 'applied' ORDER BY id`)
    .all(commentId) as Array<{ at: string; meta: string | null }>;
}

/**
 * A row written before v19: the kind and the submission are stored, the terms are not. It is
 * seeded through `insertComment` on purpose — that is exactly what an old row looks like.
 */
function seedPreTerms(harness: Harness, id: string): string {
  const at = harness.clock.now().toISOString();
  insertComment(harness.db, {
    id,
    identityId: harness.identity.id,
    chapter: 8,
    blockId: null,
    blockIndex: null,
    baseRev: null,
    quote: null,
    prefix: null,
    suffix: null,
    author: 'Аня',
    body: 'Свет в комнате ровный, а не мигает.',
    proposedText: 'Свет в комнате ровный, а не мигает.',
    interventionKind: 'testimony',
    bodySha: 'a'.repeat(64),
    flags: [],
    ipHash: 'f'.repeat(64),
    status: 'new',
    guard: null,
    reason: null,
    createdAt: at,
    idemKey: null,
  });
  // The two gates acceptance reads, recorded as triage records them.
  harness.db
    .prepare(
      `UPDATE comments SET audit_verdict = 'FITS', audited_at = ?, audited_by = 'triage-1',
         rights_verdict = 'CLEAR', rights_at = ?, rights_source = 'scan' WHERE id = ?`,
    )
    .run(at, at, id);
  return id;
}

describe('the terms a submission records (BOOK-58)', () => {
  it('writes the version in force and the hash of the accepted text at posting', async () => {
    await withHarness(async (harness) => {
      const id = await post(harness, FILING);
      const row = termsRow(harness, id);
      // The server's own version, never one the request carried.
      expect(row.terms_version).toBe(TERMS_VERSION);
      expect(row.terms_sha).toBe(RECOMPUTED_SHA);
      expect(acceptedTermsText()).toBe(`${RIGHTS_ASSIGNMENT}\n\n${SUBMIT_LINE}`);
      // A submission is not a landing: nothing was entered yet.
      expect(row.accepted_at).toBeNull();
      expect(row.accepted_terms_version).toBeNull();
      expect(appliedEvents(harness, id)).toHaveLength(0);
    });
  });

  it('records a landed variant once, with the terms it accepted (AC1, AC4)', async () => {
    for (const outcome of ['applied', 'adapted', 'ripple'] as const) {
      await withHarness(async (harness) => {
        const id = await post(harness, FILING);
        fitForTriage(harness, id);
        const changeId = accept(harness, id);

        harness.clock.advance(60_000);
        const at = toIso(harness.clock.ms);
        closeChange(engineDeps(harness), changeOf(harness, changeId), 'done', outcome, null, harness.clock.ms);

        const row = termsRow(harness, id);
        expect(row.accepted_at, outcome).toBe(at);
        // The version the moment accepted is the row's own — copied, never re-read from today's.
        expect(row.accepted_terms_version, outcome).toBe(row.terms_version);
        const events = appliedEvents(harness, id);
        expect(events, outcome).toHaveLength(1);
        expect(events[0]?.at).toBe(at);
        expect(JSON.parse(events[0]?.meta ?? '{}')).toEqual({
          changeId,
          outcome,
          termsVersion: row.terms_version,
          termsSha: RECOMPUTED_SHA,
        });
      });
    }
  });

  it('records the moment of a pre-terms row, and leaves the terms unknown (BOOK-58)', async () => {
    await withHarness(async (harness) => {
      const id = seedPreTerms(harness, 'cmt_pre_v19');
      expect(termsRow(harness, id).terms_version).toBeNull();
      const changeId = accept(harness, id);

      harness.clock.advance(60_000);
      const at = toIso(harness.clock.ms);
      closeChange(engineDeps(harness), changeOf(harness, changeId), 'done', 'applied', null, harness.clock.ms);

      const row = termsRow(harness, id);
      // The landing is a fact and is recorded; the version is not known and is never guessed.
      expect(row.accepted_at).toBe(at);
      expect(row.accepted_terms_version).toBeNull();
      const events = appliedEvents(harness, id);
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]?.meta ?? '{}')).toEqual({
        changeId,
        outcome: 'applied',
        termsVersion: null,
        termsSha: null,
      });
    });
  });

  it('does not rewrite the moment: a second close appends nothing', async () => {
    await withHarness(async (harness) => {
      const id = await post(harness, FILING);
      fitForTriage(harness, id);
      const changeId = accept(harness, id);
      const change = changeOf(harness, changeId);

      harness.clock.advance(60_000);
      const first = toIso(harness.clock.ms);
      closeChange(engineDeps(harness), change, 'done', 'applied', null, harness.clock.ms);
      // A later close — a replay, a second writer, an operator re-run — must not move the moment.
      harness.clock.advance(3_600_000);
      closeChange(engineDeps(harness), change, 'done', 'adapted', null, harness.clock.ms);

      const row = termsRow(harness, id);
      expect(row.accepted_at).toBe(first);
      expect(appliedEvents(harness, id)).toHaveLength(1);
    });
  });

  it('accepts nothing for a landed note: a note transfers nothing', async () => {
    await withHarness(async (harness) => {
      // No `proposedText`, hence no kind: the row the page calls «замечание сохранено».
      const id = await post(harness);
      fitForTriage(harness, id);
      // Acceptance reads the gates, not the kind — a note becomes an ordinary change.
      const changeId = accept(harness, id);
      expect(changeOf(harness, changeId).source_comment).toBe(id);

      harness.clock.advance(60_000);
      closeChange(engineDeps(harness), changeOf(harness, changeId), 'done', 'applied', null, harness.clock.ms);

      const row = termsRow(harness, id);
      // The submission is on the record; a right that never moved is not.
      expect(row.terms_version).toBe(TERMS_VERSION);
      expect(row.accepted_at).toBeNull();
      expect(row.accepted_terms_version).toBeNull();
      expect(appliedEvents(harness, id)).toHaveLength(0);
    });
  });

  it('writes nothing for a variant that never landed', async () => {
    // A triaged rejection never becomes a change at all.
    await withHarness(async (harness) => {
      const id = await post(harness, FILING);
      harness.db
        .prepare(`UPDATE comments SET status = 'rejected', decided_at = ?, reason = 'не входит в книгу' WHERE id = ?`)
        .run(harness.clock.now().toISOString(), id);
      expect(harness.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
      const rejected = termsRow(harness, id);
      expect(rejected.accepted_at).toBeNull();
      expect(appliedEvents(harness, id)).toHaveLength(0);
    });
    // A change that was closed as dropped decided against the variant, and records no landing.
    await withHarness(async (harness) => {
      const id = await post(harness, FILING);
      fitForTriage(harness, id);
      const changeId = accept(harness, id);
      closeChange(engineDeps(harness), changeOf(harness, changeId), 'void', 'dropped', 'не входит в книгу', harness.clock.ms);

      const row = termsRow(harness, id);
      expect(row.accepted_at).toBeNull();
      expect(row.accepted_terms_version).toBeNull();
      expect(appliedEvents(harness, id)).toHaveLength(0);
    });
  });

  it('has nothing to accept for a change the site made for itself', async () => {
    await withHarness(async (harness) => {
      const changeId = 'chg_operator_1';
      store.insertChange(harness.db, {
        id: changeId,
        kind: 'operator',
        interventionKind: null,
        chapter: 8,
        anchor: null,
        intent: 'поправить пунктуацию',
        proposedText: null,
        sourceComment: null,
        sourceSession: null,
        baseRev: 1,
        baseSha: '',
        baseBlocks: '[]',
        scopeHint: 'phrase',
        premise: 0,
        enqueuedAt: harness.clock.now().toISOString(),
      });
      closeChange(engineDeps(harness), changeOf(harness, changeId), 'done', 'applied', null, harness.clock.ms);
      // No reader row exists, so no terms are closed and no acceptance is invented.
      expect(harness.db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'applied'`).get()).toEqual({
        n: 0,
      });
    });
  });
});
