/**
 * BOOK-172 — `deploy/flip.sh`, the one command that moves prod between launchd and containers.
 *
 * A flip stops prod on purpose, so the order inside it is the safety property. This file drives the
 * real script with a fake `docker` and a fake `launchctl` on `PATH` (both record their argv into one
 * log, so "before" and "after" are comparable without a clock), a `compose-release.sh` stub that
 * exits what the case asks for, and a real `/healthz` on a temp port that answers 200 only once
 * something claims the bind is served.
 *
 * What is pinned:
 *   · `launchctl` grammar — `bootout <domain>/<service>`, `bootstrap <domain> <plist>`; the arguments
 *     are never swapped, and the writer lane stops before the site and the engine;
 *   · a flip's lock is handed to `compose-release.sh` (`BOOK_LOCK_INHERITED=1`), never re-taken;
 *   · a red `compose-release.sh` brings the stack down BEFORE launchd is bootstrapped, and leaves
 *     `runtime` untouched — the deploy workflow keeps working on the runtime that is up;
 *   · `runtime=compose` is written only after the gate is green;
 *   · `--to launchd` runs `compose down` and records `runtime=launchd`;
 *   · a `--dry-run` takes no lock and writes no state.
 *
 * Nothing here touches the real data dir, the real launchd domain, the real deploy root, a real
 * port, or `$HOME/Library/LaunchAgents`: `BOOK_*` overrides and a temp `HOME` decide every path.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// Every case spawns the real script, and a loaded box stretches the clock: a spawn is not a hang, so
// the timeout is about a wedged child, not about the work.
vi.setConfig({ testTimeout: 60_000 });

const SITE = resolve(import.meta.dirname, '..', '..');
const DEPLOY = join(SITE, 'deploy');
const COMPOSE = join(SITE, 'docker-compose.yml');

const dirs: string[] = [];
const servers: Server[] = [];

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

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** `gui/<uid>`, read from the box exactly as `flip.sh` reads it. */
const DOMAIN = `gui/${spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim()}`;

type Fixture = {
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
  url: string;
};

/**
 * The flip's world. `flip.sh` and `lib.sh` are the repo's own files (symlinked, so `dirname "$0"` is
 * this directory and no line of either script is copied); only the child it calls — the container
 * release — is a stub, because that script has its own test file.
 */
async function fixture(): Promise<Fixture> {
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
  for (const path of [script, root, stateDir, home, join(backupRoot, 'daily', '2026-10-28')]) mkdirSync(path, { recursive: true });
  // The deploy root is a git clone with two commits: the flip's `--to launchd` aligns it to the sha
  // `last-good-image` names, and the two must be distinguishable commits for that to mean anything.
  execFileSync('git', ['-C', root, 'init', '-q']);
  for (const message of ['packaging', 'deployed']) {
    execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', message]);
  }
  writeFileSync(calls, '', 'utf8');

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

  const url = await serveHealth(serving, commit);
  return { script: join(script, 'flip.sh'), root, stateDir, home, backupRoot, bin: fakes, calls, serving, commit, url };
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
function flip(
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
      done({ code, out });
    });
  });
}

const callsOf = (f: Fixture): string[] =>
  readFileSync(f.calls, 'utf8')
    .split('\n')
    .filter((line) => line !== '');

const indexOfLine = (calls: string[], match: RegExp): number => calls.findIndex((line) => match.test(line));

/** The commit the deploy root is on, read the way `flip.sh` reads it. */
const headOf = (root: string, ref = 'HEAD'): string =>
  execFileSync('git', ['-C', root, 'rev-parse', ref], { encoding: 'utf8' }).trim();

/** What the served `/healthz` names: the short sha launchd is really running. */
const served = (f: Fixture, sha: string): void => {
  writeFileSync(f.commit, `${sha.slice(0, 7)}\n`, 'utf8');
};

