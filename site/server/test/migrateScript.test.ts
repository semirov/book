/**
 * BOOK-183 — `deploy/migrate-to-volume.sh`: the one-way move of the book's state from a host data
 * dir into a named volume.
 *
 * The script stops prod, copies, verifies and starts prod again, so what these cases pin is the order
 * and the refusals, driven for real: the script and its `lib.sh`, a `compose-release.sh` stub, fake
 * `docker`/`sqlite3`/`launchctl`, and a real `/api/state` on a temp port. The world is
 * `migrateHarness.ts`; this file is the assertions.
 *
 * What is pinned: the exit codes (2/3/4/1), the order stop → copy → verify → release → runtime →
 * archive, the three failure states the message must tell apart (nothing stopped / stopped / released),
 * the `--force` refusals, the `versions/` proof, and the one-shot's "drop the journals before the copy".
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  at,
  calls,
  closeAll,
  COUNTS,
  migrate,
  MOVED,
  stateServer,
  temp,
  untouched,
  world,
} from './migrateHarness.ts';

vi.setConfig({ testTimeout: 30_000 });

afterEach(closeAll);

let port = 0;
let closeApi: () => Promise<void> = () => Promise.resolve();

beforeAll(async () => {
  const api = await stateServer();
  port = api.port;
  closeApi = api.close;
});

afterAll(async () => {
  await closeApi();
});

describe('migrate-to-volume.sh (BOOK-183)', () => {
  it('refuses an unknown argument with 2', async () => {
    const w = world(port);
    const result = await migrate(w, ['--nope']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown argument --nope');
    expect(calls(w)).toEqual([]);
  });

  it('refuses with 3 while another deploy holds the lock, and touches nothing', async () => {
    const w = world(port);
    const lock = join(w.stateDir, 'deploy.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), `${String(process.pid)}\n`, 'utf8');
    writeFileSync(join(lock, 'since'), `${String(Math.floor(Date.now() / 1000))}\n`, 'utf8');

    const result = await migrate(w, ['--confirm'], { FAKE_VOLUME_MISSING: '1' });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('another deploy is running');
    expect(calls(w).some((line) => line.startsWith('docker run'))).toBe(false);
    untouched(w);
  });

  it('--dry-run prints the plan and takes nothing (the lock stays free)', async () => {
    const w = world(port);
    const result = await migrate(w, ['--dry-run'], { FAKE_VOLUME_MISSING: '1' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry run: source');
    expect(result.stdout).toContain('pre-volume-<ts>');
    expect(at(w, 'volume inspect')).toBeGreaterThan(-1);
    untouched(w);
    expect(existsSync(join(w.stateDir, 'deploy.lock'))).toBe(false);
  });

  it('refuses a source without book.db, before any docker call', async () => {
    const w = world(port, { db: false });
    const result = await migrate(w, ['--confirm']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('has no book.db');
    expect(result.stderr).toContain('migrate: FAILED at preflight');
    expect(calls(w)).toEqual([]);
  });

  it('refuses while a running container mounts the source, and stops nothing', async () => {
    const w = world(port);
    const result = await migrate(w, ['--confirm'], { FAKE_MOUNTING: '1', FAKE_MOUNT_SOURCE: w.from });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('never kills a live holder');
    expect(result.stderr).toContain(w.from);
    untouched(w);
  });

  it('refuses a volume that already holds book.db unless --force', async () => {
    const w = world(port);
    const result = await migrate(w, ['--confirm'], { FAKE_VOLUME_DB: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already contains book.db');
    untouched(w);
  });

  it('--seed-only --confirm: stop, down, one copy, then the in-container verification', async () => {
    const w = world(port);
    // A decoy `book-data` in the CWD: the one-shot copy names a VOLUME, so the fake must write into
    // its own volume root, not into whatever directory happens to share the name here.
    const cwd = temp('book-183-migrate-cwd-');
    mkdirSync(join(cwd, 'book-data'), { recursive: true });
    const result = await migrate(w, ['--seed-only', '--confirm'], { FAKE_VOLUME_MISSING: '1' }, cwd);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('seed only: volume book-data is seeded and verified');
    const stop = at(w, ' stop');
    const down = at(w, ' down');
    const copy = at(w, 'cp -a /from/.');
    const verify = at(w, 'integrity_check');
    const hostRead = at(w, 'sqlite3 -readonly');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(down);
    expect(down).toBeLessThan(copy);
    expect(copy).toBeLessThan(verify);
    expect(verify).toBeLessThan(hostRead);
    // No release: `--seed-only` returns after the verification and says so.
    expect(calls(w).some((line) => line.startsWith('release'))).toBe(false);
    // The copy really went into the volume the fake docker holds, and the lock was released.
    expect(existsSync(join(w.volumeDir, 'book.db'))).toBe(true);
    expect(readdirSync(join(cwd, 'book-data'))).toEqual([]);
    // A journal left in the destination by an earlier open would be overlaid onto the incoming pages, so
    // the one-shot script removes it BEFORE `cp -a` — the order inside its argv is the safety property.
    // The `-c` payload contains newlines, so this is read across the whole log, not line by line.
    const log = readFileSync(w.calls, 'utf8');
    const removed = log.indexOf('rm -f /to/book.db-wal');
    expect(removed).toBeGreaterThan(-1);
    expect(removed).toBeLessThan(log.indexOf('cp -a /from/.'));
    expect(existsSync(join(w.stateDir, 'deploy.lock'))).toBe(false);
  });

  it('refuses when the volume and the host copy disagree, and leaves the host dir alone', async () => {
    const w = world(port);
    const result = await migrate(w, ['--seed-only'], {
      FAKE_VOLUME_MISSING: '1',
      FAKE_COUNTS_VOLUME: COUNTS,
      FAKE_COUNTS_HOST: COUNTS.replace('chapters=5', 'chapters=4'),
    });

    expect(result.status).toBe(1);
    // Both sides are printed, so the operator sees which one is short.
    expect(result.stdout).toContain(COUNTS);
    expect(result.stdout).toContain('host:   chapters=4');
    expect(result.stderr).toContain('the row counts differ between the volume and the host copy');
    // Stopped, not released: exactly one recovery line, and the host copy is where it was.
    expect(result.stderr.match(/recovery:/gu) ?? []).toHaveLength(1);
    expect(existsSync(join(w.from, 'book.db'))).toBe(true);
    expect(readdirSync(w.backupRoot)).toEqual([]);
  });

  it('refuses a copy that does not pass integrity_check', async () => {
    const w = world(port);
    const result = await migrate(w, ['--seed-only'], { FAKE_VOLUME_MISSING: '1', FAKE_INTEGRITY: 'bad' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not pass integrity_check');
    expect(existsSync(join(w.from, 'book.db'))).toBe(true);
    expect(readdirSync(w.backupRoot)).toEqual([]);
  });

  it('--force refuses the serving volume by name', async () => {
    const w = world(port);
    const result = await migrate(w, ['--force', '--confirm'], { FAKE_VOLUME_DB: '1' });

    expect(result.status).toBe(1);
    // Overwriting the live store is not a migration, whatever the flag says.
    expect(result.stderr).toContain('--force refuses the serving volume book-data');
    untouched(w);
  });

  it('--force without --confirm is a usage error', async () => {
    const w = world(port);
    const result = await migrate(w, ['--force'], { FAKE_VOLUME_DB: '1' });

    expect(result.status).toBe(2);
    // The `--confirm` gate speaks first (it is above the --force checks), and says what the run needs.
    expect(result.stderr).toContain('refusing a full migration without --confirm');
    untouched(w);
  });

  it('--seed-only --force without --confirm is refused with its own reason', async () => {
    const w = world(port);
    const result = await migrate(w, ['--seed-only', '--force'], { FAKE_VOLUME_DB: '1' });

    expect(result.status).toBe(2);
    // A bare `--seed-only --force` must not slip past the confirmation a full run needs.
    expect(result.stderr).toContain('refusing --seed-only --force without --confirm');
    untouched(w);
  });

  it('--force refuses a volume that does not hold the same rows as the host copy', async () => {
    const w = world(port);
    const result = await migrate(w, ['--volume', 'fresh-volume', '--force', '--confirm'], {
      FAKE_VOLUME_DB: '1',
      FAKE_COUNTS_VOLUME: COUNTS.replace('chapters=5', 'chapters=7'),
      FAKE_COUNTS_HOST: COUNTS,
    });

    expect(result.status).toBe(1);
    // Any difference on any table is a refusal: a partial seed cannot be told from a newer store by
    // counting, so the operator removes the volume instead of overwriting it.
    expect(result.stderr).toContain('do not hold the same rows');
    expect(result.stderr).toContain('docker volume rm fresh-volume');
    expect(result.stdout).toContain('volume fresh-volume: chapters=7');
    expect(result.stdout).toContain('host ');
    expect(result.stdout).toContain('chapters=5');
    untouched(w);
  });

  it('a refused launchctl disable is exit 4', async () => {
    const w = world(port);
    const result = await migrate(w, ['--confirm'], { FAKE_VOLUME_MISSING: '1', FAKE_DISABLE_REFUSE: 'dev.book-site' });
    expect(result.status).toBe(4);
  });

  it('a refused launchctl disable still records runtime=compose and names the job', async () => {
    const w = world(port);
    const result = await migrate(w, ['--confirm'], { FAKE_VOLUME_MISSING: '1', FAKE_DISABLE_REFUSE: 'dev.book-site' });

    // Green containers are worth keeping: the exit code says "migration done, one command left". The
    // runtime is the recorded one, and the operator is told which job is still enabled and what to run.
    expect(readFileSync(join(w.stateDir, 'runtime'), 'utf8').trim()).toBe('compose');
    expect(result.stdout).toContain('could not be disabled');
    const domain = `gui/${String(process.getuid?.() ?? 0)}`;
    // All three were attempted, so one refusal does not leave the other two enabled.
    expect(calls(w).filter((line) => line.startsWith('launchctl disable'))).toEqual([
      `launchctl disable ${domain}/dev.book-site`,
      `launchctl disable ${domain}/dev.book-engine`,
      `launchctl disable ${domain}/dev.book-writer`,
    ]);
    expect(result.stdout).toContain(`launchctl disable ${domain}/dev.book-site`);
    // The run stops before the archive step: prod is on the volume, the host copy has not moved.
    expect(existsSync(join(w.from, 'book.db'))).toBe(true);
    expect(readdirSync(w.backupRoot).filter((name) => name.startsWith('pre-volume-'))).toEqual([]);
  });

  it('refuses to move the host copy when versions/ did not come over whole', async () => {
    const w = world(port);
    mkdirSync(join(w.from, 'versions', 'ch01'), { recursive: true });
    writeFileSync(join(w.from, 'versions', 'ch01', 'rev1.md'), 'a', 'utf8');
    writeFileSync(join(w.from, 'versions', 'ch01', 'rev2.md'), 'b', 'utf8');
    const result = await migrate(w, ['--confirm'], { FAKE_VOLUME_MISSING: '1', FAKE_VOLUME_VERSIONS: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('holds 1 versions/ files, the host dir has 2');
    // Released already: the message must say prod is UP and that restarting it would be a second outage.
    expect(result.stderr).toContain('prod is UP');
    expect(result.stderr).toContain('do NOT restart');
    expect(result.stderr).not.toContain('recovery:');
    expect(existsSync(join(w.from, 'book.db'))).toBe(true);
    expect(readdirSync(w.backupRoot).filter((name) => name.startsWith('pre-volume-'))).toEqual([]);
  });

  it('full mode green: release, /api/state, and the host dir moves into a pre-volume archive', async () => {
    const w = world(port);
    const result = await migrate(w, ['--confirm'], { FAKE_VOLUME_MISSING: '1' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('migrated: prod serves from volume book-data');
    expect(at(w, 'release --ref main inherited=1')).toBeGreaterThan(-1);
    expect(at(w, 'release --ref main inherited=1')).toBeLessThan(at(w, 'written'));
    // The host copy is moved, never deleted: it is the backup the run leaves behind.
    const archives = readdirSync(w.backupRoot).filter((name) => name.startsWith('pre-volume-'));
    expect(archives).toHaveLength(1);
    const moved = join(w.backupRoot, archives[0] ?? '', MOVED);
    expect(existsSync(join(moved, 'book.db'))).toBe(true);
    expect(existsSync(join(moved, 'admin.token'))).toBe(true);
    expect(existsSync(w.from)).toBe(false);
    // A box whose runtime still says launchd sends backup/admin to the host path this run moved away.
    expect(readFileSync(join(w.stateDir, 'runtime'), 'utf8').trim()).toBe('compose');
    // And an enabled job would let a deploy resurrect launchd on 8091 behind the containers.
    const domain = `gui/${String(process.getuid?.() ?? 0)}`;
    expect(calls(w).filter((line) => line.startsWith('launchctl disable'))).toEqual([
      `launchctl disable ${domain}/dev.book-site`,
      `launchctl disable ${domain}/dev.book-engine`,
      `launchctl disable ${domain}/dev.book-writer`,
    ]);
    // The runtime is written before the archive move: prod is already serving on the volume by then.
    expect(result.stdout.indexOf('runtime=compose recorded')).toBeGreaterThan(-1);
    expect(result.stdout.indexOf('runtime=compose recorded')).toBeLessThan(result.stdout.indexOf('pre-volume-'));
  });

  it('full mode red release: exit 1, the host dir untouched, one recovery line', async () => {
    const w = world(port);
    const result = await migrate(w, ['--confirm'], { FAKE_VOLUME_MISSING: '1', STUB_RELEASE_EXIT: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('compose-release.sh exited 1');
    expect(result.stderr.match(/recovery:/gu) ?? []).toHaveLength(1);
    expect(result.stderr).toContain('the stack is DOWN');
    // The volume keeps the verified copy; the host dir is where it was, and nothing was archivable.
    expect(existsSync(join(w.volumeDir, 'book.db'))).toBe(true);
    expect(existsSync(join(w.from, 'book.db'))).toBe(true);
    expect(readdirSync(w.backupRoot).filter((name) => name.startsWith('pre-volume-'))).toEqual([]);
  });
});
