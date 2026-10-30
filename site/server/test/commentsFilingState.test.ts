/**
 * BOOK-136 — one state, from the change: applied, pending, refused.
 *
 * The owner's prod rows: the writer said «пока нечего писать: заявок нет», the header said «в
 * очереди 2 правки», and two filings still read «идёт · правка ждёт записи · входит в
 * книгу». The linked changes were `done applied` and the comment rows stayed `accepted`, because
 * triage is the last thing that writes a comment's own status.
 *
 * This fixture is the whole law in one place: one applied filing, one the lane still holds, and
 * one refused — with the writer's own selection (`countPending`/`headPending`) beside them.
 * It never touches a data directory: the harness builds a temp database.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { CommentDto, CommentStatus } from '@book/shared';

import { insertComment, readCommentRow, toCommentDto } from '../src/comments/repo.ts';
import { filingStatus } from '../src/comments/filingState.ts';
import { STOPPED_LINE } from '../src/comments/states.ts';
import { countPending, headPending, insertChange } from '../src/engine/store.ts';
import { bootComments, type Harness } from './comments/helpers.ts';

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const ISO = (ms: number): string => new Date(ms).toISOString();

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** One reader filing, `accepted` by triage — the state the engine leaves the row in. */
function seedRow(h: Harness, id: string, status: 'accepted' | 'rejected', reason: string | null): void {
  insertComment(h.db, {
    id,
    identityId: h.identity.id,
    chapter: 8,
    blockId: null,
    blockIndex: null,
    baseRev: 1,
    quote: null,
    prefix: null,
    suffix: null,
    author: 'Аня',
    body: `Замечание ${id}: тут дважды «слово».`,
    proposedText: null,
    interventionKind: null,
    bodySha: `sha-${id}`,
    flags: [],
    ipHash: 'a'.repeat(64),
    status,
    guard: null,
    reason,
    createdAt: ISO(T0),
    idemKey: null,
  });
}

function link(h: Harness, commentId: string, changeId: string): void {
  h.db.prepare('UPDATE comments SET change_id = ? WHERE id = ?').run(changeId, commentId);
}

function seedChange(
  h: Harness,
  facts: {
    id: string;
    commentId: string;
    status: 'pending' | 'void' | 'done';
    outcome: string | null;
    reason: string | null;
  },
): void {
  insertChange(h.db, {
    id: facts.id,
    kind: 'accepted_comment',
    interventionKind: null,
    chapter: 8,
    anchor: null,
    intent: 'убрать второе «слово»',
    proposedText: null,
    sourceComment: facts.commentId,
    sourceSession: null,
    baseRev: 1,
    baseSha: '',
    baseBlocks: '[]',
    scopeHint: 'phrase',
    premise: 0,
    status: facts.status,
    outcome: facts.outcome,
    reason: facts.reason,
    enqueuedAt: ISO(T0),
  });
  link(h, facts.commentId, facts.id);
}

function dto(h: Harness, id: string): CommentDto {
  const row = readCommentRow(h.db, id);
  if (row === undefined) throw new Error(`no row ${id}`);
  return toCommentDto(h.db, row, T0);
}

