/**
 * BOOK-183 — `deploy/backup.sh`, the one backup command the owner and launchd run.
 *
 * The script owns no backup logic: it reads `$STATE_DIR/runtime` and dispatches. Under `compose` the
 * copy is taken inside the container (`exec -T site node /app/bin/backup.mjs`), because two kernels
 * over one `book.db` is the incident; under `launchd` (or with no runtime file at all) the host
 * implementation runs. These cases pin the dispatch, the argv, the log line and the exit code with a
 * fake `docker` on `BOOK_DOCKER` and a stub `backup-host.sh` beside a symlink to the real script —
 * no real backup, no real project, no `/data`.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/** The script is `#!/bin/bash`; the same override `deployHarness.ts` uses. */
const BASH = process.env.BOOK_TEST_BASH ?? '/bin/bash';
const SITE = resolve(import.meta.dirname, '..', '..');
const DEPLOY = join(SITE, 'deploy');

const FAKE_DOCKER = `#!/bin/bash
printf 'docker %s\\n' "$*" >> "$CALLS"
[ -n "\${FAKE_OUT:-}" ] && printf '%s\\n' "$FAKE_OUT"
exit "\${FAKE_EXIT:-0}"
`;

const HOST_STUB = `#!/bin/bash
# BACKUP_ROOT is the launchd implementation's name for the same directory: one dispatch carries it over.
printf 'host %s root=%s\\n' "$*" "\${BACKUP_ROOT:-}" >> "$CALLS"
exit "\${HOST_EXIT:-0}"
`;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

type World = {
  script: string;
  logFile: string;
  backupsDir: string;
  composeFile: string;
  calls: string;
  env: Record<string, string>;
};

/**
 * A throwaway deploy: a symlink to the real `backup.sh` (so `dirname "$0"` is this directory), the
 * host stub beside it, the fake docker, and the `BOOK_*` paths every branch reads.
 */
function world(runtime?: string): World {
  const dir = temp('book-183-backup-');
  const deploy = join(dir, 'deploy');
  const stateDir = join(dir, 'state');
  const backupsDir = join(dir, 'backups');
  const bin = join(dir, 'bin');
  const calls = join(dir, 'calls.log');
  const composeFile = join(dir, 'docker-compose.yml');
  for (const path of [deploy, stateDir, backupsDir, bin]) mkdirSync(path, { recursive: true });
  writeFileSync(composeFile, 'services: {}\n', 'utf8');
  writeFileSync(calls, '', 'utf8');
  if (runtime !== undefined) writeFileSync(join(stateDir, 'runtime'), `${runtime}\n`, 'utf8');
  symlinkSync(join(DEPLOY, 'backup.sh'), join(deploy, 'backup.sh'));
  writeFileSync(join(deploy, 'backup-host.sh'), HOST_STUB, { encoding: 'utf8', mode: 0o755 });
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER, { encoding: 'utf8', mode: 0o755 });

  const logFile = join(dir, 'backup.log');
  return {
    script: join(deploy, 'backup.sh'),
    logFile,
    backupsDir,
    composeFile,
    calls,
    env: {
      BOOK_STATE_DIR: stateDir,
      BOOK_COMPOSE_FILE: composeFile,
      BOOK_BACKUPS_DIR: backupsDir,
      BOOK_DOCKER: join(bin, 'docker'),
      BOOK_PROJECT: 'book-test',
      LOG_FILE: logFile,
      HOME: dir,
      CALLS: calls,
    },
  };
}

type Run = { status: number; stdout: string; stderr: string };