describe('the flip to compose', () => {
  it('stops the writer first with the launchctl grammar, hands the lock over, and records runtime=compose', async () => {
    const f = await fixture();
    const { code, out } = await flip(f, ['--to', 'compose', '--confirm'], { STUB_EXIT: '0', STUB_HEALTHY: '1' });
    expect(code, out).toBe(0);

    const calls = callsOf(f);
    const bootout = calls.filter((line) => line.startsWith('launchctl bootout'));
    // launchctl's grammar: the service is the last component of the target, never the first argument
    // of the pair — `bootout dev.book-writer gui/501` is the silent no-op this pins.
    expect(bootout).toEqual([
      `launchctl bootout ${DOMAIN}/dev.book-writer`,
      `launchctl bootout ${DOMAIN}/dev.book-site`,
      `launchctl bootout ${DOMAIN}/dev.book-engine`,
    ]);
    // A green flip has nothing to bootstrap back: launchd is disabled, not restarted.
    expect(calls.filter((line) => line.startsWith('launchctl bootstrap'))).toEqual([]);
    expect(calls).toContain(`launchctl disable ${DOMAIN}/dev.book-site`);

    // The child never re-takes the lock a flip holds: it is told it inherits it, from this pid.
    const release = calls.find((line) => line.startsWith('release '));
    expect(release, out).toMatch(/^release --ref main inherited=1 holder=\d+$/u);

    const runtime = readFileSync(join(f.stateDir, 'runtime'), 'utf8').trim();
    expect(runtime).toBe('compose');
    expect(out).toContain('flip complete');
    // A flip that worked never stops the stack it just started.
    expect(calls.filter((line) => /compose .* down$/u.test(line))).toEqual([]);
    // The stale pre-BOOK-172 container was absent, so nothing was removed.
    expect(calls.filter((line) => line.includes('rm -f'))).toEqual([]);
    // The flip's own lock is released on the way out.
    expect(existsSync(join(f.stateDir, 'deploy.lock'))).toBe(false);
  });

  it('exits 4 when a job cannot be disabled, keeping runtime=compose and printing the commands', async () => {
    const f = await fixture();
    const { code, out } = await flip(f, ['--to', 'compose', '--confirm'], { STUB_EXIT: '0', STUB_HEALTHY: '1', FAKE_DISABLE_REFUSE: 'dev.book-site' });
    // Green containers are worth keeping: the exit code says "flip done, one command left", not "red".
    expect(code, out).toBe(4);
    expect(readFileSync(join(f.stateDir, 'runtime'), 'utf8').trim()).toBe('compose');
    expect(out).toContain('runtime=compose is recorded, but a job could not be disabled');
    // The operator's next command, spelled exactly.
    expect(out).toContain(`launchctl disable ${DOMAIN}/dev.book-site`);
    expect(out).not.toMatch(new RegExp(`launchctl disable ${DOMAIN.replace('/', '\\/')}/dev\\.book-(engine|writer)`, 'u'));
    // All three were attempted, so one refusal does not stop the other two.
    expect(callsOf(f).filter((line) => line.startsWith('launchctl disable'))).toEqual([
      `launchctl disable ${DOMAIN}/dev.book-site`,
      `launchctl disable ${DOMAIN}/dev.book-engine`,
      `launchctl disable ${DOMAIN}/dev.book-writer`,
    ]);
    expect(out).not.toContain('flip complete');
    expect(existsSync(join(f.stateDir, 'deploy.lock'))).toBe(false);
  });

  it('restores launchd and writes no runtime when 8091 never goes quiet after the bootouts', async () => {
    const f = await fixture();
    // The launchd site does not stop: `/healthz` keeps answering 200 through the whole wait_down.
    writeFileSync(f.serving, '', 'utf8');
    const { code, out } = await flip(f, ['--to', 'compose', '--confirm'], { STUB_EXIT: '0', STUB_HEALTHY: '1' });
    expect(code, out).toBe(1);
    expect(out).toContain('8091 still answers after 60 s');
    expect(out).toContain('nothing was started');
    // Nothing was started: the release never ran, and the container runtime owns nothing.
    expect(callsOf(f).filter((line) => line.startsWith('release '))).toEqual([]);
    expect(existsSync(join(f.stateDir, 'runtime'))).toBe(false);
    // Best-effort restore, engine first, so the writer's first request has something to answer.
    expect(callsOf(f).filter((line) => line.startsWith('launchctl bootstrap'))).toEqual([
      `launchctl bootstrap ${DOMAIN} ${join(f.home, 'Library/LaunchAgents/dev.book-engine.plist')}`,
      `launchctl bootstrap ${DOMAIN} ${join(f.home, 'Library/LaunchAgents/dev.book-site.plist')}`,
      `launchctl bootstrap ${DOMAIN} ${join(f.home, 'Library/LaunchAgents/dev.book-writer.plist')}`,
    ]);
    expect(callsOf(f)).toContain(`launchctl enable ${DOMAIN}/dev.book-engine`);
    expect(existsSync(join(f.stateDir, 'deploy.lock'))).toBe(false);
  });

  it('brings the stack down before launchd, and leaves runtime untouched, when the release is red', async () => {    const f = await fixture();
    const { code, out } = await flip(f, ['--to', 'compose', '--confirm'], { STUB_EXIT: '1' });
    expect(code, out).toBe(1);
    expect(out).toContain('flip aborted');

    const calls = callsOf(f);
    const down = indexOfLine(calls, /compose .* down$/u);
    const firstBootstrap = indexOfLine(calls, /^launchctl bootstrap /u);
    expect(down, out).toBeGreaterThan(-1);
    expect(firstBootstrap, out).toBeGreaterThan(-1);
    // A half-started stack would keep 8091 and launchd could not bind: containers down first, always.
    expect(down).toBeLessThan(firstBootstrap);

    // The plist is the second argument of the domain — launchctl's grammar, not ours.
    expect(calls[firstBootstrap]).toBe(`launchctl bootstrap ${DOMAIN} ${join(f.home, 'Library/LaunchAgents/dev.book-engine.plist')}`);
    // The stop ran writer, site, engine; `launchd_up` then bootouts the same three again before its
    // bootstraps (idempotent). Every line must use the service-target form, in both places.
    const bootout = calls.filter((line) => line.startsWith('launchctl bootout'));
    expect(bootout.slice(0, 3)).toEqual([
      `launchctl bootout ${DOMAIN}/dev.book-writer`,
      `launchctl bootout ${DOMAIN}/dev.book-site`,
      `launchctl bootout ${DOMAIN}/dev.book-engine`,
    ]);
    expect(new Set(bootout)).toEqual(
      new Set([`launchctl bootout ${DOMAIN}/dev.book-writer`, `launchctl bootout ${DOMAIN}/dev.book-site`, `launchctl bootout ${DOMAIN}/dev.book-engine`]),
    );
    // The red flip never claims the containers own prod.
    expect(existsSync(join(f.stateDir, 'runtime'))).toBe(false);
    expect(existsSync(join(f.stateDir, 'deploy.lock'))).toBe(false);
  });
});

