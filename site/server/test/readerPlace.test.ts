import { describe, expect, it, afterEach } from 'vitest';

import { TOTAL_CHAPTERS, type ReaderPlaceDto } from '@book/shared';

import { openDatabase, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { migrateV34 } from '../src/db/migrateV34.ts';
import { upsertIdentity } from '../src/db/repo/identities.ts';
import { readPlace, writePlace } from '../src/db/repo/places.ts';
import { REQUIRED_TABLES, SCHEMA_VERSION } from '../src/db/schema.ts';
import { parsePlace } from '../src/http/routes/place.ts';
import { bootComments, type Harness } from './comments/helpers.ts';
import { otherReader } from './myDecisions/seeds.ts';

/**
 * BOOK-209, requirement 3 — the reader's place, kept server-side so a second device resumes.
 *
 * The unit is one row per identity, an **anchor** (`chapter` + `sentenceId` + `deltaPx`) and the
 * moment of the visit; the surface is own only, and the identity is the session cookie and
 * nothing else. What is pinned here: v34 is additive and idempotent and a migrated volume equals
 * a fresh one; an anonymous visitor is refused on both verbs; «no row» is a `204` and never an
 * invented chapter 1; the round trip is faithful; a second `PUT` replaces the row instead of
 * stacking one; two identities cannot see each other; every malformed body is a `400 BAD_PLACE`
 * that wrote nothing; and every answer is `no-store`.
 */

/** A place of reader A: chapter 12, its third block, fourth sentence, a little above the line. */
const PLACE: ReaderPlaceDto = {
  chapter: 12,
  sentenceId: 'ch12#b3/s4',
  deltaPx: -18.5,
  at: '2026-10-29T09:15:00.000Z',
};

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function tableColumns(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

function tableSql(db: Db, table: string): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined;
  return (row?.sql ?? '').replace(/\s+/gu, ' ').trim();
}

function foreignKeys(db: Db, table: string): Array<{ table: string; from: string; on_delete: string }> {
  return db.pragma(`foreign_key_list(${table})`) as Array<{ table: string; from: string; on_delete: string }>;
}

/** The rows of one identity — the only way this suite looks at the store directly. */
function placeRows(db: Db, identityId: string): unknown[] {
  return db.prepare('SELECT * FROM reader_places WHERE identity_id = ?').all(identityId);
}

function get(h: Harness, cookie?: string) {
  return h.app.inject({
    method: 'GET',
    url: '/api/me/place',
    ...(cookie === undefined ? {} : { headers: { cookie: `book_session=${cookie}` } }),
  });
}

function put(h: Harness, body: unknown, cookie = h.cookie) {
  return h.app.inject({
    method: 'PUT',
    url: '/api/me/place',
    headers: { 'content-type': 'application/json', cookie: `book_session=${cookie}` },
    payload: body as Record<string, unknown>,
  });
}

function putAnonymous(h: Harness, body: unknown) {
  return h.app.inject({
    method: 'PUT',
    url: '/api/me/place',
    headers: { 'content-type': 'application/json' },
    payload: body as Record<string, unknown>,
  });
}

describe('migrate — BOOK-209 (v34): the reader’s place', () => {
  it('creates the table on a fresh install, at the head version, keyed by the identity', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION });
    expect(SCHEMA_VERSION).toBe(38);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(38);

    expect(tableColumns(db, 'reader_places')).toEqual(['identity_id', 'chapter', 'sentence_id', 'delta_px', 'at']);
    expect(REQUIRED_TABLES).toContain('reader_places');
    // One row per identity is a database fact, not an application check.
    const keys = (db.pragma('table_info(reader_places)') as Array<{ name: string; pk: number }>)
      .filter((column) => column.pk > 0)
      .map((column) => column.name);
    expect(keys).toEqual(['identity_id']);
    // A forgotten identity leaves no trace of where its owner was reading.
    expect(foreignKeys(db, 'reader_places')).toEqual([
      expect.objectContaining({ table: 'identities', from: 'identity_id', on_delete: 'CASCADE' }),
    ]);
    db.close();
  });

  it('adds the table to a v33 volume without touching a row, and a replay changes nothing', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const identity = upsertIdentity(db, {
      yandexSub: 'yandex-3003',
      displayName: 'Вера',
      at: '2026-10-28T08:00:00Z',
    });
    db.prepare(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, written_at, updated_at)
       VALUES (7, 2, 'Седьмая', 'abc', 10, 1, '2026-10-28T08:00:00Z', '2026-10-28T08:00:00Z')`,
    ).run();

    // A v33 install: `reader_places` is not there yet and the cursor is two steps back (v34, the
    // place, then BOOK-220's v35), so this proves the step still chains onto an existing store.
    db.exec('DROP TABLE reader_places');
    db.pragma('user_version = 33');

    expect(migrate(db)).toEqual({ from: 33, to: SCHEMA_VERSION });
    expect(tableColumns(db, 'reader_places')).toEqual(['identity_id', 'chapter', 'sentence_id', 'delta_px', 'at']);
    // Nothing of the book or the reader moved.
    expect(db.prepare('SELECT title, rev FROM chapters WHERE n = 7').get()).toEqual({ title: 'Седьмая', rev: 2 });
    expect(db.prepare('SELECT display_name FROM identities WHERE id = ?').get(identity.id)).toEqual({
      display_name: 'Вера',
    });

    // The table a migration creates is the table a fresh install creates — one constant, both.
    const fresh = openDatabase(':memory:');
    migrate(fresh);
    expect(tableSql(db, 'reader_places')).toBe(tableSql(fresh, 'reader_places'));
    fresh.close();

    // A stored place survives a replay, and a second migrate is a no-op.
    writePlace(db, identity.id, PLACE);
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    expect(placeRows(db, identity.id)).toHaveLength(1);
    expect(readPlace(db, identity.id)).toEqual(PLACE);
    db.close();
  });

  it('is idempotent on its own: the v34 step can run twice without touching the table or its rows', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const identity = upsertIdentity(db, {
      yandexSub: 'yandex-5005',
      displayName: 'Дина',
      at: '2026-10-28T08:00:00Z',
    });
    writePlace(db, identity.id, PLACE);
    const shape = tableSql(db, 'reader_places');

    expect(() => migrateV34(db)).not.toThrow();
    expect(() => migrateV34(db)).not.toThrow();
    expect(tableSql(db, 'reader_places')).toBe(shape);
    expect(readPlace(db, identity.id)).toEqual(PLACE);
    db.close();
  });

  it('refuses what the route would refuse, whatever the caller', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const identity = upsertIdentity(db, {
      yandexSub: 'yandex-4004',
      displayName: 'Глеб',
      at: '2026-10-28T08:00:00Z',
    });
    // The store is dumb on purpose: the route bounds the value, the column only refuses a value
    // that could not be a chapter of this book at all (the storage bound of BOOK-155).
    expect(() =>
      db
        .prepare(`INSERT INTO reader_places (identity_id, chapter, sentence_id, delta_px, at) VALUES (?, 0, 'a', 1, 'z')`)
        .run(identity.id),
    ).toThrow(/CHECK constraint failed/u);
    expect(() =>
      db
        .prepare(`INSERT INTO reader_places (identity_id, chapter, sentence_id, delta_px, at) VALUES ('nobody', 1, 'a', 1, 'z')`)
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/u);
    // An identity that never left a place reads as `null`, not as a default row.
    expect(readPlace(db, identity.id)).toBeNull();
    db.close();
  });
});

describe('GET /api/me/place (BOOK-209)', () => {
  it('refuses an anonymous visitor in the shared auth shape, and stores nothing', async () => {
    harness = await bootComments();
    const response = await get(harness);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers 204 before anything was written — no invented chapter 1', async () => {
    harness = await bootComments();
    const response = await get(harness, harness.cookie);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('returns what PUT stored, field for field, and never stores an identity in the body', async () => {
    harness = await bootComments();
    const written = await put(harness, PLACE);
    expect(written.statusCode).toBe(204);
    expect(written.headers['cache-control']).toBe('no-store');

    const response = await get(harness, harness.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual(PLACE);
    // The answer names a place, never a reader.
    expect(JSON.stringify(response.json())).not.toContain(harness.identity.id);
  });

  it('keeps one row per identity: a second PUT replaces the first place', async () => {
    harness = await bootComments();
    await put(harness, PLACE);
    const moved: ReaderPlaceDto = {
      chapter: 3,
      sentenceId: 'ch03#a1/s2',
      deltaPx: 120,
      at: '2026-10-29T10:40:00.000Z',
    };
    expect((await put(harness, moved)).statusCode).toBe(204);

    expect((await get(harness, harness.cookie)).json()).toEqual(moved);
    expect(placeRows(harness.db, harness.identity.id)).toHaveLength(1);
  });

  it('never carries the reader back: an older or equal `at` leaves the row, a newer one wins', async () => {
    harness = await bootComments();
    expect((await put(harness, PLACE)).statusCode).toBe(204);

    // A second device (or a tab) whose clock is behind: its write is a no-op, and it is not an
    // error — the stored place is already at least as new as the one it sent.
    const stale: ReaderPlaceDto = {
      chapter: 5,
      sentenceId: 'ch05#c/s1',
      deltaPx: 33,
      at: '2026-10-29T09:00:00.000Z',
    };
    expect((await put(harness, stale)).statusCode).toBe(204);
    expect((await get(harness, harness.cookie)).json()).toEqual(PLACE);

    // The same instant with different content is not «newer»: the rule is strict, so the row stands.
    const sameMoment: ReaderPlaceDto = { ...PLACE, chapter: 9, sentenceId: 'ch09#d/s2' };
    expect((await put(harness, sameMoment)).statusCode).toBe(204);
    expect((await get(harness, harness.cookie)).json()).toEqual(PLACE);

    // A genuinely newer visit is the one that stands.
    const newer: ReaderPlaceDto = {
      chapter: 4,
      sentenceId: 'ch04#q/s7',
      deltaPx: -3,
      at: '2026-10-29T10:00:00.000Z',
    };
    expect((await put(harness, newer)).statusCode).toBe(204);
    expect((await get(harness, harness.cookie)).json()).toEqual(newer);

    // Still one row, whichever device won.
    expect(placeRows(harness.db, harness.identity.id)).toHaveLength(1);
  });

  it('compares instants, not text: a later moment wins even when its offset reads as earlier', async () => {
    harness = await bootComments();
    // 10:00+03:00 is 07:00 UTC; 09:00Z is two hours later but sorts *before* it as a string.
    const stored: ReaderPlaceDto = { chapter: 2, sentenceId: 'ch02#a/s1', deltaPx: 1, at: '2026-10-29T10:00:00+03:00' };
    const later: ReaderPlaceDto = { chapter: 6, sentenceId: 'ch06#b/s2', deltaPx: 2, at: '2026-10-29T09:00:00Z' };
    expect((await put(harness, stored)).statusCode).toBe(204);
    expect((await put(harness, later)).statusCode).toBe(204);
    expect((await get(harness, harness.cookie)).json()).toEqual(later);
  });

  it('does not let an unreadable stored instant freeze the row', async () => {
    harness = await bootComments();
    // A row that came in some other way (a restore, a hand edit) whose `at` is not an instant:
    // it cannot be compared, and a place nobody can interpret must not lock the reader in place.
    harness.db
      .prepare(`INSERT INTO reader_places (identity_id, chapter, sentence_id, delta_px, at) VALUES (?, 3, 'ch03#x/s1', 5, 'not-a-date')`)
      .run(harness.identity.id);

    expect((await put(harness, PLACE)).statusCode).toBe(204);
    expect((await get(harness, harness.cookie)).json()).toEqual(PLACE);

    // Once a readable instant is on record, the ordinary rule is back: a stale write loses again.
    const stale: ReaderPlaceDto = { ...PLACE, chapter: 1, at: '2026-10-29T08:00:00Z' };
    expect((await put(harness, stale)).statusCode).toBe(204);
    expect((await get(harness, harness.cookie)).json()).toEqual(PLACE);
  });

  it('isolates two identities: A’s place is invisible to B, whose own answer stays 204', async () => {
    harness = await bootComments();
    const boris = otherReader(harness);
    await put(harness, PLACE);

    const theirs = await get(harness, boris.cookie);
    expect(theirs.statusCode).toBe(204);
    expect(theirs.body).toBe('');

    const bPlace: ReaderPlaceDto = { chapter: 2, sentenceId: 'ch02#z9/s1', deltaPx: 4, at: '2026-10-29T11:00:00.000Z' };
    expect((await put(harness, bPlace, boris.cookie)).statusCode).toBe(204);

    // Each reader reads their own row and only their own.
    expect((await get(harness, boris.cookie)).json()).toEqual(bPlace);
    expect((await get(harness, harness.cookie)).json()).toEqual(PLACE);
    expect(placeRows(harness.db, harness.identity.id)).toHaveLength(1);
    expect(placeRows(harness.db, boris.identity.id)).toHaveLength(1);
  });

  it('takes the identity from the cookie alone: an id in the query is answered with the caller’s place', async () => {
    harness = await bootComments();
    const boris = otherReader(harness);
    await put(harness, PLACE);

    const viaQuery = await harness.app.inject({
      method: 'GET',
      url: `/api/me/place?identity=${boris.identity.id}&identityId=${boris.identity.id}`,
      headers: { cookie: harness.sessionCookieHeader },
    });
    expect(viaQuery.statusCode).toBe(200);
    expect(viaQuery.json()).toEqual(PLACE);
  });
});

describe('PUT /api/me/place (BOOK-209)', () => {
  it('refuses an anonymous writer before it reads the body', async () => {
    harness = await bootComments();
    const response = await putAnonymous(harness, PLACE);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(placeRows(harness.db, harness.identity.id)).toHaveLength(0);
  });

  it('refuses every body that is not exactly the place, and writes nothing', async () => {
    harness = await bootComments();
    const long = `ch12#${'a'.repeat(196)}`; // 201 characters, one past the anchor bound
    expect(long).toHaveLength(201);
    const cases: Array<[string, unknown]> = [
      ['chapter 0', { ...PLACE, chapter: 0 }],
      ['chapter past the book', { ...PLACE, chapter: TOTAL_CHAPTERS + 1 }],
      ['fractional chapter', { ...PLACE, chapter: 8.5 }],
      ['chapter as text', { ...PLACE, chapter: '12' }],
      ['empty sentenceId', { ...PLACE, sentenceId: '' }],
      ['201-character sentenceId', { ...PLACE, sentenceId: long }],
      ['sentenceId with a space', { ...PLACE, sentenceId: 'ch12#b3 s4' }],
      ['sentenceId with a newline', { ...PLACE, sentenceId: 'ch12#b3\ns4' }],
      ['deltaPx as text', { ...PLACE, deltaPx: 'abc' }],
      ['deltaPx past the bound', { ...PLACE, deltaPx: 10_001 }],
      ['at that is not a date', { ...PLACE, at: 'nope' }],
      ['at without a zone', { ...PLACE, at: '2026-10-29T09:15:00' }],
      ['the identity in the body', { ...PLACE, identityId: harness.identity.id }],
      ['a misspelled field', { chapter: PLACE.chapter, sentenceId: PLACE.sentenceId, deltaPx: PLACE.deltaPx, time: PLACE.at }],
      ['a missing field', { chapter: PLACE.chapter, sentenceId: PLACE.sentenceId, deltaPx: PLACE.deltaPx }],
      ['an empty body', {}],
      ['an array', [PLACE]],
    ];

    for (const [label, body] of cases) {
      const response = await put(harness, body);
      expect(response.statusCode, label).toBe(400);
      expect(response.headers['cache-control'], label).toBe('no-store');
      expect(response.json(), label).toMatchObject({ code: 'BAD_PLACE' });
    }

    // No rejected body wrote a row, and the reader still reads as «no place».
    expect(placeRows(harness.db, harness.identity.id)).toHaveLength(0);
    expect((await get(harness, harness.cookie)).statusCode).toBe(204);
  });

  it('accepts the bounds themselves: chapter 1, chapter TOTAL_CHAPTERS, ±10 000 px', async () => {
    harness = await bootComments();
    // Ascending moments on purpose: a place only moves forward, so each write must be newer.
    const edges: ReaderPlaceDto[] = [
      { chapter: 1, sentenceId: 'ch01#a/s0', deltaPx: 0, at: '2026-10-29T00:00:00Z' },
      { chapter: 7, sentenceId: 'ch07#b1/s1', deltaPx: -10_000, at: '2026-10-29T09:15:00.123Z' },
      { chapter: TOTAL_CHAPTERS, sentenceId: 'ch42#z/s9', deltaPx: 10_000, at: '2026-10-29T23:59:59+03:00' },
    ];
    for (const place of edges) {
      expect((await put(harness, place)).statusCode).toBe(204);
      expect((await get(harness, harness.cookie)).json()).toEqual(place);
    }
  });
});

describe('parsePlace (BOOK-209)', () => {
  it('refuses a body that is not an object at all, and accepts the DTO untouched', () => {
    // A missing body never reaches the validator through the wire (Fastify answers an empty JSON
    // body itself), so the shapes below are checked here rather than as a status code.
    for (const body of [undefined, null, 'a place', 12, true, []]) {
      expect(parsePlace(body).ok, JSON.stringify(body)).toBe(false);
    }
    expect(parsePlace(PLACE)).toEqual({ ok: true, place: PLACE });
  });
});
