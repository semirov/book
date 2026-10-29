/**
 * BOOK-217/BOOK-232 — the rollback drill: a failed release whose new image already migrated the volume.
 *
 * The incident: `a424300` booted, migrated the volume to v30, failed its home gate, and the deploy
 * rolled the IMAGE back to a v29 build that could not open it (`SCHEMA_FUTURE`). One property per
 * case, each driven as the workflow drives it (a fake `docker` on PATH, a real HTTP site, a real
 * `curl`): the gate runs BEFORE the first `up`; the recovery is one of four lines and a dump restore
 * comes only after the stack is STOPPED; a migrating run leaves a record for the operator; a writer
 * stopped for the cutover is started again when the run refuses; and a crash loop that grew under
 * this run is reported by the run. The volume is a real directory, so "the dump went over book.db" is
 * a file assertion, not a log line.
 *
 * BOOK-232 changed the FACT the recovery is decided on: the volume's own `user_version` against the
 * schema of the image a rollback would put back (`FAKE_VOLUME_SCHEMA`, and a rollback target that is
 * a REAL commit carrying `SCHEMA_VERSION` — an unidentifiable sha is `unknown`, and unknown refuses).
 * The dump listing now only NAMES this run's pre-migration copy, the thing a `dump-restore` puts back.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closeAll,
  commitSchema,
  envFor,
  fakeDocker,
  gitRoot,
  release,
  secretsWithClientId,
  serveSite,
  sha,
  temp,
  volumeFixture,
} from './composeReleaseHarness.ts';

vi.setConfig({ testTimeout: 90_000 });

afterEach(closeAll);

/** The sentence both runtimes print when the volume holds what it may not. */
const HOME_FAILED =
  'the volume holds something it may not (every path above is named) — run bin/home-migrate.mjs --apply once';

/** The dump the fake boot writes under `FAKE_MIGRATE_ON_UP=1`. */
const DUMP = 'pre-v29-20261029T085300Z.db';

/** BOOK-232: the fact a recovery is decided on, in words — two version numbers, nothing else. */
const versions = (tag: string, db: number, target: number): string =>
  `the volume is at schema v${String(db)} and ${tag} understands v${String(target)}`;

const lines = (text: string, needle: string): string[] => text.split('\n').filter((line) => line.includes(needle));

const ups = (log: string): string[] => lines(log, 'up -d');

/** One drill's fixtures: a clone, a state dir, the fake `docker` on PATH and a volume. */
function drill(): { root: string; stateDir: string; bin: string; volume: string } {
  const stateDir = temp('book-217-state-');
  return { root: gitRoot(), stateDir, bin: fakeDocker(stateDir), volume: volumeFixture() };
}

/**
 * BOOK-232: prod before this release — the running image and the last good one both name a REAL
 * commit of the clone that understands v29, so the guard can read both numbers from `git show`. The
 * history a fixture builds is `… → v29 → (v30)`, which is all the guard asks of a commit.
 */
function previous(root: string): string {
  return `book:${commitSchema(root, 29)}`;
}

/**
 * BOOK-232: a release that changes packaging only — a second commit on the SAME schema, so "the boot
 * ran no DDL" is true of a real tree (`git commit --allow-empty`) and not a story the fixture tells.
 */
function packagingRelease(root: string): void {
  execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'packaging']);
}

function serving(stateDir: string, tag: string): void {
  writeFileSync(join(stateDir, 'current'), tag, 'utf8');
  writeFileSync(join(stateDir, 'last-good-image'), `${tag}\n`, 'utf8');
}

/** A site where each image answers its own commit. */
const answering = (stateDir: string): Promise<string> =>
  serveSite(stateDir, {
    healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) } }),
  });

