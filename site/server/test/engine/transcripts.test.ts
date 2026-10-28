/**
 * BOOK-187 AC7 — the receipt in the table: one row per call, a repeat that stores nothing, and
 * retention that runs in the same transaction as the insert.
 *
 * Three things a pass depends on, and all three are about what happens on the second call or the
 * thirtieth day: a retried insert after a timeout must not double a receipt, an old row must go on
 * its own, and the row must be small enough that a table of them is not a second book.
 */

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildControl } from '../../src/engine/control.ts';
import { TRANSCRIPT_ROW_BYTES_MAX } from '../../src/db/repo/transcripts.ts';
import { toIso } from '../../src/util/time.ts';
import { createEngineFixture, type Fixture } from './helpers.ts';

const TOKEN = 'transcript-token';
const DAY = Date.UTC(2026, 9, 28, 12, 0, 0);

let closeApp: (() => Promise<void>) | null = null;

afterEach(async () => {
  await closeApp?.();
  closeApp = null;
});

async function appOf(options: { retentionDays?: number } = {}): Promise<{ app: FastifyInstance; fixture: Fixture }> {
  const created = createEngineFixture();
  const app = await buildControl({
    engine: created.engine,
    db: created.db,
    token: TOKEN,
    logger: false,
    ...(options.retentionDays === undefined ? {} : { transcriptRetentionDays: options.retentionDays }),
  });
  closeApp = async () => {
    await app.close();
    created.close();
  };
  return { app, fixture: created };
}

type Row = Record<string, unknown>;

const rowOf = (seq: number, overrides: Row = {}): Row => ({
  seq,
  at: DAY,
  role: 'draft',
  tokensIn: 10,
  tokensOut: 2,
  promptBundle: 'bundle-1',
  content: '{"promptSha256":"aa","answer":{"sha256":"bb","chars":3}}',
  ...overrides,
});

