import { afterEach, describe, expect, it } from 'vitest';

import { CommentService } from '../src/comments/service.ts';
import { isEditExempt } from '../src/comments/budget.ts';
import { readIdentity } from '../src/db/repo/identities.ts';
import { commentIdentityKey } from '../src/rate/policy.ts';
import { bootComments, commentBody, type Harness } from './comments/helpers.ts';

/**
 * BOOK-113 — the owner's exemption from the daily edit budget.
 *
 * The product's rule is one edit a day, counted twice (BOOK-DOC-4 rule 5): per identity and
 * per network, and BOOK-158 moved the spend to **acceptance**: posting a filing costs nothing,
 * so what an exempt reader is shown and what triage spends is the whole of this file. An
 * `edit_exempt = 1` identity skips both edit counters at triage; the comment budget — the
 * anti-farming one — still applies to everyone, and the attempt ledger (BOOK-158) bounds the
 * filings themselves: five an identity a UTC day.
 */

let harness: Harness | null = null;

async function boot(): Promise<Harness> {
  harness = await bootComments();
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function post(h: Harness, body: unknown) {
  return h.app.inject({ method: 'POST', url: '/api/comments', headers: h.headers(), payload: body as object });
}

function exempt(h: Harness): void {
  h.db.prepare('UPDATE identities SET edit_exempt = 1 WHERE id = ?').run(h.identity.id);
}

function commentCount(h: Harness): number {
  return (h.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n;
}

describe('the daily edit budget and the operator exemption (BOOK-113)', () => {
  it('an exempt identity files two interventions in one day', async () => {
    const h = await boot();
    exempt(h);

    const first = await post(
      h,
      commentBody({ body: 'Первый абзац лучше начать иначе.', proposedText: 'Тестовый абзац.' }),
    );
    expect(first.statusCode).toBe(201);
    expect(first.json().remaining).toMatchObject({ editsExempt: true });

    // Same identity, same network, same day: without the exemption this is the second edit
    // and both counters (identity and network) would refuse it.
    const second = await post(
      h,
      commentBody({ body: 'Второй абзац тоже стоит сократить.', proposedText: 'Тестовый абзац номер два.' }),
    );
    expect(second.statusCode).toBe(201);
    expect(commentCount(h)).toBe(2);
    // The exemption is not a hole in the comment budget: the composer still sees it.
    expect(second.json().remaining.editsExempt).toBe(true);
    expect(second.json().remaining.editsRemaining).toBe(h.config.editSubmissionsPerDay);
    expect(second.json().remaining.editsResetAt).toBeNull();
  });

  it('a normal identity posts twice: BOOK-158 moved the spend to acceptance', async () => {
    const h = await boot();
    const first = await post(
      h,
      commentBody({ body: 'Первый абзац лучше начать иначе.', proposedText: 'Тестовый абзац.' }),
    );
    expect(first.statusCode).toBe(201);
    expect(first.json().remaining.editsExempt).toBeUndefined();
    // Posting spends nothing: the day is spent by the triage acceptance (`feedback/cli.ts`).
    expect(first.json().remaining.editsRemaining).toBe(h.config.editSubmissionsPerDay);

    const second = await post(
      h,
      commentBody({ body: 'Второй абзац тоже стоит сократить.', proposedText: 'Тестовый абзац номер два.' }),
    );
    expect(second.statusCode).toBe(201);
    expect(second.json().remaining.editsRemaining).toBe(h.config.editSubmissionsPerDay);
    expect(commentCount(h)).toBe(2);
  });

  it('an unknown exemption value is never an exemption: only an explicit 1 passes', async () => {
    // `edit_exempt !== 0` read a missing or unknown value as the owner's exemption — the one
    // direction a fail-open flag must never take. BOOK-158: the flag now decides whether triage
    // spends the day's edit, so the store's own predicate is what the test drives.
    const h = await boot();
    h.db.prepare('UPDATE identities SET edit_exempt = 2 WHERE id = ?').run(h.identity.id);

    const service = new CommentService({ db: h.db, config: h.config, limiter: h.limiter, captcha: h.captcha.verifier });
    expect(service.budget(h.identity.id, '203.0.113.7').editsExempt).toBeUndefined();
    expect(isEditExempt(h.db, h.identity.id)).toBe(false);

    h.db.prepare('UPDATE identities SET edit_exempt = 1 WHERE id = ?').run(h.identity.id);
    expect(isEditExempt(h.db, h.identity.id)).toBe(true);
  });

  it('budget() reports an exempt identity with the full day and no reset', async () => {
    const h = await boot();
    const service = new CommentService({
      db: h.db,
      config: h.config,
      limiter: h.limiter,
      captcha: h.captcha.verifier,
    });

    const ordinary = service.budget(h.identity.id, '203.0.113.7');
    expect(ordinary.editsExempt).toBeUndefined();
    expect(ordinary.editsRemaining).toBe(h.config.editSubmissionsPerDay);

    exempt(h);
    expect(readIdentity(h.db, h.identity.id)?.edit_exempt).toBe(1);
    const exempted = service.budget(h.identity.id, '203.0.113.7');
    expect(exempted.editsExempt).toBe(true);
    expect(exempted.editsRemaining).toBe(h.config.editSubmissionsPerDay);
    expect(exempted.editsPerDay).toBe(h.config.editSubmissionsPerDay);
    expect(exempted.editsResetAt).toBeNull();
    // The hourly comment line is unchanged: the exemption is about edits only.
    expect(exempted.perHour).toBe(h.config.commentsPerHourIdentity);
  });

  it('an exempt identity still spends the hourly comment budget', async () => {
    const h = await boot();
    exempt(h);
    // BOOK-158 caps one identity at five attempts a UTC day, so the hourly comment counter is
    // read from the budget the composer shows rather than by hitting a sixth post.
    const before = h.limiter.check({
      key: commentIdentityKey(h.identity.id),
      limit: h.config.commentsPerHourIdentity,
      windowMs: 60 * 60_000,
    });
    expect(before.used).toBe(0);

    for (let index = 0; index < 5; index += 1) {
      const response = await post(h, commentBody({ body: `Замечание номер ${String(index + 1)} к главе.` }));
      expect(response.statusCode, `comment ${String(index)}`).toBe(201);
    }
    const after = h.limiter.check({
      key: commentIdentityKey(h.identity.id),
      limit: h.config.commentsPerHourIdentity,
      windowMs: 60 * 60_000,
    });
    expect(after.used).toBe(5);
    expect(after.remaining).toBe(h.config.commentsPerHourIdentity - 5);
    expect(commentCount(h)).toBe(5);
  });
});
