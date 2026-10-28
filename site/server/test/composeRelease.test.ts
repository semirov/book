/**
 * BOOK-172 — `deploy/compose-release.sh` as a real process: the lock, the exit codes and the
 * rollback. Same shape as `deployScript.test.ts` (a fake `docker` on PATH, a real HTTP server, a
 * git clone fixture, nothing ambient): the script is driven exactly as the workflow drives it.
 *
 * What is pinned here is the interface BOOK-172 states:
 *   · exit 3 when another deploy holds the lock — and nothing is built, started or rolled back;
 *   · exit 2 on a bad argument;
 *   · exit 0 only when `/healthz` names the commit the image carries, plus the five smokes;
 *   · a red gate rolls back to the image that served before (`previous-image`) with ONE `up`, and
 *     the run stays exit 1 (a rollback is not a green deploy);
 *   · `--dry-run` builds nothing and starts nothing.
 *
 * Every path a run writes (`BOOK_STATE_DIR`, `BOOK_LOCKS_DIR`) is a temp dir: the script creates the
 * `/locks` bind source itself, and that must never be the box's real one.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const SITE = resolve(import.meta.dirname, '..', '..');
const RELEASE = join(SITE, 'deploy', 'compose-release.sh');
const COMPOSE = join(SITE, 'docker-compose.yml');

// A real build here is a fake that answers at once; the gate is a real server and a real curl. The
// timeout is about a wedged child, not about the work.
vi.setConfig({ testTimeout: 90_000 });

const dirs: string[] = [];
const servers: Server[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.close(() => {
            done();
          });
        }),
    ),
  );
});

/** A git clone fixture: one commit and an `origin` pointing at itself, so `git fetch` works. */
function gitRoot(): string {
  const dir = temp('book-172-root-');
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  mkdirSync(join(dir, 'site'), { recursive: true });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', dir]);
  return dir;
}

const sha = (root: string) => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

/**
 * A fake `docker` that answers the calls the release script makes and records every argv. `up`
 * writes the image tag it was given into `$STATE_DIR/current` — that file is what the test server
 * answers `/healthz` with, so "the stack moved" and "the gate noticed" are one causal chain
 * instead of two independent mocks.
 *
 * It is template-aware: `inspect -f '{{.Config.Image}}'` answers the image, while
 * `inspect -f '{{.State.Status}} …'` answers the container state per service (`FAKE_STATE_SITE`,
 * `FAKE_STATE_ENGINE`, `FAKE_STATE_WRITER`; a value prefixed `once:` is read once and then falls back
 * to the healthy default). The defaults are the healthy stack — site and engine `running healthy`,
 * the writer `running` (it has no healthcheck by design).
 */
function fakeDocker(stateDir: string): string {
  const dir = temp('book-172-bin-');
  const body = `#!/bin/bash
printf '%s BOOK_IMAGE_TAG=%s\\n' "$*" "\${BOOK_IMAGE_TAG:-}" >> "${stateDir}/docker.log"
if [ "$1" = "version" ]; then echo "Docker version 29.8.2"; exit 0; fi
if [ "$1" = "inspect" ] && [ "$2" = "-f" ]; then
  case "$3" in
    *'.State.Status'*)
      name="\${4#id-}"
      upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
      var="FAKE_STATE_$upper"
      raw="\${!var-}"
      marker="${stateDir}/state-$name-consumed"
      if [ -e "$marker" ]; then raw=""; fi
      case "$raw" in
        once:*) printf '%s\\n' "\${raw#once:}"; : > "$marker"; exit 0 ;;
      esac
      if [ -z "$raw" ]; then
        case "$name" in writer) raw="running" ;; *) raw="running healthy" ;; esac
      fi
      printf '%s\\n' "$raw"
      exit 0 ;;
  esac
  printf '%s\\n' "\${FAKE_RUNNING_IMAGE:-}"
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then [ "\${FAKE_IMAGE_MISSING:-0}" = "1" ] && exit 1; exit 0; fi
case "$*" in
  *" compose version"*) echo "Docker Compose version v5.5.0"; exit 0 ;;
  *" config -q"*) exit 0 ;;
  *" ps -q "*) printf 'id-%s\\n' "\${!#}"; exit 0 ;;
  *" image ls "*) exit 0 ;;
  *" build site"*) exit 0 ;;
  *" up -d "*)
    printf '%s\\n' "\${BOOK_IMAGE_TAG:-}" > "${stateDir}/current"
    if [ "\${FAKE_UP_FAIL_ONCE:-0}" = "1" ] && [ ! -e "${stateDir}/up-failed" ]; then : > "${stateDir}/up-failed"; exit 1; fi
    exit 0 ;;
  *" restart site"*) exit 0 ;;
esac
exit 0
`;
  writeFileSync(join(dir, 'docker'), body, { encoding: 'utf8', mode: 0o755 });
  chmodSync(join(dir, 'docker'), 0o755);
  return dir;
}