/** The script as launchd and the owner run it: a real process, its own world, nothing ambient. */
function backup(w: World, args: string[], extra: Record<string, string> = {}): Run {
  const base: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const name of Object.keys(base)) if (name.startsWith('BOOK_')) delete base[name];
  const result = spawnSync(BASH, [w.script, ...args], {
    encoding: 'utf8',
    env: { ...base, ...w.env, ...extra },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function calls(w: World): string[] {
  return readFileSync(w.calls, 'utf8').split('\n').filter((line) => line.length > 0);
}

describe('backup.sh (BOOK-183)', () => {
  it('compose: runs the CLI in the container with --out /backups and logs the line', () => {
    const w = world('compose');
    const line = 'book-backup ts=2026-10-28T04:00:00.000Z status=ok dir=/backups/daily/20261028T040000 chapters=18';
    const result = backup(w, [], { FAKE_OUT: line });

    expect(result.status).toBe(0);
    expect(calls(w)).toEqual([
      `docker compose --env-file /dev/null -f ${w.composeFile} -p book-test exec -T site node /app/bin/backup.mjs --out /backups`,
    ]);
    // The child's stdout is the log the launchd job and the owner read afterwards.
    expect(readFileSync(w.logFile, 'utf8')).toBe(`${line}\n`);
  });

  it('compose: passes the exit code through, 1 and 75 alike', () => {
    for (const code of ['1', '75']) {
      const w = world('compose');
      const result = backup(w, [], { FAKE_EXIT: code });
      expect(result.status).toBe(Number(code));
      expect(result.stderr).toContain(`compose exec exited ${code}`);
      // One line, and it is the wrapper's own: the failure is recorded with the code and the runtime,
      // never the container's stdout (that body is the node CLI's, and the caller reads it on stderr).
      const log = readFileSync(w.logFile, 'utf8').trim().split('\n');
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(
        new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z level=error job=book-backup status=fail exit=${code} runtime=compose$`, 'u'),
      );
      expect(log[0]).not.toContain('chapters=');
      expect(calls(w)).toHaveLength(1);
    }
  });

  it('launchd: runs the host implementation, never docker', () => {
    const w = world('launchd');
    const result = backup(w, []);

    expect(result.status).toBe(0);
    expect(calls(w)).toEqual([`host  root=${w.backupsDir}`]);
    expect(calls(w).some((call) => call.startsWith('docker'))).toBe(false);
  });

  it('no runtime file means launchd: a missing file must not skip the nightly backup', () => {
    const w = world();
    const result = backup(w, ['--verify', join(w.backupsDir, 'daily', 'x')]);

    expect(result.status).toBe(0);
    expect(calls(w)).toEqual([`host --verify ${join(w.backupsDir, 'daily', 'x')} root=${w.backupsDir}`]);
  });

  it('refuses a runtime it does not know, before running anything', () => {
    const w = world('systemd');
    const result = backup(w, []);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected compose|launchd');
    expect(calls(w)).toEqual([]);
  });

  it('--verify translates a host path into the container path, and leaves others alone', () => {
    const w = world('compose');
    const inside = join(w.backupsDir, 'daily', '20261028T040000');
    const outside = join(temp('book-183-backup-copy-'), 'copy');

    expect(backup(w, ['--verify', inside]).status).toBe(0);
    expect(backup(w, ['--verify', outside]).status).toBe(0);
    // `--out=/path` is passed through untouched: the runbook's own command names the container path.
    expect(backup(w, ['--out=/backups']).status).toBe(0);

    expect(calls(w)).toEqual([
      `docker compose --env-file /dev/null -f ${w.composeFile} -p book-test exec -T site node /app/bin/backup.mjs --verify /backups/daily/20261028T040000`,
      `docker compose --env-file /dev/null -f ${w.composeFile} -p book-test exec -T site node /app/bin/backup.mjs --verify ${outside}`,
      `docker compose --env-file /dev/null -f ${w.composeFile} -p book-test exec -T site node /app/bin/backup.mjs --out=/backups`,
    ]);
  });

  it('accepts BACKUP_ROOT as the alias of BOOK_BACKUPS_DIR', () => {
    const w = world('compose');
    const inside = join(w.backupsDir, 'daily', '20261028T040000');
    // The launchd scripts and the plist name the directory BACKUP_ROOT; the wrapper reads either.
    const aliased = backup(w, ['--verify', inside], { BOOK_BACKUPS_DIR: '', BACKUP_ROOT: w.backupsDir });
    expect(aliased.status).toBe(0);
    expect(calls(w)).toEqual([
      `docker compose --env-file /dev/null -f ${w.composeFile} -p book-test exec -T site node /app/bin/backup.mjs --verify /backups/daily/20261028T040000`,
    ]);

    // Under launchd the same alias is passed on, so backup-host.sh reads one name.
    const host = world('launchd');
    expect(backup(host, []).status).toBe(0);
    expect(calls(host)).toEqual([`host  root=${host.backupsDir}`]);
  });

  it('--verify without a directory is a usage error', () => {
    const w = world('compose');
    const result = backup(w, ['--verify']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--verify needs a directory');
    expect(calls(w)).toEqual([]);
  });
});
