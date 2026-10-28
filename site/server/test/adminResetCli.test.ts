import { exec as execCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';

import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { databaseFile, openDatabase, type Db } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { upsertIdentity } from '../src/db/repo/identities.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

const exec = promisify(execCallback);

/**
 * BOOK-137 — `node bin/admin.mjs reset book`, as the operator runs it.
 *
 * The command is an HTTP client: the wipe happens inside the running server, so what is proved
 * here is the client half — the exit codes an operator scripts against, the exact lines the
 * runbook prints, and the two refusals the CLI itself owns (no token, not this machine).
 */

const TOKEN = 'panel-token';
const SITE_ROOT = resolve(import.meta.dirname, '..', '..');

let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;
let readonlyDir: string | null = null;
let scratchDir: string | null = null;
let scratchDb: Db | null = null;

afterEach(async () => {
  if (readonlyDir !== null) {
    chmodSync(readonlyDir, 0o755);
    readonlyDir = null;
  }
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
  scratchDb?.close();
  scratchDb = null;
  if (scratchDir !== null) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = null;
  }
});

function bookFiles(): Record<string, string> {
  return {
    'ch01.md': FRAME_FIRST_SENTENCE,
    'ch42.md': FRAME_LAST_SENTENCE,
    'ch08.md': longProse(['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.']),
  };
}

/** One identity and one filing: enough for the counters to be numbers, not zeros. */
function seed(target: Fixture): void {
  const owner = upsertIdentity(target.db, {
    yandexSub: 'yandex-owner',
    displayName: 'Филипп Семиров',
    at: '2026-10-25T11:00:00Z',
  }).id;
  target.db
    .prepare(
      `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at)
       VALUES ('cmt_one', ?, 8, 'Филипп Семиров', 'Служебное замечание.', 'sha', 'hash-one', 'new',
               '2026-10-25T12:00:00Z')`,
    )
    .run(owner);
  target.db
    .prepare('INSERT INTO rate_events (key, ts) VALUES (?, ?)')
    .run(`edit:id:${owner}`, 1_760_000_000_000);
}

