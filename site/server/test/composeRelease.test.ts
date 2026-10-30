/**
 * BOOK-172 — `deploy/compose-release.sh` as a real process: the lock, the exit codes and the
 * rollback. Same shape as `deployScript.test.ts` (a fake `docker` on PATH, a real HTTP server, a
 * git clone fixture, nothing ambient): the script is driven exactly as the workflow drives it.
 *
 * What is pinned here is the interface BOOK-172 states:
 *   · exit 3 when another deploy holds the lock — and nothing is built, started or rolled back;
 *   · exit 2 on a bad argument;
 *   · exit 0 only when `/healthz` names the commit the image carries, plus the five smokes;
 *   · the sign-in read (BOOK-205) speaks only when the host carries the OAuth client id, and never
 *     refuses a rollback — an image swap exists to get the book serving again;
 *   · a red gate rolls back to the image that served before (`previous-image`) with ONE `up`, and
 *     the run stays exit 1 (a rollback is not a green deploy);
 *   · `--dry-run` builds nothing and starts nothing.
 *
 * Every path a run writes (`BOOK_STATE_DIR`, `BOOK_LOCKS_DIR`) is a temp dir: the script creates the
 * `/locks` bind source itself, and that must never be the box's real one.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
} from './composeReleaseHarness.ts';

// A real build here is a fake that answers at once; the gate is a real server and a real curl. The
// timeout is about a wedged child, not about the work.
vi.setConfig({ testTimeout: 90_000 });

afterEach(closeAll);

/**
 * BOOK-232: the image prod served before the release under test — a REAL commit of this clone
 * carrying `SCHEMA_VERSION = <version>`, so the rollback guard reads a number from `git show`
 * instead of refusing a target nobody can identify. A made-up sha used to be enough; now it is the
 * exact shape the guard exists for (`unknown` refuses), so the fixtures use commits.
 */
const previousAt = (root: string, version: number): string => `book:${commitSchema(root, version)}`;

