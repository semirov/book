/**
 * BOOK-232 — a migration is what makes a rollback unsafe, and the deploy decides it from the volume.
 *
 * The incident this pins: the release migrated the volume to v33, failed its smoke, rolled the IMAGE
 * back to a v32 build — which refused the schema (`SCHEMA_FUTURE`), crash-looped, and prod answered
 * 502 until a human intervened. The rule is now one comparison (`lib.sh:rollback_schema_verdict`):
 * `db > target` is a refusal, equal-or-lower is the ordinary swap, and an unreadable number refuses
 * too. The guard lives in `rollback_to()` — the one function every swap passes through — so an
 * automatic recovery, a swap after a dump restore and `--rollback` cannot disagree.
 *
 * Driven as the workflow drives it: a real git clone (a "previous image" is a real commit carrying a
 * lower `SCHEMA_VERSION`), a fake `docker` on PATH, a real HTTP site and a real `curl`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
import { failRun, lib } from './deployHarness.ts';

vi.setConfig({ testTimeout: 90_000 });

afterEach(closeAll);

const lines = (text: string, needle: string): string[] => text.split('\n').filter((line) => line.includes(needle));
const ups = (log: string): string[] => lines(log, 'up -d');

/** The fact in words — the sentence every recovery line and refusal carries. */
const versions = (tag: string, db: number, target: number): string =>
  `the volume is at schema v${String(db)} and ${tag} understands v${String(target)}`;

/** A clone that ships v33 and whose previous image is a real v32 commit. */
function pair(): { root: string; previous: string; stateDir: string; bin: string } {
  const root = gitRoot();
  const previous = `book:${commitSchema(root, 32)}`;
  commitSchema(root, 33);
  const stateDir = temp('book-232-state-');
  return { root, previous, stateDir, bin: fakeDocker(stateDir) };
}

