import { afterEach, describe, expect, it } from 'vitest';

import { CommentService } from '../src/comments/service.ts';
import { readIdentity } from '../src/db/repo/identities.ts';
import { bootComments, commentBody, type Harness } from './comments/helpers.ts';

/**
 * BOOK-113 — the owner's exemption from the daily edit budget.
 *
 * The product's rule is one edit a day, counted twice (BOOK-DOC-4 rule 5): per identity and
 * per network. The owner has to see the effect of a change at once while testing, so one
 * identity may carry `edit_exempt = 1`; both edit counters are then skipped, and the comment
 * budget — the anti-farming one — still applies. Everyone else is unaffected.
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

  it('a normal identity is refused the second edit with «одна правка в сутки»', async () => {
    const h = await boot();
    const first = await post(
      h,
      commentBody({ body: 'Первый абзац лучше начать иначе.', proposedText: 'Тестовый абзац.' }),
    );
    expect(first.statusCode).toBe(201);
    expect(first.json().remaining.editsExempt).toBeUndefined();

    const second = await post(
      h,
      commentBody({ body: 'Второй абзац тоже стоит сократить.', proposedText: 'Тестовый абзац номер два.' }),
    );
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ code: 'EDIT_DAILY_LIMIT' });
    expect(second.json().message).toContain('одна правка в сутки');
    expect(commentCount(h)).toBe(1);
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

  it('an exempt identity still spends the ten-a-hour comment budget', async () => {
    const h = await boot();
    exempt(h);
    const cap = Math.min(h.config.commentsPerHourIdentity, h.config.commentsPerHour);
    expect(cap).toBeGreaterThan(1);

    for (let index = 0; index < cap; index += 1) {
      const response = await post(h, commentBody({ body: `Замечание номер ${String(index + 1)} к главе.` }));
      expect(response.statusCode, `comment ${String(index)}`).toBe(201);
    }
    const refused = await post(h, commentBody({ body: 'Замечание сверх часа.' }));
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(commentCount(h)).toBe(cap);
  });
});
