/**
 * The harness both reset suites share: a seeded fixture (`resetSeed.ts`), a reconciled boot, and
 * a server on it. It lives apart from the tests so each suite reads as assertions, and because
 * two of them — the wipe itself and the guards around it — need the same operator-shaped book.
 *
 * Every performing boot removes `manuscript/ch08.md` after the reconcile (the rows stay, the
 * file goes: the state after the operator cleaned the engine's untracked output). A boot that
 * wants the manuscript to still hold prose says `keepProse: true`, and then the reset refuses.
 */

import { chmodSync } from 'node:fs';

import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { Db } from '../src/db/db.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, type Fixture } from './helpers.ts';
import { bookFiles, clearProse, seedBook } from './resetSeed.ts';

export const TOKEN = 'panel-token';

export type LiveOptions = {
  /** The manuscript this boot sees. Defaults to `bookFiles()`. */
  files?: Record<string, string>;
  /** The admin token the app boots with; `''` means the route does not exist. */
  token?: string;
  /** Leave `manuscript/ch08.md` on disk: a boot scan would re-ingest it (the B2 refusal). */
  keepProse?: boolean;
  /** BOOK-137 M1: the hook the reset route calls after a completed wipe. */
  onBookReset?: () => void;
};

export type ResetHarness = {
  /** A seeded book and a booted app on it. One at a time — `close()` ends it. */
  live(options?: LiveOptions): Promise<Fixture>;
  /** `POST /api/admin/reset/book` on the running app. */
  call(body?: unknown, token?: string | null): Promise<LightMyRequestResponse>;
  /** A plain GET on the running app, for the read-only surfaces after a wipe. */
  get(url: string): Promise<LightMyRequestResponse>;
  /** Make a data dir read-only; `close()` restores the mode. */
  readonlyDir(dir: string): void;
  close(): Promise<void>;
};

export function createResetHarness(): ResetHarness {
  let fixture: Fixture | null = null;
  let app: FastifyInstance | null = null;
  let locked: string | null = null;

  return {
    async live(options: LiveOptions = {}): Promise<Fixture> {
      const { files = bookFiles(), token = TOKEN, keepProse = false, onBookReset } = options;
      fixture = createFixture(files);
      reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
      seedBook(fixture);
      if (!keepProse) clearProse(fixture);
      app = await buildApp({
        config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir }),
        db: fixture.db,
        state: new StateService(fixture.db),
        version: 'test',
        logger: false,
        adminToken: token,
        ...(onBookReset === undefined ? {} : { onBookReset }),
      });
      await app.ready();
      return fixture;
    },

    call(body?: unknown, token: string | null = TOKEN): Promise<LightMyRequestResponse> {
      if (app === null) throw new Error('no app: call live() first');
      return app.inject({
        method: 'POST',
        url: '/api/admin/reset/book',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token === null ? {} : { 'x-admin-token': token }),
        },
        ...(body === undefined ? {} : { payload: body as object }),
      });
    },

    get(url: string): Promise<LightMyRequestResponse> {
      if (app === null) throw new Error('no app: call live() first');
      return app.inject({ method: 'GET', url });
    },

    readonlyDir(dir: string): void {
      chmodSync(dir, 0o555);
      locked = dir;
    },

    async close(): Promise<void> {
      if (locked !== null) {
        chmodSync(locked, 0o755);
        locked = null;
      }
      await app?.close();
      app = null;
      fixture?.close();
      fixture = null;
    },
  };
}

/** The published snapshot counter; 0 when the book never served a state. */
export function stateVersionOf(db: Db): number {
  const row = db.prepare("SELECT v FROM meta WHERE k = 'state_version'").get() as { v?: string } | undefined;
  return row?.v === undefined ? 0 : Number.parseInt(row.v, 10);
}
