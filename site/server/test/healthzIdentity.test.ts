/**
 * BOOK-109 / BOOK-187 — `/healthz` says *which* build answered, which two roots it read, and what
 * shape the volume it serves is in.
 *
 * The probe used to carry only the watcher and the engine, so "the phone shows old prose" could
 * not be answered: a second host, a stale container and a cache all looked identical. The body
 * now names the commit (through the `commit` seam, so a test pins the value a deploy would
 * print), the manuscript root, the data dir and the moment the process started — and still
 * nothing about the text, the queue or the pen. `deploy.sh` reads `"ok":true`, which is why
 * the key order is asserted too.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';
import { sha256Hex } from '../src/util/hash.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;
let webDist: string | null = null;

async function boot(options: { commit?: string } = {}): Promise<void> {
  fixture = createFixture({ 'ch01.md': longProse(['Первый абзац главы.']) });
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });

  webDist = mkdtempSync(join(tmpdir(), 'book-web-'));
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>книга</title>', 'utf8');

  app = await buildApp({
    config: loadConfig({
      BOOK_ROOT: fixture.root,
      DATA_DIR: fixture.dataDir,
      WEB_DIST: webDist,
      PORT: '8080',
    }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logger: false,
    ...(options.commit === undefined ? {} : { commit: options.commit }),
  });
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
  if (webDist) rmSync(webDist, { recursive: true, force: true });
  webDist = null;
});

describe('GET /healthz — the identity of the answering process (BOOK-109)', () => {
  it('carries the build the app was booted with, the two roots, and an ISO start moment', async () => {
    const before = Date.now();
    await boot({ commit: '5558449' });
    const response = await app!.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json() as Record<string, unknown>;

    expect(body.commit).toBe('5558449');
    expect(body.bookRoot).toBe(fixture!.root);
    expect(body.dataDir).toBe(fixture!.dataDir);

    expect(typeof body.startedAt).toBe('string');
    const startedAt = Date.parse(String(body.startedAt));
    expect(Number.isNaN(startedAt)).toBe(false);
    // ISO with a zone, not a locale string: two hosts' bodies compare directly.
    expect(String(body.startedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(startedAt).toBeGreaterThanOrEqual(before - 1_000);
    expect(startedAt).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('keeps `ok` first, and still says nothing an operator knows', async () => {
    await boot({ commit: '5558449' });
    const body = (await app!.inject({ method: 'GET', url: '/healthz' })).json() as Record<string, unknown>;
    // `deploy.sh` greps `"ok":true`; the key stays first in the serialized body as well.
    expect(Object.keys(body)[0]).toBe('ok');
    expect(body).toMatchObject({ ok: true, engine: { status: 'absent' } });

    // Counts, the version, the cover and the lane holder remain operator facts.
    for (const key of ['lane', 'db', 'front', 'version', 'uptimeMs']) {
      expect(body).not.toHaveProperty(key);
    }
    expect(JSON.stringify(body)).not.toContain('holder');
    // The identity is about the build and the roots — not about the text.
    expect(JSON.stringify(body)).not.toContain('blocks');
  });

  it('names the schema the volume was migrated to and the two frame hashes it holds (BOOK-187)', async () => {
    await boot({ commit: '5558449' });
    const body = (await app!.inject({ method: 'GET', url: '/healthz' })).json() as {
      schema_version: number;
      frame: { first: string | null; last: string | null };
      prompt_drift: string | null;
    };
    // The fixture migrated without a boot, so no `schema_version` stamp exists yet: 0 is the
    // honest answer ("never stamped"), and the two frame hashes come from the rows themselves.
    expect(body.schema_version).toBe(0);
    expect(body.frame).toEqual({
      first: sha256Hex(FRAME_FIRST_SENTENCE),
      last: sha256Hex(FRAME_LAST_SENTENCE),
    });
    expect(body.prompt_drift).toBeNull();
  });

  it('prints the schema stamp the boot wrote, and the drift it recorded', async () => {
    await boot({ commit: '5558449' });
    // What `bootDatabase` writes, and the fingerprint of a rollback that changed the bundle.
    fixture!.db.prepare(`INSERT INTO meta (k, v) VALUES ('schema_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(
      String(SCHEMA_VERSION),
    );
    fixture!.db.prepare(`INSERT INTO meta (k, v) VALUES ('prompt_drift', 'b') ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run();

    const body = (await app!.inject({ method: 'GET', url: '/healthz' })).json() as {
      schema_version: number;
      prompt_drift: string | null;
    };
    expect(body.schema_version).toBe(SCHEMA_VERSION);
    expect(body.prompt_drift).toBe('b');
  });

  it('falls back to a placeholder rather than an empty string when no stamp is shipped', async () => {
    await boot();
    const body = (await app!.inject({ method: 'GET', url: '/healthz' })).json() as { commit: string };
    // The default reads `site/build-info.json`; with no file (a dev checkout) it is `dev`, and
    // never an empty string — the answer must still say what it is.
    expect(body.commit.length).toBeGreaterThan(0);
  });
});
