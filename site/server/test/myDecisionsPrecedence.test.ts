import { afterEach, describe, expect, it } from 'vitest';

import type { MyDecisionsDto } from '@book/shared';

import { bootComments, type Harness } from './comments/helpers.ts';
import { seedChange, seedComment } from './myDecisions/seeds.ts';

/**
 * BOOK-136/BOOK-206 B2 — one filing, one newest fact.
 *
 * A premise that landed and a **later** pass the engine stopped is `refused` with the stop's own
 * sentence; a landing **newer** than the stop is the answer. The DTO half of the same rule is
 * `commentsFilingState.test.ts`; this file is `/api/me/decisions`, which used to read only the
 * linked change row and so answered the older fact whenever `comments.change_id` was stale.
 */

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function mine(h: Harness): Promise<MyDecisionsDto> {
  return h.app
    .inject({ method: 'GET', url: '/api/me/decisions', headers: h.headers() })
    .then((response) => response.json() as MyDecisionsDto);
}

describe('GET /api/me/decisions — the newest change decides (BOOK-136)', () => {
  it('reads the newest fact: a stop after a premise’s landing, and a landing after a stop (BOOK-136)', async () => {
    harness = await bootComments();
    // A premise that landed, then a later pass the engine stopped; the link still names the landing.
    seedComment(harness, {
      id: 'cmt_pstop',
      identityId: harness.identity.id,
      status: 'accepted',
      decidedAt: '2026-10-25T12:00:00Z',
      reason: 'принято в основу',
      auditVerdict: 'FITS',
    });
    seedChange(harness, {
      id: 'chg_pold',
      seq: 7,
      status: 'done',
      outcome: 'applied',
      commentId: 'cmt_pstop',
      finishedAt: '2026-10-25T13:00:00Z',
    });
    seedChange(harness, {
      id: 'chg_pstop',
      seq: 8,
      status: 'escalated',
      outcome: 'gate_timeout',
      reason: 'проверка не ответила вовремя — шаг остановлен',
      commentId: 'cmt_pstop',
      finishedAt: '2026-10-25T14:00:00Z',
    });
    harness.db.prepare(`UPDATE changes SET premise = 1 WHERE id IN ('chg_pold', 'chg_pstop')`).run();
    harness.db.prepare('UPDATE comments SET change_id = ? WHERE id = ?').run('chg_pold', 'cmt_pstop');

    const stopped = (await mine(harness)).items.find((item) => item.commentId === 'cmt_pstop');
    expect(stopped).toMatchObject({
      outcome: 'refused',
      reason: 'проверка не ответила вовремя — шаг остановлен',
      waves: null,
      blocks: null,
      chapters: [],
    });

    // The other way round: a landing **newer** than the stop is the answer, and the numbers are
    // the landing's own — the linked stop's projection is never borrowed.
    seedComment(harness, {
      id: 'cmt_pland',
      identityId: harness.identity.id,
      status: 'accepted',
      decidedAt: '2026-10-25T12:00:00Z',
      reason: 'принято в основу',
      auditVerdict: 'FITS',
    });
    seedChange(harness, {
      id: 'chg_stop0',
      seq: 9,
      status: 'escalated',
      outcome: 'gate_timeout',
      reason: 'проверка не ответила вовремя — шаг остановлен',
      commentId: 'cmt_pland',
      finishedAt: '2026-10-25T13:00:00Z',
    });
    seedChange(harness, {
      id: 'chg_land1',
      seq: 10,
      status: 'done',
      outcome: 'applied',
      commentId: 'cmt_pland',
      finishedAt: '2026-10-25T14:00:00Z',
    });
    harness.db.prepare(`UPDATE changes SET premise = 1 WHERE id IN ('chg_stop0', 'chg_land1')`).run();
    harness.db.prepare('UPDATE comments SET change_id = ? WHERE id = ?').run('chg_stop0', 'cmt_pland');

    const landed = (await mine(harness)).items.find((item) => item.commentId === 'cmt_pland');
    expect(landed).toMatchObject({
      commentId: 'cmt_pland',
      changeId: 'chg_land1',
      outcome: 'applied',
      reason: null,
      waves: null,
      blocks: null,
    });
  });
});
