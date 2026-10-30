import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DoctorReport } from '../../bin/adminDoctor.mjs';

/**
 * BOOK-236 — `site/deploy/admin.sh` and the one tool that does not run in the container.
 *
 * The measured defect: under `runtime=compose` the wrapper exec'd **every** tool into the `site`
 * container, so `admin.sh admin doctor` answered `spawn docker ENOENT` for seven of eight rows —
 * the doctor is a HOST CLI (docker, mountinfo, host backups, the drill log), and the container has
 * no docker. These tests spawn the real script with a real shell and no docker:
 *
 *   * the dry-run shape proves the dispatch (`--print-command`), and fails if the doctor goes back
 *     into the container;
 *   * a `BOOK_DOCKER` stub answers the two calls the doctor path makes, so the published port, the
 *     token that crosses as a file, its removal and the exit code are all read from a real run.
 */

const SITE = resolve(import.meta.dirname, '..', '..');
const REPO = resolve(SITE, '..');
const WRAPPER = join(SITE, 'deploy', 'admin.sh');
const HOST_CLI = join(REPO, 'site', 'bin', 'admin.mjs');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type CliResult = { status: number; stdout: string; stderr: string };
type Tree = { root: string; state: string; tokenTmp: string; home: string };

/** A scratch layout: a state dir holding `runtime`, a private TMPDIR, a HOME of its own. */
function scratch(runtime: string): Tree {
  const root = mkdtempSync(join(tmpdir(), 'book-admin-sh-'));
  dirs.push(root);
  const state = join(root, 'state');
  const tokenTmp = join(root, 'tmp');
  const home = join(root, 'home');
  for (const dir of [state, tokenTmp, home]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(state, 'runtime'), `${runtime}\n`);
  return { root, state, tokenTmp, home };
}

/** The environment a case names and nothing else: no ambient token, no ambient data dir. */
function envFor(tree: Tree, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: tree.home,
    TMPDIR: tree.tokenTmp,
    BOOK_STATE_DIR: tree.state,
    BOOK_PROJECT: 'book-admin-sh-no-such-project',
    ...extra,
  };
}

function runWrapper(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<CliResult> {
  return spawnWrapper(args, env, cwd).done;
}

/** The same spawn, with the child in hand — a signal case has to hold the process it kills. */
function spawnWrapper(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): { child: ChildProcess; done: Promise<CliResult> } {
  const child = spawn('bash', [WRAPPER, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<CliResult>((finish) => {
    child.on('close', (code) => {
      finish({ status: code ?? 1, stdout, stderr });
    });
  });
  return { child, done };
}

/**
 * A stand-in for `docker compose`: it records every call, answers the published port and the
 * container's token, and refuses anything else — so a call the wrapper should not make is a
 * visible failure, not a silent success.
 */
function fakeDocker(
  tree: Tree,
  options: { port: string; token: string; tokenFails?: boolean; tokenDelayS?: number },
): string {
  const script = join(tree.root, 'fake-docker');
  const delay = options.tokenDelayS === undefined ? '' : `sleep ${String(options.tokenDelayS)}; `;
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'printf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"',
      'case "$*" in',
      `  *" port site 8080") printf '%s\\n' '${options.port}' ;;`,
      '  *" cat /data/admin.token")',
      `    if [ "${options.tokenFails === true ? '1' : '0'}" = 1 ]; then printf 'no such file\\n' >&2; exit 1; fi`,
      `    ${delay}printf '%s\\n' '${options.token}' ;;`,
      '  *) printf \'fake docker: unexpected call: %s\\n\' "$*" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return script;
}

/** A port nothing listens on: bound once, then released, so the doctor's fetch is refused at once. */
async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        fail(new Error('no port'));
        return;
      }
      const { port } = address;
      server.close(() => {
        done(port);
      });
    });
  });
}

/* ---------------------------------------------------------------------------- the dispatch -- */

