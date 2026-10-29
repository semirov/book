import { afterEach, describe, expect, it } from 'vitest';

import { READING_RESCHEDULED_LINE } from '@book/shared';

import { appendCommentEvent } from '../src/comments/repo.ts';
import { EngineBridge } from '../src/engineState/bridge.ts';
import { DecisionsTailer } from '../src/feedback/decisions.ts';
import { bootComments, commentBody, type Clock, type Harness } from './comments/helpers.ts';
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
    expect('report' in (decision ?? {})).toBe(true);
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

describe('BOOK-206 B5 — a read that never happened reaches the page', () => {
  it('drains `triage.failed` at the cap and `triage.abandoned`, once each', async () => {
    const h = await boot();
    const id = await post(h);
    h.db.prepare(`UPDATE comments SET reason = ? WHERE id = ?`).run(READING_RESCHEDULED_LINE, id);
    const frames: Frame[] = [];
    const engine = bridge(h, frames, { replay: true });

    // The cap: the attempt is back at the next UTC midnight with its line rescheduled.
    const retryAt = '2026-10-26T00:00:00.000Z';
    h.db.prepare(`UPDATE comment_attempts SET tries = 3, next_at = ? WHERE comment_id = ?`).run(retryAt, id);
    appendCommentEvent(h.db, id, 'triage.failed', '2026-10-25T12:10:00.000Z', {
      code: 'PROVIDER_SHAPE',
      attempt: 1,
      try: 3,
      cap: true,
      retryAt,
    });

    engine.tick();

    const cap = frames.find((frame) => frame.type === 'comment:decision')?.data;
    expect(cap).toMatchObject({
      id,
      chapter: 8,
      // The row's own sentence is the one the DTO prints — never «остаётся в очереди».
      status: 'new',
      reason: READING_RESCHEDULED_LINE,
      changeId: null,
      applied: null,
    });
    expect(cap?.attempt).toEqual({ state: 'failed', retryAt });
    expect(JSON.stringify(cap)).not.toContain('остаётся в очереди');

    // An abandoned claim carries no `retryAt` of its own: the rescheduled attempt row is the fact.
    appendCommentEvent(h.db, id, 'triage.abandoned', '2026-10-25T12:20:00.000Z', {
      attempt: 2,
      tries: 3,
      detail: 'claim-abandoned',
    });
    const seen = frames.length;
    engine.tick();

    const abandoned = frames
      .slice(seen)
      .filter((frame) => frame.type === 'comment:decision')
      .map((frame) => frame.data);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.attempt).toEqual({ state: 'failed', retryAt });

    // One frame per transition: the cursor has already passed both rows.
    const after = frames.length;
    engine.tick();
    expect(frames.slice(after).filter((frame) => frame.type === 'comment:decision')).toEqual([]);
  });

  it('says nothing for an event whose filing is withdrawn', async () => {
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
      cap: true,
      retryAt: '2026-10-26T00:00:00.000Z',
    });
    appendCommentEvent(h.db, withdrawn, 'triage.abandoned', '2026-10-25T12:12:00.000Z', {
      attempt: 1,
      tries: 3,
      detail: 'claim-abandoned',
    });
    engine.tick();

    // Only the filing that still stands speaks; a withdrawn row is never republished.
    const decisions = frames.filter((frame) => frame.type === 'comment:decision');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.data.id).toBe(gone);
  });

  it('primes its cursor: a restart does not replay yesterday’s failure', async () => {
    const h = await boot();
    const id = await post(h);
    appendCommentEvent(h.db, id, 'triage.failed', '2026-10-24T12:00:00.000Z', {
      code: 'PROVIDER_SHAPE',
      attempt: 1,
      try: 3,
      cap: true,
      retryAt: '2026-10-25T00:00:00.000Z',
    });
    const frames: Frame[] = [];

    const engine = bridge(h, frames, { replay: false });
    const clock: Clock = h.clock;
    clock.advance(60_000);
    engine.tick();

    expect(frames.filter((frame) => frame.type === 'comment:decision')).toEqual([]);
  });
});
