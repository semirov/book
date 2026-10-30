/**
 * «Повторить» — a retry is not a new filing (owner's rule, 2026-10-29). These tests pin who may be
 * retried (only a defect on our side — never a lock, a content refusal or the book's cap), what a
 * retry writes (the same row, a fresh ladder, the same change back in the queue, the failure kept
 * in the trail), and what it costs (one submission a day, however many retries). Fixtures are temp
 * databases built by the harness — never the production data dir.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TRIAGE_REFUSED_LINE, type CommentDto } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { appendCommentEvent, readCommentRow, type CommentRow } from '../../src/comments/repo.ts';
import { RETRY_MAX, ourFailureCode } from '../../src/comments/retryOffer.ts';
import { dueTriage, refuseTriage } from '../../src/comments/triage.ts';
import { upsertIdentity } from '../../src/db/repo/identities.ts';
import { EngineBridge } from '../../src/engineState/bridge.ts';
import { acceptComment } from '../../src/feedback/accept.ts';
import { runFeedback } from '../../src/feedback/cli.ts';
import { SESSION_COOKIE } from '../../src/identity/session.ts';
import { bootComments, commentBody, type Harness } from './helpers.ts';

let harness: Harness | null = null;
let dir: string | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
  if (dir !== null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const ACCEPT_REASON = 'принято: одно событие этой главы';
const INTENT = 'в абзаце дважды «слово» — оставить одно упоминание';
const LOCK_REASON = 'вне рамок: не про текст этой главы';
/** A pass that broke on our side, in the reader's words — the engine's own stop sentence. */
const PASS_SENTENCE = 'проверка не ответила — текст возвращён к прежней редакции, правка остановлена';

async function boot(): Promise<Harness> {
  harness = await bootComments();
  dir = mkdtempSync(join(tmpdir(), 'book-retry-'));
  return harness;
}

function post(h: Harness, body: string, chapter = 8, headers: Record<string, string> = h.headers()) {
  return h.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers,
    payload: commentBody({ chapter, body }),
  });
}

/** The retry door takes no field at all: an empty object is the whole request. */
function retry(h: Harness, id: string, headers: Record<string, string> = h.headers()) {
  return h.app.inject({ method: 'POST', url: `/api/comments/${id}/retry`, headers, payload: {} });
}

/** The filing as the page reads it. */
async function dtoOf(h: Harness, id: string): Promise<CommentDto> {
  return (await h.app.inject({ method: 'GET', url: `/api/comments/${id}` })).json() as CommentDto;
}

function cli(h: Harness, ...argv: string[]): { code: number; out: string[] } {
  const out: string[] = [];
  const code = runFeedback(argv, { db: h.db, dir: dir ?? '', now: h.clock.now, print: (line) => out.push(line) });
  return { code, out };
}

async function filed(h: Harness, body: string, chapter = 8): Promise<string> {
  const response = await post(h, body, chapter);
  expect(response.statusCode).toBe(201);
  return (response.json() as { comment: { id: string } }).comment.id;
}

/** The read never answered: `refuseTriage` closes the attempt with no verdict and refuses the row. */
function sinkFailure(h: Harness, id: string): void {
  const latest = h.db
    .prepare('SELECT n FROM comment_attempts WHERE comment_id = ? ORDER BY n DESC LIMIT 1')
    .get(id) as { n: number };
  const at = h.clock.now().toISOString();
  // What the engine's own tick writes beside the sink: the failure the page is told about.
  appendCommentEvent(h.db, id, 'triage.failed', at, { retryAt: null, attempt: latest.n });
  expect(refuseTriage(h.db, { commentId: id, n: latest.n, at })).toBe(true);
}

/** The gates' answers a filing needs before it may become a change. */
function clearGates(h: Harness, id: string): void {
  h.db.prepare(`UPDATE comments SET rights_verdict = 'CLEAR', audit_verdict = 'FITS' WHERE id = ?`).run(id);
}