describe('one state per filing, read from its change (BOOK-136)', () => {
  it('reads a landed change as applied, with the chapter’s own revision as the receipt', async () => {
    const h = await bootComments();
    harness = h;
    const base = h.db.prepare('SELECT rev FROM chapters WHERE n = 8').get() as { rev: number };
    seedRow(h, 'cmt_applied', 'accepted', 'входит в книгу');
    seedChange(h, { id: 'chg_applied', commentId: 'cmt_applied', status: 'done', outcome: 'applied', reason: null });

    const landed = dto(h, 'cmt_applied');
    expect(landed.status).toBe('applied');
    expect(landed.applied).toEqual({ chapter: 8, rev: base.rev });
    // The acceptance sentence is not a fact about text that already landed.
    expect(landed.reason).toBeNull();
    expect(JSON.stringify(landed)).not.toContain('входит в книгу');
    expect(landed.changeStatus).toBeNull();
  });

  it('keeps a filing the lane still holds accepted, and says the lane holds it', async () => {
    const h = await bootComments();
    harness = h;
    seedRow(h, 'cmt_pending', 'accepted', 'входит в книгу');
    seedChange(h, { id: 'chg_pending', commentId: 'cmt_pending', status: 'pending', outcome: null, reason: null });

    const pending = dto(h, 'cmt_pending');
    expect(pending.status).toBe('accepted');
    expect(pending.changeStatus).toBe('pending');
    expect(pending.applied).toBeNull();
  });

  it('reads the writer’s human refusal as rejected, and a held row as its own decision', async () => {
    const h = await bootComments();
    harness = h;
    // A change the writer settled with a sentence: the row never decided, the change did.
    seedRow(h, 'cmt_void', 'accepted', 'входит в книгу');
    seedChange(h, {
      id: 'chg_void',
      commentId: 'cmt_void',
      status: 'void',
      outcome: 'dropped',
      reason: 'не входит в книгу — правка ждёт решения',
    });
    // A gate's own refusal: the row's word is the last one, whatever a change says.
    seedRow(h, 'cmt_gate', 'rejected', 'не принято: чужая цитата без источника');

    const refused = dto(h, 'cmt_void');
    expect(refused.status).toBe('rejected');
    expect(refused.reason).toBe('не входит в книгу — правка ждёт решения');
    expect(refused.changeStatus).toBeNull();

    const gate = dto(h, 'cmt_gate');
    expect(gate.status).toBe('rejected');
    expect(gate.reason).toBe('не принято: чужая цитата без источника');
  });

  it('reads the landing, not change_id, when a filing has several changes (the live rows)', async () => {
    // The owner's rows: `comments.change_id` names an `escalated · gate_timeout` attempt, and a
    // later `done · applied` change landed the same filing. The failed attempt is history.
    const h = await bootComments();
    harness = h;
    const base = h.db.prepare('SELECT rev FROM chapters WHERE n = 8').get() as { rev: number };
    seedRow(h, 'cmt_many', 'accepted', 'входит в книгу');
    seedChange(h, {
      id: 'chg_escalated',
      commentId: 'cmt_many',
      status: 'pending',
      outcome: null,
      reason: null,
    });
    // `escalated` is the worker's own transition, never an insert the store types.
    h.db
      .prepare(
        `UPDATE changes SET status = 'escalated', outcome = 'gate_timeout', reason = 'модель не ответила: PROVIDER_SHAPE'
          WHERE id = 'chg_escalated'`,
      )
      .run();
    seedChange(h, { id: 'chg_applied', commentId: 'cmt_many', status: 'done', outcome: 'applied', reason: null });
    // The bug itself: the comment points at the attempt that came back empty.
    link(h, 'cmt_many', 'chg_escalated');

    const filing = dto(h, 'cmt_many');
    expect(filing.status).toBe('applied');
    expect(filing.applied).toEqual({ chapter: 8, rev: base.rev });
    expect(filing.reason).toBeNull();
    expect(filing.changeStatus).toBeNull();
    // The door opens the landing, and the failed attempt is not the filing's state.
    expect(filing.changeId).toBe('chg_applied');
    expect(filing.attempt).toBeNull();
    expect(JSON.stringify(filing)).not.toContain('входит в книгу');
    expect(JSON.stringify(filing)).not.toContain('PROVIDER_SHAPE');
  });

  it('reads a premise’s landing over an older escalated attempt', async () => {
    // BOOK-7 + BOOK-136: the same selection for a premise — a `done` first edition hides the
    // escalated attempt behind it, whatever the row links to.
    const h = await bootComments();
    harness = h;
    seedRow(h, 'cmt_34p', 'accepted', 'принято: глава отвечает процедурой');
    seedChange(h, { id: 'chg_34old', commentId: 'cmt_34p', status: 'pending', outcome: null, reason: null });
    h.db
      .prepare("UPDATE changes SET status = 'escalated', premise = 1, reason = 'движок отказал: ENGINE_TIMEOUT' WHERE id = 'chg_34old'")
      .run();
    seedChange(h, { id: 'chg_34new', commentId: 'cmt_34p', status: 'done', outcome: 'applied', reason: null });
    h.db.prepare("UPDATE changes SET premise = 1 WHERE id = 'chg_34new'").run();
    link(h, 'cmt_34p', 'chg_34old');

    const premise = dto(h, 'cmt_34p');
    expect(premise).toMatchObject({ premise: true, status: 'applied', changeId: 'chg_34new', attempt: null });
    expect(premise.applied).toEqual({ chapter: 8, rev: 1 });
  });

  it('falls back to the linked row when the ledger has no change for the filing', async () => {
    // Older data: `change_id` is set and `source_comment` is not. Nothing is invented — the
    // linked row is the attempt, exactly as before BOOK-136.
    const h = await bootComments();
    harness = h;
    seedRow(h, 'cmt_legacy', 'accepted', 'входит в книгу');
    seedChange(h, { id: 'chg_legacy', commentId: 'cmt_legacy', status: 'pending', outcome: null, reason: null });
    h.db.prepare("UPDATE changes SET source_comment = NULL WHERE id = 'chg_legacy'").run();

    expect(dto(h, 'cmt_legacy')).toMatchObject({
      status: 'accepted',
      changeStatus: 'pending',
      changeId: 'chg_legacy',
      applied: null,
    });
  });

  it('reads the remaining decisions: paperwork, a supersede, and the writer at work', async () => {
    const h = await bootComments();
    harness = h;
    // BOOK-137 — a `done` change closed as paperwork is «рассмотрено», never «внесено».
    seedRow(h, 'cmt_paper', 'accepted', null);
    seedChange(h, { id: 'chg_paper', commentId: 'cmt_paper', status: 'done', outcome: 'registered', reason: null });
    expect(dto(h, 'cmt_paper').status).toBe('registered');
    // A human sentence with the supersede outcome is the supersede, not a refusal.
    seedRow(h, 'cmt_super', 'accepted', 'входит в книгу');
    seedChange(h, {
      id: 'chg_super',
      commentId: 'cmt_super',
      status: 'void',
      outcome: 'superseded',
      reason: 'текст успел измениться',
    });
    expect(dto(h, 'cmt_super').status).toBe('superseded');
    // The writer has this filing in hand: `accepted` stays, and the change says «processing».
    seedRow(h, 'cmt_work', 'accepted', 'входит в книгу');
    seedChange(h, { id: 'chg_work', commentId: 'cmt_work', status: 'pending', outcome: null, reason: null });
    // `processing` is the worker's own transition, never an insert the store types: the row is
    // queued here and picked up by the writer, exactly as the lane does it.
    h.db.prepare("UPDATE changes SET status = 'processing' WHERE id = 'chg_work'").run();
    expect(dto(h, 'cmt_work')).toMatchObject({ status: 'accepted', changeStatus: 'processing' });
  });

  it('keeps the row’s word for a `done` change closed with no landing outcome', async () => {
    // A `done` change is closed with a landing or with the paperwork outcome. Anything else is
    // not a fact about text, so the filing keeps its own word rather than inventing «внесено».
    const h = await bootComments();
    harness = h;
    seedRow(h, 'cmt_odd', 'accepted', 'входит в книгу');
    seedChange(h, { id: 'chg_odd', commentId: 'cmt_odd', status: 'done', outcome: 'budget', reason: null });

    const odd = dto(h, 'cmt_odd');
    expect(odd.status).toBe('accepted');
    expect(odd.applied).toBeNull();
    expect(odd.changeStatus).toBeNull();
  });

  it('counts the writer’s lane, not the filings: one pending change, and it is the head', async () => {
    const h = await bootComments();
    harness = h;
    seedRow(h, 'cmt_applied', 'accepted', 'входит в книгу');
    seedChange(h, { id: 'chg_applied', commentId: 'cmt_applied', status: 'done', outcome: 'applied', reason: null });
    seedRow(h, 'cmt_pending', 'accepted', 'входит в книгу');
    seedChange(h, { id: 'chg_pending', commentId: 'cmt_pending', status: 'pending', outcome: null, reason: null });
    seedRow(h, 'cmt_refused', 'rejected', 'не принято: чужая цитата без источника');

    expect(countPending(h.db)).toBe(1);
    expect(headPending(h.db)?.id).toBe('chg_pending');
  });
});

