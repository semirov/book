import { afterEach, describe, expect, it } from 'vitest';

import { TRIAGE_REFUSED_LINE } from '@book/shared';

import { appendCommentEvent } from '../src/comments/repo.ts';
import { createEngine } from '../src/engine/service.ts';
import { EngineBridge } from '../src/engineState/bridge.ts';
import { DecisionsTailer } from '../src/feedback/decisions.ts';
import { poll } from '../src/feedback/triageApplier.ts';
import { bootComments, commentBody, type Harness } from './comments/helpers.ts';
import { longProse } from './helpers.ts';

/**
 * BOOK-206 B1 — every filing transition reaches the socket, as one frame the reducer reads.
 *
 * The audit's B1: the site's bridge narrated `change_events` and `events`, and the filing's own
 * transitions did not always arrive as a frame the open page understands. These are the three
 * doors that were missing or unsure — a triage **accept**, a **gate refusal**, and a read that
 * never happened (`comment_events`, drained by nobody) — each asserted against the one contract
 * `{ id, chapter, status, reason, decidedAt, changeId, applied, report, attempt? }`, and each one
 * frame per transition.
 */

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

type Frame = { type: string; data: Record<string, unknown> };

async function boot(): Promise<Harness> {
  harness = await bootComments({
    chapters: {
      'ch08.md': longProse([
        'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.',
        'Тестовый абзац номер два. Это служебный текст.',
      ]),
    },
  });
  return harness;
}

/** One filed remark, as the reader made it: the row triage is about to answer. */
async function post(h: Harness, body = 'В абзаце дважды «слово» — оставить одно упоминание.'): Promise<string> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: h.headers(),
    payload: commentBody({ body }),
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { comment: { id: string } }).comment.id;
}

/** The decision line the CLI appends — the tailer applies it exactly as it reads the file. */
function line(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: 'accepted',
    reason: '«слово» и «словосочетание» рядом — оставил одно',
    intent: 'в абзаце дважды «слово» — оставить одно упоминание',
    rev: { chapter: 8, rev: 1 },
    at: '2026-10-25T12:05:00.000Z',
    ...overrides,
  };
}

function tailer(h: Harness, frames: Frame[]): DecisionsTailer {
  const created = new DecisionsTailer({
    db: h.db,
    dir: '/nonexistent',
    emit: (type, data) => frames.push({ type, data: data as Record<string, unknown> }),
    now: h.clock.now,
    replay: true,
  });
  created.prime();
  return created;
}

function bridge(h: Harness, frames: Frame[], options: { replay?: boolean; prime?: boolean } = {}): EngineBridge {
  const created = new EngineBridge({
    db: h.db,
    emit: (type, data) => frames.push({ type, data: data as Record<string, unknown> }),
    replay: options.replay ?? true,
    progressThrottleMs: 0,
    now: () => h.clock.ms,
  });
  if (options.prime !== false) created.prime();
  return created;
}

/** Give the row what the gates write before a model may answer it. */
function clearGates(h: Harness, id: string): void {
  h.db.prepare(`UPDATE comments SET rights_verdict = 'CLEAR', audit_verdict = 'FITS' WHERE id = ?`).run(id);
}

describe('BOOK-206 B1 — a triage accept speaks the filing, with no receipt', () => {
  it('emits `comment:decision` with `applied: null` and keeps `change:queued` beside it', async () => {
    const h = await boot();
    const id = await post(h);
    clearGates(h, id);
    const frames: Frame[] = [];

    const applied = tailer(h, frames).apply(line(id));

    expect(applied).toBe(1);
    const decision = frames.find((frame) => frame.type === 'comment:decision')?.data;
    expect(decision).toMatchObject({
      id,
      chapter: 8,
      status: 'accepted',
      reason: '«слово» и «словосочетание» рядом — оставил одно',
    });
    // Acceptance is not application: the receipt is present and null (BOOK-206 B2), and the
    // change's own queue frame still arrives — the filing frame is never instead of it.
    expect(decision?.applied).toBeNull();
    expect('disposition' in (decision ?? {})).toBe(true);
    expect(frames.map((frame) => frame.type)).toContain('change:queued');

    // One frame per transition: a re-read of the same line re-announces the same decision — never
    // a second state («first decision wins»), so the record cannot move twice on one filing.
    const changeId = (h.db.prepare('SELECT change_id FROM comments WHERE id = ?').get(id) as { change_id: string })
      .change_id;
    const seen = frames.length;
    tailer(h, frames).apply(line(id, { changeId }));
    expect(frames.slice(seen).filter((frame) => frame.type === 'comment:decision')).toHaveLength(1);
  });
});