describe('BOOK-217: the volume gate runs before the boot', () => {
  it('a stray path stops the deploy with the current stack still serving: exit 1, no up, no DDL', async () => {
    const { root, stateDir, bin, volume } = drill();
    const prev = previous(root);
    // The shape the home gate exists for: a file `home-migrate --apply` does not fold away.
    writeFileSync(join(volume, 'notes.txt'), 'scratch', 'utf8');
    const siteUrl = await serveSite(stateDir, {
      healthz: () => ({ status: 200, body: { ok: true, commit: '0123456' } }),
    });
    serving(stateDir, prev);
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      FAKE_VOLUME_DIR: volume,
      FAKE_RUNNING_IMAGE: prev,
    });

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('/data/notes.txt');
    expect(result.out).toContain(HOME_FAILED);
    expect(result.out).toContain('the deploy stopped before any DDL: nothing was started and nothing was migrated');
    expect(result.out).toContain('home: stopped the old writer');
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    // Nothing was started: no `up`, so no rollback and no recovery line from a failure before the boot.
    expect(ups(log)).toHaveLength(0);
    expect(result.out).not.toContain('recovery:');
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(prev);
    // The volume is exactly as it was: no DDL, and the gate itself is a read plus a dry fold.
    expect(readFileSync(join(volume, '.book-volume'), 'utf8')).toContain('schema=29');
    expect(existsSync(join(volume, 'book.db-wal'))).toBe(false);
  });

  // The writer is `restart: unless-stopped`, so the cutover's `dc stop` is not undone by the engine:
  // without the EXIT trap the site keeps a green `/healthz` while nothing writes, until a deploy.
  it('a refusal starts the writer it stopped, after the stop', async () => {
    const { root, stateDir, bin, volume } = drill();
    const prev = previous(root);
    writeFileSync(join(volume, 'notes.txt'), 'scratch', 'utf8');
    const siteUrl = await serveSite(stateDir, {
      healthz: () => ({ status: 200, body: { ok: true, commit: '0123456' } }),
    });
    serving(stateDir, prev);
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      FAKE_VOLUME_DIR: volume,
      FAKE_RUNNING_IMAGE: prev,
    });

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('home: the writer is started again');
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    expect(log).toMatch(/stop writer[\s\S]*start writer/u);
    expect(ups(log), result.out).toHaveLength(0);
  });
});

