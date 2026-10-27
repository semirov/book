import { afterEach, describe, expect, it } from 'vitest';

import { upsertIdentity } from '../src/db/repo/identities.ts';
import type { CaptchaVerifier } from '../src/captcha/verify.ts';
import { bootComments, commentBody, type Harness } from './comments/helpers.ts';

/**
 * One submission, one row (BOOK-111) — the idempotency half of the posting API, split out of
 * `commentsApi.test.ts` when that file reached the arch line limit.
 *
 * A key is scoped to one reader (a foreign key is a collision, and the refusal names no row);
 * a replay returns the first answer; and two requests that pass the checks and then meet at
 * the CAPTCHA await are serialised by the UNIQUE index on `idem_key`, never by a 500.
 */

let harness: Harness | null = null;

async function boot(options: Parameters<typeof bootComments>[0] = {}): Promise<Harness> {
  harness = await bootComments(options);
  return harness;
}

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function post(h: Harness, body: unknown, headers: Record<string, string> = h.headers()) {
  return h.app.inject({ method: 'POST', url: '/api/comments', headers, payload: body as object });
}

/**
 * A CAPTCHA stub that holds every call until two are in flight, then releases them
 * together: the one await in the posting path is where two requests can interleave.
 */
function gatedCaptcha(): { verifier: CaptchaVerifier; together: Promise<void>; release: () => void } {
  let arrived = 0;
  let resolveGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  let bothInFlight!: () => void;
  const together = new Promise<void>((resolve) => {
    bothInFlight = resolve;
  });
  const verifier: CaptchaVerifier = async () => {
    arrived += 1;
    if (arrived === 2) bothInFlight();
    await gate;
    return { ok: true, band: 'ok' };
  };
  return { verifier, together, release: () => resolveGate() };
}

describe('POST /api/comments — one key, one row', () => {
  it('refuses an idempotency key reused by another reader', async () => {
    const h = await boot();
    expect((await post(h, commentBody({ idempotencyKey: 'shared-key', body: 'Первый текст с ключом.' }))).statusCode).toBe(201);
    const other = upsertIdentity(h.db, {
      yandexSub: 'yandex-2002',
      displayName: 'Борис',
      at: h.clock.now().toISOString(),
    });
    const otherSession = h.sessions.issue(other.id, { ipKey: '198.51.100.9' });
    const foreign = await post(
      h,
      commentBody({ idempotencyKey: 'shared-key', body: 'Другой текст с тем же ключом.' }),
      h.headers({ cookie: `book_session=${otherSession.cookie}` }),
    );
    expect(foreign.statusCode).toBe(409);
    // Another reader's row is not named: it may be hidden from them, and the refusal is about
    // the key, not about a filing this reader was never shown (BOOK-111).
    expect(foreign.json()).toMatchObject({ code: 'DUPLICATE' });
    expect(foreign.json().commentId).toBeUndefined();
  });

  it('is idempotent for one idempotency key', async () => {
    const h = await boot();
    const body = commentBody({ idempotencyKey: 'idem-1', body: 'Один и тот же текст с ключом.' });
    const first = await post(h, body);
    const second = await post(h, body);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().comment.id).toBe(first.json().comment.id);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 1 });
  });

  it('answers two overlapping posts with one key from one row, not with a 500', async () => {
    // Both requests pass the idempotency check, then meet at the CAPTCHA await: releasing
    // them together is the exact race the UNIQUE index on `idem_key` has to survive.
    const gated = gatedCaptcha();
    const h = await boot({ captchaProvider: 'turnstile', captcha: gated.verifier });

    const body = commentBody({ idempotencyKey: 'race-key', body: 'Одна отправка, два запроса.' });
    const first = post(h, body);
    const second = post(h, body);
    await gated.together;
    gated.release();
    const [left, right] = await Promise.all([first, second]);

    expect([left.statusCode, right.statusCode]).toEqual([201, 201]);
    expect(left.json().comment.id).toBe(right.json().comment.id);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 1 });
  });

  it('survives a replay whose text differs: one key, one row, no 500', async () => {
    // A retry that rebuilt its body passes the dedupe check and meets the UNIQUE index on
    // `idem_key` — the case that used to surface as an empty 500.
    const gated = gatedCaptcha();
    const h = await boot({ captchaProvider: 'turnstile', captcha: gated.verifier });

    const key = 'race-key-different-text';
    const first = post(h, commentBody({ idempotencyKey: key, body: 'Первый вариант этой отправки.' }));
    const second = post(h, commentBody({ idempotencyKey: key, body: 'Второй вариант, тот же ключ.' }));
    await gated.together;
    gated.release();
    const [left, right] = await Promise.all([first, second]);

    expect([left.statusCode, right.statusCode]).toEqual([201, 201]);
    expect(left.json().comment.id).toBe(right.json().comment.id);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 1 });
  });
});