describe('BOOK-206 B2 — one derivation, four surfaces', () => {
  /** One change row as the state derivation reads it. */
  function change(status: string, outcome: string | null, reason: string | null = null, seq = 1) {
    return { id: 'chg', seq, premise: 0, status, outcome, reason, chapter: 8 };
  }

  it('maps ChangeStatus × outcome to one word — a stop included', () => {
    // The whole table in one place: every row the writer can close a filing with, and the one
    // word the card, the record and the change card print for it.
    const table: Array<[string, ReturnType<typeof change> | undefined, CommentStatus]> = [
      ['no change at all', undefined, 'accepted'],
      ['done · applied', change('done', 'applied'), 'applied'],
      ['done · adapted', change('done', 'adapted'), 'applied'],
      ['done · finding', change('done', 'finding'), 'applied'],
      ['done · registered', change('done', 'registered'), 'registered'],
      ['void · dropped (a human sentence)', change('void', 'dropped', 'не входит в книгу — правка ждёт решения'), 'rejected'],
      ['void · superseded', change('void', 'superseded', 'текст успел измениться'), 'superseded'],
      ['void · a failed attempt (an engine code)', change('void', 'dropped', 'PROVIDER_SHAPE'), 'accepted'],
      ['escalated', change('escalated', 'gate_timeout', 'проверка не ответила вовремя — шаг остановлен'), 'rejected'],
      ['failed', change('failed', 'origin', 'повторные обрывы'), 'rejected'],
      ['pending', change('pending', null), 'accepted'],
      ['processing', change('processing', null), 'accepted'],
      ['stale', change('stale', null), 'accepted'],
    ];
    for (const [label, row, expected] of table) {
      expect(filingStatus(row, 'accepted'), label).toBe(expected);
    }
    // A row that decided itself is never upgraded by a change behind it.
    expect(filingStatus(change('escalated', 'origin', 'повторные обрывы'), 'rejected')).toBe('rejected');
  });

  it('never serializes a stopped filing as «в очереди» — the DTO says `rejected`, with the sentence', async () => {
    const h = await bootComments();
    harness = h;
    seedRow(h, 'cmt_stop', 'accepted', 'принято · входит в книгу');
    seedChange(h, {
      id: 'chg_stop',
      commentId: 'cmt_stop',
      status: 'pending',
      outcome: null,
      reason: null,
    });
    h.db
      .prepare(
        `UPDATE changes SET status = 'escalated', outcome = 'delta',
           reason = 'починка задела слишком много текста — нужно решение' WHERE id = 'chg_stop'`,
      )
      .run();

    const stopped = dto(h, 'cmt_stop');
    // The terminal word, the change's own sentence, and no queue place — the three things three
    // surfaces used to disagree about.
    expect(stopped.status).toBe('rejected');
    expect(stopped.reason).toBe('починка задела слишком много текста — нужно решение');
    expect(stopped.changeStatus).toBeNull();
    expect(stopped.applied).toBeNull();
    // A stop is not a refusal of the reader's wording: no attempt line, no advice, no door.
    expect(stopped.attempt).toBeNull();
    expect(stopped.hint).toBeNull();
    expect(stopped.revise?.allowed).toBe(false);
    expect(JSON.stringify(stopped)).not.toContain('ждёт записи');
    expect(JSON.stringify(stopped)).not.toContain('входит в книгу');
  });

  it('reads the newest fact: a stop after a landing is the filing’s state (BOOK-206 B2)', async () => {
    const h = await bootComments();
    harness = h;
    const base = h.db.prepare('SELECT rev FROM chapters WHERE n = 8').get() as { rev: number };
    // A premise that landed, and a **later** pass the engine gave up on: the stop is the current
    // attempt, and the chapter's text is not what became of the filing that was tried again.
    seedRow(h, 'cmt_pstop', 'accepted', 'принято в основу');
    seedChange(h, { id: 'chg_pold', commentId: 'cmt_pstop', status: 'done', outcome: 'applied', reason: null });
    h.db.prepare("UPDATE changes SET premise = 1 WHERE id = 'chg_pold'").run();
    seedChange(h, { id: 'chg_pstop', commentId: 'cmt_pstop', status: 'pending', outcome: null, reason: null });
    h.db
      .prepare(
        `UPDATE changes SET premise = 1, status = 'escalated', outcome = 'gate_timeout', reason = ?
          WHERE id = 'chg_pstop'`,
      )
      .run('проверка не ответила вовремя — шаг остановлен');
    // The stale link of the owner's rows: `comments.change_id` still names the older landing.
    link(h, 'cmt_pstop', 'chg_pold');

    const stopped = dto(h, 'cmt_pstop');
    expect(stopped).toMatchObject({
      premise: true,
      status: 'rejected',
      reason: 'проверка не ответила вовремя — шаг остановлен',
      applied: null,
      changeStatus: null,
    });

    // The same rule the other way round: a landing **newer** than the stop is the answer.
    seedRow(h, 'cmt_pland', 'accepted', 'принято в основу');
    seedChange(h, { id: 'chg_stop0', commentId: 'cmt_pland', status: 'pending', outcome: null, reason: null });
    h.db
      .prepare(`UPDATE changes SET premise = 1, status = 'escalated', outcome = 'gate_timeout', reason = ?
                 WHERE id = 'chg_stop0'`)
      .run('проверка не ответила вовремя — шаг остановлен');
    seedChange(h, { id: 'chg_land1', commentId: 'cmt_pland', status: 'done', outcome: 'applied', reason: null });
    h.db.prepare("UPDATE changes SET premise = 1 WHERE id = 'chg_land1'").run();
    link(h, 'cmt_pland', 'chg_stop0');

    expect(dto(h, 'cmt_pland')).toMatchObject({
      premise: true,
      status: 'applied',
      applied: { chapter: 8, rev: base.rev },
      changeStatus: null,
    });

    // An ordinary filing obeys the same precedence: the newer stop wins over the older landing.
    seedRow(h, 'cmt_ostop', 'accepted', 'входит в книгу');
    seedChange(h, { id: 'chg_oold', commentId: 'cmt_ostop', status: 'done', outcome: 'applied', reason: null });
    seedChange(h, { id: 'chg_onew', commentId: 'cmt_ostop', status: 'pending', outcome: null, reason: null });
    h.db
      .prepare(`UPDATE changes SET status = 'failed', outcome = 'origin', reason = 'повторные обрывы — правка остановлена'
                 WHERE id = 'chg_onew'`)
      .run();
    link(h, 'cmt_ostop', 'chg_oold');

    expect(dto(h, 'cmt_ostop')).toMatchObject({
      status: 'rejected',
      reason: 'повторные обрывы — правка остановлена',
      applied: null,
    });
  });

  it('never prints an engine code as a stop’s sentence', async () => {
    const h = await bootComments();
    harness = h;
    seedRow(h, 'cmt_code', 'accepted', 'входит в книгу');
    seedChange(h, { id: 'chg_code', commentId: 'cmt_code', status: 'pending', outcome: null, reason: null });
    h.db
      .prepare(`UPDATE changes SET status = 'failed', outcome = 'origin', reason = 'модель не ответила: PROVIDER_SHAPE'
                 WHERE id = 'chg_code'`)
      .run();

    const stopped = dto(h, 'cmt_code');
    expect(stopped.status).toBe('rejected');
    expect(stopped.reason).toBe(STOPPED_LINE);
    expect(JSON.stringify(stopped)).not.toContain('PROVIDER_SHAPE');
    // `readerReason` would answer «заявка остаётся в очереди» here — the lie B5 named.
    expect(stopped.reason).not.toContain('остаётся в очереди');
  });
});