describe('BOOK-206 B1 — a gate refusal speaks the filing’s own word', () => {
  it('emits `rejected` with the gate’s sentence and a null receipt', async () => {
    const h = await boot();
    const id = await post(h);
    // Gate C has not judged this row: `acceptComment` answers AUDIT_REQUIRED and the refusal is
    // the row's own — no change is made, so no close will ever announce it.
    const frames: Frame[] = [];

    const applied = tailer(h, frames).apply(line(id));

    expect(applied).toBe(1);
    const decision = frames.find((frame) => frame.type === 'comment:decision')?.data;
    expect(decision).toMatchObject({
      id,
      chapter: 8,
      status: 'rejected',
      reason: 'замечание не прошло проверку на соответствие книге — правку из него не делают',
      changeId: null,
      applied: null,
    });
    expect(frames.map((frame) => frame.type)).not.toContain('change:queued');
  });
});

describe('BOOK-DOC-84 §10.1 — `filing:reading`, one frame per attempt', () => {
  it('drains the claim, the answer, the failure and the widening, each once', async () => {
    const h = await boot();
    const id = await post(h);
    clearGates(h, id);
    const claimedUntil = '2026-10-25T12:10:00.000Z';
    h.db.prepare(`UPDATE comment_attempts SET tries = 1, claim_until = ? WHERE comment_id = ?`).run(claimedUntil, id);
    const frames: Frame[] = [];
    const engine = bridge(h, frames, { replay: true });

    appendCommentEvent(h.db, id, 'triage.claimed', '2026-10-25T12:05:00.000Z', { attempt: 1, try: 1 });
    engine.tick();

    const claimed = frames.find((frame) => frame.type === 'filing:reading')?.data;
    expect(claimed).toMatchObject({
      commentId: id,
      chapter: 8,
      phase: 'claimed',
      attempt: 1,
      maxAttempts: 5,
      desperate: false,
      widened: null,
      reason: null,
      costUsd: null,
      at: Date.parse('2026-10-25T12:05:00.000Z'),
      deadlineAt: Date.parse(claimedUntil),
      retryAt: null,
    });
    // The cursor is the row's own id: a replay of this row is a no-op on the client.
    expect(claimed?.readingSeq).toBe(
      (h.db.prepare(`SELECT MAX(id) AS id FROM comment_events WHERE comment_id = ?`).get(id) as { id: number }).id,
    );

    // The answer: one frame, priced from the ledger row the verdict wrote.
    h.db
      .prepare(
        `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, change_id, model, tokens_in, tokens_out, usd, priced, provenance)
         VALUES (?, ?, ?, 8, 'triage', NULL, 'm', 10, 20, 0.05, 1, 'pipeline-estimated')`,
      )
      .run('2026-10-25T12:06:00.000Z', '2026-10-25', `triage:${id}:1`);
    appendCommentEvent(h.db, id, 'triage.read', '2026-10-25T12:06:00.000Z', { attempt: 1, try: 1 });
    engine.tick();
    const read = frames.filter((frame) => frame.type === 'filing:reading').at(-1)?.data;
    expect(read).toMatchObject({ phase: 'read', attempt: 1, costUsd: 0.05, estimated: true, reason: null });

    // A failed try carries the six-word class and the hour the next one is bought.
    h.db.prepare(`UPDATE comment_attempts SET tries = 2, next_at = ? WHERE comment_id = ?`).run(
      '2026-10-25T12:16:00.000Z',
      id,
    );
    appendCommentEvent(h.db, id, 'triage.failed', '2026-10-25T12:06:30.000Z', {
      code: 'PROVIDER_TIMEOUT',
      attempt: 1,
      try: 2,
      retryAt: '2026-10-25T12:16:00.000Z',
    });
    engine.tick();
    const failed = frames.filter((frame) => frame.type === 'filing:reading').at(-1)?.data;
    expect(failed).toMatchObject({
      phase: 'failed',
      attempt: 2,
      reason: 'таймаут',
      retryAt: Date.parse('2026-10-25T12:16:00.000Z'),
      deadlineAt: null,
      costUsd: null,
    });

    // The third failure widened the reading: its own frame, with the engine's code and the
    // human sentence from the vocabulary module.
    h.db.prepare(`UPDATE comment_attempts SET widened = 'as-document', tries = 3 WHERE comment_id = ?`).run(id);
    appendCommentEvent(h.db, id, 'triage.widened', '2026-10-25T12:07:00.000Z', {
      attempt: 1,
      try: 3,
      widened: 'as-document',
    });
    engine.tick();
    const widened = frames.filter((frame) => frame.type === 'filing:reading').at(-1)?.data;
    expect(widened).toMatchObject({
      phase: 'widened',
      attempt: 3,
      widened: { code: 'as-document', sentence: 'просим читать документ'.replace('документ', 'как документ') },
      reason: null,
      retryAt: null,
    });

    // One frame per row: the cursor has passed all four.
    const seen = frames.length;
    engine.tick();
    expect(frames.slice(seen).filter((frame) => frame.type === 'filing:reading')).toEqual([]);
  });

  it('a claim abandoned by a crash speaks as a failure, never as silence', async () => {
    const h = await boot();
    const id = await post(h);
    clearGates(h, id);
    const frames: Frame[] = [];
    const engine = bridge(h, frames, { replay: true });
    h.db.prepare('UPDATE comment_attempts SET tries = 2 WHERE comment_id = ?').run(id);
    appendCommentEvent(h.db, id, 'triage.abandoned', '2026-10-25T12:12:00.000Z', {
      attempt: 1,
      tries: 2,
      detail: 'claim-abandoned',
    });
    engine.tick();
    const abandoned = frames.find((frame) => frame.type === 'filing:reading')?.data;
    expect(abandoned).toMatchObject({ phase: 'failed', attempt: 2, reason: 'обрыв связи' });
  });

  it('counts the failure that failed: the fifth is 5 of 5, only the desperate sixth is 6 of 6', async () => {
    const h = await boot();
    const id = await post(h);
    clearGates(h, id);
    // The real ledger writes the rows and the events, exactly as the writer's client drives it:
    // five bought tries that fail, then the site's own deterministic settlement of the sixth.
    const triage = createEngine({
      db: h.db,
      config: { ...h.config, drafting: 'on' },
      bookRoot: h.fixture.root,
      clock: { now: () => h.clock.ms },
      alert: () => {},
    });
    const frames: Frame[] = [];
    const narrator = bridge(h, frames, { replay: true });
    const readings = (): Array<Record<string, unknown>> =>
      frames.filter((frame) => frame.type === 'filing:reading').map((frame) => frame.data);

    for (let tryNo = 0; tryNo < 5; tryNo += 1) {
      expect(triage.triage.next('writer-1')).toMatchObject({ commentId: id });
      triage.triage.fail({ commentId: id, n: 1, code: 'PROVIDER_TIMEOUT' });
      // Past the retry's own backoff (60 s, 10 min, 6 h, 6 h): the next try is due.
      h.clock.advance(6 * 60 * 60_000 + 1_000);
      narrator.tick();
    }

    // The fifth failure marks the row `desperate` in the same transaction: the ladder's sixth
    // attempt is the engine's own floor, so the count the row carries is 6 and no call was bought.
    expect(
      h.db.prepare('SELECT tries, desperate FROM comment_attempts WHERE comment_id = ? AND n = 1').get(id),
    ).toEqual({ tries: 6, desperate: 1 });
    const fifth = readings().filter((frame) => frame.phase === 'failed').at(-1);
    expect(fifth).toMatchObject({ attempt: 5, maxAttempts: 5, desperate: false, retryAt: null });

    // BOOK-219: the sixth attempt is the **engine's own** floor rung (`engine/triageFloor.ts`),
    // so it spends no call and the applier has nothing to settle — five bought attempts, five
    // frames, and a second tick over the same rows says nothing twice.
    poll({ db: h.db, emit: () => {}, notify: () => {}, now: h.clock.now });
    narrator.tick();
    expect(readings().filter((frame) => frame.phase === 'failed')).toHaveLength(5);
    poll({ db: h.db, emit: () => {}, notify: () => {}, now: h.clock.now });
    narrator.tick();
    expect(readings().filter((frame) => frame.phase === 'failed')).toHaveLength(5);
  });

  it('says nothing for a withdrawn filing', async () => {
    const h = await boot();
    const gone = await post(h);
    const withdrawn = await post(h, 'В абзаце дважды «слово» — оставить одно.');
    h.db.prepare(`UPDATE comments SET status = 'hidden' WHERE id = ?`).run(withdrawn);
    const frames: Frame[] = [];
    const engine = bridge(h, frames, { replay: true });

    appendCommentEvent(h.db, gone, 'triage.failed', '2026-10-25T12:10:00.000Z', {
      code: 'PROVIDER_SHAPE',
      attempt: 1,
      try: 3,
    });
    appendCommentEvent(h.db, withdrawn, 'triage.failed', '2026-10-25T12:12:00.000Z', {
      attempt: 1,
      try: 3,
    });
    engine.tick();

    const readings = frames.filter((frame) => frame.type === 'filing:reading');
    expect(readings).toHaveLength(1);
    expect(readings[0]?.data.commentId).toBe(gone);
  });

  it('primes its cursor: a restart does not replay yesterday’s failure', async () => {
    const h = await boot();
    const id = await post(h);
    appendCommentEvent(h.db, id, 'triage.failed', '2026-10-24T12:00:00.000Z', {
      code: 'PROVIDER_SHAPE',
      attempt: 1,
      try: 3,
    });
    const frames: Frame[] = [];
    const engine = bridge(h, frames, { replay: false });
    h.clock.advance(60_000);
    engine.tick();
    expect(frames.filter((frame) => frame.type === 'filing:reading')).toEqual([]);
  });
});

