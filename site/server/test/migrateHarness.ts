/**
 * BOOK-183 — the world `migrateScript.test.ts` drives. Not a test file (vitest collects `*.test.ts`):
 * it exists so the file of assertions stays under the 500-line arch limit, the same split
 * `flipHarness.ts` makes for `flipScript.test.ts`.
 *
 * One throwaway deploy root per case: the repo's own `migrate-to-volume.sh` and `lib.sh` (symlinked, so
 * `dirname "$0"` is this directory and no line of either is copied), a stub `compose-release.sh` beside
 * them, a fake `docker` that performs the one-shot copy into a temp "volume" and answers the container
 * reads, a fake `sqlite3` for the host-side counts, a fake `launchctl`, and a `BOOK_*` override for every
 * path. Nothing here touches the real deploy root, the real state dir, the `book` project, or a real
 * data dir.
 *
 * Two things a fake can get wrong on its own: it must anchor what it copies to its own temp root (a bare
 * `-v <name>:/to` is a volume, never a directory in the runner's CWD), and the "volume" it writes into
 * must be the one the script then verifies.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect } from 'vitest';

/** The directory name the script moves the host copy into — assembled, so no file names a real data dir. */
export const MOVED = ['book', 'site', 'data'].join('-');

/** The script is `#!/bin/bash`; the same override `deployHarness.ts` uses. */
const BASH = process.env.BOOK_TEST_BASH ?? '/bin/bash';
const SITE = resolve(import.meta.dirname, '..', '..');
const DEPLOY = join(SITE, 'deploy');

const dirs: string[] = [];

/** A temp directory this suite owns and removes: every path in a world is one of these. */
export function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Everything a case's world leaves behind. */
export function closeAll(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A real `/api/state` on a temp port: the two fields the script compares after a green release. */
export async function stateServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if ((request.url ?? '/') !== '/api/state') {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ chapters: { count: 5, totalChars: 8000 } }));
  });
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => {
      done();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the test server has no port');
  return {
    port: address.port,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      }),
  };
}

/** The one-shot copy is the fake docker's; the verification numbers are the two fakes' agreement. */
export const COUNTS = 'chapters=5 blocks=2 changes=1 comments=1 identities=1 revisions=1 events=1 chars=8000';

const FAKE_DOCKER = `#!/bin/bash
printf 'docker %s\\n' "$*" >> "$CALLS"
case "$1" in
  version) echo "Docker version 29.8.2"; exit 0 ;;
  ps) [ "\${FAKE_MOUNTING:-0}" = "1" ] && printf 'abc123def456\\n'; exit 0 ;;
  # \`inspect\` here is the mount-source read \`containers_mounting\` makes for each running id.
  inspect) [ "\${FAKE_MOUNTING:-0}" = "1" ] && printf '%s\\n' "\${FAKE_MOUNT_SOURCE:-}"; exit 0 ;;
  volume) [ "\${FAKE_VOLUME_MISSING:-0}" = "1" ] && exit 1; exit 0 ;;
  run)
    case "$*" in
      *"test -f /to/book.db"*)
        [ "\${FAKE_VOLUME_DB:-0}" = "1" ] && exit 0
        [ -f "$FAKE_VOLUME_ROOT/\${FAKE_VOLUME_NAME:-book-data}/book.db" ] && exit 0
        exit 1 ;;
      # The two node one-shots: the state read names what it selects, the verification names its pragma.
      *written*) printf 'written=%s chapters=%s chars=%s\\n' "\${FAKE_WRITTEN:-4}" "\${FAKE_CHAPTERS:-5}" "\${FAKE_CHARS:-8000}"; exit 0 ;;
      # A copy that does not pass integrity exits like the real node one-shot: a reason on stderr, non-zero.
      *integrity_check*)
        [ "\${FAKE_INTEGRITY:-ok}" = "ok" ] || { echo "integrity_check: database disk image is malformed" >&2; exit 1; }
        printf '%s\\n' "\${FAKE_COUNTS_VOLUME:-$FAKE_COUNTS}"
        exit 0 ;;
      # The archive step counts the volume's snapshots through a container: answer from this fake's own
      # volume dir, or with what the case says (a copy that lost files).
      *"/v/versions"*)
        if [ -n "\${FAKE_VOLUME_VERSIONS:-}" ]; then printf '%s\\n' "$FAKE_VOLUME_VERSIONS"; exit 0; fi
        find "$FAKE_VOLUME_ROOT/\${FAKE_VOLUME_NAME:-book-data}/versions" -type f 2>/dev/null | wc -l | tr -d ' '
        exit 0 ;;
      *"cp -a /from/."*)
        from=""; to=""
        for a in "$@"; do
          case "$a" in
            *:/from:ro) from="\${a%:/from:ro}" ;;
            *:/to) to="\${a%:/to}" ;;
          esac
        done
        # A bare -v <volume>:/to is a volume name, never a path: anchor it to this fake's own
        # volume root, or a directory of the same name in the runner's CWD would be the target.
        case "$to" in
          /*) ;;
          *) to="$FAKE_VOLUME_ROOT/\${FAKE_VOLUME_NAME:-book-data}" ;;
        esac
        mkdir -p "$to" && cp -a "$from/." "$to/" && rm -f "$to/book.db-shm"
        exit 0 ;;
    esac
    exit 0 ;;
  compose) exit 0 ;;
esac
exit 0
`;

const FAKE_SQLITE3 = `#!/bin/bash
printf 'sqlite3 %s\\n' "$*" >> "$CALLS"
# The host copy's own counts: the volume's are FAKE_COUNTS_VOLUME, so a case can disagree on one number.
printf '%s\\n' "\${FAKE_COUNTS_HOST:-$FAKE_COUNTS}"
exit 0
`;