/** Accept the filing into a queued change — the placement itself, not the operator's daily edit. */
function accept(h: Harness, id: string): string {
  clearGates(h, id);
  const comment = readCommentRow(h.db, id);
  expect(comment).toBeDefined();
  const accepted = acceptComment(h.db, {
    comment: comment as CommentRow,
    intent: INTENT,
    at: h.clock.now().toISOString(),
    reason: ACCEPT_REASON,
  });
  expect('changeId' in accepted, JSON.stringify(accepted)).toBe(true);
  return (accepted as { changeId: string }).changeId;
}

let stopSeq = 0;

/** A pass that broke: `code` is the failure a pass writes into its own receipt, when it wrote one. */
function stopPass(h: Harness, changeId: string, options: { code?: string; cascade?: string } = {}): void {
  stopSeq += 1;
  const at = h.clock.now().toISOString();
  const cascade = `csc_RETRYPASS${String(stopSeq).padStart(14, '0')}`;
  const step = `stp_RETRYPASS${String(stopSeq).padStart(14, '0')}`;
  h.db
    .prepare(`INSERT INTO cascades (id, change_id, status, outcome, budget, opened_at) VALUES (?, ?, 'escalated', ?, '{}', ?)`)
    .run(cascade, changeId, options.cascade ?? 'escalated:origin', at);
  h.db
    .prepare(
      `INSERT INTO steps (step_id, cascade_id, seq, wave, pass, boundary, chapter, at, outcome)
       VALUES (?, ?, 1, 0, 'change', '8', 8, ?, 'escalated')`,
    )
    .run(step, cascade, at);
  if (options.code !== undefined) {
    h.db
      .prepare(`INSERT INTO pass_transcripts (pass_id, seq, at, role, content_redacted) VALUES (?, 1, ?, 'draft', ?)`)
      .run(step, at, JSON.stringify({ failure: options.code }));
  }
  h.db
    .prepare(
      `UPDATE changes SET status = 'void', outcome = 'dropped', reason = ?, finished_at = ?, cascade_id = ?
        WHERE id = ?`,
    )
    .run(PASS_SENTENCE, at, cascade, changeId);
}

function attempts(h: Harness, id: string) {
  return h.db
    .prepare('SELECT n, outcome, tries, verdict FROM comment_attempts WHERE comment_id = ? ORDER BY n')
    .all(id) as Array<{ n: number; outcome: string | null; tries: number; verdict: string | null }>;
}

function row(h: Harness, id: string) {
  return h.db.prepare('SELECT status, reason, decided_at, change_id FROM comments WHERE id = ?').get(id) as {
    status: string;
    reason: string | null;
    decided_at: string | null;
    change_id: string | null;
  };
}

function retryEvents(h: Harness, id: string) {
  return (
    h.db
      .prepare(`SELECT meta FROM comment_events WHERE comment_id = ? AND type = 'retry' ORDER BY id`)
      .all(id) as Array<{ meta: string }>
  ).map((event) => JSON.parse(event.meta) as { n: number; because: string; was: { status: string } });
}

function due(h: Harness, id: string, n: number): boolean {
  return dueTriage(h.db, h.clock.now().toISOString(), 50).some(
    (due) => due.commentId === id && due.n === n,
  );
}