describe('the container release: lock, exit codes, rollback', () => {
  it('a) refuses with exit 2 on an unknown argument', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const result = await release(['--nope'], envFor(root, stateDir, bin, 'http://127.0.0.1:9'));
    expect(result.code).toBe(2);
    expect(result.out).toContain('unknown argument');
  });

  it('b) refuses with exit 3 while another deploy holds the lock, and touches nothing', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) } }),
    });
    const lock = join(stateDir, 'deploy.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`, 'utf8');
    writeFileSync(join(lock, 'since'), `${Math.floor(Date.now() / 1000)}\n`, 'utf8');
    const result = await release(['--ref', 'HEAD'], envFor(root, stateDir, bin, siteUrl));
    expect(result.code, result.out).toBe(3);
    expect(result.out).toContain('another deploy is running');
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    expect(log).not.toContain('build site');
    expect(log).not.toContain('up -d');
  });

  it('b2) refuses a stack on a missing data volume: exit 1, named reason, nothing built or started', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, 'http://127.0.0.1:9'),
      FAKE_VOLUME_MISSING: '1',
    });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('does not exist');
    expect(result.out).toContain('migrate-to-volume.sh');
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    expect(log).not.toContain('build site');
    expect(log).not.toContain('up -d');
  });

  it('b3) refuses a stack on a volume with no book.db: exit 1, named reason, nothing built or started', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, 'http://127.0.0.1:9'),
      FAKE_VOLUME_EMPTY: '1',
    });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('holds no book.db');
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    expect(log).not.toContain('build site');
    expect(log).not.toContain('up -d');
  });

  it('c) ships when /healthz names the image commit: exit 0, last-good recorded, audited', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const expected = sha(root).slice(0, 7);
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
    });
    const result = await release(['--ref', 'HEAD'], envFor(root, stateDir, bin, siteUrl));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`healthy: book:${sha(root)}`);
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(`book:${sha(root)}`);
    expect(readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8')).toContain(
      `ok mode=deploy runtime=compose image=book:${sha(root)} commit=${expected}`,
    );
  });

  it('d) a red gate rolls back to the previous image and still exits 1', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const previous = previousAt(root, 32);
    // …and the release ships a LATER commit, so the two images are different trees.
    commitSchema(root, 33);
    const previous7 = previous.split(':')[1]?.slice(0, 7) ?? '';
    const siteUrl = await serveSite(stateDir, {
      // The new image answers a commit that is not its own; the previous image answers its own.
      healthz: (current) => ({
        status: 200,
        body: { ok: true, commit: current === previous ? previous7 : 'deadbee' },
      }),
    });
    const env = envFor(root, stateDir, bin, siteUrl);
    env.FAKE_RUNNING_IMAGE = previous;
    // BOOK-232: the boot ran no DDL, so the volume is still on the schema the older image understands
    // — the one case a swap is safe, and the one this case is about (the swap itself, not the guard).
    env.FAKE_VOLUME_SCHEMA = '32';
    writeFileSync(join(stateDir, 'current'), previous, 'utf8');
    writeFileSync(join(stateDir, 'docker.log'), '', 'utf8');
    const result = await release(['--ref', 'HEAD'], env);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('back on');
    expect(readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8')).toContain('rollback ok');
    const ups = readFileSync(join(stateDir, 'docker.log'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('up -d'));
    expect(ups).toHaveLength(2);
    expect(ups[0]).toContain(`BOOK_IMAGE_TAG=book:${sha(root)}`);
    expect(ups[1]).toContain(`BOOK_IMAGE_TAG=${previous}`);
    // A red run never records the image it could not bring up.
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(previous);
  });

  it('e) --dry-run builds nothing and starts nothing', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const siteUrl = await serveSite(stateDir, { healthz: () => ({ status: 200, body: { ok: true, commit: 'dev' } }) });
    const result = await release(['--ref', 'HEAD', '--dry-run'], envFor(root, stateDir, bin, siteUrl));
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('dry run: would build');
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    expect(log).not.toContain('build site');
    expect(log).not.toContain('up -d');
  });

  it('f) a compose up that exits 1 is red even when the site already serves the new commit', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const previous = previousAt(root, 32);
    commitSchema(root, 33);
    // The stack half-came-up: the site answers the NEW commit while `up` itself returned 1.
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
    });
    const env = envFor(root, stateDir, bin, siteUrl);
    env.FAKE_RUNNING_IMAGE = previous;
    env.FAKE_UP_FAIL_ONCE = '1';
    env.FAKE_VOLUME_SCHEMA = '32';
    writeFileSync(join(stateDir, 'current'), previous, 'utf8');
    writeFileSync(join(stateDir, 'last-good-image'), `${previous}\n`, 'utf8');

    const result = await release(['--ref', 'HEAD'], env);
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('compose up exited 1');
    // The exit code is the verdict: no health window is consulted for it.
    expect(result.out.indexOf('compose up exited 1')).toBeLessThan(result.out.indexOf('rollback:'));
    const ups = readFileSync(join(stateDir, 'docker.log'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('up -d'));
    expect(ups).toHaveLength(2);
    expect(ups[1]).toContain(`BOOK_IMAGE_TAG=${previous}`);
    // The image that served before the run is still the last good one.
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(previous);
  });

  it('g) a dead engine is red on the container state alone, with no health window spent', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const previous = previousAt(root, 32);
    commitSchema(root, 33);
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
    });
    const env = envFor(root, stateDir, bin, siteUrl);
    env.FAKE_RUNNING_IMAGE = previous;
    env.FAKE_VOLUME_SCHEMA = '32';
    env.FAKE_STATE_ENGINE = 'once:exited';
    writeFileSync(join(stateDir, 'current'), previous, 'utf8');
    writeFileSync(join(stateDir, 'last-good-image'), `${previous}\n`, 'utf8');

    const result = await release(['--ref', 'HEAD'], env);
    expect(result.code, result.out).toBe(1);
    // The log names the container that is wrong, not a service the site never mentioned.
    expect(result.out).toContain('service engine: exited (container id-engine');
    // A dead container is decisive: the 2 s window (let alone 180 s) is never entered for it.
    expect(result.out).not.toContain('healthz did not name');
    const ups = readFileSync(join(stateDir, 'docker.log'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('up -d'));
    expect(ups).toHaveLength(2);
    expect(ups[1]).toContain(`BOOK_IMAGE_TAG=${previous}`);
    expect(result.out).toContain('back on');
  });

  it('h) all three containers running/healthy is the green path', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
    });
    const env = envFor(root, stateDir, bin, siteUrl);
    env.FAKE_STATE_SITE = 'running healthy';
    env.FAKE_STATE_ENGINE = 'running healthy';
    // The writer has no healthcheck by design: `running` is its full contract.
    env.FAKE_STATE_WRITER = 'running';

    const result = await release(['--ref', 'HEAD'], env);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('service engine: running healthy');
    expect(result.out).toContain('service writer: running (container id-writer');
    expect(result.out).toContain(`healthy: book:${sha(root)}`);
  });

  it('i) --rollback swaps the image and leaves the deploy root where it is', async () => {
    // The rehearsal defect: a rollback used to `git checkout` the image's commit, so the tree lost the
    // packaging the deployed image was built from. A rollback is an image swap, not a tree move.
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const packaged = sha(root); // the commit the tree is on: newer packaging, older image
    execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'packaging']);
    const head = sha(root);
    expect(head).not.toBe(packaged);
    const previous = `book:${packaged}`;
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
    });
    const env = envFor(root, stateDir, bin, siteUrl);
    env.FAKE_RUNNING_IMAGE = `book:${head}`;
    // BOOK-232: both commits carry the same schema, so the swap is the ordinary one.
    env.FAKE_VOLUME_SCHEMA = '33';
    writeFileSync(join(stateDir, 'current'), `book:${head}`, 'utf8');
    writeFileSync(join(stateDir, 'previous-image'), `${previous}\n`, 'utf8');

    const result = await release(['--rollback'], env);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`rollback healthy: ${previous}`);
    // The running image moved...
    const ups = readFileSync(join(stateDir, 'docker.log'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('up -d'));
    expect(ups).toHaveLength(1);
    expect(ups[0]).toContain(`BOOK_IMAGE_TAG=${previous}`);
    // ...and the tree did not: HEAD is still the commit the deployed packaging lives on.
    expect(sha(root), result.out).toBe(head);
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(previous);
    expect(existsSync(join(stateDir, 'previous-image'))).toBe(false);
  });

  it('j) BOOK-205: a host that carries the OAuth client id must see /auth/yandex/start redirect to Yandex', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
      signin: { status: 302 },
    });
    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      BOOK_SECRETS_DIR: secretsWithClientId(),
    });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`healthy: book:${sha(root)}`);
    // The check passed, so it says nothing: a green deploy carries no sign-in line.
    expect(result.out).not.toContain('sign-in');
  });

  it('k) BOOK-205: a 503 there is a red deploy — and the automatic rollback it triggers is not refused too', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const previous = previousAt(root, 32);
    commitSchema(root, 33);
    const siteUrl = await serveSite(stateDir, {
      // Each image answers its own commit, so both gates (new image, then the rollback) are green on
      // `/healthz` and the only thing that can go red is the sign-in read.
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
      signin: { status: 503 },
    });
    const env = envFor(root, stateDir, bin, siteUrl);
    // A recorded previous image: this is the shape in which `red()` really rolls back.
    env.FAKE_RUNNING_IMAGE = previous;
    env.BOOK_SECRETS_DIR = secretsWithClientId();
    env.FAKE_VOLUME_SCHEMA = '32';
    writeFileSync(join(stateDir, 'current'), previous, 'utf8');
    writeFileSync(join(stateDir, 'last-good-image'), `${previous}\n`, 'utf8');

    const result = await release(['--ref', 'HEAD'], env);
    // The deploy is red (exit 1) — and it says why, with the image named in the reason.
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('sign-in is off although the host carries the client id');
    expect(result.out).toContain('answered 503, not 302');
    // The rollback it triggered went through: the older image is serving again, its sign-in read was
    // accepted instead of refusing the swap, and the audit records the rollback as ok.
    expect(result.out).toContain('back on');
    expect(result.out).toContain('accepted on a rollback');
    expect(readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8')).toContain('rollback ok');
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(previous);
    const ups = readFileSync(join(stateDir, 'docker.log'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('up -d'));
    expect(ups).toHaveLength(2);
    expect(ups[1]).toContain(`BOOK_IMAGE_TAG=${previous}`);
  });

  it('l) BOOK-205: no client id on the host means sign-in is off by design — the same 503 passes silently', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
      signin: { status: 503 },
    });
    // envFor's BOOK_SECRETS_DIR is a temp dir with no `yandex_client_id` in it.
    const result = await release(['--ref', 'HEAD'], envFor(root, stateDir, bin, siteUrl));
    expect(result.code, result.out).toBe(0);
    expect(result.out).not.toContain('sign-in');
  });

  it('n) BOOK-205: a touched 0-byte client id is not a configured sign-in — the same 503 passes silently', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
      signin: { status: 503 },
    });
    // The review's reproduction: `touch` left `-rw------- 0 bytes`, and mere existence made every
    // release red. The predicate is the app's own ("a usable credential"), so this is silent.
    const secrets = temp('book-205-secrets-');
    writeFileSync(join(secrets, 'yandex_client_id'), '', { mode: 0o600 });
    const result = await release(['--ref', 'HEAD'], { ...envFor(root, stateDir, bin, siteUrl), BOOK_SECRETS_DIR: secrets });
    expect(result.code, result.out).toBe(0);
    expect(result.out).not.toContain('sign-in');
    // The file is still there: the preflight only ever touches a directory at that path.
    expect(readFileSync(join(secrets, 'yandex_client_id'), 'utf8')).toBe('');
  });

  it('o) BOOK-205: an empty directory Docker left at a mount source is removed before the build', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
    });
    // The no-OAuth host after one `up`: Docker created both bind sources as empty directories.
    const secrets = temp('book-205-secrets-');
    mkdirSync(join(secrets, 'yandex_client_id'), { recursive: true });
    mkdirSync(join(secrets, 'yandex_client_secret'), { recursive: true });

    const result = await release(['--ref', 'HEAD'], { ...envFor(root, stateDir, bin, siteUrl), BOOK_SECRETS_DIR: secrets });
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('removed the empty directory');
    // The path is free, which is exactly what makes "drop the 0600 file in" a step an operator can take.
    expect(existsSync(join(secrets, 'yandex_client_id'))).toBe(false);
    expect(existsSync(join(secrets, 'yandex_client_secret'))).toBe(false);
  });

  it('p) BOOK-205: a NON-empty directory at a mount source is refused by name before anything is built', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    // A dangerous shape: whoever "put the file there" wrote it INSIDE the directory Docker made.
    const secrets = temp('book-205-secrets-');
    mkdirSync(join(secrets, 'yandex_client_id'), { recursive: true });
    writeFileSync(join(secrets, 'yandex_client_id', 'client_id'), 'stray', 'utf8');

    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, 'http://127.0.0.1:9'),
      BOOK_SECRETS_DIR: secrets,
    });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('is a directory, not the 0600 file');
    expect(result.out).toContain('sudo rm -rf');
    expect(result.out).toContain('nothing was built and nothing was rolled back');
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    expect(log).not.toContain('build site');
    expect(log).not.toContain('up -d');
  });

  it('m) BOOK-205: --rollback is not refused because sign-in is off on the image it goes back to', async () => {
    const root = gitRoot();
    const stateDir = temp('book-172-state-');
    const bin = fakeDocker(stateDir);
    const previous = previousAt(root, 32);
    commitSchema(root, 33);
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) ?? 'none' } }),
      // The host carries the client id; the older image still answers `OAUTH_UNCONFIGURED`.
      signin: { status: 503 },
    });
    const env = envFor(root, stateDir, bin, siteUrl);
    env.FAKE_RUNNING_IMAGE = `book:${sha(root)}`;
    env.FAKE_VOLUME_SCHEMA = '32';
    env.BOOK_SECRETS_DIR = secretsWithClientId();
    writeFileSync(join(stateDir, 'current'), `book:${sha(root)}`, 'utf8');
    writeFileSync(join(stateDir, 'previous-image'), `${previous}\n`, 'utf8');

    const result = await release(['--rollback'], env);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`rollback healthy: ${previous}`);
    // The one line it owes: the check saw it and did not refuse the rollback.
    expect(result.out).toContain('accepted on a rollback');
  });
});