describe('the flip to launchd', () => {
  it('runs compose down and records runtime=launchd', async () => {
    const f = await fixture();
    writeFileSync(join(f.stateDir, 'runtime'), 'compose\n', 'utf8');
    // launchd is what will answer here: the stack is already down and its bind comes back on bootstrap.
    writeFileSync(f.serving, '', 'utf8');
    served(f, headOf(f.root));
    const { code, out } = await flip(f, ['--to', 'launchd', '--confirm']);
    expect(code, out).toBe(0);

    const calls = callsOf(f);
    expect(indexOfLine(calls, /compose .* down$/u), out).toBeGreaterThan(-1);
    expect(calls).toContain(`launchctl enable ${DOMAIN}/dev.book-site`);
    expect(calls.filter((line) => line.startsWith('launchctl bootstrap'))).toEqual([
      `launchctl bootstrap ${DOMAIN} ${join(f.home, 'Library/LaunchAgents/dev.book-engine.plist')}`,
      `launchctl bootstrap ${DOMAIN} ${join(f.home, 'Library/LaunchAgents/dev.book-site.plist')}`,
      `launchctl bootstrap ${DOMAIN} ${join(f.home, 'Library/LaunchAgents/dev.book-writer.plist')}`,
    ]);
    // No last good image is recorded, so the tree is left alone — and the flip says so, once.
    expect(out).toContain('tree: no last-good-image recorded — the deploy root stays where it is');
    expect(out).toContain('flip back complete');
    expect(existsSync(join(f.stateDir, 'deploy.lock'))).toBe(false);
  });

  it('refuses to claim launchd when what answers is not the tree it runs', async () => {
    const f = await fixture();
    const stranger = 'beeffff';
    writeFileSync(f.serving, '', 'utf8');
    served(f, `${stranger}000`); // a build this root never checked out
    const { code, out } = await flip(f, ['--to', 'launchd', '--confirm']);
    expect(code, out).toBe(1);
    expect(out).toContain(`launchd answers ${stranger}, but the deploy root is at ${headOf(f.root).slice(0, 7)}`);
    expect(out).toContain('the plist runs a different build');
    // Prod may look healthy while running the wrong code: nothing is recorded, a human is told.
    expect(existsSync(join(f.stateDir, 'runtime'))).toBe(false);
  });

  it('aligns the deploy root to the last good image before launchd serves the tree', async () => {
    const f = await fixture();
    const deployed = headOf(f.root);
    const packaged = headOf(f.root, 'HEAD~1'); // the image that gets served: an older commit
    expect(packaged).not.toBe(deployed);
    writeFileSync(join(f.stateDir, 'last-good-image'), `book:${packaged}\n`, 'utf8');
    writeFileSync(f.serving, '', 'utf8');
    served(f, packaged); // launchd runs the aligned tree, so this is what it answers with

    const { code, out } = await flip(f, ['--to', 'launchd', '--confirm']);
    expect(code, out).toBe(0);
    // launchd runs the tree, so the tree is moved to the code that was serving — before the bootstrap.
    expect(out).toContain(`tree: deploy root at ${packaged.slice(0, 7)} (the last good image)`);
    expect(out.indexOf('tree: deploy root at')).toBeLessThan(out.indexOf('bootstrapping the launchd fallback'));
    expect(headOf(f.root)).toBe(packaged);
    expect(readFileSync(join(f.stateDir, 'runtime'), 'utf8').trim()).toBe('launchd');
  });

  it('bootstraps launchd anyway when the last good image is not in the tree', async () => {
    const f = await fixture();
    const deployed = headOf(f.root);
    const stranger = 'ab'.repeat(20); // 40 hex characters that this clone never had
    writeFileSync(join(f.stateDir, 'last-good-image'), `book:${stranger}\n`, 'utf8');
    writeFileSync(f.serving, '', 'utf8');
    served(f, deployed); // the tree stays put, so launchd answers the commit it is on

    const { code, out } = await flip(f, ['--to', 'launchd', '--confirm']);
    // A guarded alignment: one log line, no abort, and launchd still comes up.
    expect(code, out).toBe(0);
    const tree = out.split('\n').filter((line) => line.includes('flip: tree:'));
    expect(tree, out).toEqual([expect.stringContaining(`${stranger.slice(0, 7)} from last-good-image is not in ${f.root} — the deploy root stays where it is`)]);
    expect(headOf(f.root)).toBe(deployed);
    expect(callsOf(f).filter((line) => line.startsWith('launchctl bootstrap'))).toHaveLength(3);
    expect(readFileSync(join(f.stateDir, 'runtime'), 'utf8').trim()).toBe('launchd');
  });

  it('does not record runtime=launchd when compose down leaves a container behind', async () => {
    const f = await fixture();
    writeFileSync(join(f.stateDir, 'runtime'), 'compose\n', 'utf8');
    writeFileSync(f.serving, '', 'utf8');
    const { code, out } = await flip(f, ['--to', 'launchd', '--confirm'], { FAKE_LEFTOVER: '1' });
    expect(code, out).toBe(1);
    // A stack that is still up owns 8091: launchd could not bind, and its 200 would be the
    // container's — the flip must refuse to claim the other runtime.
    expect(out).toContain("still has containers after 'compose down'");
    expect(out).toContain('runtime untouched');
    expect(readFileSync(join(f.stateDir, 'runtime'), 'utf8').trim()).toBe('compose');
    // Nothing was loaded: the refusal is before launchd_up.
    expect(callsOf(f).filter((line) => line.startsWith('launchctl enable') || line.startsWith('launchctl bootstrap'))).toEqual([]);
    expect(existsSync(join(f.stateDir, 'deploy.lock'))).toBe(false);
  });
});