describe('a technical failure offers the button, and a retry re-arms the same filing', () => {
  it('re-arms the ladder of a read that never answered, and keeps the failure in the trail', async () => {
    const h = await boot();
    const id = await filed(h, 'Первый абзац лучше начать иначе.');
    sinkFailure(h, id);

    const refused = await h.app.inject({ method: 'GET', url: `/api/comments/${id}` });
    const dto = refused.json() as CommentDto;
    expect(dto).toMatchObject({ status: 'rejected', retryable: true, reason: TRIAGE_REFUSED_LINE });
    // The filing no longer asks to be read: its attempt was settled without an answer.
    expect(due(h, id, 1)).toBe(false);

    const response = await retry(h, id);
    expect(response.statusCode).toBe(200);
    const after = response.json() as { comment: CommentDto };
    expect(after.comment).toMatchObject({ id, status: 'new', reason: null, retryable: false, decidedAt: null });
    // The same filing, the same words, the same anchor: nothing about the submission moved.
    expect(row(h, id)).toMatchObject({ status: 'new', reason: null, decided_at: null });
    // A fresh ladder: the next attempt of this filing, no tries, no verdict, no claim.
    expect(attempts(h, id)).toEqual([
      { n: 1, outcome: 'refused', tries: 0, verdict: null },
      { n: 2, outcome: 'submitted', tries: 0, verdict: null },
    ]);
    // The trail has both facts, in order: the failure the engine wrote, and the retry that
    // re-armed it. Nothing was erased — the «posted» and Gate B's «rights» rows are still there.
    const types = (
      h.db.prepare('SELECT type FROM comment_events WHERE comment_id = ? ORDER BY id').all(id) as Array<{
        type: string;
      }>
    ).map((event) => event.type);
    expect(types).toContain('triage.failed');
    expect(types.at(-1)).toBe('retry');
    expect(types.indexOf('triage.failed')).toBeLessThan(types.indexOf('retry'));
    expect(retryEvents(h, id)).toEqual([
      { n: 2, because: 'triage', was: { status: 'rejected', reason: TRIAGE_REFUSED_LINE, disposition: null } },
    ]);
    // The read is due again, on the new attempt — that is what «повторить» buys.
    expect(due(h, id, 2)).toBe(true);
  });

  it('puts the same change back in the queue when a pass broke, and never reads the row twice', async () => {
    const h = await boot();
    const id = await filed(h, 'Первый абзац лучше начать иначе.');
    const changeId = accept(h, id);
    stopPass(h, changeId, { code: 'PROVIDER_TIMEOUT' });

    expect(await dtoOf(h, id)).toMatchObject({ status: 'rejected', retryable: true, reason: PASS_SENTENCE });

    const response = await retry(h, id);
    expect(response.statusCode).toBe(200);
    expect((response.json() as { comment: CommentDto }).comment).toMatchObject({
      id,
      status: 'new',
      reason: null,
      changeId,
      changeStatus: 'pending',
      retryable: false,
    });
    // The change itself returns to the queue with a fresh attempt count — no second change.
    const changeRow = 'SELECT status, outcome, reason, attempts, cascade_id FROM changes WHERE id = ?';
    expect(h.db.prepare(changeRow).get(changeId)).toEqual(
      { status: 'pending', outcome: null, reason: null, attempts: 0, cascade_id: null },
    );
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM changes WHERE source_comment = ?').get(id)).toEqual({ n: 1 });
    // The queue place is announced in the engine's own vocabulary, a second time.
    const queued = h.db
      .prepare(`SELECT COUNT(*) AS n FROM change_events WHERE change_id = ? AND type = 'queued'`)
      .get(changeId) as { n: number };
    expect(queued.n).toBe(2);
    expect(attempts(h, id).map((attempt) => attempt.n)).toEqual([1, 2]);
    // The trail keeps what the row said when we gave up — including how it had been read.
    expect(retryEvents(h, id)).toEqual([
      { n: 2, because: 'pass', was: { status: 'accepted', reason: ACCEPT_REASON, disposition: 'as_said' } },
    ]);
    // The armed change is the filing's business now: triage must not read it into a second change.
    expect(due(h, id, 2)).toBe(false);
  });

  it('emits one `comment:decision` per retry, with no failure beside it', async () => {
    const h = await boot();
    const id = await filed(h, 'Первый абзац лучше начать иначе.');
    sinkFailure(h, id);
    expect((await retry(h, id)).statusCode).toBe(200);

    const frames: Array<{ type: string; data: Record<string, unknown> }> = [];
    const bridge = new EngineBridge({
      db: h.db,
      emit: (type, data) => frames.push({ type, data: data as Record<string, unknown> }),
      replay: true,
      progressThrottleMs: 0,
      now: () => h.clock.ms,
    });
    bridge.prime();
    bridge.tick();

    // The one word the page must not hear is a decision: the row is `new` again, and no frame may
    // say otherwise (BOOK-220 narrates a re-armed filing with the row's own reading frames).
    expect(frames.filter((frame) => frame.type === 'comment:decision')).toEqual([]);
    expect(frames.filter((frame) => frame.type === 'change:decided' && frame.data.id === id)).toEqual([]);
    expect(frames.map((frame) => frame.type)).not.toContain('change:queued');
  });
});

