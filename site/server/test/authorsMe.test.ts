import { afterEach, describe, expect, it } from 'vitest';

import type { AuthorsDto, MyTraceDto } from '@book/shared';

import { upsertIdentity } from '../src/db/repo/identities.ts';
import { bootComments, type Harness } from './comments/helpers.ts';

/**
 * BOOK-DOC-4, the reader's own surfaces: `GET /api/authors/me` is session-only and own-only;
 * `POST /api/authors/hide` is idempotent, reversible and reflected by the list, the byline
 * count and the personal view. The measurement unit tests live in `authors.test.ts`.
 */

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

/** A surviving paragraph owned by one reader: the same rows the history writer produces. */
function seedSurviving(h: Harness, identityId: string, uid: string, chars = 120): void {
  h.db
    .prepare(
      `INSERT INTO block_versions
         (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
          change_id, step_id, actor_kind, actor_label, identity_id, at)
       VALUES (?, 1, 8, 2, 100, ?, 'h', ?, 'introduced', NULL, NULL,
               NULL, NULL, 'reader', 'читатель', ?, '2026-10-25T12:00:00Z')`,
    )
    .run(uid, `ch08#${uid}`, chars, identityId);
}

describe('GET /api/authors/me', () => {
  it('refuses an anonymous visitor with the shared auth shape', async () => {
    harness = await bootComments();
    const response = await harness.app.inject({ method: 'GET', url: '/api/authors/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(String(response.headers['cache-control'])).toContain('no-store');
  });

  it('answers with the session reader’s own trace and nobody else’s', async () => {
    harness = await bootComments();
    seedSurviving(harness, harness.identity.id, 'bkd_me');
    const boris = upsertIdentity(harness.db, {
      yandexSub: 'yandex-2002',
      displayName: 'Борис',
      at: '2026-10-25T12:00:00Z',
    });
    seedSurviving(harness, boris.id, 'bkd_boris', 500);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/authors/me',
      headers: { cookie: harness.sessionCookieHeader },
    });
    expect(response.statusCode).toBe(200);
    const trace = response.json() as MyTraceDto;
    expect(trace).toMatchObject({ label: 'Аня', edits: 0, hidden: false, series: [], survivedRevisions: 0 });
    expect(trace.chars).toBe(120);
    expect(trace.share).toBeGreaterThan(0);
    // Own only: the other reader's name and no identity key anywhere in the payload.
    const body = JSON.stringify(trace);
    expect(body).not.toContain('Борис');
    expect(body).not.toContain(harness.identity.id);
    expect(body).not.toContain(boris.id);
  });
});

