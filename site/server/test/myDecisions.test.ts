import { afterEach, describe, expect, it } from 'vitest';

import type { MyDecisionsDto, MyTraceDto } from '@book/shared';

import { EngineBridge } from '../src/engineState/bridge.ts';
import { appendChangeEvent } from '../src/history/log.ts';
import { bootComments, type Harness } from './comments/helpers.ts';
import {
  otherReader,
  seedCascade,
  seedChange,
  seedComment,
  seedImpact,
  seedSurviving,
} from './myDecisions/seeds.ts';

/**
 * BOOK-13 — a reader's own decision is addressed to them and stays: `GET /api/me/decisions`
 * is session-only and own-only, a refusal carries its public reason and no invented numbers,
 * and the share is the one `/api/authors/me` prints at the same moment. The live path is the
 * existing `change:decided` frame: it names the comment, and only that id makes it «yours».
 */

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** One applied intervention of reader A: the shape the engine closes it with. */
function seededA(h: Harness): void {
  seedComment(h, {
    id: 'cmt_A',
    identityId: h.identity.id,
    status: 'applied',
    decidedAt: '2026-10-25T12:00:00Z',
    auditVerdict: 'FITS',
    reason: 'принято',
  });
  seedChange(h, {
    id: 'chg_A',
    seq: 11,
    status: 'done',
    outcome: 'applied',
    intent: 'внести документ о регистрации сенсора в главу 8',
    commentId: 'cmt_A',
    cascadeId: 'csc_A',
    finishedAt: '2026-10-25T12:30:00Z',
  });
  seedCascade(h, 'csc_A', 'chg_A', 3);
  seedImpact(h, 'chg_A', [7, 8, 9], 12);
}

function get(h: Harness, cookie?: string) {
  return h.app.inject({
    method: 'GET',
    url: '/api/me/decisions',
    ...(cookie === undefined ? {} : { headers: { cookie: `book_session=${cookie}` } }),
  });
}

function mine(h: Harness): Promise<MyDecisionsDto> {
  return get(h, h.cookie).then((response) => response.json() as MyDecisionsDto);
}