describe('BOOK-217: the recovery is decided from the dump the boot wrote', () => {
  it('migrated and the new image never serves: stop first, then the dump, then the previous image', async () => {
    const { root, stateDir, bin, volume } = drill();
    const prev = previous(root);
    // The deployed image names v30: the volume it boots on is past the v29 image the swap goes to.
    commitSchema(root, 30);
    const next = `book:${sha(root)}`;
    // The new image boots but never answers its own commit; the previous one answers its own.
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({
        status: 200,
        body: { ok: true, commit: current === next ? 'deadbee' : current.split(':')[1]?.slice(0, 7) },
      }),
    });
    serving(stateDir, prev);
    // The sidecar shape of the incident: a WAL and its SHM beside the database a restore replaces.
    writeFileSync(join(volume, 'book.db-wal'), 'wal', 'utf8');
    writeFileSync(join(volume, 'book.db-shm'), 'shm', 'utf8');
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      FAKE_VOLUME_DIR: volume,
      FAKE_RUNNING_IMAGE: prev,
      FAKE_MIGRATE_ON_UP: '1',
      FAKE_VOLUME_SCHEMA: '30',
    });

    expect(result.code, result.out).toBe(1);
    // The fact was read from the volume, not guessed: one listing before, one after.
    expect(result.out).toContain('migration: before up — 0 dump(s) in backups/');
    expect(result.out).toContain(`migration: the boot dumped v29 before migrating (backups/${DUMP})`);
    const recovery = lines(result.out, 'recovery:');
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain('recovery: dump-restore');
    expect(recovery[0]).toContain(versions(prev, 30, 29));
    // The exact dump is over book.db, WAL/SHM are gone, the dump stays, no temp file is left.
    expect(readFileSync(join(volume, 'book.db'), 'utf8')).toContain('DUMP v29 20261029T085300Z');
    expect(existsSync(join(volume, 'book.db-wal'))).toBe(false);
    expect(existsSync(join(volume, 'book.db-shm'))).toBe(false);
    expect(existsSync(join(volume, 'backups', DUMP))).toBe(true);
    expect(existsSync(join(volume, 'book.db.restoring'))).toBe(false);
    expect(existsSync(join(volume, 'backups', '.book.db.restoring'))).toBe(false);
    // The migration was recorded for `--rollback`, and the restore cleared it (old schema again).
    expect(result.out).toContain('volume-migrated: recorded schema=30');
    expect(existsSync(join(stateDir, 'volume-migrated'))).toBe(false);
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    // THE ORDER: the stack is stopped, then the dump is copied, then the previous image's `up`.
    const stopped = log.indexOf(' stop site engine writer');
    const copied = log.indexOf(`cp /data/backups/${DUMP} /data/backups/.book.db.restoring`);
    const started = ups(log);
    const secondUp = log.indexOf(started[1] ?? 'never');
    expect(stopped, log).toBeGreaterThan(0);
    expect(copied, log).toBeGreaterThan(stopped);
    expect(secondUp, log).toBeGreaterThan(copied);
    expect(started, result.out).toHaveLength(2);
    expect(started[0]).toContain(`BOOK_IMAGE_TAG=${next}`);
    expect(started[1]).toContain(`BOOK_IMAGE_TAG=${prev}`);
    expect(result.out).toContain('back on');
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(prev);
    expect(readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8')).toContain('recovery=dump-restore');
    // And prod really is serving again: a 200 within the window, from a real server.
    const health = await fetch(`${siteUrl}/healthz`);
    expect(health.status, result.out).toBe(200);
  });

  it('migrated and the new image serves: roll-forward, one up, no image swap, exit 1', async () => {
    const { root, stateDir, bin, volume } = drill();
    const prev = previous(root);
    commitSchema(root, 30);
    const next = `book:${sha(root)}`;
    // Both health gates are green; the red comes from a smoke (BOOK-205's sign-in read).
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) } }),
      signin: { status: 503 },
    });
    serving(stateDir, prev);
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      BOOK_SECRETS_DIR: secretsWithClientId(),
      FAKE_VOLUME_DIR: volume,
      FAKE_RUNNING_IMAGE: prev,
      FAKE_MIGRATE_ON_UP: '1',
      FAKE_VOLUME_SCHEMA: '30',
    });

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('sign-in is off although the host carries the client id');
    const recovery = lines(result.out, 'recovery:');
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain('recovery: roll-forward');
    expect(recovery[0]).toContain(versions(prev, 30, 29));
    // Only ONE `up -d`, carrying the new tag: no image swap, no second restart, no dump.
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    const started = ups(log);
    expect(started, result.out).toHaveLength(1);
    expect(started[0]).toContain(`BOOK_IMAGE_TAG=${next}`);
    expect(result.out).not.toContain('rollback:');
    // The `up` brought the writer back, so the flag that would start it a second time is cleared.
    expect(result.out).not.toContain('home: the writer is started again');
    expect(readFileSync(join(volume, 'book.db'), 'utf8')).toContain('BOOK-DB-v29');
    // Not green: last-good names what served before, and the migration is on the record.
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(prev);
    expect(readFileSync(join(stateDir, 'volume-migrated'), 'utf8')).toBe('schema=30\n');
    expect(readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8')).toContain('recovery=roll-forward');
    const health = await fetch(`${siteUrl}/healthz`);
    expect(health.status, result.out).toBe(200);
  });

  it('a decisive up failure whose new image answers is a roll-forward, not a dump restore', async () => {
    const { root, stateDir, bin, volume } = drill();
    const prev = previous(root);
    commitSchema(root, 30);
    const next = `book:${sha(root)}`;
    // A container restarted inside `up -d --wait` (what the wait trips on): `up` exited non-zero.
    const siteUrl = await answering(stateDir);
    serving(stateDir, prev);
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      FAKE_VOLUME_DIR: volume,
      FAKE_RUNNING_IMAGE: prev,
      FAKE_MIGRATE_ON_UP: '1',
      FAKE_UP_FAIL_ONCE: '1',
      FAKE_VOLUME_SCHEMA: '30',
    });

    expect(result.code, result.out).toBe(1);
    // No window ran, so the plain read is what says the new image answers — not a dump restore.
    expect(result.out).toContain('compose up exited 1');
    expect(result.out).toContain('plain read: prod reports');
    const recovery = lines(result.out, 'recovery:');
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain('recovery: roll-forward');
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    // One `up`, with the new tag: no stack stop, no restore over book.db, no image swap.
    const started = ups(log);
    expect(started, result.out).toHaveLength(1);
    expect(started[0]).toContain(`BOOK_IMAGE_TAG=${next}`);
    expect(log).not.toContain('stop site engine writer');
    expect(log).not.toContain('cp /data/backups/');
    expect(readFileSync(join(volume, 'book.db'), 'utf8')).toBe('BOOK-DB-v29\n');
    // The volume really moved, so the record stands and `last-good` still names the old image.
    expect(readFileSync(join(stateDir, 'volume-migrated'), 'utf8')).toBe('schema=30\n');
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(prev);
    const health = await fetch(`${siteUrl}/healthz`);
    expect(health.status, result.out).toBe(200);
  });

  it('the fact cannot be read (the after-listing fails): recovery none, no swap, no restore', async () => {
    const { root, stateDir, bin, volume } = drill();
    const prev = previous(root);
    const next = `book:${sha(root)}`;
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({
        status: 200,
        body: { ok: true, commit: current === next ? 'deadbee' : current.split(':')[1]?.slice(0, 7) },
      }),
    });
    serving(stateDir, prev);
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      FAKE_VOLUME_DIR: volume,
      FAKE_RUNNING_IMAGE: prev,
      FAKE_MIGRATE_ON_UP: '1',
      FAKE_VOLUME_SCHEMA: '30',
      // The dump IS written; the after-listing fails, so this run cannot say WHICH backup is its own.
      // BOOK-232: the schema still proves the volume moved, and that is exactly why nothing may be
      // restored from a listing that failed — "the newest file there" is somebody else's copy.
      FAKE_DUMPS_FAIL: 'after',
    });

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('migration: the listing of backups/ after up failed, so this run\'s own dump cannot be named');
    const recovery = lines(result.out, 'recovery:');
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain('recovery: none');
    expect(recovery[0]).toContain('no pre-deploy dump was named this run');
    expect(recovery[0]).toContain('nothing was rolled back and nothing was restored, a human must look');
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    // ONE up (the new tag), no stop, no restore, and the book was not replaced.
    expect(ups(log), result.out).toHaveLength(1);
    expect(log).not.toContain('stop site engine writer');
    expect(log).not.toContain('cp /data/backups/');
    expect(readFileSync(join(volume, 'book.db'), 'utf8')).toBe('BOOK-DB-v29\n');
    expect(readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8')).toContain('recovery=none');
  });

  it('the stack cannot be stopped: the dump is not put back and the reason is named', async () => {
    const { root, stateDir, bin, volume } = drill();
    const prev = previous(root);
    const next = `book:${sha(root)}`;
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({
        status: 200,
        body: { ok: true, commit: current === next ? 'deadbee' : current.split(':')[1]?.slice(0, 7) },
      }),
    });
    serving(stateDir, prev);
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      FAKE_VOLUME_DIR: volume,
      FAKE_RUNNING_IMAGE: prev,
      FAKE_MIGRATE_ON_UP: '1',
      FAKE_VOLUME_SCHEMA: '30',
      FAKE_STOP_FAIL: '1',
    });

    expect(result.code, result.out).toBe(1);
    // The pre-up stop failed too, said and continued — only the restore's stop is decisive.
    expect(result.out).toContain('home: the old writer could not be stopped — continuing; the post-up home-check is the net');
    expect(result.out).not.toContain('home: the writer is started again');
    expect(result.out).toContain('the stack could not be stopped, so book.db was not replaced');
    const recovery = lines(result.out, 'recovery:');
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain('recovery: none');
    // A live process would recreate the WAL and a v30 boot could migrate it back: nothing copied.
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    expect(ups(log), result.out).toHaveLength(1);
    expect(log).not.toContain('start writer');
    expect(log).not.toContain('cp /data/backups/');
    expect(readFileSync(join(volume, 'book.db'), 'utf8')).toBe('BOOK-DB-v29\n');
  });

  // The boot creates `backups/` only when it dumps, so a volume that never migrated has none: an
  // absent directory is an empty listing (a fact), never a failed read — an empty one reads alike.
  it.each([
    { shape: 'an empty backups/', absent: false },
    { shape: 'no backups/ at all', absent: true },
  ])('nothing was migrated ($shape): image-rollback, and no record is written', async ({ absent }) => {
    const { root, stateDir, bin, volume } = drill();
    const prev = previous(root);
    packagingRelease(root);
    if (absent) rmSync(join(volume, 'backups'), { recursive: true, force: true });
    const next = `book:${sha(root)}`;
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({
        status: 200,
        body: { ok: true, commit: current === next ? 'deadbee' : current.split(':')[1]?.slice(0, 7) },
      }),
    });
    serving(stateDir, prev);
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      FAKE_VOLUME_DIR: volume,
      FAKE_RUNNING_IMAGE: prev,
      // BOOK-232: the boot ran no DDL, so the volume is still on the schema the older image knows.
      FAKE_VOLUME_SCHEMA: '29',
    });

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('migration: before up — 0 dump(s) in backups/');
    expect(result.out).toContain('migration: no new dump in backups/, so the boot ran no DDL');
    const recovery = lines(result.out, 'recovery:');
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain('recovery: image-rollback');
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    expect(ups(log), result.out).toHaveLength(2);
    expect(ups(log)[1]).toContain(`BOOK_IMAGE_TAG=${prev}`);
    expect(existsSync(join(stateDir, 'volume-migrated'))).toBe(false);
  });

  it('refuses to roll back when a late read names the build of this run: exit 1, recovery none, no swap', async () => {
    const { root, stateDir, bin } = drill();
    const prev = previous(root);
    packagingRelease(root);
    // 0 ms budget/grace: the window is one read. #1 the rebind probe, #2 the window, #3 the first
    // plain read are 503; #4 answers this run's build — the state `rollback_allowed` refuses.
    let reads = 0;
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => {
        reads += 1;
        if (reads < 4) return { status: 503, body: {} };
        return { status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) } };
      },
    });
    serving(stateDir, prev);
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      BOOK_HEALTH_TIMEOUT: '0',
      BOOK_HEALTH_GRACE: '0',
      FAKE_RUNNING_IMAGE: prev,
      FAKE_VOLUME_SCHEMA: '29',
    });

    expect(result.code, result.out).toBe(1);
    // Four reads decided it (the rebind probe, the window, the two plain reads). The fifth is the
    // schema fact's `/healthz` read — BOOK-232 takes the max of it and the volume probe, so it is
    // always asked; the sixth is the alert's own prod check. Neither feeds the window's verdict.
    expect(reads, result.out).toBe(6);
    expect(result.out).toContain('refused to roll back');
    const recovery = lines(result.out, 'recovery:');
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain('recovery: none');
    // No swap and no second `up`: the image that is already there keeps serving.
    expect(ups(readFileSync(join(stateDir, 'docker.log'), 'utf8')), result.out).toHaveLength(1);
    expect(result.out).not.toContain('back on');
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(prev);
  });
});