describe('a retry is offered only for our own defect', () => {
  it('refuses the button on a lock, and the endpoint answers RETRY_NOT_OFFERED', async () => {
    const h = await boot();
    const id = await filed(h, 'Первый абзац лучше начать иначе.');
    h.db.prepare(`UPDATE comments SET guard = 'legal' WHERE id = ?`).run(id);
    expect(cli(h, 'decide', id, 'rejected', '--reason', LOCK_REASON).code).toBe(0);

    const dto = await dtoOf(h, id);
    expect(dto).toMatchObject({ status: 'rejected', retryable: false });
    // The refusal is the lock's own chain — «не принято» with its sentence, not a defect of ours.
    expect(h.db.prepare('SELECT disposition, lock FROM comments WHERE id = ?').get(id)).toMatchObject({
      disposition: 'inadmissible',
    });

    const response = await retry(h, id);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'RETRY_NOT_OFFERED' });
    // Nothing was written by the refusal: no ladder, no event, and the row keeps its sentence.
    expect(attempts(h, id)).toHaveLength(1);
    expect(retryEvents(h, id)).toHaveLength(0);
    expect(row(h, id).status).toBe('rejected');
  });

  it('reads the cascade’s own word when the pass left no receipt', async () => {
    const h = await boot();
    // A stop the engine owns (a wall, a lost session) writes no failure code of its own: only the
    // cascade's word can tell a gate that never answered from the rest of the stops.
    const silent = await filed(h, 'Первый абзац лучше начать иначе.');
    const silentChange = accept(h, silent);
    stopPass(h, silentChange, { cascade: 'escalated:gate_timeout' });
    expect((await dtoOf(h, silent)).retryable).toBe(true);
    expect((await retry(h, silent)).statusCode).toBe(200);

    // A stop with no receipt and no such word stays shut: a retry on a guess would be the lie.
    const guessed = await filed(h, 'Второй абзац тоже стоит начать иначе.');
    const guessedChange = accept(h, guessed);
    stopPass(h, guessedChange, { cascade: 'escalated:origin' });
    expect((await dtoOf(h, guessed)).retryable).toBe(false);
    expect((await retry(h, guessed)).statusCode).toBe(409);
  });

  it('refuses a premise, and refuses a second retry of the same re-armed filing', async () => {
    const h = await boot();
    // A chapter-level filing of an unwritten chapter is its premise: it waits for the first pass.
    const premise = await filed(h, 'Девятая глава начинается с письма.', 9);
    accept(h, premise);
    expect(h.db.prepare('SELECT premise FROM changes WHERE source_comment = ?').get(premise)).toMatchObject({ premise: 1 });
    expect((await dtoOf(h, premise)).retryable).toBe(false);
    expect((await retry(h, premise)).statusCode).toBe(409);

    // One failure, one re-arm: a second press while armed is refused and spends nothing.
    const id = await filed(h, 'Первый абзац лучше начать иначе.');
    sinkFailure(h, id);
    expect((await retry(h, id)).statusCode).toBe(200);
    expect((await retry(h, id)).json()).toMatchObject({ code: 'RETRY_NOT_OFFERED' });
    expect(attempts(h, id)).toHaveLength(2);
    expect(retryEvents(h, id)).toHaveLength(1);
  });

  it('refuses a content refusal and the book’s money cap, and neither is re-armed', async () => {
    const h = await boot();
    // A writer's refusal in its own words: `void · dropped` with a sentence, no failure code.
    const content = await filed(h, 'Первый абзац лучше начать иначе.');
    const contentChange = accept(h, content);
    stopPass(h, contentChange, { code: 'ANSWER_REFUSAL' });
    expect((await dtoOf(h, content)).retryable).toBe(false);
    expect((await retry(h, content)).statusCode).toBe(409);

    // The book's money cap stops every queued filing: the day would not change the answer.
    const budget = await filed(h, 'Второй абзац тоже стоит начать иначе.');
    const budgetChange = accept(h, budget);
    stopPass(h, budgetChange, { cascade: 'escalated:budget' });
    h.db.prepare(`UPDATE changes SET outcome = 'budget' WHERE id = ?`).run(budgetChange);
    expect((await dtoOf(h, budget)).retryable).toBe(false);
    expect((await retry(h, budget)).statusCode).toBe(409);
  });

  it('refuses a filing that is still being read, one in the lane and one that landed', async () => {
    const h = await boot();
    const fresh = await filed(h, 'Первый абзац лучше начать иначе.');
    // Still being read: a claim is the lane's business, not a defect.
    expect((await dtoOf(h, fresh)).retryable).toBe(false);
    expect((await retry(h, fresh)).statusCode).toBe(409);

    const inLane = await filed(h, 'Второй абзац тоже стоит начать иначе.');
    accept(h, inLane);
    expect(await dtoOf(h, inLane)).toMatchObject({ changeStatus: 'pending', retryable: false });
    expect((await retry(h, inLane)).statusCode).toBe(409);

    // A landed filing has no failure behind it: the text is in the book.
    const landed = await filed(h, 'Третий абзац стоит начать иначе.');
    const landedChange = accept(h, landed);
    h.db
      .prepare(`UPDATE changes SET status = 'done', outcome = 'applied', finished_at = ? WHERE id = ?`)
      .run(h.clock.now().toISOString(), landedChange);
    expect(await dtoOf(h, landed)).toMatchObject({ status: 'applied', retryable: false });
    expect((await retry(h, landed)).statusCode).toBe(409);
  });
});

