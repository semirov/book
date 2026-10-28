/**
 * BOOK-183 — `deploy/entrypoint.sh`'s data guard, driven as a real `/bin/sh` process.
 *
 * The guard is the containment for the incident: a macOS host bind mount into OrbStack is two
 * kernels over one SQLite file, and a role that starts on one is the `SQLITE_IOERR_SHORT_READ`
 * waiting to happen. What it reads is `/proc/self/mountinfo`; `BOOK_MOUNTINFO_FILE` exists so these
 * cases feed **measured** lines — the bind and the volume as the box reports them — without Docker.
 *
 * Every host path is assembled from parts, never written literally, the way `dataIsolation.test.ts`
 * assembles its needles: a fixture is a fixture, and a test that spells a real data dir out is one
 * rename from touching it.
 *
 * The guard treats every mount related to DATA_DIR — the mount at that path, an ancestor, and anything
 * mounted UNDER it — and it fails closed: a table it cannot read, or one that covers nothing, is a
 * refusal rather than a pass. Both halves are pinned below, because both are one edit away from
 * "nothing matched, so start".
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ENTRYPOINT = resolve(import.meta.dirname, '..', '..', 'deploy', 'entrypoint.sh');
/** The script's own shebang: the image's `/bin/sh`, not the runner's bash. */
const SH = '/bin/sh';

/** A macOS path as the host exports it — assembled, so this file names no real data dir. */
const HOST_ROOT = ['', 'Users', 'tester', ['book', 'site', 'data'].join('-')].join('/');
/** A named volume's `_data` as OrbStack mounts it: one kernel, `btrfs`, no host path. */
const VOLUME_ROOT = '/docker/volumes/book-data/_data';

const HAS_FLOCK = spawnSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).status === 0;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix = 'book-183-guard-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** One mountinfo(5) line, in the shape the box reports: root and mount point, then ` - ` and fstype. */
function line(root: string, point: string, fstype: string, source: string): string {
  return `1234 1200 0:50 ${root} ${point} rw,relatime - ${fstype} ${source} rw`;
}