describe('admin.sh under runtime=compose — the doctor runs on the host', () => {
  it('prints the host CLI shape and never the container one', async () => {
    const tree = scratch('compose');
    const result = await runWrapper(['admin', 'doctor'], envFor(tree, { BOOK_ADMIN_SH_DRY_RUN: '1' }), tree.root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    // The shape: the published port is resolved first, then the HOST CLI with a token FILE.
    expect(result.stdout).toContain('port site 8080');
    expect(result.stdout).toContain(`ADMIN_TOKEN_FILE=<token file> node ${HOST_CLI} doctor`);
    expect(result.stdout).toContain('--url http://<published address>');
    expect(result.stdout).toContain('0600 temp file');
    // The defect this fixes: the doctor must not be exec'd into the container again.
    expect(result.stdout).not.toContain('exec -T site');
    expect(result.stdout).not.toContain('/app/bin/admin.mjs doctor');
    // A dry run runs nothing: no docker, no node — and it leaves no token file behind.
    expect(readdirSync(tree.tokenTmp)).toEqual([]);
  });

  it('accepts --print-command among the tool’s arguments and does not forward it', async () => {
    const tree = scratch('compose');
    const result = await runWrapper(['admin', 'doctor', '--print-command', '--json'], envFor(tree), tree.root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`node ${HOST_CLI} doctor --json`);
    expect(result.stdout).not.toContain('--print-command');
  });

  it('reads the sub-command past the flag: `admin --print-command doctor` is the doctor too', async () => {
    // The first cut took the sub-command from `$1`, so this ordering silently dispatched the
    // doctor into the container — the very defect the item fixes.
    const tree = scratch('compose');
    const result = await runWrapper(['admin', '--print-command', 'doctor'], envFor(tree), tree.root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`ADMIN_TOKEN_FILE=<token file> node ${HOST_CLI} doctor`);
    expect(result.stdout).not.toContain('exec -T site');
    expect(result.stdout).not.toContain('/app/bin/admin.mjs');
  });

  it('answers `admin doctor --help` without a stack, a port or a token', async () => {
    const tree = scratch('compose');
    // A docker that cannot be run at all: the help path may not call it.
    const result = await runWrapper(
      ['admin', 'doctor', '--help'],
      envFor(tree, { BOOK_DOCKER: join(tree.root, 'no-such-docker') }),
      tree.root,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('node bin/admin.mjs doctor [--json] [--url <url>]');
    expect(result.stderr).toBe('');
    expect(readdirSync(tree.tokenTmp)).toEqual([]);
  });

  it('leaves the operator’s own target alone: --url and BOOK_ADMIN_URL win over the default', async () => {
    const flagged = scratch('compose');
    const viaFlag = await runWrapper(
      ['admin', 'doctor', '--url', 'http://127.0.0.1:9123'],
      envFor(flagged, { BOOK_ADMIN_SH_DRY_RUN: '1' }),
      flagged.root,
    );
    expect(viaFlag.stdout).toContain('--url http://127.0.0.1:9123');
    expect(viaFlag.stdout).not.toContain('<published address>');

    const variable = scratch('compose');
    const viaEnv = await runWrapper(
      ['admin', 'doctor'],
      envFor(variable, { BOOK_ADMIN_SH_DRY_RUN: '1', BOOK_ADMIN_URL: 'http://127.0.0.1:9124' }),
      variable.root,
    );
    // The CLI reads BOOK_ADMIN_URL itself, so the wrapper adds no second target.
    expect(viaEnv.stdout).not.toContain('--url');
  });

  it('keeps every other tool in the container, reset included', async () => {
    const tree = scratch('compose');
    const result = await runWrapper(['admin', 'reset', 'book'], envFor(tree, { BOOK_ADMIN_SH_DRY_RUN: '1' }), tree.root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`exec -T site node /app/bin/admin.mjs reset book`);
    expect(result.stdout).not.toContain('ADMIN_TOKEN_FILE');
  });

  it('keeps the doctor on the host under runtime=launchd, as it always was', async () => {
    const tree = scratch('launchd');
    const result = await runWrapper(['admin', 'doctor', '--json'], envFor(tree, { BOOK_ADMIN_SH_DRY_RUN: '1' }), tree.root);

    expect(result.status).toBe(0);
    // The host branch exports the prod host data dir and runs the tree's own CLI — no token file.
    expect(result.stdout).toMatch(/DATA_DIR=\S+ node /u);
    expect(result.stdout).toContain(`node ${HOST_CLI} doctor --json`);
    expect(result.stdout).not.toContain('ADMIN_TOKEN_FILE');
  });
});

/* ------------------------------------------------------------------------- the real dispatch -- */

describe('admin.sh under runtime=compose — the token crosses as a file, never as an argument', () => {
  it('resolves the published port, hands the CLI a temp token file and passes its exit code through', async () => {
    const port = await freePort();
    const tree = scratch('compose');
    const log = join(tree.root, 'docker.log');
    const token = 'wrapper-token-2f7d';
    const docker = fakeDocker(tree, { port: `0.0.0.0:${String(port)}`, token });

    const result = await runWrapper(
      ['admin', 'doctor', '--json'],
      envFor(tree, { BOOK_DOCKER: docker, FAKE_DOCKER_LOG: log }),
      tree.root,
    );

    // docker answered `0.0.0.0:<port>`; the wrapper read the wildcard as loopback, the CLI reached
    // a closed port and said `not ready` — its own exit 1, passed through untouched.
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.exitCode).toBe(1);
    expect(report.checks.map((check) => check.id)).toContain('graph');
    const schema = report.checks.find((check) => check.id === 'schema');
    expect(schema?.evidence).toContain(`http://127.0.0.1:${String(port)}`);
    // Nothing printed carries the token, in either stream.
    expect(`${result.stdout}${result.stderr}`).not.toContain(token);

    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.some((call) => call.endsWith(' port site 8080'))).toBe(true);
    expect(calls.some((call) => call.includes('exec -T site sh -c cat /data/admin.token'))).toBe(true);
    expect(calls.some((call) => call.includes('/app/bin/admin.mjs'))).toBe(false);
    // The temp file left with the process, on the success path as on every other.
    expect(readdirSync(tree.tokenTmp)).toEqual([]);
  });

  it('exits 3 with one line naming the path when the token cannot be read, and prints no value', async () => {
    const tree = scratch('compose');
    const log = join(tree.root, 'docker.log');
    const docker = fakeDocker(tree, { port: '0.0.0.0:8091', token: 'never-printed', tokenFails: true });

    const result = await runWrapper(
      ['admin', 'doctor'],
      envFor(tree, { BOOK_DOCKER: docker, FAKE_DOCKER_LOG: log }),
      tree.root,
    );

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('/data/admin.token');
    expect(result.stderr).not.toContain('never-printed');
    expect(readdirSync(tree.tokenTmp)).toEqual([]);
  });

  it('exits 1 with one line when the site port is not published', async () => {
    const tree = scratch('compose');
    const log = join(tree.root, 'docker.log');
    const docker = fakeDocker(tree, { port: '', token: 'unused' });

    const result = await runWrapper(
      ['admin', 'doctor'],
      envFor(tree, { BOOK_DOCKER: docker, FAKE_DOCKER_LOG: log }),
      tree.root,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('no port 8080');
  });

  it('treats an empty token as no token: exit 3, the path named, nothing run', async () => {
    const tree = scratch('compose');
    const log = join(tree.root, 'docker.log');
    const docker = fakeDocker(tree, { port: '0.0.0.0:8091', token: '' });

    const result = await runWrapper(
      ['admin', 'doctor'],
      envFor(tree, { BOOK_DOCKER: docker, FAKE_DOCKER_LOG: log }),
      tree.root,
    );

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('empty token');
    expect(result.stderr).toContain('/data/admin.token');
    expect(readdirSync(tree.tokenTmp)).toEqual([]);
  });

  it('deletes the token file when HUP ends the run, and stops with 130', async () => {
    // The first cut trapped EXIT/INT/TERM only: a signal without its own trap ended the run by the
    // signal (129), and the four signals that mean «stop now» did not agree on one exit code. The
    // trap now cleans and exits 130 for INT/TERM/HUP/QUIT alike.
    const tree = scratch('compose');
    const log = join(tree.root, 'docker.log');
    const docker = fakeDocker(tree, { port: '0.0.0.0:8099', token: 'signal-token', tokenDelayS: 2 });
    const { child, done } = spawnWrapper(
      ['admin', 'doctor'],
      envFor(tree, { BOOK_DOCKER: docker, FAKE_DOCKER_LOG: log }),
      tree.root,
    );

    const deadline = Date.now() + 5_000;
    while (readdirSync(tree.tokenTmp).length === 0 && Date.now() < deadline) {
      await new Promise((settle) => setTimeout(settle, 25));
    }
    // The file is there while the token is being read — that is the window a signal opens.
    expect(readdirSync(tree.tokenTmp)).toHaveLength(1);

    child.kill('SIGHUP');
    const result = await done;

    expect(result.status).toBe(130);
    expect(readdirSync(tree.tokenTmp)).toEqual([]);
  }, 30_000);
});
