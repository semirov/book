/**
 * BOOK-172 — `deploy/flip.sh`, the one command that moves prod between launchd and containers.
 *
 * A flip stops prod on purpose, so the order inside it is the safety property. The world it runs in
 * — the repo's own script, a fake `docker`/`launchctl`, a GNU-shaped `stat`, a `compose-release.sh`
 * stub and a real `/healthz` on a temp port — is `flipHarness.ts`; this file is the assertions.
 *
 * What is pinned:
 *   · `launchctl` grammar — `bootout <domain>/<service>`, `bootstrap <domain> <plist>`; the arguments
 *     are never swapped, and the writer lane stops before the site and the engine;
 *   · a flip's lock is handed to `compose-release.sh` (`BOOK_LOCK_INHERITED=1`), never re-taken;
 *   · a red `compose-release.sh` brings the stack down BEFORE launchd is bootstrapped, and leaves
 *     `runtime` untouched — the deploy workflow keeps working on the runtime that is up;
 *   · `runtime=compose` is written only after the gate is green, and a job that cannot be disabled
 *     is exit 4 with the command to run by hand;
 *   · `--to launchd` runs `compose down`, aligns the tree to the last good image, and refuses to
 *     claim the runtime when what answers is not the tree it runs;
 *   · a `--dry-run` takes no lock and writes no state.
 *
 * The backup guard is read through a GNU `stat` shim on purpose: on macOS the `stat -f`-first bug was
 * invisible, and it broke every flip on the Debian runner.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  callsOf,
  closeAll,
  DOMAIN,
  fixture,
  flip,
  HAS_SQLITE3,
  headOf,
  hostDb,
  indexOfLine,
  served,
  statCallsOf,
} from './flipHarness.ts';

// Every case spawns the real script, and a loaded box stretches the clock: a spawn is not a hang, so
// the timeout is about a wedged child, not about the work.
vi.setConfig({ testTimeout: 60_000 });

afterEach(closeAll);

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
    // The backup guard read a real epoch through the GNU-shaped `stat` and got a number out of it:
    // a `-f`-first script would have captured "  File: …" and died before this line.
    expect(out).toMatch(/backup: 2026-10-28 is \d+s old \(limit 3600s\)/u);
    expect(statCallsOf(f)).toContain('-c %Y ' + join(f.backupRoot, 'daily', '2026-10-28'));
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

describe('the data volume (BOOK-183)', () => {
  /** The host data dir the launchd runtime serves from — the seed's source, and the export's target. */
  // Written from parts, like `dataIsolation.test.ts` assembles its needles: no test file may spell
  // the production data dir's name (the isolation test is the producer of that rule).
  const hostData = (home: string) => join(home, ['book', 'site', 'data'].join('-'));

  it('seeds an empty volume from the host dir before any container starts', async () => {
    const f = await fixture();
    mkdirSync(hostData(f.home), { recursive: true });
    writeFileSync(join(hostData(f.home), 'book.db'), '', 'utf8');
    const { code, out } = await flip(f, ['--to', 'compose', '--confirm'], {
      FAKE_VOLUME_DB: '0', // the volume holds no book.db yet: a first flip
      STUB_HEALTHY: '1',
    });
    expect(code, out).toBe(0);
    const calls = callsOf(f);
    const seed = indexOfLine(calls, /^migrate .*--seed-only/u);
    const release = indexOfLine(calls, /^release /u);
    expect(seed, out).toBeGreaterThan(-1);
    // The seed is inherited from the flip (it must not refuse its own parent with exit 3), and it runs
    // BEFORE the release: a container never starts on an empty volume.
    expect(calls[seed]).toContain('inherited=1');
    expect(calls[seed]).toContain(`--volume book-data`);
    expect(release).toBeGreaterThan(seed);
    expect(existsSync(join(f.stateDir, 'runtime'))).toBe(true);
  });

  it('refuses to start containers when the volume could not be seeded, and brings launchd back', async () => {
    const f = await fixture();
    mkdirSync(hostData(f.home), { recursive: true });
    writeFileSync(join(hostData(f.home), 'book.db'), '', 'utf8');
    const { code, out } = await flip(f, ['--to', 'compose', '--confirm'], {
      FAKE_VOLUME_DB: '0',
      STUB_SEED_EXIT: '1',
      STUB_HEALTHY: '1',
    });
    expect(code, out).toBe(1);
    expect(out).toContain('launchd serves');
    const calls = callsOf(f);
    expect(indexOfLine(calls, /^release /u), 'no release may run on an empty volume').toBe(-1);
    // The fallback was bootstrapped back, and the runtime file is untouched.
    expect(calls).toContain(`launchctl bootstrap ${DOMAIN} ${join(f.home, 'Library/LaunchAgents/dev.book-site.plist')}`);
    expect(existsSync(join(f.stateDir, 'runtime'))).toBe(false);
  });

  it.skipIf(!HAS_SQLITE3)('refuses to serve a volume that differs from the host dir (the fallback window)', async () => {
    const f = await fixture();
    // launchd kept writing the host dir after the last export: the volume is a chapter behind. Serving
    // it would publish stale data, and there is no merge — the flip refuses and puts launchd back.
    hostDb(f.home, 18);
    const { code, out } = await flip(f, ['--to', 'compose', '--confirm'], {
      FAKE_VOLUME_DB: '1', // both sides hold a database
      FAKE_CH_VOLUME: '17',
      STUB_HEALTHY: '1',
    });
    expect(code, out).toBe(1);
    // The reason names BOTH counts, so the operator can see which side is ahead.
    expect(out).toContain('hold DIFFERENT books');
    expect(out).toContain('chapters=18');
    expect(out).toContain('"chapters":17');
    // The operator's next command is printed whole: the sibling script, the host dir it must read, a
    // FRESH volume name, and the confirmation flag — not a suggestion to overwrite the serving one.
    expect(out).toContain(
      `${join(f.script, '..', 'migrate-to-volume.sh')} --from ${hostData(f.home)} --volume <fresh-name> --confirm`,
    );
    // Nothing was released on the volume, and launchd serves again.
    expect(callsOf(f).filter((line) => line.startsWith('release '))).toEqual([]);
    expect(callsOf(f).some((line) => line.startsWith('launchctl bootstrap'))).toBe(true);
    expect(out).toContain('launchd serves');
    expect(existsSync(join(f.stateDir, 'runtime'))).toBe(false);
  });

  it('does not bootstrap launchd when the export proof does not match the volume', async () => {
    const f = await fixture();
    writeFileSync(join(f.stateDir, 'runtime'), 'compose\n', 'utf8');
    served(f, headOf(f.root));
    const { code, out } = await flip(f, ['--to', 'launchd', '--confirm'], {
      // The host copy comes out one chapter short of the volume: the counts must disagree, and that is
      // the only reason this run may fail — a read error would prove nothing about the comparison.
      FAKE_CH_HOST: '17',
    });
    expect(code, out).toBe(1);
    expect(out).toContain('the export does not match volume book-data');
    expect(out).toContain('host chapters=17');
    expect(out).toContain('volume {"chapters":18');
    expect(out).toContain('nothing was bootstrapped');
    expect(callsOf(f).filter((line) => line.startsWith('launchctl bootstrap'))).toEqual([]);
    expect(existsSync(join(f.stateDir, 'runtime'))).toBe(true);
  });
});

