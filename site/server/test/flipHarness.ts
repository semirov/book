/**
 * BOOK-172 — the world `flipScript.test.ts` drives. Not a test file (vitest collects `*.test.ts`):
 * it exists so the file of assertions stays readable and under the 500-line arch limit, the same
 * split `deployHarness.ts` makes for `deployScript.test.ts`.
 *
 * The flip stops prod on purpose, so what a case needs is a controlled world, not a mock of the
 * script: the repo's own `flip.sh`/`lib.sh` (symlinked, so `dirname "$0"` is this directory and no
 * line of either is copied), a `compose-release.sh` stub beside them, a fake `docker` and a fake
 * `launchctl` that record their argv into one log, a GNU-shaped `stat` shim, a no-op `sleep`, and a
 * real `/healthz` on a temp port that answers 200 only once something claims the bind is served.
 *
 * Nothing here touches the real data dir, the real launchd domain, the real deploy root, a real
 * port, or `$HOME/Library/LaunchAgents`: `BOOK_*` overrides and a temp `HOME` decide every path.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect } from 'vitest';

const SITE = resolve(import.meta.dirname, '..', '..');
const DEPLOY = join(SITE, 'deploy');
const COMPOSE = join(SITE, 'docker-compose.yml');

const dirs: string[] = [];
const servers: Server[] = [];

/** Everything a case's world leaves behind: temp dirs and the test's own servers. */
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

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** `gui/<uid>`, read from the box exactly as `flip.sh` reads it. */
export const DOMAIN = `gui/${spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim()}`;

export type Fixture = {
  /** The directory the flip runs from: symlinks to the real script + lib, a stub release beside it. */
  script: string;
  root: string;
  stateDir: string;
  home: string;
  backupRoot: string;
  bin: string;
  calls: string;
  serving: string;
  /** What `/healthz` names once something serves — the tree's commit, in the launchd cases. */
  commit: string;
  /** Every `stat` the shim was asked for, in argv order: proof the GNU shape was on `PATH`. */
  statLog: string;
  url: string;
};

/**
 * The flip's world. `--to launchd` aligns the deploy root to the sha `last-good-image` names and
 * then compares what answers with the root's HEAD, so the root is a two-commit clone and the served
 * commit is a file a case writes.
 */
export async function fixture(): Promise<Fixture> {
  const dir = temp('book-172-flip-');
  const fakes = temp('book-172-flip-bin-');
  const script = join(dir, 'deploy');
  const root = join(dir, 'root');
  const stateDir = join(dir, 'state');
  const home = join(dir, 'home');
  const backupRoot = join(dir, 'backups');
  const calls = join(dir, 'calls.log');
  const serving = join(dir, 'serving');
  const commit = join(dir, 'serving-commit');
  const statLog = join(dir, 'stat.log');
  for (const path of [script, root, stateDir, home, join(backupRoot, 'daily', '2026-10-28')]) mkdirSync(path, { recursive: true });
  // The deploy root is a git clone with two commits: the alignment moves it to the older one, and the
  // two must be distinguishable for that (and for "the tree did not move") to mean anything.
  execFileSync('git', ['-C', root, 'init', '-q']);
  for (const message of ['packaging', 'deployed']) {
    execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', message]);
  }
  writeFileSync(calls, '', 'utf8');
  writeFileSync(statLog, '', 'utf8');

  symlinkSync(join(DEPLOY, 'flip.sh'), join(script, 'flip.sh'));
  symlinkSync(join(DEPLOY, 'lib.sh'), join(script, 'lib.sh'));
  const stub = `#!/bin/bash
printf 'release %s inherited=%s holder=%s\\n' "$*" "\${BOOK_LOCK_INHERITED:-0}" "\${BOOK_LOCK_HOLDER:-unknown}" >> "$CALLS"
if [ "\${STUB_HEALTHY:-0}" = "1" ]; then : > "$SERVING"; fi
exit "\${STUB_EXIT:-0}"
`;
  writeFileSync(join(script, 'compose-release.sh'), stub, { encoding: 'utf8', mode: 0o755 });

  // The fake docker: records every argv, refuses the stale pre-BOOK-172 container, answers the rest.
  // `ps -q` lists containers that `compose down` was supposed to remove — `FAKE_LEFTOVER=1` is the
  // stack that is still up.
  writeFileSync(
    join(fakes, 'docker'),
    `#!/bin/bash
printf 'docker %s\\n' "$*" >> "$CALLS"
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then exit 1; fi
if [ "$1" = "version" ]; then echo "Docker version 29.8.2"; exit 0; fi
case "$*" in
  *" compose version"*) echo "Docker Compose version v5.5.0"; exit 0 ;;
  *" down") exit 0 ;;
  *" ps -q"*) [ "\${FAKE_LEFTOVER:-0}" = "1" ] && printf 'abc123def456\\n'; exit 0 ;;
esac
exit 0
`,
    { encoding: 'utf8', mode: 0o755 },
  );
  // The fake launchctl: records every argv; a successful `bootstrap` is "launchd serves again", and
  // `disable` for the job named in `FAKE_DISABLE_REFUSE` is refused exactly as launchd would.
  writeFileSync(
    join(fakes, 'launchctl'),
    `#!/bin/bash
printf 'launchctl %s\\n' "$*" >> "$CALLS"
if [ "$1" = "bootstrap" ]; then : > "$SERVING"; fi
if [ "$1" = "disable" ] && [ -n "\${FAKE_DISABLE_REFUSE:-}" ]; then
  case "$2" in */"\$FAKE_DISABLE_REFUSE") exit 1 ;; esac
fi
exit 0
`,
    { encoding: 'utf8', mode: 0o755 },
  );
  // A no-op `sleep`: the flip's waits are bounded by read counts, and a test that spent them on the
  // wall clock would cost a minute to prove one branch. The loops themselves still run.
  writeFileSync(join(fakes, 'sleep'), '#!/bin/bash\nexit 0\n', { encoding: 'utf8', mode: 0o755 });
  // `stat` as GNU coreutils has it — the shape the Debian CI runner has, and the shape on which the
  // `stat -f`-first bug is invisible on macOS: `-f` is "filesystem status" there, not a format, so
  // the report goes to stdout and the exit code is 1. `-c %Y`/`-c %U` answer like coreutils does.
  writeFileSync(
    join(fakes, 'stat'),
    `#!/bin/bash
printf '%s\\n' "$*" >> "\${STAT_LOG:-/dev/null}"
case "$1" in
  -f)
    printf '  File: "%s"\\n' "$3"
    printf '    ID: 0        Namelen: 255\\n'
    printf 'Block size: 4096\\n'
    exit 1 ;;
  -c)
    case "$2" in
      %Y) /usr/bin/stat -c %Y "$3" 2>/dev/null || /usr/bin/stat -f %m "$3" 2>/dev/null; exit $? ;;
      %U) id -un; exit 0 ;;
    esac ;;
esac
exit 1
`,
    { encoding: 'utf8', mode: 0o755 },
  );

  const url = await serveHealth(serving, commit);
  return { script: join(script, 'flip.sh'), root, stateDir, home, backupRoot, bin: fakes, calls, serving, commit, statLog, url };
}