describe('BOOK-217: the crash loop is this run’s to report', () => {
  it('does not report a restart count that did not grow under this run', async () => {
    const { root, stateDir, bin } = drill();
    const prev = previous(root);
    packagingRelease(root);
    const siteUrl = await answering(stateDir);
    serving(stateDir, prev);
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      FAKE_RUNNING_IMAGE: prev,
      // `up` failed before recreating anything: these are the OLD containers, weeks-old count.
      FAKE_UP_FAIL_ONCE: '1',
      FAKE_RESTARTS_SITE: '7',
      FAKE_VOLUME_SCHEMA: '29',
    });

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('crash loop baseline: site=7 engine=0 writer=0');
    expect(result.out).not.toContain('CRASH LOOP');
    expect(result.out).not.toContain('prod is not serving');
    expect(readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8')).toContain('crashloop=0');
  });

  it('reports a count that grew, prints the fixed sentence and audits crashloop=1', async () => {
    const { root, stateDir, bin } = drill();
    const prev = previous(root);
    packagingRelease(root);
    const siteUrl = await answering(stateDir);
    serving(stateDir, prev);
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      FAKE_RUNNING_IMAGE: prev,
      FAKE_UP_FAIL_ONCE: '1',
      // 0 before this run's `up`, 2 after it: the growth is the loop.
      FAKE_RESTARTS_SITE: '0,2',
      FAKE_VOLUME_SCHEMA: '29',
      GITHUB_ACTIONS: 'true',
    });

    expect(result.code, result.out).toBe(1);
    // The sentence names the service, the grown count and the state the engine reports.
    const loops = lines(result.out, 'CRASH LOOP: site restarted 2 time(s)').filter(
      (line) => !line.startsWith('::error::'),
    );
    expect(loops.length, result.out).toBe(1);
    expect(loops[0]).toContain('the stack cannot boot; prod is not serving');
    // The workflow reads ONE alarm, the alert its failure path printed (BOOK-232): the crash-loop
    // line is evidence, and a second annotation per run is how a reader learns to ignore them.
    const annotations = lines(result.out, '::error::');
    expect(annotations, result.out).toHaveLength(1);
    expect(annotations[0]).toContain('FAILED at');
    expect(annotations[0]).toContain('prod: serving');
    expect(readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8')).toContain('crashloop=1');
  });
});
