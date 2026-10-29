import { afterEach, describe, expect, it } from 'vitest';

import type { MyFilingsDto } from '@book/shared';

import { bootComments, type Harness } from './comments/helpers.ts';
import { otherReader, seedComment } from './myDecisions/seeds.ts';

/**
 * BOOK-207 — `GET /api/me/filings`, the trail's own read.
 *
 * Own only from the session cookie, newest first, the newest 50, `no-store`. The route has no
 * id in the path or the query, so it cannot be turned into a way of reading another reader's
 * page; the test seeds a second reader's filing beside the first's and expects it gone.
 */

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function get(h: Harness, cookie?: string) {
  return h.app.inject({
    method: 'GET',
    url: '/api/me/filings',
    ...(cookie === undefined ? {} : { headers: { cookie: `book_session=${cookie}` } }),
  });
}

function own(h: Harness, id: string, createdAt: string): void {
  seedComment(h, { id, identityId: h.identity.id, createdAt });
}

describe('GET /api/me/filings (BOOK-207)', () => {
  it('refuses an anonymous visitor in the shared auth shape', async () => {
    harness = await bootComments();
    const response = await get(harness);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(String(response.headers['cache-control'])).toContain('no-store');
  });

  it('answers an empty page for a reader with no filings — no fake row', async () => {
    harness = await bootComments();
    const response = await get(harness, harness.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ items: [] });
  });

  it('gives the reader’s own filings only, newest first', async () => {
    harness = await bootComments();
    const boris = otherReader(harness);
    own(harness, 'cmt_old', '2026-10-20T09:00:00Z');
    own(harness, 'cmt_new', '2026-10-25T09:00:00Z');
    own(harness, 'cmt_mid', '2026-10-22T09:00:00Z');
    seedComment(harness, {
      id: 'cmt_boris',
      identityId: boris.identity.id,
      createdAt: '2026-10-26T09:00:00Z',
    });

    const answer = (await get(harness, harness.cookie)).json() as MyFilingsDto;
    expect(answer.items.map((item) => item.id)).toEqual(['cmt_new', 'cmt_mid', 'cmt_old']);
    // The other reader's filing never appears under this session.
    expect(answer.items.some((item) => item.id === 'cmt_boris')).toBe(false);
  });

  it('caps the page at the newest 50', async () => {
    harness = await bootComments();
    // 55 own filings, one a minute apart: the newest 50 is everything after the first five.
    for (let index = 0; index < 55; index += 1) {
      const minute = String(index % 60).padStart(2, '0');
      own(harness, `cmt_${String(index).padStart(3, '0')}`, `2026-10-20T09:${minute}:00Z`);
    }
    const answer = (await get(harness, harness.cookie)).json() as MyFilingsDto;
    expect(answer.items).toHaveLength(50);
    expect(answer.items[0]?.id).toBe('cmt_054');
    expect(answer.items.some((item) => item.id === 'cmt_004')).toBe(false);
  });
});