type Answers = { healthz: (current: string) => { status: number; body: unknown } };

/** The site the gate reads: `/healthz` plus the five smokes, answered from the fake's state. */
async function serveSite(stateDir: string, answers: Answers): Promise<string> {
  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    const current = readFileSync(join(stateDir, 'current'), 'utf8').trim();
    if (url === '/healthz') {
      const reply = answers.healthz(current);
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
      return;
    }
    if (url === '/api/chapters') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('[{"n":1}]');
      return;
    }
    if (url.startsWith('/api/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (url === '/manifest.webmanifest') {
      response.writeHead(200, { 'content-type': 'application/manifest+json' });
      response.end('{}');
      return;
    }
    if (url === '/sw.js') {
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' });
      response.end('//');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => {
      done();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

function release(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('BOOK_')) continue;
    if (value !== undefined) merged[key] = value;
  }
  Object.assign(merged, env);
  // Asynchronous: the site under test is this process's own server, and `spawnSync` would block the
  // event loop that has to answer the `curl` inside the script (deployHarness.ts, same reason).
  return new Promise((done) => {
    const child = spawn('/bin/bash', [RELEASE, ...args], { env: merged });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out += String(chunk);
    });
    child.on('close', (code: number | null) => {
      done({ code, out });
    });
  });
}

/** Everything a run needs, except the site URL and the fake's answers. */
function envFor(root: string, stateDir: string, bin: string, siteUrl: string): Record<string, string> {
  const log = join(stateDir, 'docker.log');
  writeFileSync(log, '', 'utf8');
  return {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    BOOK_DEPLOY_ROOT: root,
    BOOK_STATE_DIR: stateDir,
    // The script creates this bind source and checks its owner: it must never be the box's own.
    BOOK_LOCKS_DIR: join(stateDir, 'locks'),
    BOOK_COMPOSE_FILE: COMPOSE,
    BOOK_PROJECT: 'book-test',
    BOOK_SITE_URL: siteUrl,
    BOOK_HEALTH_TIMEOUT: '2',
    BOOK_HEALTH_GRACE: '1',
    BOOK_BUILD_TIMEOUT: '30',
    BOOK_DOCKER: join(bin, 'docker'),
    FAKE_RUNNING_IMAGE: '',
  };
}