/** A mountinfo file holding exactly these lines. */
function mountinfo(lines: string[]): string {
  const file = join(temp(), 'mountinfo');
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

/**
 * The command the entrypoint is asked to run. It only records that it ran, so "refused" is proved
 * by the absence of a file, not by the absence of a message: the guard has to stop before `exec`.
 */
function command(): { script: string; marker: string } {
  const dir = temp('book-183-guard-cmd-');
  const script = join(dir, 'ran.sh');
  const marker = join(dir, 'ran');
  writeFileSync(script, '#!/bin/sh\nprintf "ran\\n" > "$MARKER"\n', { encoding: 'utf8', mode: 0o755 });
  return { script, marker };
}

type Run = { status: number; stdout: string; stderr: string };

/** The entrypoint as the image runs it: the role from the environment, one command to exec. */
function run(env: Record<string, string>, cli = command()): Run & { marker: string } {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ['BOOK_ROLE', 'BOOK_LOCKS_DIR', 'BOOK_MOUNTINFO_FILE', 'DATA_DIR', 'MARKER']) delete base[name];
  const result = spawnSync(SH, [ENTRYPOINT, cli.script], {
    encoding: 'utf8',
    env: { ...base, MARKER: cli.marker, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr, marker: cli.marker };
}

describe('entrypoint.sh — the data guard (BOOK-183)', () => {
  it('refuses a role whose DATA_DIR is a macOS bind mount, with the incident on the line', () => {
    const info = mountinfo([line(HOST_ROOT, '/data', 'virtiofs', 'mac')]);
    const result = run({ BOOK_ROLE: 'site', BOOK_MOUNTINFO_FILE: info });

    expect(result.status).toBe(78);
    for (const needle of [
      'refusing to start site',
      'host bind mount',
      'virtiofs',
      'BOOK-183',
      'book-data',
      'mount point /data',
    ]) {
      expect(result.stderr).toContain(needle);
    }
    // The refusal is one block, and the service never started.
    expect(existsSync(result.marker)).toBe(false);
    expect(result.stdout).not.toContain('holds');
  });

  it('lets a named volume through the guard', () => {
    const info = mountinfo([line(VOLUME_ROOT, '/data', 'btrfs', '/dev/vdb1')]);
    const result = run({ BOOK_ROLE: 'site', BOOK_MOUNTINFO_FILE: info, BOOK_LOCKS_DIR: temp() });

    // Not the data guard's refusal. Without `flock` on this host the lock stage refuses afterwards
    // (exit 75), which is exactly the proof that the guard itself let the volume through.
    expect(result.status).not.toBe(78);
    expect(result.stderr).not.toContain('host bind mount');
  });

  it.skipIf(!HAS_FLOCK)('reaches the single-instance lock and execs the command on a volume', () => {
    const info = mountinfo([line(VOLUME_ROOT, '/data', 'btrfs', '/dev/vdb1')]);
    const locks = temp();
    const result = run({ BOOK_ROLE: 'site', BOOK_MOUNTINFO_FILE: info, BOOK_LOCKS_DIR: locks });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`book: site holds '${join(locks, 'site.lock')}'`);
    // The lock file names the holder, and the command ran.
    expect(readFileSync(join(locks, 'site.lock'), 'utf8')).toMatch(/^\d+ \S+$/mu);
    expect(existsSync(result.marker)).toBe(true);
  });

  it('refuses on a benign fstype whose mount root is a macOS path', () => {
    const info = mountinfo([line(HOST_ROOT, '/data', 'ext4', '/dev/vdb1')]);
    const result = run({ BOOK_ROLE: 'engine', BOOK_MOUNTINFO_FILE: info });

    expect(result.status).toBe(78);
    // The root is the evidence, not the fstype: a host directory can arrive as anything.
    expect(result.stderr).toContain(`mount root ${HOST_ROOT}`);
    expect(existsSync(result.marker)).toBe(false);
  });

  it('resolves DATA_DIR to the longest mount point it sits under', () => {
    // /data is a volume, but /data/sub is a host bind: the path under it is the one that counts.
    const nested = mountinfo([
      line('/', '/', 'ext4', '/dev/vda1'),
      line(VOLUME_ROOT, '/data', 'btrfs', '/dev/vdb1'),
      line(HOST_ROOT, '/data/sub', 'virtiofs', 'mac'),
    ]);
    const refused = run({ BOOK_ROLE: 'writer', DATA_DIR: '/data/sub', BOOK_MOUNTINFO_FILE: nested });
    expect(refused.status).toBe(78);
    expect(refused.stderr).toContain('refusing to start writer');
    expect(refused.stderr).toContain('mount point /data/sub');
    expect(existsSync(refused.marker)).toBe(false);

  });

  it('refuses a host mount ABOVE DATA_DIR: a volume inside a macOS bind is still two kernels', () => {
    // The inverse of the case above: /data is the bind, /data/sub a named volume. A longest-prefix rule
    // alone would pass this — and the container would still be reading a macOS directory (fail-closed).
    const inside = mountinfo([
      line('/', '/', 'ext4', '/dev/vda1'),
      line(HOST_ROOT, '/data', 'virtiofs', 'mac'),
      line('/docker/volumes/sub/_data', '/data/sub', 'btrfs', '/dev/vdb1'),
    ]);
    const refused = run({ BOOK_ROLE: 'writer', DATA_DIR: '/data/sub', BOOK_MOUNTINFO_FILE: inside });
    expect(refused.status).toBe(78);
    expect(refused.stderr).toContain('mount point /data');
    expect(existsSync(refused.marker)).toBe(false);
  });

  it('lets DATA_DIR sit under a volume with no host mount in its chain', () => {
    const info = mountinfo([
      line('/', '/', 'ext4', '/dev/vda1'),
      line(VOLUME_ROOT, '/data', 'btrfs', '/dev/vdb1'),
    ]);
    const allowed = run({ BOOK_ROLE: 'writer', DATA_DIR: '/data/sub', BOOK_MOUNTINFO_FILE: info, BOOK_LOCKS_DIR: temp() });
    expect(allowed.stderr).not.toContain('host bind mount');
    expect(allowed.status).not.toBe(78);
  });

  it('refuses a host FILE bind mounted under DATA_DIR', () => {
    // One file exported from the host is two kernels for that file, and `book.db` is the one that matters.
    const info = mountinfo([
      line(VOLUME_ROOT, '/data', 'btrfs', '/dev/vdb1'),
      line(HOST_ROOT, '/data/book.db', 'virtiofs', 'mac'),
    ]);
    const result = run({ BOOK_ROLE: 'site', BOOK_MOUNTINFO_FILE: info });

    expect(result.status).toBe(78);
    expect(result.stderr).toContain('host bind mount');
    expect(result.stderr).toContain('mount point /data/book.db');
    expect(existsSync(result.marker)).toBe(false);
  });

  it('fails closed when the mount table is empty', () => {
    // A table that covers nothing cannot prove DATA_DIR is a volume: a pass here is a guess.
    const info = mountinfo([]);
    const result = run({ BOOK_ROLE: 'site', BOOK_MOUNTINFO_FILE: info });

    expect(result.status).toBe(78);
    expect(result.stderr).toContain('no mount in');
    expect(result.stderr).toContain('cannot be proven');
    expect(existsSync(result.marker)).toBe(false);
  });

  it.skipIf((process.getuid?.() ?? 0) === 0)('fails closed when the mount table is unreadable', () => {
    const file = join(temp(), 'mountinfo');
    writeFileSync(file, '', 'utf8');
    chmodSync(file, 0o000);
    try {
      const result = run({ BOOK_ROLE: 'site', BOOK_MOUNTINFO_FILE: file });
      expect(result.status).toBe(78);
      expect(result.stderr).toContain('unreadable');
      expect(existsSync(result.marker)).toBe(false);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it('skips both guards when BOOK_ROLE is unset', () => {
    const info = mountinfo([line(HOST_ROOT, '/data', 'virtiofs', 'mac')]);
    const result = run({ BOOK_MOUNTINFO_FILE: info });

    // A one-off `compose run`/`exec` must stay possible without fighting a running service.
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(existsSync(result.marker)).toBe(true);
  });

  it('names the role it refused', () => {
    const info = mountinfo([line(HOST_ROOT, '/data', 'virtiofs', 'mac')]);
    for (const role of ['site', 'engine', 'writer']) {
      const result = run({ BOOK_ROLE: role, BOOK_MOUNTINFO_FILE: info });
      expect(result.status).toBe(78);
      expect(result.stderr).toContain(`book: refusing to start ${role}:`);
    }
  });
});