async function boot(db: Db, root: string, dataDir: string, onBookReset?: () => void): Promise<string> {
  app = await buildApp({
    config: loadConfig({ BOOK_ROOT: root, DATA_DIR: dataDir }),
    db,
    state: new StateService(db),
    version: 'test',
    logger: false,
    adminToken: TOKEN,
    ...(onBookReset === undefined ? {} : { onBookReset }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}`;
}

type LiveOptions = {
  /** Leave `manuscript/ch08.md` on disk, so a boot scan would re-ingest it (the B2 refusal). */
  keepProse?: boolean;
  /** BOOK-137 M1: a hook that fails, so the server has to answer with a warning. */
  brokenBridge?: boolean;
};

/**
 * A seeded fixture and a server on it, in the operator's pre-launch state: the rows of a written
 * chapter stay, its engine-written file is removed from the manuscript.
 */
async function live(options: LiveOptions = {}): Promise<{ fixture: Fixture; base: string }> {
  fixture = createFixture(bookFiles());
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  seed(fixture);
  if (options.keepProse !== true) rmSync(join(fixture.manuscript, 'ch08.md'), { force: true });
  const onBookReset =
    options.brokenBridge === true
      ? (): void => {
          throw new Error('boom');
        }
      : undefined;
  const base = await boot(fixture.db, fixture.root, fixture.dataDir, onBookReset);
  return { fixture, base };
}

function run(args: string, env: NodeJS.ProcessEnv = {}) {
  return exec(`node bin/admin.mjs ${args}`, {
    env: { ...process.env, ADMIN_TOKEN: TOKEN, ADMIN_TOKEN_FILE: '', ...env },
  });
}

/** The exit code and stderr of a command that must fail (a passing command is a bug here). */
async function failed(args: string, env: NodeJS.ProcessEnv = {}): Promise<{ code?: number; stderr?: string; stdout?: string }> {
  const outcome = await run(args, env).then(
    () => null,
    (error: unknown) => error,
  );
  if (outcome === null) throw new Error('the CLI should have failed');
  return outcome as { code?: number; stderr?: string; stdout?: string };
}

type Probe = {
  tables: Array<{ key: string; label: string; rows: number }>;
  total: number;
  kept: Array<{ key: string; rows: number }>;
};

function probe(): Promise<Probe> {
  return app!
    .inject({
      method: 'POST',
      url: '/api/admin/reset/book',
      headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
      payload: { dryRun: true },
    })
    .then((response) => response.json() as Probe);
}

/** The frozen lines of a reset answer, built from the server's own counts — never hard-coded. */
function tableLines(body: Probe, dryRun: boolean): string[] {
  const suffix = dryRun ? '' : ' rows removed';
  return [
    ...body.tables.map((entry) => `  ${entry.label}  ${String(entry.rows)}${suffix}`),
    `  ${String(body.tables.length)} entries, ${String(body.total)} rows${dryRun ? '' : ' removed'}`,
  ];
}

function keptLine(body: Probe): string {
  return `kept: ${body.kept.map((entry) => `${entry.key} ${String(entry.rows)}`).join(' · ')}`;
}

describe('reset book — the CLI refusals it owns', () => {
  it('exits 3 when ADMIN_TOKEN_FILE is declared but absent, naming the variable and the path', async () => {
    const { base } = await live();
    const missing = join(fixture!.dataDir, 'absent', 'admin.token');
    const failure = await failed(`reset book --url ${base}`, { ADMIN_TOKEN: '', ADMIN_TOKEN_FILE: missing });
    expect(failure.code).toBe(3);
    expect(failure.stderr).toContain('ADMIN_TOKEN_FILE');
    expect(failure.stderr).toContain(missing);
    expect(failure.stdout ?? '').not.toContain(TOKEN);
    // …and nothing was written: the refusal happened before the request.
    expect((await probe()).total).toBeGreaterThan(0);
  });

  it('exits 4 for a target that is not this machine', async () => {
    const failure = await failed('reset book --url https://example.com');
    expect(failure.code).toBe(4);
    expect(failure.stderr).toContain('non-local');
  });

  it('exits 6 when DATA_DIR sits inside the checkout, and leaves the database alone', async () => {
    fixture = createFixture(bookFiles());
    const dir = join(SITE_ROOT, `.reset-test-${randomUUID().slice(0, 8)}`);
    scratchDir = dir;
    mkdirSync(dir, { recursive: true });
    const db = openDatabase(databaseFile(dir));
    scratchDb = db;
    try {
      migrate(db);
      reconcile(db, { bookRoot: fixture.root, dataDir: dir });
      const base = await boot(db, fixture.root, dir);

      const failure = await failed(`reset book --url ${base} --yes`);
      expect(failure.code).toBe(6);
      expect(failure.stderr).toContain('DATA_DIR_IN_REPO');
      const chapters = db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE basis = 0').get() as { n: number };
      expect(chapters.n).toBe(1);
    } finally {
      // The scratch dir is inside the checkout: it must not outlive this test even if an
      // assertion failed, so it is removed here and not only in `afterEach`.
      await app?.close();
      app = null;
      db.close();
      scratchDb = null;
      rmSync(dir, { recursive: true, force: true });
      scratchDir = null;
    }
  });

  it('exits 5 on a wrong token and never prints it', async () => {
    const { base } = await live();
    const failure = await failed(`reset book --url ${base} --yes`, { ADMIN_TOKEN: 'not-the-token' });
    expect(failure.code).toBe(5);
    expect(failure.stderr).toContain('refused');
    expect(failure.stderr).not.toContain('not-the-token');
  });

  it('exits 2 on a usage error: two intents at once, a flag without its command, another target', async () => {
    for (const argv of [
      'reset book --yes --dry-run',
      'reset book --backup-ok',
      'reset manuscript',
      'reset book --bogus',
    ]) {
      const failure = await failed(`${argv} --url http://127.0.0.1:1`);
      expect(failure.code, argv).toBe(2);
      expect(failure.stderr, argv).toContain('usage:');
    }
  });
});

