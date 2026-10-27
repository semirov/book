import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { assertLocalTarget, localAddresses, parseBudgetArgs } from '../../bin/admin.mjs';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { upsertIdentity } from '../src/db/repo/identities.ts';
import { reconcile } from '../src/ingest/reconcile.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, longProse, type Fixture } from './helpers.ts';

const exec = promisify(execCallback);

/**
 * BOOK-113 — the operator's CLI (`bin/admin.mjs`).
 *
 * Two things are worth proving without a running server: the two documented forms parse into
 * exactly one request, and the target rule refuses anything that is not this machine — because
 * the tool sends the admin token, and prod binds `HOST=192.168.1.76`, not only loopback.
 */

describe('bin/admin.mjs — the documented budget forms', () => {
  it('accepts the two forms the runbook prints', () => {
    expect(parseBudgetArgs(['budget', 'reset', '--identity', 'idt_01M5XVEQ9NTKES9J6TP0VWNHPH'])).toEqual({
      kind: 'reset',
      identity: 'idt_01M5XVEQ9NTKES9J6TP0VWNHPH',
    });
    expect(parseBudgetArgs(['budget', 'exempt', 'Филипп Семиров', 'on'])).toEqual({
      kind: 'exempt',
      identity: 'Филипп Семиров',
      exempt: true,
    });
    expect(parseBudgetArgs(['budget', 'exempt', 'Филипп Семиров', 'off'])).toEqual({
      kind: 'exempt',
      identity: 'Филипп Семиров',
      exempt: false,
    });
    // The display name is trimmed, and `--url` travels with the parsed command.
    expect(parseBudgetArgs(['budget', 'exempt', '--url', 'http://127.0.0.1:8091', ' Аня ', 'on'])).toEqual({
      kind: 'exempt',
      identity: 'Аня',
      exempt: true,
      url: 'http://127.0.0.1:8091',
    });
    expect(parseBudgetArgs(['--help'])).toEqual({ kind: 'help' });
  });

  it('rejects junk instead of guessing', () => {
    const junk: string[][] = [
      [],
      ['budget'],
      ['budget', 'reset'],
      ['budget', 'reset', '--identity'],
      ['budget', 'reset', '--bogus', 'x'],
      ['budget', 'exempt', 'Аня'],
      ['budget', 'exempt', 'Аня', 'maybe'],
      ['budget', 'exempt', 'Аня', 'on', 'extra'],
      ['publish', 'reset', '--identity', 'x'],
    ];
    for (const argv of junk) {
      expect(() => parseBudgetArgs(argv), argv.join(' ')).toThrow();
    }
  });
});

describe('bin/admin.mjs — the target must be this machine', () => {
  it('accepts loopback and this host’s own address', () => {
    expect(assertLocalTarget('http://127.0.0.1:8091').hostname).toBe('127.0.0.1');
    expect(assertLocalTarget('http://localhost:8091').hostname).toBe('localhost');
    expect(assertLocalTarget('http://[::1]:8091').hostname).toBe('[::1]');

    const own = [...localAddresses()].find((address) => address !== '127.0.0.1' && address !== '::1');
    if (own !== undefined) {
      // Production binds an interface address (HOST=192.168.1.76), so it must be allowed too.
      // An IPv6 literal is bracketed in a URL, as any browser/curl would write it.
      const host = own.includes(':') ? `[${own}]` : own;
      expect(assertLocalTarget(`http://${host}:8091`).hostname.length).toBeGreaterThan(0);
    }
  });

  it('refuses a public host, a remote address and a non-HTTP scheme', () => {
    expect(() => assertLocalTarget('https://example.com')).toThrow(/non-local/u);
    expect(() => assertLocalTarget('http://10.9.8.7:8091')).toThrow(/non-local/u);
    expect(() => assertLocalTarget('file:///etc/passwd')).toThrow(/non-HTTP/u);
    expect(() => assertLocalTarget('not a url')).toThrow(/not a URL/u);
  });
});