/**
 * `/healthz` on a temp port: 503 until `$SERVING` exists, 200 after. That one file is how a case says
 * "something took the bind" — set by the release stub (containers) or by the launchctl fake
 * (`bootstrap`), never by the test between two reads. The `commit` it names is a second file: the
 * flip's launchd path compares it with the deploy root's HEAD, so a case has to say which build
 * launchd is really serving.
 */
async function serveHealth(serving: string, commitPath: string): Promise<string> {
  const server = createServer((request, response) => {
    if ((request.url ?? '/') !== '/healthz') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (existsSync(serving)) {
      const commit = existsSync(commitPath) ? readFileSync(commitPath, 'utf8').trim() : '';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, commit }));
      return;
    }
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false }));
  });
  servers.push(server);
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => {
      done();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the test server has no port');
  return `http://127.0.0.1:${address.port}`;
}

/** The flip as the operator runs it: a real process, its own world, nothing ambient. */
export function flip(
  f: Fixture,
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ code: number | null; out: string }> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('BOOK_')) continue;
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    PATH: `${f.bin}:${process.env.PATH ?? ''}`,
    HOME: f.home,
    BOOK_DOCKER: join(f.bin, 'docker'),
    BOOK_LAUNCHCTL: join(f.bin, 'launchctl'),
    BOOK_DEPLOY_ROOT: f.root,
    BOOK_STATE_DIR: f.stateDir,
    BOOK_COMPOSE_FILE: COMPOSE,
    BOOK_LOCKS_DIR: join(f.stateDir, 'locks'),
    BOOK_PROJECT: 'book-test',
    BOOK_SITE_PUBLISH: `127.0.0.1:${new URL(f.url).port}`,
    BOOK_HEALTH_TIMEOUT: '1',
    BOOK_BACKUP_MAX_AGE_S: '3600',
    BACKUP_ROOT: f.backupRoot,
    CALLS: f.calls,
    SERVING: f.serving,
    STAT_LOG: f.statLog,
  });
  Object.assign(env, extra);
  return new Promise((done) => {
    const child = spawn('/bin/bash', [f.script, ...args], { env });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out += String(chunk);
    });
    child.on('close', (code: number | null) => {
      // Every case: a GNU-shaped `stat` must never reach `$(( ))` as text. The CI runner died with
      // `File: unbound variable` before a single flip assertion ran, and macOS cannot see that.
      expect(out, 'a shell arithmetic error from a tool report').not.toContain('unbound variable');
      done({ code, out });
    });
  });
}

/** Every argv the fakes were given, in order. */
export const callsOf = (f: Fixture): string[] =>
  readFileSync(f.calls, 'utf8')
    .split('\n')
    .filter((line) => line !== '');

export const indexOfLine = (calls: string[], match: RegExp): number => calls.findIndex((line) => match.test(line));

/** What the GNU-shaped `stat` shim was asked for, in order. */
export const statCallsOf = (f: Fixture): string[] =>
  readFileSync(f.statLog, 'utf8')
    .split('\n')
    .filter((line) => line !== '');

/** The commit the deploy root is on, read the way `flip.sh` reads it. */
export const headOf = (root: string, ref = 'HEAD'): string =>
  execFileSync('git', ['-C', root, 'rev-parse', ref], { encoding: 'utf8' }).trim();

/** What the served `/healthz` names: the short sha launchd is really running. */
export const served = (f: Fixture, sha: string): void => {
  writeFileSync(f.commit, `${sha.slice(0, 7)}\n`, 'utf8');
};
