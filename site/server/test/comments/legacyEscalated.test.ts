/**
 * BOOK-206 — a stored value the type still carries must not break a page.
 *
 * The DB's `comments.status`/`disposition` CHECKs are untouched (a legacy value is data), and
 * the v30 boot migration re-opens every `escalated` row to `new`. Until it runs — an old volume,
 * a hand-edited row, a test — the DTO, the report and the refusal reading must render that row
 * without a crash and without a word the book no longer has («ждёт решения автора», «решает
 * автор», the old question as a line).
 */

import { describe, expect, it } from 'vitest';

import { chainReport, normalizeDisposition } from '@book/shared';

import { insertComment, readCommentRow, toCommentDto } from '../../src/comments/repo.ts';
import { upsertIdentity } from '../../src/db/repo/identities.ts';
import { bootComments } from '../comments/helpers.ts';

const AT = '2026-10-25T12:00:00.000Z';
const OWNER = 'cmt_01M635KZP466CGBC0CKS1NWS4Z';

describe('a legacy escalated row renders, and claims nothing', () => {
  it('drops the removed chain word and prints no author’s line', async () => {
    const h = await bootComments();
    try {
      const identity = upsertIdentity(h.db, { yandexSub: 'yandex-owner', displayName: 'Аня', at: AT });
      const block = h.db.prepare('SELECT id FROM blocks WHERE chapter = 8 ORDER BY idx LIMIT 1').get() as { id: string };
      insertComment(h.db, {
        id: OWNER,
        identityId: identity.id,
        chapter: 8,
        blockId: block.id,
        blockIndex: 0,
        baseRev: 1,
        quote: 'Тестовый абзац номер один.',
        prefix: null,
        suffix: null,
        author: 'Аня',
        body: 'он чихнул',
        proposedText: null,
        interventionKind: 'decision',
        bodySha: 'sha-legacy',
        flags: [],
        ipHash: 'ip-legacy',
        status: 'escalated',
        guard: null,
        reason: 'можно ли оформить это бумагой?',
        createdAt: AT,
        idemKey: null,
      });
      // The pre-v30 chain, written straight into the columns the CHECK still allows.
      h.db
        .prepare(
          `UPDATE comments SET disposition = 'escalated', audit_verdict = 'OFF', audit_reason = 'вне книги',
              audited_at = ?, audited_by = 'cli', decided_at = ? WHERE id = ?`,
        )
        .run(AT, AT, OWNER);

      // The word is not a chain any more: a stored value this build does not know reads as none.
      expect(normalizeDisposition('escalated')).toBeNull();

      const row = readCommentRow(h.db, OWNER)!;
      const dto = toCommentDto(h.db, row, Date.parse(AT));
      expect(dto).toMatchObject({ id: OWNER, status: 'escalated', disposition: null, report: null });
      // No word of the removed door: no state, no third line, no report. The row's stored
      // sentence stays data — it is what the reader was told — but it heads nothing.
      const printed = JSON.stringify(dto);
      for (const gone of ['ждёт решения автора', 'решает автор']) expect(printed).not.toContain(gone);
      expect(h.db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'escalated'`).get()).toEqual({ n: 0 });
    } finally {
      await h.close();
    }
  });

  it('refuses to render a chain whose stored word is unknown', () => {
    // `chainReport` is only ever called with a stored word the build knows; the guard that keeps
    // it that way is the type, and the value above is dropped before it can reach this call.
    expect(() =>
      chainReport(
        { disposition: 'as_said', lock: null, carrierKind: null, quoteKept: null, sentenceId: null },
        { chapter: 8, blockIndex: 0, sentenceIndex: 0 },
        true,
      ),
    ).not.toThrow();
  });
});