describe('the cap', () => {
  it('lets three re-arms through and answers the fourth with RETRY_NOT_OFFERED', async () => {
    const h = await boot();
    const id = await filed(h, 'Первый абзац лучше начать иначе.');

    for (let turn = 1; turn <= RETRY_MAX; turn += 1) {
      sinkFailure(h, id);
      const response = await retry(h, id);
      expect(response.statusCode, `retry ${String(turn)}`).toBe(200);
      expect((response.json() as { comment: CommentDto }).comment).toMatchObject({ status: 'new', retryable: false });
    }
    expect(attempts(h, id)).toHaveLength(1 + RETRY_MAX);

    // The defect survived three re-arms: the fourth is not offered, and the row keeps the honest
    // sentence the sink wrote — the reader is told, and no button promises another try.
    sinkFailure(h, id);
    const dto = await dtoOf(h, id);
    expect(dto).toMatchObject({ status: 'rejected', retryable: false, reason: TRIAGE_REFUSED_LINE });
    const fourth = await retry(h, id);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json()).toMatchObject({ code: 'RETRY_NOT_OFFERED' });
    expect(attempts(h, id)).toHaveLength(1 + RETRY_MAX);
    expect(retryEvents(h, id)).toHaveLength(RETRY_MAX);
  });
});

