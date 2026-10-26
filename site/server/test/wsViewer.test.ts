import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { CASCADE_MAX_WAVE, COMMENT_MAX_CHARS, COMMENT_MIN_CHARS, EDIT_MAX_CHARS } from '@book/shared';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { loadImprint } from '../src/imprint.ts';
import { WsHub } from '../src/ws/hub.ts';
import { createFixture, type Fixture } from './helpers.ts';

/** `hello` carries the composer's configuration and the signed-in reader (§10, §12.8). */

type Frame = { type: string; data: Record<string, unknown> };

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
});

async function boot(): Promise<void> {
  fixture = createFixture({});
  const config = loadConfig({
    BOOK_ROOT: fixture.root,
    DATA_DIR: fixture.dataDir,
    WEB_DIST: fixture.dataDir,
    CAPTCHA_PROVIDER: 'hcaptcha',
    CAPTCHA_SECRET: 'test-secret',
    CAPTCHA_SITE_KEY: 'site-key',
    EDIT_SUBMISSIONS_PER_DAY: '1',
  });
  const state = new StateService(fixture.db);
  const hub = new WsHub({
    db: fixture.db,
    state,
    config,
    imprint: loadImprint(config.imprintPath),
    stateThrottleMs: 0,
    resolveViewer: (request) =>
      request.headers.cookie === 'book_session=known'
        ? { signedIn: true, displayName: 'Аня' }
        : { signedIn: false, displayName: null },
  });
  app = await buildApp({ config, db: fixture.db, state, wsHub: hub, version: 'test', logger: false });
  await app.ready();
}

async function hello(headers: Record<string, string> = {}): Promise<Frame> {
  const frames: Frame[] = [];
  const ws: WebSocket = await app!.injectWS(
    '/ws',
    { headers },
    { onInit: (socket) => socket.on('message', (data) => frames.push(JSON.parse(data.toString()) as Frame)) },
  );
  for (let attempt = 0; attempt < 100 && frames.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  ws.terminate();
  const first = frames[0];
  if (first === undefined) throw new Error('no hello frame');
  return first;
}

describe('hello — viewer and composer', () => {
  it('resolves an anonymous reader and the configured CAPTCHA provider', async () => {
    await boot();
    const frame = await hello();
    expect(frame.type).toBe('hello');
    expect(frame.data.viewer).toEqual({ signedIn: false, displayName: null });
    expect(frame.data.composer).toEqual({
      captcha: { provider: 'hcaptcha', siteKey: 'site-key' },
      minChars: COMMENT_MIN_CHARS,
      maxChars: COMMENT_MAX_CHARS,
      editMaxChars: EDIT_MAX_CHARS,
    });
    // The frame carries the true numbers, so the SPA never hardcodes a cap of its own.
    expect(frame.data.limits).toMatchObject({
      maxCommentChars: COMMENT_MAX_CHARS,
      maxEditChars: EDIT_MAX_CHARS,
      editSubmissionsPerDay: 1,
      // BOOK-DOC-4 rule 3: the wave bound travels too, so «волна 2 / N» is the server's N.
      maxWave: CASCADE_MAX_WAVE,
    });
    expect(COMMENT_MAX_CHARS).toBe(1_200);
    expect(EDIT_MAX_CHARS).toBe(10_000);
    expect(CASCADE_MAX_WAVE).toBe(5);
  });

  it('resolves a signed-in reader from the session cookie', async () => {
    await boot();
    const frame = await hello({ cookie: 'book_session=known' });
    expect(frame.data.viewer).toEqual({ signedIn: true, displayName: 'Аня' });
  });
});
