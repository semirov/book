/**
 * BOOK-232 — the launchd driver decides a rollback from the volume, not from a note.
 *
 * `deploy.sh` used to decide on `$STATE_DIR/volume-migrated` and to PROCEED when the record was
 * absent, unreadable or the target's constant unreadable — a fail-open branch that this change made
 * more reachable (the compose release deletes the record on a non-migrated run). The rule is now the
 * same one the container release uses, decided by the same pure helper
 * (`lib.sh:rollback_schema_verdict`): the volume's own `PRAGMA user_version`, read with
 * `sqlite3 -readonly` on the host, against the target build's `SCHEMA_VERSION` from `git show`.
 * `refuse` and `unknown` both refuse, the dry run refuses identically, and nothing is fetched,
 * checked out, built or restarted either way.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeAll } from './deployHarness.ts';
import { commitSchema, logLines, runDeploy, stage } from './deployLaunchdHarness.ts';

vi.setConfig({ testTimeout: 90_000 });

afterEach(closeAll);

/** A `--rollback --dry-run` would stop here anyway; the assertion is that it never reaches `fetching`. */
const NOTHING_DONE = 'nothing was fetched, checked out or built';

/** The fact in words, as the shared line builder prints it. */
const versions = (db: string, target: number): string =>
  `the volume is at v${db} and the build being rolled back to understands v${String(target)}`;