describe('the schema verdict is one pure rule', () => {
  it('refuses only a volume past the target, and treats an unreadable number as a refusal', async () => {
    const { code, out } = await lib(
      [
        `printf '%s\\n' "$(rollback_schema_verdict 33 32)"`,
        `printf '%s\\n' "$(rollback_schema_verdict 32 32)"`,
        `printf '%s\\n' "$(rollback_schema_verdict 31 32)"`,
        // Neither side readable is `unknown`, and both the guard and `recovery_choice` read that as
        // "nothing is started" — never as "probably fine".
        `printf '%s\\n' "$(rollback_schema_verdict '' 32)"`,
        `printf '%s\\n' "$(rollback_schema_verdict 33 '')"`,
        `printf '%s\\n' "$(rollback_schema_verdict abc 32)"`,
        `printf '%s\\n' "$(rollback_schema_verdict '' '')"`,
        // `0` is what an empty database (and a read that found nothing) reports — not a version, and
        // never a reason to call a swap "safe" on either side.
        `printf '%s\\n' "$(rollback_schema_verdict 0 30)"`,
        `printf '%s\\n' "$(rollback_schema_verdict 30 0)"`,
      ].join('\n'),
    );

    expect(code, out).toBe(0);
    expect(out.trim().split('\n')).toEqual([
      'refuse',
      'safe',
      'safe',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
  });

  it('names both numbers and the way back in the refusal line', async () => {
    const { code, out } = await lib(`printf '%s\\n' "$(rollback_schema_line refuse 33 32 book:abc)"`);
    expect(code, out).toBe(0);
    expect(out).toContain('the volume is at schema v33 and book:abc understands v32');
    expect(out).toContain('SCHEMA_FUTURE');
    expect(out).toContain('restore the pre-deploy dump instead');
  });

  it('a `set -e` death reaches the run’s one alert, not a line of its own', async () => {
    // The ERR trap is the third way a run can die (a command failing under `set -e`, when no `die`
    // ran). When the driver defines an alert, the death goes through it — otherwise that run is the
    // one failure with no `::error::` at all.
    const withAlert = await failRun(
      [
        'trap \'fail_on_err ${LINENO} "$BASH_COMMAND"\' ERR',
        'STEP="gate"',
        'ALERTED=0',
        'alert() { [ "$ALERTED" = 1 ] && return 0; ALERTED=1; printf "ALERT:%s\\n" "$*"; }',
        'false',
      ].join('\n'),
    );
    expect(withAlert.out).toContain('ALERT:false (line');
    // …and a driver without one (deploy.sh) keeps its own sentence, unchanged.
    const withoutAlert = await failRun(
      ['trap \'fail_on_err ${LINENO} "$BASH_COMMAND"\' ERR', 'STEP="gate"', 'false'].join('\n'),
    );
    expect(withoutAlert.out).toContain('FAILED at gate: false (line');
    expect(withoutAlert.out).not.toContain('ALERT:');
  });
});

describe('BOOK-232: a migrating release that fails its smoke keeps the new image serving', () => {
  it('a) exit 1, one up, one ::error::, no swap — recovery: roll-forward', async () => {
    const { root, previous, stateDir, bin } = pair();
    const previous7 = previous.split(':')[1]?.slice(0, 7) ?? '';
    const next = `book:${sha(root)}`;
    // Both images answer their own commit, so the health gate is fast for each of them; the red comes
    // from a smoke (the sign-in read), which is exactly the shape of tonight's failure.
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current === previous ? previous7 : current.split(':')[1]?.slice(0, 7) } }),
      signin: { status: 503 },
    });
    writeFileSync(join(stateDir, 'current'), previous, 'utf8');
    writeFileSync(join(stateDir, 'last-good-image'), `${previous}\n`, 'utf8');

    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      BOOK_SECRETS_DIR: secretsWithClientId(),
      FAKE_RUNNING_IMAGE: previous,
      FAKE_VOLUME_DIR: volumeFixture(),
      FAKE_MIGRATE_ON_UP: '1',
      // The boot migrated the volume: it is now past the image a rollback would put back.
      FAKE_VOLUME_SCHEMA: '33',
      GITHUB_ACTIONS: 'true',
    });

    expect(result.code, result.out).toBe(1);
    const recovery = lines(result.out, 'recovery:');
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain('recovery: roll-forward');
    expect(recovery[0]).toContain(versions(previous, 33, 32));
    // Prod keeps the NEW image: the swap that would have crashed it never happened.
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    const started = ups(log);
    expect(started, result.out).toHaveLength(1);
    expect(started[0]).toContain(`BOOK_IMAGE_TAG=${next}`);
    expect(result.out).not.toContain('rollback:');
    // The alert names what answers: the NEW image, degraded but alive.
    expect(result.out).toContain(`prod: serving ${next.split(':')[1]?.slice(0, 7) ?? ''}`);
    // Not green: last-good still names what served before, and the volume is on the record.
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(previous);
    expect(readFileSync(join(stateDir, 'volume-migrated'), 'utf8')).toBe('schema=33\n');
    // ONE annotation for the run, and it is the alert — not the log line of some layer in between.
    const annotations = lines(result.out, '::error::');
    expect(annotations, result.out).toHaveLength(1);
    expect(annotations[0]).toContain('FAILED at');
    const health = await fetch(`${siteUrl}/healthz`);
    expect(health.status, result.out).toBe(200);
  });
});