describe('the container release: lock, exit codes, rollback', () => {
  it('a) refuses with exit 2 on an unknown argument', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const result = await release(['--nope'], envFor(root, stateDir, bin, 'http://127.0.0.1:9'));
    expect(result.code).toBe(2);
    expect(result.out).toContain('unknown argument');
  });

  it('b) refuses with exit 3 while another deploy holds the lock, and touches nothing', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) } }),
    });
    const lock = join(stateDir, 'deploy.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`, 'utf8');
    writeFileSync(join(lock, 'since'), `${Math.floor(Date.now() / 1000)}\n`, 'utf8');
    const result = await release(['--ref', 'HEAD'], envFor(root, stateDir, bin, siteUrl));
    expect(result.code, result.out).toBe(3);
    expect(result.out).toContain('another deploy is running');
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    expect(log).not.toContain('build site');
    expect(log).not.toContain('up -d');
  });

  it('c) ships when /healthz names the image commit: exit 0, last-good recorded, audited', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const expected = sha(root).slice(0, 7);
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
    });
    const result = await release(['--ref', 'HEAD'], envFor(root, stateDir, bin, siteUrl));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`healthy: book:${sha(root)}`);
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(`book:${sha(root)}`);
    expect(readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8')).toContain(
      `ok mode=deploy runtime=compose image=book:${sha(root)} commit=${expected}`,
    );
  });

  it('d) a red gate rolls back to the previous image and still exits 1', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const previous = 'book:0123456789abcdef0123456789abcdef01234567';
    const siteUrl = await serveSite(stateDir, {
      // The new image answers a commit that is not its own; the previous image answers its own.
      healthz: (current) => ({
        status: 200,
        body: { ok: true, commit: current === previous ? '0123456' : 'deadbee' },
      }),
    });
    const env = envFor(root, stateDir, bin, siteUrl);
    env.FAKE_RUNNING_IMAGE = previous;
    writeFileSync(join(stateDir, 'current'), previous, 'utf8');
    writeFileSync(join(stateDir, 'docker.log'), '', 'utf8');
    const result = await release(['--ref', 'HEAD'], env);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('back on');
    expect(readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8')).toContain('rollback ok');
    const ups = readFileSync(join(stateDir, 'docker.log'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('up -d'));
    expect(ups).toHaveLength(2);
    expect(ups[0]).toContain(`BOOK_IMAGE_TAG=book:${sha(root)}`);
    expect(ups[1]).toContain(`BOOK_IMAGE_TAG=${previous}`);
    // A red run never records the image it could not bring up.
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(previous);
  });

  it('e) --dry-run builds nothing and starts nothing', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const siteUrl = await serveSite(stateDir, { healthz: () => ({ status: 200, body: { ok: true, commit: 'dev' } }) });
    const result = await release(['--ref', 'HEAD', '--dry-run'], envFor(root, stateDir, bin, siteUrl));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('dry run: would build');
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    expect(log).not.toContain('build site');
    expect(log).not.toContain('up -d');
  });

  it('f) a compose up that exits 1 is red even when the site already serves the new commit', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const previous = 'book:0123456789abcdef0123456789abcdef01234567';
    // The stack half-came-up: the site answers the NEW commit while `up` itself returned 1.
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
    });
    const env = envFor(root, stateDir, bin, siteUrl);
    env.FAKE_RUNNING_IMAGE = previous;
    env.FAKE_UP_FAIL_ONCE = '1';
    writeFileSync(join(stateDir, 'current'), previous, 'utf8');
    writeFileSync(join(stateDir, 'last-good-image'), `${previous}\n`, 'utf8');

    const result = await release(['--ref', 'HEAD'], env);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('compose up exited 1');
    // The exit code is the verdict: no health window is consulted for it.
    expect(result.out.indexOf('compose up exited 1')).toBeLessThan(result.out.indexOf('rollback:'));
    const ups = readFileSync(join(stateDir, 'docker.log'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('up -d'));
    expect(ups).toHaveLength(2);
    expect(ups[1]).toContain(`BOOK_IMAGE_TAG=${previous}`);
    // The image that served before the run is still the last good one.
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(previous);
  });

  it('g) a dead engine is red on the container state alone, with no health window spent', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const previous = 'book:0123456789abcdef0123456789abcdef01234567';
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
    });
    const env = envFor(root, stateDir, bin, siteUrl);
    env.FAKE_RUNNING_IMAGE = previous;
    env.FAKE_STATE_ENGINE = 'once:exited';
    writeFileSync(join(stateDir, 'current'), previous, 'utf8');
    writeFileSync(join(stateDir, 'last-good-image'), `${previous}\n`, 'utf8');

    const result = await release(['--ref', 'HEAD'], env);
    expect(result.code, result.out).toBe(1);
    // The log names the container that is wrong, not a service the site never mentioned.
    expect(result.out).toContain('service engine: exited (container id-engine');
    // A dead container is decisive: the 2 s window (let alone 180 s) is never entered for it.
    expect(result.out).not.toContain('healthz did not name');
    const ups = readFileSync(join(stateDir, 'docker.log'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('up -d'));
    expect(ups).toHaveLength(2);
    expect(ups[1]).toContain(`BOOK_IMAGE_TAG=${previous}`);
    expect(result.out).toContain('back on');
  });

  it('h) all three containers running/healthy is the green path', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
    });
    const env = envFor(root, stateDir, bin, siteUrl);
    env.FAKE_STATE_SITE = 'running healthy';
    env.FAKE_STATE_ENGINE = 'running healthy';
    // The writer has no healthcheck by design: `running` is its full contract.
    env.FAKE_STATE_WRITER = 'running';

    const result = await release(['--ref', 'HEAD'], env);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('service engine: running healthy');
    expect(result.out).toContain('service writer: running (container id-writer');
    expect(result.out).toContain(`healthy: book:${sha(root)}`);
  });
});
