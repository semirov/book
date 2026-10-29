/**
 * BOOK-187 AC3 — before the book has a chapter, it still has its two sentences.
 *
 * `book_frame` is seeded by the v28 migration, and the slot's answer comes from that **row**, not
 * from the constant the image compiles in: a fresh volume serves `/api/chapters/1` and
 * `/api/chapters/42` as basis slots, and a row edited by hand is what the reader is given — that
 * is the difference between «the DB is the book» and a second copy of the canon in the binary.
 * A slot with no frame row stays a 404 (`NOT_WRITTEN`), the normal answer for an empty slot.
 *
 * The fixture is a real migrated database with no `chapters` row at all: the state a brand-new
 * volume is in on its first boot, before the first pass lands anything.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS } from '@book/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { sha256Hex } from '../src/util/hash.ts';
import { createFixture, type Fixture } from './helpers.ts';

const roots: string[] = [];
let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

afterEach(() => {
  app = null;
  fixture?.close();
  fixture = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A migrated volume with the frame seeded and **no chapter row** — a fresh book. */
async function bootFreshBook(): Promise<{ lines: string[] }> {
  fixture = createFixture({});
  expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM chapters').get()).toEqual({ n: 0 });

  const lines: string[] = [];
  app = await buildApp({
    config: loadConfig({
      BOOK_ROOT: fixture.root,
      DATA_DIR: fixture.dataDir,
      WEB_DIST: tempDir('book-web-'),
      PORT: '8080',
    }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logStream: { write: (line) => lines.push(line) },
  });
  return { lines };
}

describe('GET /api/chapters/:n before the book has a chapter (BOOK-187 AC3)', () => {
  it('serves the opening frame as ch01’s one basis block, out of the row', async () => {
    await bootFreshBook();
    const stored = fixture!.db.prepare('SELECT text FROM book_frame WHERE chapter = 1 AND position = ?').get('first') as
      | { text: string }
      | undefined;
    expect(stored?.text).toBe(FRAME_FIRST_SENTENCE);

    const response = await app!.inject({ method: 'GET', url: '/api/chapters/1' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      n: number;
      rev: number;
      title: string | null;
      chars: number;
      basis: boolean;
      writtenAt: string | null;
      updatedAt: string | null;
      blocks: Array<{ id: string; i: number; text: string; hash: string }>;
    };
    expect(body).toMatchObject({
      n: 1,
      rev: 0,
      title: null,
      chars: 0,
      basis: true,
      writtenAt: null,
      updatedAt: null,
    });
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0]).toEqual({
      id: `ch01#${sha256Hex(FRAME_FIRST_SENTENCE).slice(0, 8)}`,
      i: 0,
      text: FRAME_FIRST_SENTENCE,
      hash: sha256Hex(FRAME_FIRST_SENTENCE).slice(0, 8),
    });
    // The cache tag names the projection, like every other answer.
    expect(String(response.headers.etag)).toContain('"');
  });

  it('serves the closing frame as ch42’s one basis block', async () => {
    await bootFreshBook();
    const body = (await app!.inject({ method: 'GET', url: `/api/chapters/${String(TOTAL_CHAPTERS)}` })).json() as {
      basis: boolean;
      blocks: Array<{ text: string }>;
    };
    expect(body.basis).toBe(true);
    expect(body.blocks.map((block) => block.text)).toEqual([FRAME_LAST_SENTENCE]);
  });

  it('leaves a slot without a frame a 404 — the normal answer for an empty slot', async () => {
    await bootFreshBook();
    for (const n of [2, 21, 41]) {
      const response = await app!.inject({ method: 'GET', url: `/api/chapters/${String(n)}` });
      expect(response.statusCode, String(n)).toBe(404);
      expect(response.json()).toMatchObject({ code: 'NOT_WRITTEN' });
    }
  });

  it('serves a hand-edited row, not the constant — the volume is the source', async () => {
    await bootFreshBook();
    const edited = `${FRAME_FIRST_SENTENCE} (правка владельца)` ;
    fixture!.db.prepare('UPDATE book_frame SET text = ?, sha256 = ? WHERE chapter = 1 AND position = ?').run(
      edited,
      sha256Hex(edited),
      'first',
    );

    const body = (await app!.inject({ method: 'GET', url: '/api/chapters/1' })).json() as {
      blocks: Array<{ text: string; hash: string }>;
    };

    expect(body.blocks[0]?.text).toBe(edited);
    expect(body.blocks[0]?.text).not.toBe(FRAME_FIRST_SENTENCE);
    expect(body.blocks[0]?.hash).toBe(sha256Hex(edited).slice(0, 8));
  });

  it('logs no drift for a block that is the row itself, and still names the row when it is gone', async () => {
    const { lines } = await bootFreshBook();
    expect((await app!.inject({ method: 'GET', url: '/api/chapters/1' })).statusCode).toBe(200);
    expect(lines.filter((line) => line.includes('FRAME_DRIFT'))).toEqual([]);

    // A volume whose seed never ran has no row: the slot falls back to 404, and no false drift
    // is claimed for text nobody served.
    fixture!.db.prepare('DELETE FROM book_frame WHERE chapter = 1').run();
    const missing = await app!.inject({ method: 'GET', url: '/api/chapters/1' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NOT_WRITTEN' });
    expect(lines.filter((line) => line.includes('FRAME_DRIFT'))).toEqual([]);
  });
});