describe('the author marker on the reader’s own surfaces (owner, 2026-10-28)', () => {
  async function me(h: Harness): Promise<MyTraceDto> {
    return (
      await h.app.inject({ method: 'GET', url: '/api/authors/me', headers: { cookie: h.sessionCookieHeader } })
    ).json() as MyTraceDto;
  }

  it('serves the author his own trace — and the list and the byline count only the second reader', async () => {
    harness = await bootComments();
    seedSurviving(harness, harness.identity.id, 'bkd_me', 300);
    const boris = upsertIdentity(harness.db, {
      yandexSub: 'yandex-2002',
      displayName: 'Борис',
      at: '2026-10-25T12:00:00Z',
    });
    seedSurviving(harness, boris.id, 'bkd_boris', 500);
    harness.db.prepare('UPDATE identities SET is_author = 1 WHERE id = ?').run(harness.identity.id);

    const trace = await me(harness);
    expect(trace).toMatchObject({ label: 'Аня', isAuthor: true, hidden: false, edits: 0 });
    // The author is still a reader for his own numbers: his chars, his share, his label.
    expect(trace.chars).toBe(300);
    expect(trace.share).toBeGreaterThan(0);
    // Own only, keyless — and no other reader's name in the payload.
    const body = JSON.stringify(trace);
    expect(body).not.toContain('Борис');
    expect(body).not.toContain(harness.identity.id);
    expect(body).not.toContain(boris.id);

    const list = (await harness.app.inject({ method: 'GET', url: '/api/authors' })).json() as AuthorsDto;
    expect(list.contributors.map((item) => item.label)).toEqual(['Борис']);
    // The author's own 300 characters are the remainder, not a row — the rest of the book is
    // written prose (no reader), which is also the author's.
    expect(list.author.chars).toBe(list.totalChars - 500);
    expect(list.author.chars).toBeGreaterThanOrEqual(300);
    expect(list.sum).toBe(1);
    const front = (await harness.app.inject({ method: 'GET', url: '/api/front' })).json() as {
      authors: { count: number };
    };
    expect(front.authors.count).toBe(1);
  });

  it('keeps the author out of the list and the byline whatever his hide flag says', async () => {
    harness = await bootComments();
    seedSurviving(harness, harness.identity.id, 'bkd_me', 300);
    harness.db.prepare('UPDATE identities SET is_author = 1 WHERE id = ?').run(harness.identity.id);

    const hidden = await harness.app.inject({
      method: 'POST',
      url: '/api/authors/hide',
      headers: harness.headers(),
      payload: { hidden: true },
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).toMatchObject({ hidden: true, authors: { count: 0 } });

    // Clearing the flag does not put him back: the exclusion is the marker, not the opt-out.
    const cleared = await harness.app.inject({
      method: 'POST',
      url: '/api/authors/hide',
      headers: harness.headers(),
      payload: { hidden: false },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ hidden: false, authors: { count: 0 } });

    const list = (await harness.app.inject({ method: 'GET', url: '/api/authors' })).json() as AuthorsDto;
    expect(list.contributors).toEqual([]);
    expect(list.author.share).toBe(1);
    expect((await me(harness)).isAuthor).toBe(true);
  });
});

describe('the front payload (BOOK-DOC-4)', () => {
  it('puts the byline count in the ETag, and never answers 304 (BOOK-109)', async () => {
    harness = await bootComments();
    const first = await harness.app.inject({ method: 'GET', url: '/api/front' });
    expect(first.json().authors.count).toBe(0);

    seedSurviving(harness, harness.identity.id, 'bkd_me');

    const stale = await harness.app.inject({
      method: 'GET',
      url: '/api/front',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().authors.count).toBe(1);
    // BOOK-60: the edition number rides the tag beside the front revision and N.
    expect(stale.headers.etag).toBe(`"front-0-a1-e${stale.json().revision}"`);

    // The same count again keeps the same tag, and the page arrives with it: a cached page
    // may not pin a byline, and no client is told its copy is still right (BOOK-109).
    const same = await harness.app.inject({
      method: 'GET',
      url: '/api/front',
      headers: { 'if-none-match': stale.headers.etag as string },
    });
    expect(same.statusCode).toBe(200);
    expect(same.headers.etag).toBe(stale.headers.etag);
    expect(same.json().authors.count).toBe(1);
    expect(same.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/authors/hide (BOOK-DOC-4)', () => {
  function hide(h: Harness, hidden: boolean) {
    return h.app.inject({
      method: 'POST',
      url: '/api/authors/hide',
      headers: h.headers(),
      payload: { hidden },
    });
  }

  it('keeps the byline and the surviving-text list in agreement when the last character is erased', async () => {
    harness = await bootComments();
    seedSurviving(harness, harness.identity.id, 'bkd_me');
    // A later writer takes the paragraph away: the uid's latest version is `erased`.
    harness.db
      .prepare(
        `INSERT INTO block_versions
           (block_uid, ver, chapter, rev, hseq, block_id, text_hash, chars, op, prev_ver, replaced_by,
            change_id, step_id, actor_kind, actor_label, identity_id, at)
         VALUES ('bkd_me', 2, 8, 3, 101, 'ch08#me', 'h2', 120, 'erased', 1, NULL,
                 NULL, NULL, 'author', 'автор', NULL, '2026-10-25T12:05:00Z')`,
      )
      .run();

    const front = (await harness.app.inject({ method: 'GET', url: '/api/front' })).json() as {
      authors: { count: number };
    };
    const list = (await harness.app.inject({ method: 'GET', url: '/api/authors' })).json() as AuthorsDto;
    const rows = list.contributors.filter((item) => item.chars > 0);
    expect(front.authors.count).toBe(0);
    expect(rows).toHaveLength(0);
    expect(front.authors.count).toBe(rows.length);

    // The zero state is the reader's own, and it is truthful: no trace, no invented curve.
    const me = (
      await harness.app.inject({
        method: 'GET',
        url: '/api/authors/me',
        headers: { cookie: harness.sessionCookieHeader },
      })
    ).json() as MyTraceDto;
    expect(me).toMatchObject({ chars: 0, share: 0, survivedRevisions: 0, series: [] });
  });

  it('requires a session', async () => {
    harness = await bootComments();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/authors/hide',
      headers: { origin: harness.config.publicOrigin, 'content-type': 'application/json' },
      payload: { hidden: true },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('refuses a body that is not a boolean', async () => {
    harness = await bootComments();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/authors/hide',
      headers: harness.headers(),
      payload: { hidden: 'yes' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID' });
  });

  it('is idempotent and reflected by the list, the byline and the personal view', async () => {
    harness = await bootComments();
    seedSurviving(harness, harness.identity.id, 'bkd_me');

    const before = (await harness.app.inject({ method: 'GET', url: '/api/authors' })).json() as AuthorsDto;
    expect(before.contributors.map((item) => item.label)).toContain('Аня');
    const front = (await harness.app.inject({ method: 'GET', url: '/api/front' })).json() as {
      authors: { count: number };
    };
    expect(front.authors.count).toBe(1);

    const first = await hide(harness, true);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ hidden: true, authors: { count: 0 } });
    const second = await hide(harness, true);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ hidden: true, authors: { count: 0 } });

    const after = (await harness.app.inject({ method: 'GET', url: '/api/authors' })).json() as AuthorsDto;
    expect(after.contributors.map((item) => item.label)).not.toContain('Аня');
    // Hiding is not deletion: the text is still measured, and it accrues to the author.
    expect(after.measured).toBe(before.measured);
    expect(after.author.share).toBe(1);

    const hiddenFront = (await harness.app.inject({ method: 'GET', url: '/api/front' })).json() as {
      authors: { count: number };
    };
    expect(hiddenFront.authors.count).toBe(0);

    const me = (
      await harness.app.inject({
        method: 'GET',
        url: '/api/authors/me',
        headers: { cookie: harness.sessionCookieHeader },
      })
    ).json() as MyTraceDto;
    expect(me.hidden).toBe(true);
    // The history and the share are still the reader's own view.
    expect(me.chars).toBe(120);
    expect(me.share).toBeGreaterThan(0);

    // Reversible, and page 1 follows at once through the same monotonic count.
    const back = await hide(harness, false);
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ hidden: false, authors: { count: 1 } });
    const restored = (await harness.app.inject({ method: 'GET', url: '/api/authors' })).json() as AuthorsDto;
    expect(restored.contributors.map((item) => item.label)).toContain('Аня');
  });

  it('broadcasts the new count so an open page follows without a poll', async () => {
    harness = await bootComments();
    seedSurviving(harness, harness.identity.id, 'bkd_me');
    await hide(harness, true);
    const frames = harness.emitted.filter((event) => event.type === 'authors:update');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data).toMatchObject({ count: 0 });
    expect(typeof (frames[0]?.data as { measuredAt?: unknown }).measuredAt).toBe('string');
  });

  it('refuses a foreign origin', async () => {
    harness = await bootComments();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/authors/hide',
      headers: { ...harness.headers(), origin: 'https://evil.test' },
      payload: { hidden: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'ORIGIN' });
  });

  it('refuses a non-JSON post: a state mutation is JSON only', async () => {
    harness = await bootComments();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/authors/hide',
      headers: { origin: harness.config.publicOrigin, 'content-type': 'text/plain' },
      payload: '{"hidden":true}',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'CONTENT_TYPE' });
  });

  it('spends the shared limiter, so a reader cannot churn the list', async () => {
    harness = await bootComments();
    for (let i = 0; i < 30; i += 1) {
      const response = await hide(harness, i % 2 === 0);
      expect(response.statusCode).toBe(200);
    }
    const blocked = await hide(harness, true);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
});