describe('bin/admin.mjs — the process itself', () => {
  it('prints the usage on --help and exits 0', async () => {
    const { stdout } = await exec('node bin/admin.mjs --help');
    expect(stdout).toContain('node bin/admin.mjs budget reset');
    expect(stdout).toContain('node bin/admin.mjs budget exempt');
  });

  it('exits 2 on an unknown flag, naming it and printing the usage', async () => {
    await expect(exec('node bin/admin.mjs budget reset --bogus x')).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('unknown flag: --bogus'),
    });
  });
});

/**
 * The real loop: a booted server on a loopback port, the CLI as the operator runs it, and the
 * two lines the runbook prints. The token goes through `ADMIN_TOKEN`, so no file is written.
 */
let fixture: Fixture | null = null;
let app: FastifyInstance | null = null;

async function live(): Promise<{ fixture: Fixture; owner: string; base: string }> {
  fixture = createFixture({
    'ch08.md': longProse(['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.']),
  });
  reconcile(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir });
  app = await buildApp({
    config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir }),
    db: fixture.db,
    state: new StateService(fixture.db),
    version: 'test',
    logger: false,
    adminToken: 'panel-token',
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const owner = upsertIdentity(fixture.db, {
    yandexSub: 'yandex-owner',
    displayName: 'Филипп Семиров',
    at: '2026-10-25T11:00:00Z',
  }).id;
  fixture.db
    .prepare(
      `INSERT INTO comments (id, identity_id, chapter, author, body, body_sha, ip_hash, status, created_at)
       VALUES ('cmt_one', ?, 8, 'Филипп Семиров', 'Служебное замечание.', 'sha', 'hash-one', 'new',
               '2026-10-25T12:00:00Z')`,
    )
    .run(owner);
  const event = fixture.db.prepare('INSERT INTO rate_events (key, ts) VALUES (?, 1760000000000)');
  event.run(`edit:id:${owner}`);
  event.run('edit:ip:hash-one');
  return { fixture, owner, base: `http://127.0.0.1:${String(address.port)}` };
}

afterEach(async () => {
  await app?.close();
  app = null;
  fixture?.close();
  fixture = null;
});

function run(args: string, token = 'panel-token') {
  return exec(`node bin/admin.mjs ${args}`, {
    env: { ...process.env, ADMIN_TOKEN: token },
  });
}

/** The CLI's exit code and stderr for a command that must fail (a passing command is a bug here). */
async function failed(args: string, token = 'panel-token'): Promise<{ code?: number; stderr?: string }> {
  const outcome = await run(args, token).then(
    () => null,
    (error: unknown) => error,
  );
  if (outcome === null) throw new Error('the CLI should have failed');
  return outcome as { code?: number; stderr?: string };
}

describe('bin/admin.mjs — against a live server', () => {
  it('prints the reset line the runbook shows', async () => {
    const { owner, base } = await live();
    const { stdout } = await run(`budget reset --identity "Филипп Семиров" --url ${base}`);
    expect(stdout).toBe(
      `identity ${owner} «Филипп Семиров»\nremoved edit:id 1 · edit:ip 1 · cmt:id 0\n`,
    );
    expect(fixture!.db.prepare('SELECT COUNT(*) AS n FROM rate_events').get()).toEqual({ n: 0 });
  });

  it('prints the exemption transition the runbook shows', async () => {
    const { owner, base } = await live();
    const on = await run(`budget exempt "Филипп Семиров" on --url ${base}`);
    expect(on.stdout).toBe(`identity ${owner} «Филипп Семиров» · edit_exempt 0 → 1\n`);
    const off = await run(`budget exempt ${owner} off --url ${base}`);
    expect(off.stdout).toBe(`identity ${owner} «Филипп Семиров» · edit_exempt 1 → 0\n`);
  });

  it('exits 5 with the server code and message, and never prints the token', async () => {
    const { base } = await live();
    await expect(run(`budget reset --identity никто --url ${base}`)).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining('NOT_FOUND'),
    });
    const failure = await failed(`budget reset --identity x --url ${base}`, 'not-the-token');
    expect(failure.code).toBe(5);
    expect(failure.stderr).toContain('refused');
    expect(failure.stderr).not.toContain('not-the-token');
  });
});