describe('GET /api/me/decisions (BOOK-13)', () => {
  it('refuses an anonymous visitor in the shared auth shape', async () => {
    harness = await bootComments();
    const response = await get(harness);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(String(response.headers['cache-control'])).toContain('no-store');
  });

  it('gives a reader with no interventions nothing — no fake zero card', async () => {
    harness = await bootComments();
    const response = await get(harness, harness.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], open: [], share: 0 });
  });

  it('answers a zero share for a book with no measured text, and a refusal with no line at all', async () => {
    harness = await bootComments();
    harness.db.prepare('DELETE FROM block_versions').run();
    seedComment(harness, {
      id: 'cmt_silent',
      identityId: harness.identity.id,
      status: 'rejected',
      decidedAt: '2026-10-25T12:00:00Z',
    });
    const decisions = await mine(harness);
    expect(decisions.share).toBe(0);
    expect(decisions.items[0]).toMatchObject({ outcome: 'refused', reason: null });
  });

  it('shows an own decision with its chapters, waves and paragraphs — and never to another reader', async () => {
    harness = await bootComments();
    const boris = otherReader(harness);
    seededA(harness);
    seedComment(harness, {
      id: 'cmt_B',
      identityId: boris.identity.id,
      status: 'applied',
      decidedAt: '2026-10-25T12:10:00Z',
    });
    seedChange(harness, {
      id: 'chg_B',
      seq: 12,
      status: 'done',
      outcome: 'applied',
      intent: 'чужая правка',
      commentId: 'cmt_B',
      finishedAt: '2026-10-25T12:40:00Z',
    });

    const myDecisions = await mine(harness);
    expect(myDecisions.items).toHaveLength(1);
    expect(myDecisions.items[0]).toMatchObject({
      commentId: 'cmt_A',
      changeId: 'chg_A',
      chapter: 8,
      outcome: 'applied',
      chapters: [7, 8, 9],
      waves: 3,
      blocks: 12,
      intent: 'внести документ о регистрации сенсора в главу 8',
      decidedAt: '2026-10-25T12:30:00Z',
    });

    // Own only: no identity key at all, and the other reader's record is unreachable here.
    const body = JSON.stringify(myDecisions);
    expect(body).not.toContain(harness.identity.id);
    expect(body).not.toContain(boris.identity.id);
    expect(body).not.toContain('Борис');

    const theirs = (await get(harness, boris.cookie)).json() as MyDecisionsDto;
    expect(theirs.items.map((item) => item.commentId)).toEqual(['cmt_B']);
    expect(JSON.stringify(theirs)).not.toContain('cmt_A');

    // No id parameter can widen the record: the identity is the cookie, and a query string
    // naming the other reader is answered with the caller's own list.
    const viaQuery = await harness.app.inject({
      method: 'GET',
      url: `/api/me/decisions?identity=${boris.identity.id}&id=cmt_B`,
      headers: { cookie: harness.sessionCookieHeader },
    });
    expect(viaQuery.json()).toEqual(myDecisions);
  });

  it('is durable: the same decision answers a reload without any live frame', async () => {
    harness = await bootComments();
    seededA(harness);
    const first = await mine(harness);
    const second = await mine(harness);
    expect(second).toEqual(first);
    expect(second.items[0]?.commentId).toBe('cmt_A');
  });

  it('prints the same share number /api/authors/me reports at that moment', async () => {
    harness = await bootComments();
    seededA(harness);
    seedSurviving(harness, harness.identity.id, 'bkd_me', 4_000);
    const boris = otherReader(harness);
    seedSurviving(harness, boris.identity.id, 'bkd_boris', 96_000);

    const decisions = await mine(harness);
    const trace = (
      await harness.app.inject({
        method: 'GET',
        url: '/api/authors/me',
        headers: { cookie: harness.sessionCookieHeader },
      })
    ).json() as MyTraceDto;

    expect(decisions.share).toBe(trace.share);
    expect(decisions.share).toBeGreaterThan(0);
    // Floored to six decimals, like every printed share, so a column cannot sum above 1.
    expect(decisions.share * 1_000_000).toBe(Math.floor(decisions.share * 1_000_000));
  });

  it('carries the measured share of the decision day, never a curve', async () => {
    harness = await bootComments();
    seededA(harness);
    harness.db
      .prepare(
        `INSERT INTO contribution_history (identity_id, day, edits, chars, share, measured_at)
         VALUES (?, '2026-10-24', 1, 100, 0.0099, '2026-10-24T03:00:00Z'),
                (?, '2026-10-25', 2, 200, 0.0123, '2026-10-25T03:00:00Z')`,
      )
      .run(harness.identity.id, harness.identity.id);

    // The number travels with the day it was measured on, never with the decision's day.
    expect((await mine(harness)).items[0]?.shareAtDecision).toEqual({ share: 0.0123, day: '2026-10-25' });

    // A decision before any measurement has no number at all — not a zero, not a guess.
    harness.db.prepare(`UPDATE changes SET finished_at = '2026-10-01T12:00:00Z' WHERE id = 'chg_A'`).run();
    expect((await mine(harness)).items[0]?.shareAtDecision).toBeNull();

    // A decision after the last measurement carries that measurement's own earlier day.
    harness.db.prepare(`UPDATE changes SET finished_at = '2026-10-27T12:00:00Z' WHERE id = 'chg_A'`).run();
    expect((await mine(harness)).items[0]?.shareAtDecision).toEqual({ share: 0.0123, day: '2026-10-25' });
  });

  it('tells a refusal by its public reason and invents no numbers', async () => {
    harness = await bootComments();
    seedComment(harness, {
      id: 'cmt_off',
      identityId: harness.identity.id,
      status: 'rejected',
      decidedAt: '2026-10-25T12:05:00Z',
      reason: 'правка не про эту книгу: здесь нет утешения',
      auditVerdict: 'OFF',
    });
    seedComment(harness, {
      id: 'cmt_guard',
      identityId: harness.identity.id,
      status: 'rejected',
      reason: 'в книге нет готовых лозунгов',
      createdAt: '2026-10-25T12:20:00Z',
    });

    const decisions = await mine(harness);
    expect(decisions.items.map((item) => item.outcome)).toEqual(['refused', 'refused']);
    const [guard, auditor] = decisions.items;
    expect(auditor).toMatchObject({
      commentId: 'cmt_off',
      reason: 'правка не про эту книгу: здесь нет утешения',
      chapters: [],
      waves: null,
      blocks: null,
      shareAtDecision: null,
      intent: null,
      changeId: null,
    });
    expect(guard?.reason).toBe('в книге нет готовых лозунгов');
    expect(guard?.decidedAt).toBe('2026-10-25T12:20:00Z');
  });

  it('says a change a gate stopped is not accepted, and keeps no wave or share claim', async () => {
    harness = await bootComments();
    seedComment(harness, {
      id: 'cmt_esc',
      identityId: harness.identity.id,
      status: 'accepted',
      decidedAt: '2026-10-25T12:00:00Z',
      auditVerdict: 'FITS',
    });
    seedChange(harness, {
      id: 'chg_esc',
      seq: 4,
      status: 'escalated',
      outcome: 'origin',
      reason: 'дальше нужен автор: правка меняет решение героя',
      intent: 'изменить решение героя в главе 8',
      commentId: 'cmt_esc',
      cascadeId: 'csc_esc',
      finishedAt: '2026-10-25T13:00:00Z',
    });
    seedCascade(harness, 'csc_esc', 'chg_esc', 2);
    seedImpact(harness, 'chg_esc', [8, 9], 5);

    // BOOK-206: the reader's own vocabulary has no «waits for the author» — a stopped change is
    // «не принята», with the gate's own line as the reason.
    expect((await mine(harness)).items[0]).toMatchObject({
      outcome: 'refused',
      reason: 'дальше нужен автор: правка меняет решение героя',
      waves: null,
      blocks: null,
      shareAtDecision: null,
      chapters: [],
    });
  });

  it('shows an accepted change as waiting, not as a result', async () => {
    harness = await bootComments();
    seedComment(harness, {
      id: 'cmt_q',
      identityId: harness.identity.id,
      status: 'accepted',
      decidedAt: '2026-10-25T12:00:00Z',
      auditVerdict: 'FITS',
    });
    seedChange(harness, { id: 'chg_q', seq: 5, status: 'pending', commentId: 'cmt_q' });

    expect((await mine(harness)).items[0]).toMatchObject({
      outcome: 'queued',
      waves: null,
      blocks: null,
      intent: null,
    });
  });

  it('reads the projection for a decision whose impact row is not materialized yet', async () => {
    harness = await bootComments();
    seedComment(harness, {
      id: 'cmt_bare',
      identityId: harness.identity.id,
      status: 'applied',
      decidedAt: '2026-10-25T12:00:00Z',
      auditVerdict: 'FITS',
    });
    seedChange(harness, {
      id: 'chg_bare',
      seq: 6,
      status: 'done',
      outcome: 'applied',
      intent: 'стереть деталь в главе 8',
      commentId: 'cmt_bare',
      finishedAt: '2026-10-25T12:30:00Z',
    });

    // The close event can arrive before `recordImpact`; the origin chapter is still true,
    // and a projection that measured no revision says zero — the page then omits the clause.
    expect((await mine(harness)).items[0]).toMatchObject({
      outcome: 'applied',
      chapters: [8],
      waves: null,
      blocks: 0,
    });
  });

  it('shows a note that was never considered as dropped', async () => {
    harness = await bootComments();
    seedComment(harness, {
      id: 'cmt_expired',
      identityId: harness.identity.id,
      status: 'expired',
      decidedAt: '2026-10-25T12:00:00Z',
      reason: 'проход не состоялся',
    });

    expect((await mine(harness)).items[0]).toMatchObject({
      outcome: 'dropped',
      reason: 'проход не состоялся',
      chapters: [],
    });
  });

  it('is newest first and bounded', async () => {
    harness = await bootComments();
    for (let index = 0; index < 25; index += 1) {
      seedComment(harness, {
        id: `cmt_${String(index).padStart(2, '0')}`,
        identityId: harness.identity.id,
        status: 'rejected',
        decidedAt: `2026-10-25T12:${String(index).padStart(2, '0')}:00Z`,
        reason: 'не по канону',
      });
    }
    const decisions = await mine(harness);
    expect(decisions.items).toHaveLength(20);
    expect(decisions.items[0]?.commentId).toBe('cmt_24');
    expect(decisions.items.at(-1)?.commentId).toBe('cmt_05');
  });

  it('hands the client its own open comment ids — the key to a live frame, nobody else’s', async () => {
    harness = await bootComments();
    const boris = otherReader(harness);
    seedComment(harness, { id: 'cmt_open', identityId: harness.identity.id });
    seedComment(harness, { id: 'cmt_open_b', identityId: boris.identity.id });
    seedComment(harness, {
      id: 'cmt_done',
      identityId: harness.identity.id,
      status: 'rejected',
      decidedAt: '2026-10-25T12:02:00Z',
      reason: 'не по канону',
    });

    const decisions = await mine(harness);
    expect(decisions.open).toEqual(['cmt_open']);
    expect(JSON.stringify(decisions)).not.toContain('cmt_open_b');
  });

  it('matches the live frame by comment id: the same decision the bridge announces', async () => {
    harness = await bootComments();
    seededA(harness);
    const boris = otherReader(harness);
    appendChangeEvent(harness.db, 'chg_A', 'decided', { outcome: 'applied' }, Date.UTC(2026, 9, 25, 12, 30));

    const frames: Array<{ type: string; data: Record<string, unknown> }> = [];
    new EngineBridge({
      db: harness.db,
      emit: (type, data) => frames.push({ type, data: data as Record<string, unknown> }),
      replay: true,
      progressThrottleMs: 0,
      now: () => Date.UTC(2026, 9, 25, 13, 0),
    }).tick();

    const decided = frames.filter((frame) => frame.type === 'change:decided');
    expect(decided).toHaveLength(1);
    expect(decided[0]?.data).toMatchObject({ id: 'chg_A', commentId: 'cmt_A', outcome: 'applied' });

    const theirs = (await get(harness, boris.cookie)).json() as MyDecisionsDto;
    const myDecisions = await mine(harness);
    // The frame names the comment; only the reader whose record holds that id may render it.
    expect(myDecisions.items.map((item) => item.commentId)).toContain(decided[0]?.data.commentId as string);
    expect(theirs.items.map((item) => item.commentId)).not.toContain('cmt_A');
    expect(theirs.open).not.toContain('cmt_A');
  });
});