describe('the API sends the same three states the writer has (BOOK-136)', () => {
  it('answers /api/comments with applied + receipt, accepted + pending, rejected + reason', async () => {
    const h = await bootComments();
    harness = h;
    const base = h.db.prepare('SELECT rev FROM chapters WHERE n = 8').get() as { rev: number };
    seedRow(h, 'cmt_applied', 'accepted', 'входит в книгу');
    seedChange(h, { id: 'chg_applied', commentId: 'cmt_applied', status: 'done', outcome: 'applied', reason: null });
    seedRow(h, 'cmt_pending', 'accepted', 'входит в книгу');
    seedChange(h, { id: 'chg_pending', commentId: 'cmt_pending', status: 'pending', outcome: null, reason: null });
    seedRow(h, 'cmt_refused', 'rejected', 'не принято: чужая цитата без источника');

    const response = await h.app.inject({ method: 'GET', url: '/api/comments?chapter=8', headers: h.headers() });
    expect(response.statusCode).toBe(200);
    const items = (response.json() as { items: CommentDto[] }).items;
    const byId = new Map(items.map((item) => [item.id, item]));

    expect(byId.get('cmt_applied')).toMatchObject({
      status: 'applied',
      applied: { chapter: 8, rev: base.rev },
      reason: null,
      changeStatus: null,
    });
    expect(byId.get('cmt_pending')).toMatchObject({
      status: 'accepted',
      changeStatus: 'pending',
      applied: null,
    });
    expect(byId.get('cmt_refused')).toMatchObject({
      status: 'rejected',
      reason: 'не принято: чужая цитата без источника',
      changeStatus: null,
    });
    expect(countPending(h.db)).toBe(1);
  });
});
