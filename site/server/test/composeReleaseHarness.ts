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
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * BOOK-217: a directory that stands in for the named data volume, so the one-shot `sh` calls the
 * release makes around `up` (`ls backups/`, the marker's `schema=` line, the dump restore) act on
 * files instead of on a string in a log. The shape is the prod one after the incident's first image
 * booted: a v29 database, the marker that names it, and the `backups/` directory the boot dumps into.
 */
export function volumeFixture(): string {
  const dir = temp('book-217-volume-');
  mkdirSync(join(dir, 'backups'), { recursive: true });
  writeFileSync(join(dir, 'book.db'), 'BOOK-DB-v29\n', 'utf8');
  writeFileSync(join(dir, '.book-volume'), 'book-volume 1\nschema=29\n', 'utf8');
  return dir;
}

/**
 * A git clone fixture: one commit and an `origin` pointing at itself, so `git fetch` works.
 *
 * BOOK-232: the commit carries `site/server/src/db/schema.ts` at the prod version, so the image the
 * release builds always has a READABLE schema constant. A rollback target that must be safe is then a
 * real earlier commit (`commitSchema(root, n)`) rather than a made-up sha only the fake `docker`
 * could resolve — the decision under test is a git read on this clone.
 */
export function gitRoot(): string {
  const dir = temp('book-172-root-');
  execFileSync('git', ['-C', dir, 'init', '-q']);
  mkdirSync(join(dir, 'site', 'server', 'src', 'db'), { recursive: true });
  writeFileSync(join(dir, 'site', 'server', 'src', 'db', 'schema.ts'), 'export const SCHEMA_VERSION = 33;\n', 'utf8');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', dir]);
  return dir;
}

export const sha = (root: string) => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

/**
 * BOOK-217: a commit whose `site/server/src/db/schema.ts` carries `SCHEMA_VERSION = <version>`, so the
 * release's `git show <sha>:site/server/src/db/schema.ts` reads a real number (the deployed image and
 * a rollback target are both commits of this clone). Returns the commit's sha.
 */
export function commitSchema(root: string, version: number): string {
  mkdirSync(join(root, 'site', 'server', 'src', 'db'), { recursive: true });
  writeFileSync(
    join(root, 'site', 'server', 'src', 'db', 'schema.ts'),
    `export const SCHEMA_VERSION = ${String(version)};\n`,
    'utf8',
  );
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', `schema v${String(version)}`]);
  return sha(root);
}

/**
 * A fake `docker` that answers the calls the release script makes and records every argv. `up`
 * writes the image tag it was given into `$STATE_DIR/current` — that file is what the test server
 * answers `/healthz` with, so "the stack moved" and "the gate noticed" are one causal chain
 * instead of two independent mocks.
 *
 * It is template-aware: `inspect -f '{{.Config.Image}}'` answers the image, while
 * `inspect -f '{{.State.Status}} …'` answers the container state per service (`FAKE_STATE_SITE`,
 * `FAKE_STATE_ENGINE`, `FAKE_STATE_WRITER`; a value prefixed `once:` is read once and then falls back
 * to the healthy default) and `{{.RestartCount}}` answers `FAKE_RESTARTS_<SERVICE>` (default 0; a
 * value `before,after` answers `before` on the first read and `after` on every later one — the shape
 * of a container that keeps restarting under the run). The defaults are the healthy stack — site and
 * engine `running healthy`, the writer `running` (it has no healthcheck by design).
 *
 * BOOK-217: the one-shot `sh` the release runs around `up` acts on `FAKE_VOLUME_DIR` (a directory
 * from `volumeFixture()`): the dump listing and the restore. `FAKE_DUMPS_FAIL=after` makes the second
 * listing fail (the fact the run cannot read); `before` makes the first fail. `up -d` simulates the
 * boot's pre-migration dump under `FAKE_MIGRATE_ON_UP=1` — one dump, once (the migration happens on
 * the boot of the new image, not on every `up`), with `FAKE_MIGRATE_STAMP` as its name; the volume
 * marker is NOT bumped, because the real boot writes it once and never refreshes `schema=`.
 * `FAKE_STOP_FAIL=1` refuses `dc stop`. A stray `writer/`, `manuscript/` or `notes.txt` in that
 * fixture is what `home-check` refuses, and `home-migrate --apply` folds the `writer/` one away — the
 * shape of a fixable leftover and a genuinely stray file.
 *
 * BOOK-232: the two schema probes answer by their own marker line. The volume read (`compose run …
 * --entrypoint node site -e '<better-sqlite3 user_version>'`) answers `FAKE_VOLUME_SCHEMA`, or the
 * number the fake restore last wrote to `<state>/volume-schema` — a restored dump carries the version
 * in its own name (`pre-v29-…db` → 29), exactly as the real file would. Unset means "unreadable" (the
 * probe exits 1), which is the `unknown` the guard must refuse. The image read (`docker run … <tag> -e
 * '<import schema.js>'`) answers `FAKE_IMAGE_SCHEMA`, and is only reached for a tag whose commit this
 * clone does not carry.
 */
export function fakeDocker(stateDir: string): string {
  const dir = temp('book-172-bin-');
  const body = `#!/bin/bash
printf '%s BOOK_IMAGE_TAG=%s\\n' "$*" "\${BOOK_IMAGE_TAG:-}" >> "${stateDir}/docker.log"
if [ "$1" = "version" ]; then echo "Docker version 29.8.2"; exit 0; fi
if [ "$1" = "inspect" ] && [ "$2" = "-f" ]; then
  case "$3" in
    *'.RestartCount'*)
      name="\${4#id-}"
      upper="$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')"
      var="FAKE_RESTARTS_$upper"
      raw="\${!var:-0}"
      case "$raw" in
        *,*)
          counter="${stateDir}/restarts-$name"
          if [ -e "$counter" ]; then printf '%s\\n' "\${raw#*,}"; else : > "$counter"; printf '%s\\n' "\${raw%%,*}"; fi
          exit 0 ;;
      esac
      printf '%s\\n' "$raw"
      exit 0 ;;
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
if [ "$1" = "run" ]; then
  case "$*" in
    *BOOK_SCHEMA*)
      [ -n "\${FAKE_IMAGE_SCHEMA:-}" ] || { echo "node: cannot find module '/app/server/dist/db/schema.js'" >&2; exit 1; }
      printf 'BOOK_SCHEMA=%s\\n' "\${FAKE_IMAGE_SCHEMA}"
      exit 0 ;;
  esac
  [ "\${FAKE_VOLUME_EMPTY:-0}" = "1" ] && exit 1
  exit 0
fi
case "$*" in
  *" compose version"*) echo "Docker Compose version v5.5.0"; exit 0 ;;
  *" config -q"*) exit 0 ;;
  *" ps -q "*) printf 'id-%s\\n' "\${!#}"; exit 0 ;;
  *"image ls "*) [ "\${FAKE_IMAGE_LS_EMPTY:-0}" = "1" ] || printf '2026-10-28 18:00:00 +0300 MSK book:0000000\\n'; exit 0 ;;
  *" build site"*) exit 0 ;;
  # BOOK-217: the volume read and the dump restore, one-shot 'sh' on the site image. No service
  # command is passed, so (as in the real image) nothing boots and no DDL can run here. The shapes
  # the release uses are told apart by their own text.
  *" run --rm -T --no-deps --entrypoint sh site -c "*)
    cmd="\${!#}"
    [ -n "\${FAKE_VOLUME_DIR:-}" ] || exit 0
    case "$cmd" in
      *"cp /data/backups/"*)
        # The restore: the same file operations the release runs, on the fixture volume.
        name="$(printf '%s' "$cmd" | tr ' ' '\\n' | sed -n 's#^/data/backups/##p' | head -n 1)"
        [ -f "\${FAKE_VOLUME_DIR}/backups/$name" ] || { echo "restore: backups/$name is not there"; exit 1; }
        rm -f "\${FAKE_VOLUME_DIR}/book.db-wal" "\${FAKE_VOLUME_DIR}/book.db-shm"
        cp "\${FAKE_VOLUME_DIR}/backups/$name" "\${FAKE_VOLUME_DIR}/backups/.book.db.restoring"
        mv "\${FAKE_VOLUME_DIR}/backups/.book.db.restoring" "\${FAKE_VOLUME_DIR}/book.db"
        # BOOK-232: the restored file is on the version its own name carries, so the schema probe
        # answers that from now on — the guard after a restore judges the dump, not the live boot.
        printf '%s\\n' "$(printf '%s' "$name" | sed -n 's/^pre-v\\([0-9][0-9]*\\)-.*$/\\1/p')" > "${stateDir}/volume-schema"
        printf 'restored backups/%s\\n' "$name"
        exit 0 ;;
      *"ls -1 /data/backups"*)
        # FAKE_DUMPS_FAIL=before: the pre-up listing fails; =after: every later listing fails.
        if [ "\${FAKE_DUMPS_FAIL:-0}" = "before" ] && [ ! -e "${stateDir}/dumps-first-read" ]; then
          : > "${stateDir}/dumps-first-read"
          echo "ls: cannot access '/data/backups': No such file or directory" >&2
          exit 1
        fi
        if [ "\${FAKE_DUMPS_FAIL:-0}" = "after" ]; then
          if [ -e "${stateDir}/dumps-first-read" ]; then
            echo "ls: cannot access '/data/backups': No such file or directory" >&2
            exit 1
          fi
          : > "${stateDir}/dumps-first-read"
        fi
        if [ -d "\${FAKE_VOLUME_DIR}/backups" ]; then
          ls -1 "\${FAKE_VOLUME_DIR}/backups" 2>/dev/null | grep -E '^pre-v.*[.]db$' | sort
          exit 0
        fi
        # A volume that never took a dump has no 'backups/', and the real 'ls' fails on it (exit 2,
        # the status 'docker compose run' passes on) — unless the command asks first, in which case
        # the guarded one-shot succeeds with no names. The fake answers what the real shell would,
        # so a driver that never asks cannot call the absence an empty listing.
        case "$cmd" in *"[ -d /data/backups ]"*) exit 0 ;; esac
        echo "ls: cannot access '/data/backups': No such file or directory" >&2
        exit 2 ;;
    esac
    exit 0 ;;
  # BOOK-217: the home gate, one-shot 'node'. 'home-migrate --apply' folds the old writer's files away
  # (as the real one does), and 'home-check' refuses what is left and names the path — the sentence an
  # operator reads. A 'notes.txt' is the genuinely stray file '--apply' cannot fix.
  *" run --rm -T --no-deps --entrypoint node site "*)
    case "$*" in
      # BOOK-232: the volume's own user_version, asked read-only by one one-shot that never boots.
      *BOOK_SCHEMA*)
        if [ -f "${stateDir}/volume-schema" ]; then
          printf 'BOOK_SCHEMA=%s\\n' "$(cat "${stateDir}/volume-schema")"
          exit 0
        fi
        [ -n "\${FAKE_VOLUME_SCHEMA:-}" ] || { echo "BOOK_SCHEMA: the volume could not be read" >&2; exit 1; }
        printf 'BOOK_SCHEMA=%s\\n' "\${FAKE_VOLUME_SCHEMA}"
        exit 0 ;;
      *"home-migrate.mjs --apply"*)
        rm -rf "\${FAKE_VOLUME_DIR:-}/writer"
        exit 0 ;;
      *"home-check.mjs"*)
        for stray in writer manuscript notes.txt; do
          if [ -e "\${FAKE_VOLUME_DIR:-}/$stray" ]; then
            echo "home-check: /data/$stray may not be here — run bin/home-migrate.mjs --apply"
            exit 1
          fi
        done ;;
    esac
    exit 0 ;;
  # BOOK-217: the stack is stopped before the dump goes over book.db; a stop that fails must not be
  # followed by a restore.
  *" stop "*) [ "\${FAKE_STOP_FAIL:-0}" = "1" ] && exit 1; exit 0 ;;
  *" up -d "*)
    printf '%s\\n' "\${BOOK_IMAGE_TAG:-}" > "${stateDir}/current"
    if [ "\${FAKE_MIGRATE_ON_UP:-0}" = "1" ] && [ ! -e "${stateDir}/migrated" ]; then
      # A volume fixture is required: without one this used to write the dump into the deploy's own
      # working directory (site/backups/), littering the tree a test runs in.
      [ -n "\${FAKE_VOLUME_DIR:-}" ] || { echo "fake docker: FAKE_MIGRATE_ON_UP needs FAKE_VOLUME_DIR" >&2; exit 1; }
      : > "${stateDir}/migrated"
      stamp="\${FAKE_MIGRATE_STAMP:-20261029T085300Z}"
      mkdir -p "\${FAKE_VOLUME_DIR}/backups"
      printf 'DUMP v29 %s\\n' "$stamp" > "\${FAKE_VOLUME_DIR}/backups/pre-v29-$stamp.db"
    fi
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
  /**
   * BOOK-232: the age gate (BOOK-225) as the deployed site answers it. `off` (the default) serves the
   * chapter to anybody; `on` answers `403 {"code":"AGE_GATE"}`, a `POST /api/age` writes
   * `book_age=<today>`, and the same GET with that cookie answers 200 — the round trip the smoke
   * must prove; `ignored` refuses even WITH the cookie, the shape of a gate no reader can satisfy;
   * `other` refuses `403` with a code that is not `AGE_GATE` (a refusal the smoke must not read as
   * the age gate).
   */
  gate?: 'off' | 'on' | 'ignored' | 'other';
  /**
   * BOOK-232: a file every request line is appended to (`POST /api/age age=none`), so "the smoke
   * really asked" is an assertion. The cookie's VALUE is never written — only whether it was sent.
   */
  log?: string;
  /**
   * BOOK-232: the status `/api/chapters` answers (200 by default). The smoke must require 200 before
   * it reads the array — a 500 whose body happens to begin with `[` is not a healthy catalog.
   */
  catalogStatus?: number;
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

/** The day the fake writes on `POST /api/age` — the site's own clock, which the smoke must reuse. */
const FAKE_AGE_DAY = new Date().toISOString().slice(0, 10);

/** The `book_age` value in a `Cookie` header, or undefined. The value is a day and nothing else. */
function ageCookie(cookie: string | undefined): string | undefined {
  if (cookie === undefined) return undefined;
  for (const part of cookie.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    if (part.slice(0, index).trim() !== 'book_age') continue;
    return part.slice(index + 1).trim();
  }
  return undefined;
}

/** The site the gate reads: `/healthz`, the smokes and the age gate, answered from the fake's state. */
export async function serveSite(stateDir: string, answers: Answers): Promise<string> {
  const gate = answers.gate ?? 'off';
  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    const current = readFileSync(join(stateDir, 'current'), 'utf8').trim();
    const acknowledged = ageCookie(request.headers.cookie);
    // The recorded log is what makes "the smoke asked, and asked again with the cookie" provable.
    if (answers.log !== undefined) {
      appendFileSync(answers.log, `${request.method ?? 'GET'} ${url} age=${acknowledged === undefined ? 'none' : 'sent'}\n`);
    }
    if (request.method === 'POST' && url === '/api/age') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `book_age=${FAKE_AGE_DAY}; Max-Age=31536000; Path=/; SameSite=Lax`,
      });
      response.end(JSON.stringify({ acknowledgedAt: FAKE_AGE_DAY }));
      return;
    }
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
      const status = answers.catalogStatus ?? 200;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(status === 200 ? '[{"n":1}]' : '[{"error":"the catalog is down"}]');
      return;
    }
    if (url === '/api/chapters/1') {
      const served = gate === 'off' || (gate === 'on' && acknowledged !== undefined);
      if (!served) {
        // The refusal the reader meets, with the machine-readable code and `no-store`, as the route
        // sends it: the smoke must decide from the code, never from "403 is fine".
        response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        const code = gate === 'other' ? 'NOT_ADULTS' : 'AGE_GATE';
        response.end(JSON.stringify({ code, message: 'The book is for adults.' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"n":1,"title":"One"}');
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