describe('the flip to launchd', () => {
  it('runs compose down and records runtime=launchd', async () => {
    const f = await fixture();
    writeFileSync(join(f.stateDir, 'runtime'), 'compose\n', 'utf8');
    // Nothing answers 8091 before the flip (the containers are what did), and the launchd bootstrap is
    // what starts answering again — the liveness gate would refuse a flip that began with a 200 here.
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
    // The export copy is the only writer of the host dir while the stack is down: a journal an earlier
    // open left there would be overlaid onto the incoming pages, so it is removed BEFORE `cp -a`. The
    // `-c` payload has newlines, so this is read across the whole log, not line by line.
    const log = readFileSync(f.calls, 'utf8');
    const dropped = log.indexOf('rm -f /to/book.db-wal /to/book.db-shm /to/book.db-journal');
    expect(dropped).toBeGreaterThan(-1);
    expect(dropped).toBeLessThan(log.indexOf('cp -a /from/.'));

    // No last good image is recorded, so the tree is left alone — and the flip says so, once.
    expect(out).toContain('tree: no last-good-image recorded — the deploy root stays where it is');
    expect(out).toContain('flip back complete');
    expect(existsSync(join(f.stateDir, 'deploy.lock'))).toBe(false);
  });

  it('refuses to claim launchd when what answers is not the tree it runs', async () => {
    const f = await fixture();
    const stranger = 'beeffff';
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

  it('refuses to export while a launchd job is still running', async () => {
    const f = await fixture();
    writeFileSync(join(f.stateDir, 'runtime'), 'compose\n', 'utf8');
    const { code, out } = await flip(f, ['--to', 'launchd', '--confirm'], { FAKE_JOB_RUNNING: '1' });

    expect(code, out).toBe(1);
    // The proof is `launchctl print`, not the health endpoint alone: a job can be running with the port
    // already lost, and exporting under it would race its writer.
    expect(out).toContain('is still running (launchctl print: state = running)');
    expect(out).toContain('nothing was exported, nothing was bootstrapped');
    expect(out).toContain('runtime unchanged');
    const calls = callsOf(f);
    expect(calls.filter((line) => line.startsWith('launchctl print'))).toEqual([`launchctl print ${DOMAIN}/dev.book-site`]);
    // The stack was stopped first (that is the flip), and nothing after the refusal happened.
    expect(indexOfLine(calls, /compose .* down$/u)).toBeGreaterThan(-1);
    expect(calls.filter((line) => line.startsWith('docker run'))).toEqual([]);
    expect(calls.filter((line) => line.startsWith('launchctl bootstrap'))).toEqual([]);
    expect(existsSync(join(f.stateDir, 'runtime'))).toBe(true);
  });

  it('does not record runtime=launchd when compose down leaves a container behind', async () => {
    const f = await fixture();
    writeFileSync(join(f.stateDir, 'runtime'), 'compose\n', 'utf8');
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

  it('refuses to flip on a stale backup, before anything is stopped', async () => {
    const f = await fixture();
    // The newest backup is two hours old; the limit is the script's 3600 s default.
    const newest = join(f.backupRoot, 'daily', '2026-10-28');
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
    utimesSync(newest, twoHoursAgo, twoHoursAgo);
    const { code, out } = await flip(f, ['--to', 'compose', '--confirm'], { STUB_EXIT: '0', STUB_HEALTHY: '1' });
    expect(code, out).toBe(1);
    // A number, not a filesystem report: the age is arithmetic on a real epoch.
    expect(out).toMatch(/the newest backup \(2026-10-28\) is \d+s old \(limit 3600s\) — run site\/deploy\/backup\.sh first/u);
    expect(statCallsOf(f)).toContain(`-c %Y ${newest}`);
    // A flip changes where the book lives: no backup, no stop, no lock, no runtime change.
    expect(callsOf(f).filter((line) => line.startsWith('launchctl') || /compose .* down$/u.test(line))).toEqual([]);
    expect(existsSync(join(f.stateDir, 'deploy.lock'))).toBe(false);
    expect(existsSync(join(f.stateDir, 'runtime'))).toBe(false);
  });
});
