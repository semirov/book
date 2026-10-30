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

/** `hello` carries the composer's configuration and the signed-in reader (§10, BOOK-64). */

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
        ? { viewer: { signedIn: true, displayName: 'Аня', isAuthor: false }, identityId: 'idt_1' }
        : request.headers.cookie === 'book_session=author'
          ? { viewer: { signedIn: true, displayName: 'Филипп', isAuthor: true }, identityId: 'idt_author' }
          : { viewer: { signedIn: false, displayName: null, isAuthor: false }, identityId: null },
  });
  app = await buildApp({ config, db: fixture.db, state, wsHub: hub, version: 'test', logger: false });
  await app.ready();
}

async function hello(headers: Record<string, string> = {}): Promise<Frame> {
  // The hello arrives on its own: the promise is the wait, not a poll of the wall clock. The
  // 1 s timer is a failure bound with a readable message, not a claim about how long a frame takes.
  let resolveFirst: (frame: Frame) => void = () => undefined;
  const first = new Promise<Frame>((resolve) => {
    resolveFirst = resolve;
  });
  const ws: WebSocket = await app!.injectWS(
    '/ws',
    { headers },
    { onInit: (socket) => socket.on('message', (data) => resolveFirst(JSON.parse(data.toString()) as Frame)) },
  );
  let bound: ReturnType<typeof setTimeout> | undefined;
  try {
    const arrived = Promise.race([
      first,
      new Promise<never>((_resolve, reject) => {
        bound = setTimeout(() => reject(new Error('no hello frame')), 1_000);
      }),
    ]);
    return await arrived;
  } finally {
    if (bound !== undefined) clearTimeout(bound);
    ws.terminate();
  }
}

describe('hello — viewer and composer', () => {
  it('resolves an anonymous reader and the composer caps (no challenge travels)', async () => {
    await boot();
    const frame = await hello();
    expect(frame.type).toBe('hello');
    expect(frame.data.viewer).toEqual({ signedIn: false, displayName: null, isAuthor: false });
    expect(frame.data.composer).toEqual({
      minChars: COMMENT_MIN_CHARS,
      maxChars: COMMENT_MAX_CHARS,
      editMaxChars: EDIT_MAX_CHARS,
    });
    // BOOK-64: no provider and no sitekey on the wire — the client has no challenge to mount.
    expect(frame.data.composer).not.toHaveProperty('captcha');
    // The frame carries the true numbers, so the SPA never hardcodes a cap of its own.
    const limits = frame.data.limits as Record<string, unknown>;
    expect(limits).toMatchObject({
      maxCommentChars: COMMENT_MAX_CHARS,
      maxEditChars: EDIT_MAX_CHARS,
      editSubmissionsPerDay: 1,
      // BOOK-59: the wave bound travels too, and it is one — a second wave needs a decision.
      maxWave: CASCADE_MAX_WAVE,
    });
    expect(COMMENT_MAX_CHARS).toBe(1_200);
    expect(EDIT_MAX_CHARS).toBe(10_000);
    expect(CASCADE_MAX_WAVE).toBe(1);
    // AC4 of BOOK-59: the frame reports one wave, not the old five.
    expect(limits.maxWave).toBe(1);
  });

  it('resolves a signed-in reader from the session cookie', async () => {
    await boot();
    const frame = await hello({ cookie: 'book_session=known' });
    expect(frame.data.viewer).toEqual({ signedIn: true, displayName: 'Аня', isAuthor: false });
  });

  it('names the author from `identities.is_author`, with no second fetch (§10.4)', async () => {
    await boot();
    const frame = await hello({ cookie: 'book_session=author' });
    expect(frame.data.viewer).toEqual({ signedIn: true, displayName: 'Филипп', isAuthor: true });
  });
});