describe('BOOK-206 B5 — a refused read reaches the page as a decision', () => {
  it('drains `triage.failed` of a refused triage as the reading’s own frame, once', async () => {
    const h = await boot();
    const id = await post(h);
    // The engine's refusal, as `refuseTriage` leaves it: the row is decided, the attempt settled,
    // and no hour is named anywhere — the filing has left every queue.
    const at = '2026-10-25T12:10:00.000Z';
    h.db.prepare(`UPDATE comments SET status = 'rejected', reason = ?, decided_at = ? WHERE id = ?`).run(
      TRIAGE_REFUSED_LINE,
      at,
      id,
    );
    h.db
      .prepare(`UPDATE comment_attempts SET outcome = 'refused', tries = 3, next_at = NULL WHERE comment_id = ?`)
      .run(id);
    const frames: Frame[] = [];
    const engine = bridge(h, frames, { replay: true });

    appendCommentEvent(h.db, id, 'triage.failed', at, {
      code: 'TRIAGE_UNPLACED',
      attempt: 1,
      try: 3,
      cap: true,
      retryAt: null,
    });

    engine.tick();

    // §10.1 (BOOK-220): the reading's own frame is the page's word for a failed try, and the
    // row's sentence is read from the DTO — never a second `comment:decision` for one row.
    const reading = frames.filter((frame) => frame.type === 'filing:reading');
    expect(reading).toHaveLength(1);
    expect(reading[0]?.data).toMatchObject({ commentId: id, chapter: 8, phase: 'failed' });
    expect(frames.filter((frame) => frame.type === 'comment:decision')).toEqual([]);

    // A second failure kind on the same refusal is its own row, told once: the abandoned claim
    // carries the same row and no hour.
    appendCommentEvent(h.db, id, 'triage.abandoned', '2026-10-25T12:20:00.000Z', {
      attempt: 2,
      tries: 3,
      detail: 'claim-abandoned',
    });
    const seen = frames.length;
    engine.tick();
    const after = frames.slice(seen).filter((frame) => frame.type === 'filing:reading');
    expect(after.length).toBeLessThanOrEqual(1);
    for (const frame of after) {
      expect(String((frame.data as { reason?: string }).reason ?? '')).not.toContain('00:00');
    }

    // The cursor has already passed both rows: a second tick narrates nothing.
    const settled = frames.length;
    engine.tick();
    expect(frames.slice(settled).filter((frame) => frame.type === 'filing:reading')).toEqual([]);
  });
});
