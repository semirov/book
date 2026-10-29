/**
 * BOOK-217 — the launchd driver's recovery decision and the crash loop it must report.
 *
 * `compose-release.sh` is the drill's primary proof; this file pins the fallback runtime twice. In
 * the text: the volume is read around the restart, the recovery is consulted before the rollback's
 * `git checkout`, the fact is TRI-state, and the driver prints the one shared `lib.sh` sentence. In
 * driven runs (a real process, fake `launchctl`/`npm`, a real HTTP site): a migrated volume with a
 * serving build is a roll-forward; a failed listing or an unissued restart is `none`.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SITE_ROOT } from '../src/config.ts';
import { closeAll, failRun, fakes, temp } from './deployHarness.ts';
import { DUMP, LABEL, MOVED, commitSchema, logLines, runDeploy, stage } from './deployLaunchdHarness.ts';

vi.setConfig({ testTimeout: 90_000 });

afterEach(closeAll);

const script = readFileSync(join(SITE_ROOT, 'deploy', 'deploy.sh'), 'utf8');

/** The body of one shell function, up to the first line that closes it at column 0. */
function body(name: string): string {
  const start = script.indexOf(`${name}() {`);
  expect(start, name).toBeGreaterThan(0);
  return script.slice(start, script.indexOf('\n}\n', start));
}

