/**
 * BOOK-172/BOOK-205 — the harness `composeRelease.test.ts` drives: a real git clone fixture, a fake
 * `docker` on `PATH` that records every argv, a real HTTP site and a real `curl`. Not a test file
 * (vitest collects `*.test.ts`): it exists so the suite stays under the 500-line arch limit with the
 * same primitives, and so the sign-in cases of BOOK-205 share one fixture rather than a copy of it.
 *
 * Everything is asynchronous on purpose where a server is involved: the site the gate reads lives in
 * this process, and `spawnSync` would block the event loop that has to answer the `curl` under test.
 */

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SITE = resolve(import.meta.dirname, '..', '..');
const RELEASE = join(SITE, 'deploy', 'compose-release.sh');
export const COMPOSE = join(SITE, 'docker-compose.yml');

const dirs: string[] = [];
const servers: Server[] = [];

/** Every temp dir and server a case made: the file's `afterEach` closes them. */
export async function closeAll(): Promise<void> {
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
}

export function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A git clone fixture: one commit and an `origin` pointing at itself, so `git fetch` works. */
export function gitRoot(): string {
  const dir = temp('book-172-root-');
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  mkdirSync(join(dir, 'site'), { recursive: true });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', dir]);
  return dir;
}

export const sha = (root: string) => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

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
export function fakeDocker(stateDir: string): string {
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
# BOOK-183: the data volume preflight. 'volume inspect' is the volume's existence; the one-shot
# 'test -f /v/book.db' is its content. FAKE_VOLUME_MISSING/FAKE_VOLUME_EMPTY are the two refusals.
if [ "$1" = "volume" ] && [ "$2" = "inspect" ]; then [ "\${FAKE_VOLUME_MISSING:-0}" = "1" ] && exit 1; exit 0; fi
if [ "$1" = "run" ]; then [ "\${FAKE_VOLUME_EMPTY:-0}" = "1" ] && exit 1; exit 0; fi
case "$*" in
  *" compose version"*) echo "Docker Compose version v5.5.0"; exit 0 ;;
  *" config -q"*) exit 0 ;;
  *" ps -q "*) printf 'id-%s\\n' "\${!#}"; exit 0 ;;
  *"image ls "*) [ "\${FAKE_IMAGE_LS_EMPTY:-0}" = "1" ] || printf '2026-10-28 18:00:00 +0300 MSK book:0000000\\n'; exit 0 ;;
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

export type Answers = {
  healthz: (current: string) => { status: number; body: unknown };
  /**
   * `/auth/yandex/start`, only answered when a test asks for it (otherwise the 404 every other case
   * already relied on). BOOK-205: the release reads this only when the host carries the client id.
   */
  signin?: { status: number; location?: string };
};

/** What a 302 to Yandex looks like, without any real client id in it. */
const YANDEX_AUTHORIZE = 'https://oauth.yandex.ru/authorize?client_id=test-client-id';

/**
 * BOOK-205: a host secrets dir that carries `yandex_client_id`, the shape of the prod host. The
 * release script reads that FILE NAME only; the content is never opened.
 */
export function secretsWithClientId(): string {
  const dir = temp('book-205-secrets-');
  writeFileSync(join(dir, 'yandex_client_id'), 'client-id-of-the-smoke', { mode: 0o600 });
  return dir;
}

/** The site the gate reads: `/healthz` plus the five smokes, answered from the fake's state. */
export async function serveSite(stateDir: string, answers: Answers): Promise<string> {
  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    const current = readFileSync(join(stateDir, 'current'), 'utf8').trim();
    if (url === '/healthz') {
      const reply = answers.healthz(current);
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
      return;
    }
    if (url === '/auth/yandex/start' && answers.signin !== undefined) {
      response.writeHead(answers.signin.status, { location: answers.signin.location ?? YANDEX_AUTHORIZE });
      response.end();
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

export function release(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
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
export function envFor(root: string, stateDir: string, bin: string, siteUrl: string): Record<string, string> {
  const log = join(stateDir, 'docker.log');
  writeFileSync(log, '', 'utf8');
  return {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    BOOK_DEPLOY_ROOT: root,
    BOOK_STATE_DIR: stateDir,
    // The script creates this bind source and checks its owner: it must never be the box's own.
    BOOK_LOCKS_DIR: join(stateDir, 'locks'),
    // BOOK-183: the /backups bind source the release creates. It must never be the box's real one.
    BOOK_BACKUPS_DIR: join(stateDir, 'backups'),
    // BOOK-205: the sign-in smoke reads `${BOOK_SECRETS_DIR:-./secrets}/yandex_client_id`. Pinned to a
    // temp dir that holds no such file, so no case depends on the developer's own checkout, and the
    // "sign-in off" shape is the default here.
    BOOK_SECRETS_DIR: join(temp('book-172-secrets-'), 'none'),
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