describe('BOOK-232: an older image on a newer volume is refused, and nothing is started', () => {
  it('b1) --rollback to a v32 image on a v33 volume: exit 1, both numbers, no up', async () => {
    const root = gitRoot();
    const stateDir = temp('book-232-state-');
    const bin = fakeDocker(stateDir);
    const v32 = `book:${commitSchema(root, 32)}`;
    const v33 = `book:${commitSchema(root, 33)}`;
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) } }),
    });
    writeFileSync(join(stateDir, 'current'), v33, 'utf8');
    writeFileSync(join(stateDir, 'previous-image'), `${v32}\n`, 'utf8');

    const env = { ...envFor(root, stateDir, bin, siteUrl), FAKE_RUNNING_IMAGE: v33, FAKE_VOLUME_SCHEMA: '33' };
    const result = await release(['--rollback'], env);

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain(versions(v32, 33, 32));
    expect(result.out).toContain('restore the pre-deploy dump instead');
    // Nothing was started: no `up`, no gate, and the image prod serves is the one it already had.
    expect(ups(readFileSync(join(stateDir, 'docker.log'), 'utf8')), result.out).toHaveLength(0);
    expect(existsSync(join(stateDir, 'last-good-image'))).toBe(false);
    expect(readFileSync(join(stateDir, 'previous-image'), 'utf8')).toBe(`${v32}\n`);

    // The dry run meets the same refusal: an operator sees it before touching anything.
    const dry = await release(['--rollback', '--dry-run'], env);
    expect(dry.code, dry.out).toBe(1);
    expect(dry.out).toContain(versions(v32, 33, 32));
    // The sentence matches what the path really does: it may create the lock source for its
    // one-shot, and nothing else.
    expect(dry.out).toContain('may create');
    expect(dry.out).not.toContain('this run takes nothing');
    expect(dry.out).not.toContain('dry run: would roll back');
    expect(ups(readFileSync(join(stateDir, 'docker.log'), 'utf8')), dry.out).toHaveLength(0);
  });

  it('b2) a failed release with no dump of its own: nothing swapped, and the alert says prod is down', async () => {
    const { root, previous, stateDir, bin } = pair();
    // The new image never answers, and no dump was named this run, so a dump-restore has nothing to
    // put back. The old rule would have restored whatever file it found in `backups/`.
    const siteUrl = await serveSite(stateDir, {
      healthz: () => ({ status: 503, body: {} }),
    });
    writeFileSync(join(stateDir, 'current'), previous, 'utf8');
    writeFileSync(join(stateDir, 'last-good-image'), `${previous}\n`, 'utf8');

    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      BOOK_HEALTH_TIMEOUT: '1',
      BOOK_HEALTH_GRACE: '0',
      FAKE_RUNNING_IMAGE: previous,
      FAKE_VOLUME_SCHEMA: '33',
      GITHUB_ACTIONS: 'true',
    });

    expect(result.code, result.out).toBe(1);
    const recovery = lines(result.out, 'recovery:');
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain('recovery: none');
    expect(recovery[0]).toContain('no pre-deploy dump was named this run');
    // Nothing was stopped, copied or swapped: an older image on this volume is the crash loop.
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    expect(ups(log), result.out).toHaveLength(1);
    expect(log).not.toContain('stop site engine writer');
    expect(log).not.toContain('cp /data/backups/');
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(previous);
    // The one alert says the truth an operator acts on: prod is NOT serving.
    const annotations = lines(result.out, '::error::');
    expect(annotations, result.out).toHaveLength(1);
    expect(annotations[0]).toContain('prod: NOT serving');
  });

  it('proceeds when the target understands the schema the volume is on', async () => {
    // The other half of the rule: an EQUAL pair of numbers is the ordinary swap, and the guard must
    // let a rollback through — a guard that refuses everything protects nothing real.
    const root = gitRoot();
    const stateDir = temp('book-232-state-');
    const bin = fakeDocker(stateDir);
    const v29 = `book:${commitSchema(root, 29)}`;
    const v30 = `book:${commitSchema(root, 30)}`;
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) } }),
    });
    writeFileSync(join(stateDir, 'current'), v29, 'utf8');
    writeFileSync(join(stateDir, 'previous-image'), `${v30}\n`, 'utf8');

    const result = await release(['--rollback'], {
      ...envFor(root, stateDir, bin, siteUrl),
      FAKE_RUNNING_IMAGE: v29,
      FAKE_VOLUME_SCHEMA: '30',
    });

    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`the volume is at v30 and ${v30} understands v30 — the swap cannot meet a future schema`);
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    const started = ups(log);
    expect(started, result.out).toHaveLength(1);
    expect(started[0]).toContain(`BOOK_IMAGE_TAG=${v30}`);
    // BOOK-232: the volume probe is a `compose run` on the service, so it runs on the image that would
    // SERVE — `rollback_to` points the tag at the target before it asks. A probe on the new image
    // would answer "this build understands v29" and hide a mismatch.
    const probes = lines(log, 'BOOK_SCHEMA');
    expect(probes.length, result.out).toBeGreaterThan(0);
    for (const probe of probes) expect(probe, result.out).toContain(`BOOK_IMAGE_TAG=${v30}`);
  });

  it('reads an image whose commit this clone no longer carries from the image itself', async () => {
    // An old tag whose commit was pruned is still an image that knows what it can open: the guard asks
    // the image (`docker run --entrypoint node … SCHEMA_VERSION`) instead of calling the swap unknown.
    const root = gitRoot();
    const stateDir = temp('book-232-state-');
    const bin = fakeDocker(stateDir);
    const gone = 'book:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) } }),
    });
    writeFileSync(join(stateDir, 'current'), `book:${sha(root)}`, 'utf8');
    writeFileSync(join(stateDir, 'previous-image'), `${gone}\n`, 'utf8');
    const base = { ...envFor(root, stateDir, bin, siteUrl), FAKE_RUNNING_IMAGE: `book:${sha(root)}`, FAKE_VOLUME_SCHEMA: '33' };

    // The image says v32 and the volume is v33: the same refusal, reached through the image probe.
    const refused = await release(['--rollback'], { ...base, FAKE_IMAGE_SCHEMA: '32' });
    expect(refused.code, refused.out).toBe(1);
    expect(refused.out).toContain(versions(gone, 33, 32));
    expect(ups(readFileSync(join(stateDir, 'docker.log'), 'utf8')), refused.out).toHaveLength(0);

    // The image says v33: the ordinary swap, and the probe really ran (`docker run` in the log).
    const allowed = await release(['--rollback'], { ...base, FAKE_IMAGE_SCHEMA: '33' });
    expect(allowed.code, allowed.out).toBe(0);
    expect(allowed.out).toContain(`the volume is at v33 and ${gone} understands v33`);
    expect(ups(readFileSync(join(stateDir, 'docker.log'), 'utf8')), allowed.out).toHaveLength(1);
  });
});