describe('reset book — the lines the runbook prints', () => {
  it('prints the dry-run table, and writes nothing', async () => {
    const { fixture: target, base } = await live();
    const body = await probe();

    const { stdout } = await run(`reset book --url ${base}`);
    const lines = stdout.split('\n');
    expect(lines[0]).toBe('reset book — dry run, nothing is written');
    expect(lines.slice(1, 1 + body.tables.length + 1)).toEqual(tableLines(body, true));
    expect(lines[1 + body.tables.length + 1]).toBe(keptLine(body));
    expect(lines[2 + body.tables.length + 1]).toBe('frame: ch01, ch42 re-read from the manuscript');
    // No backup line on a dry run: nothing is written, so nothing is backed up. And no warning:
    // the manuscript holds no prose and the engine is idle.
    expect(stdout).not.toContain('backup:');
    expect(stdout).not.toContain('manuscript:');
    expect(stdout).not.toContain('engine:');

    const chapters = target.db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE basis = 0').get() as { n: number };
    expect(chapters.n).toBe(1);
  });

  it('performs the wipe on --yes, then reports 0 rows removed the second time', async () => {
    const { fixture: target, base } = await live();
    const body = await probe();

    const done = await run(`reset book --url ${base} --yes`);
    const lines = done.stdout.split('\n');
    expect(lines[0]).toBe('reset book — done');
    expect(lines.slice(1, 1 + body.tables.length + 1)).toEqual(tableLines(body, false));
    expect(lines[1 + body.tables.length + 1]).toBe(keptLine(body));
    expect(lines[2 + body.tables.length + 1]).toBe('frame: ch01, ch42 re-read from the manuscript');
    expect(lines[3 + body.tables.length + 1]).toMatch(
      /^backup: .*book-reset-\d{8}T\d{6}Z\.db \(0600, integrity ok, counts match\)$/u,
    );
    expect(done.stdout.trimEnd().split('\n')).toHaveLength(4 + body.tables.length + 1);

    const chapters = target.db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE basis = 0').get() as { n: number };
    expect(chapters.n).toBe(0);

    const again = await run(`reset book --url ${base} --yes`);
    expect(again.stdout).toContain('reset book — done');
    expect(again.stdout).toContain('0 rows removed');
    expect(again.stdout).toContain('backup: skipped (nothing to remove)');
  });
});

describe('reset book — the two refusals a dry run names', () => {
  it('prints the prose chapter and refuses the wipe, naming the files', async () => {
    const { base } = await live({ keepProse: true });

    const dry = await run(`reset book --url ${base}`);
    expect(dry.stdout).toContain(
      'manuscript: 1 chapter files hold prose — a boot scan would restore them; clear manuscript/ first',
    );

    const failure = await failed(`reset book --url ${base} --yes`);
    expect(failure.code).toBe(5);
    expect(failure.stderr).toContain('MANUSCRIPT_WRITTEN');
    expect(failure.stderr).toContain('ch08.md');
    expect(failure.stderr).toContain('git clean -fd manuscript/');
    expect(failure.stdout ?? '').not.toContain('reset book — done');

    // Removing the file (the operator's `git clean -fd manuscript/`) makes the dry run clean.
    rmSync(join(fixture!.manuscript, 'ch08.md'), { force: true });
    const clean = await run(`reset book --url ${base}`);
    expect(clean.stdout).not.toContain('manuscript:');
  });

  it('prints the open step and reports ENGINE_BUSY on --yes', async () => {
    const { fixture: target, base } = await live();
    target.db
      .prepare(
        `INSERT INTO steps (step_id, seq, wave, pass, chapter, boundary, outcome, at)
         VALUES ('stp_open', 2, 0, 'draft', 9, '9', NULL, '2026-10-25T12:00:00Z')`,
      )
      .run();

    const dry = await run(`reset book --url ${base}`);
    expect(dry.stdout).toContain('engine: 1 open step(s) · 0 live lease(s) — a wipe would be refused');

    const failure = await failed(`reset book --url ${base} --yes`);
    expect(failure.code).toBe(5);
    expect(failure.stderr).toContain('ENGINE_BUSY');
    expect(failure.stderr).toContain('open steps 1');
  });
});

describe('reset book — the server’s warning', () => {
  it('prints the warning after the backup line and still exits 0', async () => {
    const { base } = await live({ brokenBridge: true });

    // `run` only resolves on exit 0: a refused or crashing command rejects this promise.
    const done = await run(`reset book --url ${base} --yes`);
    expect(done.stdout).toContain('reset book — done');
    expect(done.stdout).toContain('warning: the engine bridge could not be re-primed — restart the site');

    const lines = done.stdout.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toBe('warning: the engine bridge could not be re-primed — restart the site');
    expect(lines[lines.length - 2]?.startsWith('backup: ')).toBe(true);
  });
});

describe('reset book — a read-only data dir', () => {
  it('exits 7 without --backup-ok, and wipes with it', async () => {
    const { fixture: target, base } = await live();
    chmodSync(target.dataDir, 0o555);
    readonlyDir = target.dataDir;

    const failure = await failed(`reset book --url ${base} --yes`);
    expect(failure.code).toBe(7);
    expect(failure.stderr).toContain('BACKUP_FAILED');
    const chapters = target.db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE basis = 0').get() as { n: number };
    expect(chapters.n).toBe(1);

    const forced = await run(`reset book --url ${base} --yes --backup-ok`);
    expect(forced.stdout).toContain('reset book — done');
    expect(forced.stdout).toContain('backup: none (backupOk was given)');
    expect((target.db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE basis = 0').get() as { n: number }).n).toBe(0);
  });
});
