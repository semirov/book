/**
 * BOOK-145 — a database fault has a name, not a bare `INTERNAL`.
 *
 * Two of them hid real bugs in prod: «database is locked» on a stage write, and «no such column»
 * on a close (a binary ahead of its migration). Both reached the writer as `INTERNAL: internal
 * error`, which says nothing an operator can act on. The mapping is pinned here.
 */

import { describe, expect, it } from 'vitest';

import { buildControl } from '../../src/engine/control.ts';
import type { Db } from '../../src/db/db.ts';
import { createEngineFixture } from './helpers.ts';

const TOKEN = 'test-token';

/** A database whose every statement fails the way the two prod faults did. */
function failingDb(message: string, code: string): Db {
  const failure = Object.assign(new Error(message), { code });
  return {
    prepare: () => {
      throw failure;
    },
    exec: () => {
      throw failure;
    },
    pragma: () => [],
    transaction: () => () => undefined,
  } as unknown as Db;
}

describe('a database failure is a code, not INTERNAL', () => {
  it('maps a busy database to 503 DB_BUSY', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({
      engine: fixture.engine,
      db: failingDb('database is locked', 'SQLITE_BUSY'),
      token: TOKEN,
      logger: false,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/stage',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          passId: 'stp_x',
          stage: 'queued',
          at: Date.now(),
          actor: { process: 'writer', model: null },
          summary: 'тест',
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'DB_BUSY' });
      expect(response.json().message).not.toBe('internal error');
    } finally {
      fixture.close();
    }
  });

  it('maps a missing column to SCHEMA_MISMATCH', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({
      engine: fixture.engine,
      db: failingDb('no such column: provenance', 'SQLITE_ERROR'),
      token: TOKEN,
      logger: false,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/stage',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {
          passId: 'stp_x',
          stage: 'queued',
          at: Date.now(),
          actor: { process: 'writer', model: null },
          summary: 'тест',
        },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: 'SCHEMA_MISMATCH' });
      expect(response.json().message).toMatch(/миграция/u);
    } finally {
      fixture.close();
    }
  });
});