describe('BOOK-232: an unreadable number is a refusal, and the larger read wins', () => {
  it('no probe answer and no schema_version on /healthz: recovery none, nothing swapped, one alert', async () => {
    // The reviewer's case: the file's number is unreadable AND the site reports none. "Unknown" is
    // not "probably fine" — nothing is swapped, nothing restored, and one alert says so.
    const { root, previous, stateDir, bin } = pair();
    const siteUrl = await serveSite(stateDir, { healthz: () => ({ status: 503, body: {} }) });
    writeFileSync(join(stateDir, 'current'), previous, 'utf8');
    writeFileSync(join(stateDir, 'last-good-image'), `${previous}\n`, 'utf8');

    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      BOOK_HEALTH_TIMEOUT: '1',
      BOOK_HEALTH_GRACE: '0',
      FAKE_RUNNING_IMAGE: previous,
      // No FAKE_VOLUME_SCHEMA: the probe fails, and it says so instead of failing silently.
      GITHUB_ACTIONS: 'true',
    });

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('schema: the volume probe could not read book.db');
    const recovery = lines(result.out, 'recovery:');
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain('recovery: none');
    expect(recovery[0]).toContain('cannot be compared');
    const log = readFileSync(join(stateDir, 'docker.log'), 'utf8');
    expect(ups(log), result.out).toHaveLength(1);
    expect(log).not.toContain('stop site engine writer');
    expect(log).not.toContain('cp /data/backups/');
    expect(readFileSync(join(stateDir, 'last-good-image'), 'utf8').trim()).toBe(previous);
    expect(lines(result.out, '::error::'), result.out).toHaveLength(1);
  });

  it('takes the larger of the probe and /healthz, because the smaller one authorises the swap', async () => {
    // `meta.schema_version` is written AFTER the migrations, so a boot killed in between leaves it
    // below the file's `user_version`. The probe says 32, the site says 33: the swap goes to a v32
    // image, so it must be refused — 32 would have said "safe".
    const { root, previous, stateDir, bin } = pair();
    const previous7 = previous.split(':')[1]?.slice(0, 7) ?? '';
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({
        status: 200,
        body: {
          ok: true,
          commit: current === previous ? previous7 : current.split(':')[1]?.slice(0, 7),
          schema_version: 33,
        },
      }),
      signin: { status: 503 },
    });
    writeFileSync(join(stateDir, 'current'), previous, 'utf8');
    writeFileSync(join(stateDir, 'last-good-image'), `${previous}\n`, 'utf8');

    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      BOOK_SECRETS_DIR: secretsWithClientId(),
      FAKE_RUNNING_IMAGE: previous,
      FAKE_VOLUME_SCHEMA: '32',
    });

    expect(result.code, result.out).toBe(1);
    const recovery = lines(result.out, 'recovery:');
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain('recovery: roll-forward');
    expect(recovery[0]).toContain(versions(previous, 33, 32));
    expect(ups(readFileSync(join(stateDir, 'docker.log'), 'utf8')), result.out).toHaveLength(1);
  });
});