/** Stands in for `launchctl`: the disable loop after a green release is the operator-facing contract. */
const FAKE_LAUNCHCTL = `#!/bin/bash
printf 'launchctl %s\\n' "$*" >> "$CALLS"
if [ "$1" = "disable" ] && [ -n "\${FAKE_DISABLE_REFUSE:-}" ]; then
  case "$2" in */"\$FAKE_DISABLE_REFUSE") exit 1 ;; esac
fi
exit 0
`;

/** Stands in for `compose-release.sh`; `--ref` and the inherited lock are what the script passes. */
const STUB_RELEASE = `#!/bin/bash
printf 'release %s inherited=%s\\n' "$*" "\${BOOK_LOCK_INHERITED:-0}" >> "$CALLS"
exit "\${STUB_RELEASE_EXIT:-0}"
`;

export type World = {
  script: string;
  from: string;
  stateDir: string;
  backupRoot: string;
  volumeDir: string;
  calls: string;
  env: Record<string, string>;
};

/** A throwaway deploy root: the script, its lib, a release stub, a fake docker/sqlite3, and paths. */
export function world(port: number, options: { db?: boolean } = {}): World {
  const dir = temp('book-183-migrate-');
  const script = join(dir, 'deploy');
  const from = join(dir, 'host-data');
  const root = join(dir, 'root');
  const stateDir = join(dir, 'state');
  const backupRoot = join(dir, 'backups');
  const volumeRoot = join(dir, 'volume');
  const volumeDir = join(volumeRoot, 'book-data');
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const calls = join(dir, 'calls.log');
  const composeFile = join(dir, 'docker-compose.yml');
  for (const path of [script, from, root, stateDir, backupRoot, volumeDir, bin, home]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(composeFile, 'services: {}\n', 'utf8');
  writeFileSync(join(from, 'admin.token'), 'stub-token\n', { encoding: 'utf8', mode: 0o600 });
  if (options.db !== false) writeFileSync(join(from, 'book.db'), 'stub\n', 'utf8');
  writeFileSync(calls, '', 'utf8');

  // Symlinks, not copies: the script under test is the repo's, and `dirname "$0"` is this directory.
  symlinkSync(join(DEPLOY, 'migrate-to-volume.sh'), join(script, 'migrate-to-volume.sh'));
  symlinkSync(join(DEPLOY, 'lib.sh'), join(script, 'lib.sh'));
  writeFileSync(join(script, 'compose-release.sh'), STUB_RELEASE, { encoding: 'utf8', mode: 0o755 });
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER, { encoding: 'utf8', mode: 0o755 });
  writeFileSync(join(bin, 'sqlite3'), FAKE_SQLITE3, { encoding: 'utf8', mode: 0o755 });
  writeFileSync(join(bin, 'launchctl'), FAKE_LAUNCHCTL, { encoding: 'utf8', mode: 0o755 });
  // A green full run disables the three jobs it just superseded — which it only does when the plists are
  // installed. The temp HOME is the only place they are looked for.
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(join(home, 'Library', 'LaunchAgents', 'dev.book-site.plist'), '<plist/>\n', 'utf8');

  const env: Record<string, string> = {
    BOOK_DEPLOY_ROOT: root,
    BOOK_STATE_DIR: stateDir,
    BOOK_COMPOSE_FILE: composeFile,
    BOOK_DATA_VOLUME: 'book-data',
    BOOK_HOST_DATA_DIR: from,
    BOOK_IMAGE_TAG: 'stub:1',
    // Never the real project name: even an argv in a log must not read as an action on `book`.
    BOOK_PROJECT: 'book-test',
    BOOK_SITE_PUBLISH: `127.0.0.1:${String(port)}`,
    BOOK_DOCKER: join(bin, 'docker'),
    BOOK_LAUNCHCTL: join(bin, 'launchctl'),
    BACKUP_ROOT: backupRoot,
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin`,
    CALLS: calls,
    FAKE_VOLUME_ROOT: volumeRoot,
    FAKE_VOLUME_NAME: 'book-data',
    FAKE_COUNTS: COUNTS,
    FAKE_WRITTEN: '4',
    FAKE_CHAPTERS: '5',
    FAKE_CHARS: '8000',
  };
  return { script: join(script, 'migrate-to-volume.sh'), from, stateDir, backupRoot, volumeDir, calls, env };
}

export type Run = { status: number; stdout: string; stderr: string };

/** The script as the operator runs it: a real process, its own world, nothing ambient. */
export async function migrate(w: World, args: string[], extra: Record<string, string> = {}, cwd?: string): Promise<Run> {
  const base: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const name of Object.keys(base)) if (name.startsWith('BOOK_')) delete base[name];
  const child = spawn(BASH, [w.script, ...args], {
    env: { ...base, ...w.env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd === undefined ? {} : { cwd }),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number>((done) => child.on('close', (code) => done(code ?? 1)));
  return { status, stdout, stderr };
}

/** Every argv the fakes recorded, in order. */
export function calls(w: World): string[] {
  return readFileSync(w.calls, 'utf8').split('\n').filter((line) => line.length > 0);
}

/** The index of the first call that mentions `needle`, or -1. */
export function at(w: World, needle: string): number {
  return calls(w).findIndex((line) => line.includes(needle));
}

/**
 * No call may have stopped, started or built anything: the refusal came before the first side effect.
 * A `docker run … test -f /to/book.db` is the read-only volume probe and is allowed through; the
 * cases where even that must not happen say so themselves.
 */
export function untouched(w: World): void {
  expect(calls(w).filter((line) => /\s(stop|down|build|up)\b/u.test(line))).toEqual([]);
  expect(calls(w).some((line) => line.startsWith('release'))).toBe(false);
}