describe('BOOK-232: deploy.sh refuses an older build on a newer volume', () => {
  it('refuses at db 33 / target 32, naming both numbers, before anything is fetched', async () => {
    const s = await stage({ frame: 0 });
    const v32 = commitSchema(s.root, 32);
    commitSchema(s.root, 33);
    writeFileSync(join(s.stateDir, 'last-good'), `${v32}\n`, 'utf8');
    const head = execFileSync('git', ['-C', s.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const before = logLines(join(s.stateDir, 'launchctl.log')).length;

    const result = await runDeploy(['--rollback', '--dry-run', '--root', s.root], {
      ...s.env,
      FAKE_SQLITE_SCHEMA: '33',
    });

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('the volume is at schema v33 and the build being rolled back to understands v32');
    expect(result.out).toContain('restore the pre-deploy dump instead');
    expect(result.out).toContain(NOTHING_DONE);
    expect(result.out).not.toContain('fetching');
    expect(result.out).not.toContain('rolling back to');
    // Nothing was started: the job's own records never grew, and the tree is where it was.
    expect(logLines(join(s.stateDir, 'launchctl.log')), result.out).toHaveLength(before);
    expect(execFileSync('git', ['-C', s.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(head);
  });

  it('proceeds when the numbers are equal — a guard that refuses everything protects nothing', async () => {
    const s = await stage({ frame: 0 });
    const v30 = commitSchema(s.root, 30);
    writeFileSync(join(s.stateDir, 'last-good'), `${v30}\n`, 'utf8');

    const result = await runDeploy(['--rollback', '--dry-run', '--root', s.root], {
      ...s.env,
      FAKE_SQLITE_SCHEMA: '30',
    });

    // The guard let it through — it reached the fetch. That fetch fails here because the fixture
    // clone has no reachable origin (the harness's known shape), which is exactly why "past the
    // guard" is asserted as `fetching` in the log and not as a green exit.
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain(versions('30', 30));
    expect(result.out).toContain('fetching');
    expect(result.out).toContain('git fetch failed');
    expect(result.out).not.toContain(NOTHING_DONE);
  });

  it('refuses when neither the read nor the record answers, and says how to read the volume', async () => {
    const s = await stage({ frame: 0 });
    const v32 = commitSchema(s.root, 32);
    writeFileSync(join(s.stateDir, 'last-good'), `${v32}\n`, 'utf8');

    // No FAKE_SQLITE_SCHEMA (the file "cannot be read") and no record: the number is unreadable, and
    // an unreadable number is a refusal — never "proceeds as usual".
    const result = await runDeploy(['--rollback', '--dry-run', '--root', s.root], s.env);

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("the volume's own schema could not be read");
    // The way out is a READ, not a restore: a good volume must not be replaced because a number was
    // missing (that is the data-loss path the re-review measured).
    expect(result.out).toContain("sqlite3 ");
    expect(result.out).toContain('PRAGMA user_version;');
    expect(result.out).toContain('bring the service up');
    expect(result.out).not.toContain('restore the pre-deploy dump');
    expect(result.out).not.toContain('dump-restore');
    expect(result.out).toContain(NOTHING_DONE);
    expect(result.out).not.toContain('fetching');
  });

  it('refuses on a record that names a schema the target predates — the note strengthens, never authorises', async () => {
    const s = await stage({ frame: 0 });
    const v25 = commitSchema(s.root, 25);
    writeFileSync(join(s.stateDir, 'last-good'), `${v25}\n`, 'utf8');
    writeFileSync(join(s.stateDir, 'volume-migrated'), 'schema=31\n', 'utf8');

    const result = await runDeploy(['--rollback', '--dry-run', '--root', s.root], s.env);

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain("the volume's own schema could not be read");
    expect(result.out).toContain('the record at');
    expect(result.out).toContain('says v31');
    expect(result.out).toContain('understands v25');
    expect(result.out).toContain('SCHEMA_FUTURE');
    expect(result.out).not.toContain('is safe');
    expect(result.out).not.toContain('fetching');
  });

  it('NEVER prints "safe" from a record: record 30 / target 30 with an unreadable volume refuses', async () => {
    // The re-review's case: the old code treated the record as the fact, so `record 30 / target 30`
    // printed "the rollback is safe on this volume" and proceeded — an authorisation from a note.
    const s = await stage({ frame: 0 });
    const v30 = commitSchema(s.root, 30);
    writeFileSync(join(s.stateDir, 'last-good'), `${v30}\n`, 'utf8');
    writeFileSync(join(s.stateDir, 'volume-migrated'), 'schema=30\n', 'utf8');

    const result = await runDeploy(['--rollback', '--dry-run', '--root', s.root], s.env);

    expect(result.code, result.out).toBe(1);
    expect(result.out).not.toContain('is safe');
    expect(result.out).toContain("the volume's own schema could not be read");
    expect(result.out).toContain("sqlite3 ");
    expect(result.out).not.toContain('fetching');
  });

  it('records the volume on a green deploy and refuses the previous build with that number', async () => {
    const s = await stage({ frame: 0 });
    const v29 = commitSchema(s.root, 29);
    commitSchema(s.root, 30);

    const green = await runDeploy(['--phase', 'run', '--root', s.root], { ...s.env, FAKE_SQLITE_SCHEMA: '30' });
    expect(green.code, green.out).toBe(0);
    expect(green.out).toContain('volume-migrated: recorded schema=30');
    expect(readFileSync(join(s.stateDir, 'volume-migrated'), 'utf8')).toBe('schema=30\n');

    writeFileSync(join(s.stateDir, 'last-good'), `${v29}\n`, 'utf8');
    const refused = await runDeploy(['--rollback', '--dry-run', '--root', s.root], {
      ...s.env,
      FAKE_SQLITE_SCHEMA: '30',
    });
    expect(refused.code, refused.out).toBe(1);
    expect(refused.out).toContain('the volume is at schema v30 and the build being rolled back to understands v29');
    expect(refused.out).toContain(NOTHING_DONE);
    // The record is still there for a human: a refusal is not a restore.
    expect(existsSync(join(s.stateDir, 'volume-migrated'))).toBe(true);
  });
});

describe('BOOK-232: the real `--rollback` is refused the same way as its dry run', () => {
  it('db 33 / target 32: exit 1, nothing fetched, checked out, built or restarted', async () => {
    // The dry run is the rehearsal; this is the command an operator types at 03:00. It takes the
    // lock and runs the guard in prepare, so "nothing happened" has to be measured: no fetch, the
    // job's own record unchanged, HEAD where it was, and no rollback build.
    const s = await stage({ frame: 0 });
    const v32 = commitSchema(s.root, 32);
    commitSchema(s.root, 33);
    writeFileSync(join(s.stateDir, 'last-good'), `${v32}\n`, 'utf8');
    const head = execFileSync('git', ['-C', s.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const launchctlBefore = logLines(join(s.stateDir, 'launchctl.log')).length;
    const npmBefore = logLines(join(s.stateDir, 'npm.log')).length;

    const result = await runDeploy(['--rollback', '--root', s.root], { ...s.env, FAKE_SQLITE_SCHEMA: '33' });

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('the volume is at schema v33 and the build being rolled back to understands v32');
    expect(result.out).toContain(NOTHING_DONE);
    expect(result.out).not.toContain('fetching');
    expect(result.out).not.toContain('rolling back to');
    expect(logLines(join(s.stateDir, 'launchctl.log')), result.out).toHaveLength(launchctlBefore);
    expect(logLines(join(s.stateDir, 'npm.log')), result.out).toHaveLength(npmBefore);
    expect(execFileSync('git', ['-C', s.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(head);
    // The lock this run took is released on the way out: a refusal must not wedge the next deploy.
    expect(existsSync(join(s.stateDir, 'deploy.lock'))).toBe(false);
  });
});