const post = (app: FastifyInstance, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/internal/transcript', headers: { authorization: `Bearer ${TOKEN}` }, payload: body });

const rowsOf = (db: Fixture['db'], passId: string): Row[] =>
  db.prepare('SELECT * FROM pass_transcripts WHERE pass_id = ? ORDER BY seq').all(passId) as Row[];

describe('POST /internal/transcript', () => {
  it('stores one row per call and answers how many were new', async () => {
    const { app, fixture } = await appOf();
    const response = await post(app, { passId: 'stp_1', rows: [rowOf(1), rowOf(2, { role: 'gate:editor', tokensIn: 5, tokensOut: 1 })] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { stored: 2, pruned: 0 } });

    const rows = rowsOf(fixture.db, 'stp_1');
    expect(rows.map((row) => [row.seq, row.role, row.tokens_in, row.tokens_out, row.prompt_bundle])).toEqual([
      [1, 'draft', 10, 2, 'bundle-1'],
      [2, 'gate:editor', 5, 1, 'bundle-1'],
    ]);
    expect(rows[0]?.at).toBe(toIso(DAY));
    expect(rows[0]?.content_redacted).toContain('promptSha256');
  });

  it('stores nothing new for a repeated (passId, seq): a retry is not a second receipt', async () => {
    const { app, fixture } = await appOf();
    await post(app, { passId: 'stp_1', rows: [rowOf(1)] });
    const again = await post(app, { passId: 'stp_1', rows: [rowOf(1, { content: '{"different":true}' }), rowOf(2)] });
    expect(again.json().data).toEqual({ stored: 1, pruned: 0 });
    const rows = rowsOf(fixture.db, 'stp_1');
    expect(rows).toHaveLength(2);
    // The first write wins: a retried receipt cannot rewrite the evidence of the first one.
    expect(rows[0]?.content_redacted).toBe('{"promptSha256":"aa","answer":{"sha256":"bb","chars":3}}');
  });

  it('prunes rows older than the retention window and keeps the young ones', async () => {
    const { app, fixture } = await appOf();
    const old = DAY - 31 * 24 * 60 * 60 * 1000;
    const fresh = DAY - 29 * 24 * 60 * 60 * 1000;
    // Rows a previous process left: written straight into the table, because a write through the
    // route would sweep the old one on its way in (which is the behaviour under test).
    const seed = fixture.db.prepare(
      `INSERT INTO pass_transcripts (pass_id, seq, at, role, content_redacted, tokens_in, tokens_out, prompt_bundle)
       VALUES (?, 1, ?, 'draft', '{}', 0, 0, NULL)`,
    );
    seed.run('stp_old', toIso(old));
    seed.run('stp_fresh', toIso(fresh));
    expect(rowsOf(fixture.db, 'stp_old')).toHaveLength(1);

    // The next write is the sweep: the 31-day-old row goes, the 29-day-old one stays.
    const response = await post(app, { passId: 'stp_new', rows: [rowOf(1, { at: DAY })] });
    expect(response.json().data).toEqual({ stored: 1, pruned: 1 });
    expect(rowsOf(fixture.db, 'stp_old')).toHaveLength(0);
    expect(rowsOf(fixture.db, 'stp_fresh')).toHaveLength(1);
    expect(rowsOf(fixture.db, 'stp_new')).toHaveLength(1);
  });

  it('keeps a row with no bundle, and honours a configured retention', async () => {
    const { app, fixture } = await appOf({ retentionDays: 1 });
    const twoDaysAgo = DAY - 2 * 24 * 60 * 60 * 1000;
    fixture.db
      .prepare(
        `INSERT INTO pass_transcripts (pass_id, seq, at, role, content_redacted, tokens_in, tokens_out, prompt_bundle)
         VALUES ('stp_old', 1, ?, 'draft', '{}', 0, 0, NULL)`,
      )
      .run(toIso(twoDaysAgo));

    // A row of an image that carried no build stamp: the column is null, not a missing row.
    const response = await post(app, { passId: 'stp_1', rows: [{ ...rowOf(1), promptBundle: undefined }] });
    expect(response.json().data).toEqual({ stored: 1, pruned: 1 });
    expect(rowsOf(fixture.db, 'stp_1')[0]?.prompt_bundle).toBeNull();
    expect(rowsOf(fixture.db, 'stp_old')).toHaveLength(0);
  });

  it('refuses more than sixteen rows, a row over four kilobytes and an unknown role', async () => {
    const { app, fixture } = await appOf();
    const many = Array.from({ length: 17 }, (_value, index) => rowOf(index + 1));
    expect((await post(app, { passId: 'stp_1', rows: many })).statusCode).toBe(400);

    const fat = rowOf(1, { content: `"${'a'.repeat(TRANSCRIPT_ROW_BYTES_MAX)}"` });
    expect((await post(app, { passId: 'stp_1', rows: [fat] })).statusCode).toBe(400);

    expect((await post(app, { passId: 'stp_1', rows: [rowOf(1, { role: 'summary' })] })).statusCode).toBe(400);
    expect((await post(app, { passId: '', rows: [rowOf(1)] })).statusCode).toBe(400);
    expect((await post(app, { passId: 'stp_1', rows: [] })).statusCode).toBe(400);
    // A client that sends nothing at all: the schema answers, the table stays empty.
    expect(
      (await app.inject({ method: 'POST', url: '/internal/transcript', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode,
    ).toBe(400);
    expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM pass_transcripts').get()).toEqual({ n: 0 });
  });

  it('refuses with 503 when the control app holds no database', async () => {
    const created = createEngineFixture();
    const app = await buildControl({ engine: created.engine, token: TOKEN, logger: false });
    closeApp = async () => {
      await app.close();
      created.close();
    };
    const response = await post(app, { passId: 'stp_1', rows: [rowOf(1)] });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'TRANSCRIPTS_UNAVAILABLE' });
  });
});