describe('a flip that touches nothing', () => {
  it('takes no lock and writes no state on --dry-run, in either direction', async () => {
    const f = await fixture();
    for (const direction of ['compose', 'launchd']) {
      const { code, out } = await flip(f, ['--to', direction, '--dry-run']);
      expect(code, out).toBe(0);
      expect(out, direction).toContain('dry run: would');
      expect(existsSync(join(f.stateDir, 'deploy.lock')), direction).toBe(false);
      expect(existsSync(join(f.stateDir, 'runtime')), direction).toBe(false);
      expect(callsOf(f), direction).toEqual([]);
    }
  });

  it('refuses a flip without --confirm, before touching launchd, docker or the lock', async () => {
    const f = await fixture();
    const { code, out } = await flip(f, ['--to', 'compose']);
    expect(code, out).toBe(1);
    expect(out).toContain('refusing a flip without --confirm');
    expect(existsSync(join(f.stateDir, 'deploy.lock'))).toBe(false);
    expect(callsOf(f)).toEqual([]);
  });

  it('refuses to flip when there is no backup at all, and says which directory it looked in', async () => {
    const f = await fixture();
    rmSync(join(f.backupRoot, 'daily'), { recursive: true, force: true });
    const { code, out } = await flip(f, ['--to', 'compose', '--confirm'], { STUB_EXIT: '0', STUB_HEALTHY: '1' });
    // An absent `daily/` used to abort the flip with no reason at all (a bare `find | sort | tail`
    // under `set -eE` + `pipefail`): the refusal must be the documented sentence.
    expect(code, out).toBe(1);
    expect(out).toContain(`no backup under ${join(f.backupRoot, 'daily')} — run site/deploy/backup.sh first`);
    expect(callsOf(f).filter((line) => line.startsWith('launchctl') || /compose .* down$/u.test(line))).toEqual([]);
    expect(existsSync(join(f.stateDir, 'deploy.lock'))).toBe(false);
    expect(existsSync(join(f.stateDir, 'runtime'))).toBe(false);
  });

  it('refuses to flip on a stale backup, before anything is stopped', async () => {    const f = await fixture();
    // The newest backup is two hours old; the limit is the script's 3600 s default.
    const newest = join(f.backupRoot, 'daily', '2026-10-28');
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
    utimesSync(newest, twoHoursAgo, twoHoursAgo);
    const { code, out } = await flip(f, ['--to', 'compose', '--confirm'], { STUB_EXIT: '0', STUB_HEALTHY: '1' });
    expect(code, out).toBe(1);
    expect(out).toMatch(/the newest backup \(2026-10-28\) is 72\d\ds old \(limit 3600s\) — run site\/deploy\/backup\.sh first/u);
    // A flip changes where the book lives: no backup, no stop, no lock, no runtime change.
    expect(callsOf(f).filter((line) => line.startsWith('launchctl') || /compose .* down$/u.test(line))).toEqual([]);
    expect(existsSync(join(f.stateDir, 'deploy.lock'))).toBe(false);
    expect(existsSync(join(f.stateDir, 'runtime'))).toBe(false);
  });
});