describe('BOOK-232: `--rollback` does not call a stack it never read "already serving"', () => {
  it('previous-image naming the running image is not green when nothing answers', async () => {
    // The review's case: the image a rollback would go to IS the one the containers were started
    // from, so the old code printed `already serving` and exited 0 without a single HTTP read — a
    // green run over a 502 (reachable after a rollback whose gate failed: the stack is down and the
    // record still names the image it tried).
    const root = gitRoot();
    const stateDir = temp('book-232-state-');
    const bin = fakeDocker(stateDir);
    // The deployed image is the clone's own v33 commit — the schema `gitRoot()` seeds.
    const running = `book:${sha(root)}`;
    const siteUrl = await serveSite(stateDir, { healthz: () => ({ status: 503, body: {} }) });
    writeFileSync(join(stateDir, 'current'), running, 'utf8');
    writeFileSync(join(stateDir, 'last-good-image'), `${running}\n`, 'utf8');

    const result = await release(['--rollback'], {
      ...envFor(root, stateDir, bin, siteUrl),
      FAKE_RUNNING_IMAGE: running,
      FAKE_VOLUME_SCHEMA: '33',
      BOOK_HEALTH_TIMEOUT: '1',
      BOOK_HEALTH_GRACE: '0',
    });

    expect(result.code, result.out).toBe(1);
    expect(result.out).not.toContain('already serving');
    expect(result.out).toContain('is what the stack was started from, but');
    expect(result.out).toContain('does not confirm it');
    // The guarded swap ran instead: the image that should be there is brought up and gated, and the
    // run is red because it does not answer — not green because a file said so.
    expect(ups(readFileSync(join(stateDir, 'docker.log'), 'utf8')), result.out).toHaveLength(1);
    expect(result.out).toContain('did not come up');
  });

  it('still reports "already serving" when /healthz confirms the commit', async () => {
    const root = gitRoot();
    const stateDir = temp('book-232-state-');
    const bin = fakeDocker(stateDir);
    // The deployed image is the clone's own v33 commit — the schema `gitRoot()` seeds.
    const running = `book:${sha(root)}`;
    const siteUrl = await serveSite(stateDir, {
      healthz: (current) => ({ status: 200, body: { ok: true, commit: current.split(':')[1]?.slice(0, 7) } }),
    });
    writeFileSync(join(stateDir, 'current'), running, 'utf8');
    writeFileSync(join(stateDir, 'last-good-image'), `${running}\n`, 'utf8');

    const result = await release(['--rollback'], {
      ...envFor(root, stateDir, bin, siteUrl),
      FAKE_RUNNING_IMAGE: running,
      FAKE_VOLUME_SCHEMA: '33',
    });

    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('already serving');
    expect(ups(readFileSync(join(stateDir, 'docker.log'), 'utf8')), result.out).toHaveLength(0);
  });
});

describe('BOOK-232: a probe that answers a non-version says so', () => {
  it('reports BOOK_SCHEMA=0 as "not a version", not as a file it could not open', async () => {
    // `BOOK_SCHEMA=0` is what an empty database (or a broken probe) prints: the marker was there, so
    // the wording must say that instead of "could not read book.db (exit 0)".
    const { root, previous, stateDir, bin } = pair();
    const siteUrl = await serveSite(stateDir, { healthz: () => ({ status: 503, body: {} }) });
    writeFileSync(join(stateDir, 'current'), previous, 'utf8');
    writeFileSync(join(stateDir, 'last-good-image'), `${previous}\n`, 'utf8');

    const result = await release(['--ref', 'HEAD'], {
      ...envFor(root, stateDir, bin, siteUrl),
      BOOK_HEALTH_TIMEOUT: '1',
      BOOK_HEALTH_GRACE: '0',
      FAKE_RUNNING_IMAGE: previous,
      FAKE_VOLUME_SCHEMA: '0',
    });

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('answered BOOK_SCHEMA=0, which is not a version');
    expect(result.out).not.toContain('could not read book.db');
    expect(lines(result.out, 'recovery:')[0]).toContain('recovery: none');
  });
});