describe('deploy.sh — the migration fact is read around the restart', () => {
  it('reads the volume after the publish/baseline, before the boot, and again after the window', () => {
    const baseline = script.indexOf('baseline_read "$URL" || true');
    const before = script.indexOf('crash_loop_before\nmigration_before');
    const restart = script.indexOf('REACHED_RESTART=1');
    const kickstart = script.indexOf('if service_kickstart "$SERVICE_LABEL" "$PLIST"; then');
    // The call site on the red path, not the definition: `migration_read` is defined above the run.
    const after = script.lastIndexOf('\nmigration_read\n');

    expect(baseline, 'the deploy has a baseline read').toBeGreaterThan(0);
    expect(before, 'migration_before is called at the restart').toBeGreaterThan(baseline);
    expect(restart, 'the restart is marked before the kickstart').toBeGreaterThan(before);
    expect(kickstart).toBeGreaterThan(restart);
    expect(after, 'the fact is read after the window').toBeGreaterThan(kickstart);
    // One read per run: the green record, the audit and the recovery name the same listing.
    expect(body('migration_read')).toContain('MIGRATION_READ=1');
  });

  it('is TRI-state: a listing that failed is `unknown`, never "not migrated" and never "a new dump"', () => {
    const dumps = body('volume_dumps');
    // The read's own status is the answer: no `|| true`, so a `backups/` that cannot be listed is a
    // failure and not an empty volume — while an ABSENT one (never dumped) is an empty listing.
    expect(dumps).toContain('if [ -d "$dir" ]; then');
    expect(dumps).toContain('out="$(ls -1 "$dir" 2>/dev/null)" || return 1');
    const before = body('migration_before');
    expect(before).toContain('DUMPS_KNOWN=1');
    expect(before).toContain('DUMPS_KNOWN=0');
    const after = body('migration_after');
    expect(after).toContain('MIGRATED="unknown"');
    expect(after).toContain('DUMPS_KNOWN" != "1"');
    expect(after).toContain('if ! now_dumps="$(volume_dumps)"; then');
    expect(after).toContain('MIGRATED=1');
    expect(after).toContain('MIGRATED=0');
    // The marker is not a signal any more: `boot.ts` never refreshes it, so nothing reads it.
    expect(script).not.toContain('volume_schema');
    expect(script).not.toContain('SCHEMA_BEFORE');
    expect(script).not.toContain('/.book-volume');
  });

  it('consults the fact before the rollback checkout, and the driver prints no recovery sentence of its own', () => {
    const decision = script.indexOf('recovery_choice "$MIGRATED" "$RECOVERY_SERVING"');
    const checkout = script.indexOf('git -C "$ROOT" checkout --quiet --detach "$PREV"');
    const none = script.indexOf('if [ "$RECOVERY_PICK" = "none" ]; then');

    expect(checkout).toBeGreaterThan(0);
    expect(decision).toBeGreaterThan(script.lastIndexOf('\nmigration_read\n'));
    expect(decision).toBeLessThan(checkout);
    // An unknown fact is its own outcome, before the shortcut and the checkout: nothing moves.
    expect(none).toBeGreaterThan(decision);
    expect(none).toBeLessThan(checkout);
    const unknown = script.slice(none, checkout);
    expect(unknown).toContain('recovery_line none "$MIGRATION_WHY"');
    expect(unknown).not.toContain('git -C "$ROOT" checkout');
    expect(unknown).not.toContain('service_kickstart');
    expect(unknown).toContain('die ');
    // One sentence source: the shared helper. A literal `say "recovery: …"` would be a second copy.
    expect(script).not.toMatch(/say "recovery:/u);
    expect(script).toContain('recovery_line "$RECOVERY_CHOICE" "$MIGRATION_WHY"');
    const block = script.slice(none, checkout);
    expect(block).toContain('case "$RECOVERY_PICK" in');
    expect(block).toContain('restore_dump');
    expect(block).toContain('recovery_line "$RECOVERY_CHOICE" "$MIGRATION_WHY"');
  });

  it('takes the serving build off a migrated volume only through a roll-forward', () => {
    const branch = script.slice(
      script.indexOf('if [ "$RECOVERY_PICK" = "roll-forward" ]'),
      script.indexOf('# The process already serves the previous commit'),
    );
    expect(branch).toContain('recovery_line "$RECOVERY_CHOICE" "$MIGRATION_WHY"');
    expect(branch).toContain('RECOVERY_CHOICE="roll-forward"');
    // Nothing is checked out, rebuilt or restarted, and `last-good` is not written.
    expect(branch).not.toContain('git -C "$ROOT" checkout');
    expect(branch).not.toContain('npm run build');
    expect(branch).not.toContain('service_kickstart');
    expect(branch).not.toContain('> "$STATE_DIR/last-good"'); // may say it; must not write it
    expect(branch).toContain('die ');
  });

  it('restores the dump with WAL and SHM first, a temp name in backups/, the service unloaded', () => {
    const restore = body('restore_dump');
    expect(restore).toContain('"${dest}-wal" "${dest}-shm"');
    expect(restore).toContain('cp "$dump" "$tmp"');
    expect(restore).toContain('mv "$tmp" "$dest"');
    // The temp file lives in the allow-listed `backups/`: beside `book.db` it is a refused stray.
    expect(restore).toContain('local tmp="${dir}/backups/.book.db.restoring"');
    // Only a name absent from the read before-list may be restored: an older dump is not this
    // run's, and writing it over the live book loses data.
    expect(restore).toContain('if printf \'%s\\n\' "$DUMPS_BEFORE" | grep -Fxq -- "$MIGRATION_DUMP"; then');
    // The volume is back on the pre-deploy schema, so the record a `--rollback` reads is cleared.
    expect(restore).toContain('rm -f "$VOLUME_MIGRATED_FILE"');
    expect(restore).toContain('volume-migrated is cleared');
    // A dump that is missing or a copy that fails is a hard failure, never a silent fall-through.
    expect(restore).toContain('return 1');
    const recovery = script.slice(script.indexOf('case "$RECOVERY_PICK" in'));
    expect(recovery.indexOf('recovery_bootout')).toBeLessThan(recovery.indexOf('restore_dump'));
    expect(body('recovery_bootout')).toContain('launchctl bootout "gui/$(id -u)/$SERVICE_LABEL"');
  });

  it('records the migrated volume and refuses a rollback onto it before anything is checked out', () => {
    // The record: `schema=<n>` or `schema=unknown`; nothing at all when the volume did not move.
    const record = body('record_volume_migrated');
    expect(record).toContain('[ "$MIGRATED" = "1" ] || return 0');
    expect(record).toContain('schema_of_commit');
    expect(record).toContain('schema=${schema:-unknown}');
    expect(record).toContain('>"$VOLUME_MIGRATED_FILE"');
    // The green path records too: a green deploy that migrated is still a migrated volume.
    const green = script.slice(script.indexOf('a green deploy that migrated is still a migrated volume'), script.indexOf('finish_green || true'));
    expect(green).toContain('migration_read');
    // The guard reads the record and the target's own constant, and refuses an older target.
    const guard = body('volume_migrated_guard');
    expect(guard).toContain('[ ! -f "$VOLUME_MIGRATED_FILE" ]');
    expect(guard).toContain('is_number "$recorded"');
    expect(guard).toContain('target_schema="$(schema_of_commit "${target##*:}")"');
    expect(guard).toContain('[ "$target_schema" -lt "$recorded" ]');
    expect(guard).toContain('die ');
    // Run in prepare, before the fetch and the checkout: a refusal changes nothing at all.
    const guardCall = script.indexOf('volume_migrated_guard "$TARGET"');
    expect(guardCall).toBeGreaterThan(0);
    expect(guardCall).toBeLessThan(script.indexOf('git -C "$ROOT" fetch --quiet --tags --prune origin'));
    expect(guardCall).toBeLessThan(script.indexOf('git -C "$ROOT" checkout --quiet --detach "$TARGET"'));
  });

  it('does not let the “already serving” shortcut skip a migrated volume', () => {
    // Old process answering over a moved volume is a recovery, not a skip: the shortcut needs 0.
    expect(script).toContain('[ "$MIGRATED" != "1" ] && [ -n "$PREV" ] && names_commit "$PLAIN_COMMIT" "$PREV"');
  });
});

describe('deploy.sh — the crash loop is the run’s to report', () => {
  it('reads the job’s runs before the restart and after a failed window, and says unknown when it cannot', () => {
    const before = body('crash_loop_before');
    expect(before).toContain('service_runs "$SERVICE_LABEL"');
    expect(before).toContain('RUNS_BEFORE');
    const check = body('crash_loop_check');
    expect(check).toContain('service_runs "$SERVICE_LABEL"');
    expect(check).toContain('RUNS_AFTER');
    expect(check).toContain('"$RUNS_AFTER" -gt "$RUNS_BEFORE"');
    expect(check).toContain('exit_nonzero');
    // A `print` that does not answer is `unknown`, never `fine`.
    expect(check).toContain('crash loop: unknown');
    // Sampled after a failed window, before the plain read that can upgrade the verdict.
    const sampled = script.indexOf('STEP="crash loop"\n  crash_loop_check');
    expect(script.indexOf('case "$HEALTH" in fail|stale)')).toBeLessThan(sampled);
    expect(sampled).toBeLessThan(script.indexOf('plain_verdict "$URL" "$BUILT_COMMIT" "$PREV" 3'));
  });

  it('prints the fixed sentence, audits crashloop=1 and annotates the workflow', () => {
    const line = body('crash_loop_line');
    expect(line).toContain(
      'CRASH LOOP: ${SERVICE_LABEL} resumed ${1:-unknown} time(s), last exit code ${2:-unknown} — the service cannot boot; prod is not serving',
    );
    expect(line).toContain('CRASHLOOP=1');
    expect(line).toContain('GITHUB_ACTIONS');
    expect(line).toContain('::error::');
    // Never a 0 with a respawning job: both late-success exits consult the flag.
    expect(script).toContain('[ "$CRASHLOOP" = "1" ]');
    expect(script).toContain('[ "$CRASHLOOP" != "1" ]');
    // A stale `last exit code` is not this run's death: it is compared with the pre-kickstart one.
    const check = body('crash_loop_check');
    expect(check).toContain('[ "$EXIT_AFTER" != "$EXIT_BEFORE" ]');
    expect(check).toContain('[ "$resumed" -ge 1 ]');
    expect(check).toContain('if [ -n "$resumed" ] && [ "$resumed" -ge 1 ] && [ "$EXIT_AFTER" != "$EXIT_BEFORE" ] && exit_nonzero "$EXIT_AFTER"; then');
  });
});

// The crash-loop functions as the file ships them, driven by bash with a fake `launchctl` — the rule
// is a comparison, and only a run can show which record speaks.
const CRASH_FNS = script.slice(script.indexOf('service_runs() {'), script.indexOf('# --- prepare: get the wanted commit'));

/** One run of `crash_loop_before` + `crash_loop_check` over two `launchctl print` answers. */
async function crashRun(before: string, after: string): Promise<string> {
  const dir = temp('book-217-crash-');
  writeFileSync(join(dir, 'before'), before, 'utf8');
  writeFileSync(join(dir, 'after'), after, 'utf8');
  const bin = fakes({
    launchctl: `case "$1" in
  print)
    n=$(( $(cat "${dir}/calls" 2>/dev/null || echo 0) + 1 ))
    printf '%s' "$n" > "${dir}/calls"
    if [ "$n" -eq 1 ]; then cat "${dir}/before"; else cat "${dir}/after"; fi ;;
esac
exit 0`,
  });
  const { out } = await failRun(
    [
      'SERVICE_LABEL=dev.book-site.test',
      'CRASHLOOP=0',
      'say() { printf "%s\\n" "$*"; }',
      CRASH_FNS,
      'crash_loop_before',
      'crash_loop_check',
      'printf "CRASHLOOP=%s\\n" "$CRASHLOOP"',
    ].join('\n'),
    { PATH: `${bin}:${process.env.PATH ?? ''}` },
  );
  return out;
}

const HEALTHY_JOB = '\tstate = running\n\truns = 3\n\tlast exit code = 0\n';

describe('deploy.sh — a non-zero exit code is evidence only when it appeared under this run', () => {
  it('does not report a code that was already there before the restart (a green run is not turned red)', async () => {
    const out = await crashRun('\tstate = running\n\truns = 3\n\tlast exit code = 1\n', '\tstate = running\n\truns = 4\n\tlast exit code = 1\n');
    expect(out).toContain('crash loop: after the failed window — runs=4, last exit code=1');
    expect(out).not.toContain('CRASH LOOP:');
    expect(out).toContain('CRASHLOOP=0');
  });

  it('does not report a stale code with no respawn either', async () => {
    const out = await crashRun('\tstate = running\n\truns = 3\n\tlast exit code = 1\n', '\tstate = running\n\truns = 3\n\tlast exit code = 1\n');
    expect(out).not.toContain('CRASH LOOP:');
    expect(out).toContain('CRASHLOOP=0');
  });

  it('reports a code that changed under this run, naming the respawn', async () => {
    const out = await crashRun(HEALTHY_JOB, '\tstate = running\n\truns = 4\n\tlast exit code = 1\n');
    expect(out).toContain(
      'CRASH LOOP: dev.book-site.test resumed 1 time(s), last exit code 1 — the service cannot boot; prod is not serving',
    );
    expect(out).toContain('CRASHLOOP=1');
  });

  it('still reports a respawn without a code of its own (the deploy’s own kickstart is one run)', async () => {
    const out = await crashRun(HEALTHY_JOB, '\tstate = running\n\truns = 5\n\tlast exit code = 0\n');
    expect(out).toContain('CRASH LOOP: dev.book-site.test resumed 2 time(s), last exit code 0');
    expect(out).toContain('CRASHLOOP=1');
  });

  it('says unknown, and claims nothing, when `launchctl print` does not answer the second time', async () => {
    const dir = temp('book-217-crash-');
    const bin = fakes({
      launchctl: `if [ "$1" = print ]; then
  n=$(( $(cat "${dir}/calls" 2>/dev/null || echo 0) + 1 ))
  printf '%s' "$n" > "${dir}/calls"
  if [ "$n" -eq 1 ]; then printf '\\tstate = running\\n\\truns = 3\\n'; exit 0; fi
  printf 'no such service\\n' >&2; exit 113
fi
exit 0`,
    });
    const { out } = await failRun(
      [
        'SERVICE_LABEL=dev.book-site.test',
        'CRASHLOOP=0',
        'say() { printf "%s\\n" "$*"; }',
        CRASH_FNS,
        'crash_loop_before',
        'crash_loop_check',
        'printf "CRASHLOOP=%s\\n" "$CRASHLOOP"',
      ].join('\n'),
      { PATH: `${bin}:${process.env.PATH ?? ''}` },
    );
    expect(out).toContain('crash loop: unknown');
    expect(out).not.toContain('CRASH LOOP:');
    expect(out).toContain('CRASHLOOP=0');
  });
});

// `restore_dump` as the file ships it, driven on a real volume: a wrong acceptance is data loss.
const RESTORE_FNS = script.slice(script.indexOf('restore_dump() {'), script.indexOf('# --- the migration record'));

async function restoreRun(dumps: string[], candidate: string): Promise<{ code: number | null; out: string; volume: string; state: string }> {
  const volume = temp('book-217-restore-');
  const state = temp('book-217-restore-state-');
  mkdirSync(join(volume, 'backups'), { recursive: true });
  // The candidate is on disk (the boot wrote it after the before-read) even when the list is older.
  for (const name of new Set([...dumps, candidate])) writeFileSync(join(volume, 'backups', name), `DUMP ${name}\n`, 'utf8');
  writeFileSync(join(volume, 'book.db'), 'LIVE\n', 'utf8');
  writeFileSync(join(volume, 'book.db-wal'), 'WAL\n', 'utf8');
  writeFileSync(join(state, 'volume-migrated'), 'schema=30\n', 'utf8');
  const { code, out } = await failRun(
    [
      `DATA_DIR_SITE="${volume}"`,
      `VOLUME_MIGRATED_FILE="${state}/volume-migrated"`,
      `MIGRATION_DUMP="${candidate}"`,
      `DUMPS_BEFORE="${dumps.join('\n')}"`,
      'say() { printf "%s\\n" "$*"; }',
      RESTORE_FNS,
      'restore_dump',
    ].join('\n'),
  );
  return { code, out, volume, state };
}

describe('deploy.sh — a dump restore never writes an old copy over the live book', () => {
  it('refuses a candidate that was already in the before-list, and leaves book.db alone', async () => {
    const old = 'pre-v28-20261001T000000Z.db';
    const { code, out, volume, state } = await restoreRun([old], old);
    expect(code, out).not.toBe(0);
    expect(out).toContain(`backups/${old} was already in the volume before this run`);
    expect(readFileSync(join(volume, 'book.db'), 'utf8')).toBe('LIVE\n');
    expect(existsSync(join(state, 'volume-migrated'))).toBe(true);
  });

  it('restores only this run’s dump: WAL removed, no temp file left in backups/, the record cleared', async () => {
    const old = 'pre-v28-20261001T000000Z.db';
    const { code, out, volume, state } = await restoreRun([old], DUMP);
    expect(code, out).toBe(0);
    expect(readFileSync(join(volume, 'book.db'), 'utf8')).toBe(`DUMP ${DUMP}\n`);
    expect(existsSync(join(volume, 'book.db-wal'))).toBe(false);
    expect(readdirSync(join(volume, 'backups')).sort()).toEqual([old, DUMP].sort());
    expect(existsSync(join(state, 'volume-migrated'))).toBe(false);
    // The old dump stays where it was: the boot prunes, the deploy does not delete.
    expect(existsSync(join(volume, 'backups', DUMP))).toBe(true);
  });
});

describe('deploy.sh — the audit names what happened', () => {
  it('every rollback/roll-forward/failed line carries recovery= and crashloop=', () => {
    const red = script
      .split('\n')
      .filter((line) => line.includes('audit "') && /(roll-forward|rolled-back|rollback-refused|rollback-failed)/u.test(line));
    expect(red.length, script).toBeGreaterThanOrEqual(9);
    for (const line of red) {
      expect(line, line).toContain('recovery=');
      expect(line, line).toContain('crashloop=');
    }
  });

  it('the header states the recovery rule, the crash-loop line and this driver’s order', () => {
    const header = script.slice(0, script.indexOf('set -eEuo pipefail'));
    expect(header).toContain('THE RECOVERY IS DECIDED FROM ONE FACT');
    expect(header).toContain('`recovery:` line');
    expect(header).toContain('CRASH LOOP:');
    expect(header).toContain('before the build and before `kickstart`');
  });
});

describe('BOOK-217: a migrated volume with a serving build is a roll-forward, not an image rollback', () => {
  it('leaves the build serving: no checkout, no rebuild, one recovery line, exit 1, last-good untouched', async () => {
    const s = await stage();
    const result = await runDeploy(['--phase', 'run', '--root', s.root], s.env);

    expect(result.code, result.out).toBe(1);
    // The fact, then exactly one line, and it is the shared roll-forward sentence.
    expect(result.out).toContain(`migration: the volume moved under this run — ${MOVED}`);
    const recovery = result.out.split('\n').filter((line) => line.includes('recovery:'));
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain(`recovery: roll-forward — a migration ran (${MOVED})`);
    expect(recovery[0]).toContain('the new image keeps serving (degraded, alive)');
    // The previous build was not put back: no rollback, no second build, no second restart.
    expect(result.out).not.toContain('rolling back to');
    expect(execFileSync('git', ['-C', s.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(s.head);
    const npm = logLines(join(s.stateDir, 'npm.log'));
    expect(npm.filter((line) => line.includes('run build')), result.out).toHaveLength(1);
    expect(npm.filter((line) => line.includes('release:publish')), result.out).toHaveLength(1);
    expect(logLines(join(s.stateDir, 'launchctl.log')).filter((line) => line.startsWith('kickstart')), result.out).toHaveLength(1);
    // A roll-forward is not green: `last-good` still names what served before this release.
    expect(readFileSync(join(s.stateDir, 'last-good'), 'utf8')).toBe('knowngood\n');
    expect(readFileSync(join(s.stateDir, 'deploy-audit.log'), 'utf8')).toMatch(/roll-forward .*recovery=roll-forward crashloop=0/u);
    const health = await fetch(s.url);
    expect(health.status, result.out).toBe(200);
  });
});

describe('BOOK-217: a listing that failed is `none` — nothing is swapped, nothing is restored', () => {
  it('stops before the checkout with the one sentence that names the failed read', async () => {
    // `backups/` is there but unreadable (mode 0), so the fact is `unknown` and both ways of
    // rounding it are unsafe. The new build answers and the frame is red — the shape that would
    // otherwise roll the previous build onto a volume nobody read.
    const s = await stage({ boot: '' });
    chmodSync(join(s.dataDir, 'backups'), 0o000);
    const result = await runDeploy(['--phase', 'run', '--root', s.root], s.env);

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('migration: before the restart — backups/ could not be listed');
    expect(result.out).toContain('migration: unknown — the listing of backups/ before the restart failed');
    const recovery = result.out.split('\n').filter((line) => line.includes('recovery:'));
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain(
      'recovery: none — the listing of backups/ before the restart failed, so whether the boot migrated the volume cannot be known; nothing was rolled back and nothing was restored, a human must look',
    );
    // Nothing was put back, restored or restarted a second time.
    expect(result.out).not.toContain('rolling back to');
    expect(execFileSync('git', ['-C', s.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(s.head);
    const npm = logLines(join(s.stateDir, 'npm.log'));
    expect(npm.filter((line) => line.includes('run build')), result.out).toHaveLength(1);
    const launchctl = logLines(join(s.stateDir, 'launchctl.log'));
    expect(launchctl.filter((line) => line.startsWith('kickstart')), result.out).toHaveLength(1);
    // The service was not unloaded for a restore: no dump went over `book.db`.
    expect(launchctl.filter((line) => line.startsWith('bootout') && line.includes(LABEL)), result.out).toHaveLength(0);
    expect(readFileSync(join(s.dataDir, 'book.db'), 'utf8')).toBe('BOOK-DB-v29\n');
    expect(readFileSync(join(s.stateDir, 'last-good'), 'utf8')).toBe('knowngood\n');
    // No record either: the volume was not seen to move.
    expect(existsSync(join(s.stateDir, 'volume-migrated'))).toBe(false);
    expect(readFileSync(join(s.stateDir, 'deploy-audit.log'), 'utf8')).toMatch(/recovery=none crashloop=0/u);
  });
});
describe('BOOK-217: a volume that never dumped is an empty listing, not a failed read', () => {
  it('no backups/ at all: image-rollback, and the previous build is checked out, rebuilt and restarted', async () => {
    // The boot creates `backups/` only when it dumps, so a volume that never migrated has none: "no
    // dump" is a fact, and the release takes the ordinary image rollback. The site answers a commit
    // naming neither build, so the window is red.
    const s = await stage({ backups: 'absent', boot: '', answer: 'deadbee' });
    // The build this deploy ships is one commit past the build that was serving.
    commitSchema(s.root, 30);
    writeFileSync(join(s.stateDir, 'previous'), `${s.head}\n`, 'utf8');

    const result = await runDeploy(['--phase', 'run', '--root', s.root], s.env);

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('migration: before the restart — 0 dump(s) in backups/');
    expect(result.out).toContain('migration: none — no new dump in backups/, so the boot ran no DDL');
    expect(result.out).not.toContain('migration: unknown');
    const recovery = result.out.split('\n').filter((line) => line.includes('recovery:'));
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain('recovery: image-rollback');
    // The previous build goes back: its commit is checked out, built and restarted a second time.
    expect(result.out).toContain('rolling back to');
    expect(execFileSync('git', ['-C', s.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(s.head);
    expect(logLines(join(s.stateDir, 'npm.log')).filter((line) => line.includes('run build')), result.out).toHaveLength(2);
    expect(logLines(join(s.stateDir, 'launchctl.log')).filter((line) => line.startsWith('kickstart')), result.out).toHaveLength(2);
    expect(readFileSync(join(s.stateDir, 'deploy-audit.log'), 'utf8')).toMatch(/recovery=image-rollback/u);
  });
});

describe('BOOK-217: a restart that was never issued still names its recovery', () => {
  it('prints `recovery: none` for the boot that never ran, and leaves prod alone', async () => {
    const s = await stage({ answer: 'deadbee' });
    // `kickstart` fails even after the bootstrap, so the job is never signalled and no boot runs.
    const bin = fakes({ launchctl: 'exit 1' });
    const result = await runDeploy(['--phase', 'run', '--root', s.root], { ...s.env, PATH: `${bin}:${s.env.PATH}` });

    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('the restart could not be issued');
    const recovery = result.out.split('\n').filter((line) => line.includes('recovery:'));
    expect(recovery, result.out).toHaveLength(1);
    expect(recovery[0]).toContain('recovery: none — the restart was never issued, so no boot ran and nothing was migrated');
    // Nothing was rolled back, rebuilt or booted a second time, and the audit names the same line.
    expect(result.out).not.toContain('rolling back to');
    expect(logLines(join(s.stateDir, 'launchctl.log'))).toHaveLength(0);
    expect(readFileSync(join(s.stateDir, 'deploy-audit.log'), 'utf8')).toMatch(/recovery=none crashloop=0/u);
  });
});

describe('BOOK-217: a migration is recorded, and `--rollback` refuses an older build on it', () => {
  it('writes schema=<n> on green, then refuses the previous build before it is fetched or checked out', async () => {
    const s = await stage({ frame: 0 });
    // The build that served before (v29) and the build this deploy ships (v30), both commits.
    const v29 = commitSchema(s.root, 29);
    const v30 = commitSchema(s.root, 30);
    const green = await runDeploy(['--phase', 'run', '--root', s.root], s.env);
    expect(green.code, green.out).toBe(0);
    expect(green.out).toContain('volume-migrated: recorded schema=30');
    expect(readFileSync(join(s.stateDir, 'volume-migrated'), 'utf8')).toBe('schema=30\n');
    // Rolling back to the build that understands v29 on a v30 volume is the crash loop: refused.
    writeFileSync(join(s.stateDir, 'last-good'), `${v29}\n`, 'utf8');
    const before = logLines(join(s.stateDir, 'launchctl.log')).length;
    const refused = await runDeploy(['--rollback', '--dry-run', '--root', s.root], s.env);

    expect(refused.code, refused.out).toBe(1);
    expect(refused.out).toContain('the volume is at schema v30 (a deploy migrated it) and the build being rolled back to understands v29');
    expect(refused.out).toContain('nothing was fetched, checked out or built');
    expect(refused.out).not.toContain('fetching');
    expect(refused.out).not.toContain('rolling back to');
    expect(execFileSync('git', ['-C', s.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(v30);
    expect(logLines(join(s.stateDir, 'launchctl.log'))).toHaveLength(before);

    // A record without a number says so and keeps today's behaviour (it reaches the fetch, which a
    // clone with no origin cannot do — the proof that the guard let it through).
    writeFileSync(join(s.stateDir, 'volume-migrated'), 'schema=unknown\n', 'utf8');
    const unknown = await runDeploy(['--rollback', '--dry-run', '--root', s.root], s.env);
    expect(unknown.out).toContain('volume-migrated: the record says schema=unknown, not a number');
    expect(unknown.out).toContain('fetching');
  });
});