describe('a retry is charged as the same submission', () => {
  it('spends the reader’s day once across three retries, not four times', async () => {
    const h = await boot();
    const id = await filed(h, 'Первый абзац лучше начать иначе.');
    for (let turn = 1; turn <= RETRY_MAX; turn += 1) {
      sinkFailure(h, id);
      expect((await retry(h, id)).statusCode).toBe(200);
    }
    // Eight attempt rows exist, and the day counts one: the identity's five submissions are the
    // filing plus four more, so four more filings fit before the cap refuses the fifth.
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM comment_attempts').get()).toEqual({ n: 1 + RETRY_MAX });

    for (let index = 1; index <= 4; index += 1) {
      const response = await post(h, `Замечание номер ${String(index)} к главе.`);
      expect(response.statusCode, `filing ${String(index)}`).toBe(201);
    }
    const sixth = await post(h, 'Замечание сверх дневной нормы.');
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toMatchObject({ code: 'ATTEMPT_LIMIT' });
  });
});

describe('the retry door is gated like the other write doors', () => {
  it('answers 404 for another reader’s filing and for one that does not exist', async () => {
    const h = await boot();
    const id = await filed(h, 'Первый абзац лучше начать иначе.');
    sinkFailure(h, id);

    const other = upsertIdentity(h.db, {
      yandexSub: 'yandex-2002',
      displayName: 'Борис',
      at: h.clock.now().toISOString(),
    });
    const foreignCookie = `${SESSION_COOKIE}=${h.sessions.issue(other.id, { ipKey: '127.0.0.1' }).cookie}`;
    const foreign = await retry(h, id, {
      origin: h.config.publicOrigin,
      'content-type': 'application/json',
      cookie: foreignCookie,
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: 'NOT_FOUND' });
    // The failure is still the row's, and the reader who owns it may still retry.
    expect(attempts(h, id)).toHaveLength(1);

    const missing = await retry(h, 'cmt_00000000000000000000000000');
    expect(missing.statusCode).toBe(404);
  });

  it('answers 401 without a session, and stores nothing', async () => {
    const h = await boot();
    const id = await filed(h, 'Первый абзац лучше начать иначе.');
    sinkFailure(h, id);

    const anonymous = await retry(h, id, { origin: h.config.publicOrigin, 'content-type': 'application/json' });
    expect(anonymous.statusCode).toBe(401);
    expect(attempts(h, id)).toHaveLength(1);
    expect(retryEvents(h, id)).toHaveLength(0);
  });

  it('answers a blocked identity 403 BLOCKED with the post path’s sentence', async () => {
    const h = await boot();
    const id = await filed(h, 'Первый абзац лучше начать иначе.');
    sinkFailure(h, id);
    // The block lands after the failure: the filing is retryable, and the *author* is the only
    // thing standing between the reader and a second read.
    h.db.prepare('UPDATE identities SET blocked = 1 WHERE id = ?').run(h.identity.id);

    const response = await retry(h, id);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'BLOCKED', message: 'замечания от этого автора не принимаются' });
    expect(attempts(h, id)).toHaveLength(1);
    expect(retryEvents(h, id)).toHaveLength(0);
  });
});

describe('the failure codes that are our defect', () => {
  it('counts a broken provider, shape or engine, and never the book’s own answer', () => {
    for (const code of ['PROVIDER_TIMEOUT', 'PROVIDER_SHAPE', 'PROVIDER_HTTP_500', 'ANSWER_TRUNCATED', 'ANSWER_SHAPE', 'ENGINE_UNREACHABLE', 'ENGINE_MECHANICAL_UNJUDGED', 'DB_BUSY']) {
      expect(ourFailureCode(code), code).toBe(true);
    }
    for (const code of ['ANSWER_REFUSAL', 'FRAME_CHANGED', 'RIGHTS_REQUIRED', 'RIGHTS_NOT_REQUIRED', 'STEP_CLOSED', 'TEXT_STUCK', 'BUDGET_STOP', null]) {
      expect(ourFailureCode(code), String(code)).toBe(false);
    }
  });
});
