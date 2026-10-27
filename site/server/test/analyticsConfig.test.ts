import { IMPRINT_AUTHOR, IMPRINT_COPYRIGHT } from '@book/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, type Fixture } from './helpers.ts';

/**
 * BOOK-63 — the counter id is served, not baked into the bundle: the CSP and the SPA read
 * one setting (`METRIKA_ID`), and an empty setting answers `null` so the page loads nothing.
 */

const IMPRINT = { author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT, publisher: null, year: 'auto' } as const;

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

async function boot(env: Record<string, string>): Promise<void> {
  fixture = createFixture();
  app = await buildApp({
    config: loadConfig({
      BOOK_ROOT: fixture.root,
      DATA_DIR: fixture.dataDir,
      WEB_DIST: '/nonexistent-web-dist',
      ...env,
    }),
    db: fixture.db,
    state: new StateService(fixture.db),
    imprint: IMPRINT,
    logger: false,
  });
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
});

describe('GET /api/analytics', () => {
  it('answers the configured counter', async () => {
    await boot({ METRIKA_ID: '113820311' });
    const response = await app!.inject({ method: 'GET', url: '/api/analytics' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ counter: '113820311' });
    // BOOK-109: the id is configuration, and the app's policy answers every `/api/` read
    // `no-store` — a stored counter would outlive the deployment that changed it.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers null when the deployment has no counter', async () => {
    await boot({ METRIKA_ID: '' });
    const response = await app!.inject({ method: 'GET', url: '/api/analytics' });
    expect(response.json()).toEqual({ counter: null });
  });
});
