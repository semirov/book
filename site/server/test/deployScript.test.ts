/**
 * BOOK-119 hotfix — the deploy's lock and its failure reporting, as real processes (no deploy, no
 * launchd, no prod).
 *
 * The lock scenarios are *fixtures*, not races: the clock (`BOOK_NOW`), the liveness check
 * (`BOOK_KILL`) and the settle (`BOOK_SLEEP`) are injected, one lock directory is prepared before
 * the run, and one process reads it. Nothing here depends on which of two processes wins, on a pid
 * being readable inside a race window, or on the box's clock — the previous version of this file was
 * red on CI for exactly that reason (a test that asserts the machine's scheduling is a false red).
 *
 * The reporting half pins the two lines a dying deploy owes: one `FAILED at <step>: …` sentence and
 * one `failed` audit line. The 00:36 run of a492d1a ended with `lock: released` alone.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeAll, deploy, emptyRoot, fakes, failRun, gitRoot, holdLock, lib, temp } from './deployHarness.ts';

// Every test here spawns real processes: a loaded box stretches the clock, and a spawn is not a
// hang, so the timeout is about a wedged child.
vi.setConfig({ testTimeout: 30_000 });

afterEach(closeAll);

/** A fixed second: every lock scenario reads this instead of the box's clock. */
const CLOCK = 1_700_000_000;

/** The injected environment a lock scenario runs with (`kill` is a fake when liveness matters). */
function lockEnv(alive: boolean): { env: Record<string, string>; bin: string } {
  const bin = fakes({ kill: `exit ${alive ? 0 : 1}` });
  return { bin, env: { BOOK_NOW: String(CLOCK), BOOK_SLEEP: 'true', BOOK_KILL: join(bin, 'kill') } };
}

/** One lock directory, prepared before the run: `pid` and `since` as a holder leaves them. */
function lockDir(stateDir: string, pid: string | null, since: number): void {
  const lock = join(stateDir, 'deploy.lock');
  mkdirSync(lock, { recursive: true });
  if (pid !== null) writeFileSync(join(lock, 'pid'), `${pid}\n`, 'utf8');
  writeFileSync(join(lock, 'since'), `${since}\n`, 'utf8');
}

/** The lock's own script: take it (a refusal exits 3), say what it signed, release. */
const take = (stateDir: string): string =>
  [
    `STATE_DIR="${stateDir}"`,
    'LOCK_DIR="$STATE_DIR/deploy.lock"',
    'lock_acquire',
    'printf "self=%s pid=%s since=%s\\n" "$$" "$(cat "$LOCK_DIR/pid")" "$(cat "$LOCK_DIR/since")"',
    'lock_release',
  ].join('\n');

// --- the lock: five fixtures --------------------------------------------------------------------

describe('the lock: five fixtures, one process each', () => {
  it('a) no lock: it is taken, signed with this run’s pid and the injected second', async () => {
    const stateDir = temp();
    const { env } = lockEnv(true);
    const { code, out } = await lib(take(stateDir), env);

    expect(code, out).toBe(0);
    expect(out).toMatch(/lock: held \(pid \d+, .*deploy\.lock\)/u);
    expect(out, 'the directory carries this run’s pid and the injected second').toMatch(/self=(\d+) pid=\1 since=1700000000/u);
    expect(out).toMatch(/lock: released/u);
    expect(existsSync(join(stateDir, 'deploy.lock'))).toBe(false);
  });

  it('b) a fresh lock with a live pid refuses, naming pid, since and age', async () => {
    const stateDir = temp();
    lockDir(stateDir, '4242', CLOCK - 10);
    const { env } = lockEnv(true);
    const { code, out } = await lib(take(stateDir), env);

    expect(code, out).toBe(3);
    expect(out).toMatch(/another deploy is running: pid 4242 since 1699999990 \(age 10s, lock .*deploy\.lock\)/u);
    expect(out).toMatch(/refused with exit 3; nothing was checked out, built, published or restarted/u);
    // A refusal owns nothing: the holder's lock is still there.
    expect(readFileSync(join(stateDir, 'deploy.lock', 'pid'), 'utf8').trim()).toBe('4242');
  });

  it('c) a fresh lock whose pid cannot be read refuses, reporting the age, and keeps the lock', async () => {
    const stateDir = temp();
    lockDir(stateDir, null, CLOCK - 10); // no pid file at all
    const { env } = lockEnv(true);
    const { code, out } = await lib(take(stateDir), env);

    expect(code, out).toBe(3);
    expect(out).toMatch(/another deploy is starting: the lock at .*deploy\.lock has no readable pid \(since 1699999990, age 10s of the 2700s stale limit\)/u);

    // Garbage instead of a number is the same answer, and it says what it found.
    writeFileSync(join(stateDir, 'deploy.lock', 'pid'), 'not-a-pid\n', 'utf8');
    const garbage = await lib(take(stateDir), env);
    expect(garbage.code, garbage.out).toBe(3);
    expect(garbage.out).toMatch(/has no readable pid \(found 'not-a-pid', since 1699999990, age 10s/u);
  });

  it('d) a stale lock is taken over: the stale line names pid, since and the limit', async () => {
    const stateDir = temp();
    lockDir(stateDir, '4242', CLOCK - 3000);
    const { env } = lockEnv(false); // the pid answers dead
    const { code, out } = await lib(take(stateDir), env);

    expect(code, out).toBe(0);
    expect(out).toMatch(/lock: taking over a stale lock — pid 4242, since 1699997000, age 3000s \(limit 2700s\)/u);
    expect(out).toMatch(/lock: taken-over \(pid \d+, .*deploy\.lock\)/u);
    expect(out).toMatch(/self=(\d+) pid=\1 since=1700000000/u);
  });

  it('e) a stale lock nobody can name is still taken over: the age is the evidence', async () => {
    const stateDir = temp();
    lockDir(stateDir, null, CLOCK - 3000); // no pid, but long past the stale limit
    const { env } = lockEnv(false);
    const { code, out } = await lib(take(stateDir), env);

    expect(code, out).toBe(0);
    expect(out).toMatch(/lock: taking over a stale lock — pid none, since 1699997000, age 3000s \(limit 2700s\)/u);
    expect(out).toMatch(/lock: taken-over \(pid \d+/u);
    expect(out).toMatch(/self=(\d+) pid=\1 since=1700000000/u);
  });

  it('the deploy refuses a live holder with exit 3 (the liveness smoke, no race claimed)', () => {
    const stateDir = temp();
    holdLock(stateDir, process.pid, Math.floor(Date.now() / 1000));
    const { code, out } = deploy(['--phase', 'run', '--root', emptyRoot()], { BOOK_STATE_DIR: stateDir });

    expect(code, out).toBe(3);
    expect(out).toMatch(new RegExp(`another deploy is running: pid ${process.pid} since \\d+ \\(age 0s, lock `, 'u'));
    expect(out).toMatch(/refused with exit 3; nothing was checked out, built, published or restarted/u);
  });

  it('the deploy takes a lock that nobody holds, and releases it however the run ends', () => {
    const stateDir = temp();
    const { code, out } = deploy(['--phase', 'run', '--root', emptyRoot()], { BOOK_STATE_DIR: stateDir });

    expect(out).toMatch(/lock: held \(pid \d+/u);
    expect(code, out).not.toBe(0); // no clone there: it dies after the lock, before any build
    expect(out).toMatch(/lock: released/u);
    expect(existsSync(join(stateDir, 'deploy.lock'))).toBe(false);
  });

  it('keeps exit 2 for a usage error: the code table is not a suggestion', () => {
    const { code, out } = deploy(['--not-a-flag'], { BOOK_STATE_DIR: temp() });
    expect(code, out).toBe(2);
    expect(out).toMatch(/unknown argument: --not-a-flag/u);
  });
});

describe('the lock: a dry run', () => {
  it('takes nothing and says what a real run would meet', () => {
    const stateDir = temp();
    const lock = holdLock(stateDir, 4321, Math.floor(Date.now() / 1000));
    const { code, out } = deploy(['--dry-run', '--root', emptyRoot()], { BOOK_STATE_DIR: stateDir });

    expect(out).toMatch(/dry run: lock held by pid 4321 since \d+ \([01]s old, stale after 2700s\)/u);
    expect(out).toMatch(/this run takes nothing/u);
    expect(existsSync(lock)).toBe(true);
    expect(code, out).toBe(1); // no clone there — the note came before it
  });

  it('says the lock is free and takes nothing', () => {
    const stateDir = temp();
    const { out } = deploy(['--dry-run', '--root', emptyRoot()], { BOOK_STATE_DIR: stateDir });
    expect(out).toMatch(/dry run: lock free — this run takes nothing/u);
    expect(existsSync(join(stateDir, 'deploy.lock'))).toBe(false);
  });
});

// --- the reason a run died ----------------------------------------------------------------------

/** deploy.sh's reporters, installed the way deploy.sh installs them, with a fixed run state. */
function reporter(stateDir: string, step: string): string {
  return [
    `STATE_DIR="${stateDir}"`,
    'LOCK_DIR="$STATE_DIR/deploy.lock"',
    'AUDIT_LOG="$STATE_DIR/deploy-audit.log"',
    'MODE=deploy; REF=main',
    `STEP="${step}"`,
    'HEALTH=fail; HEALTH_MS=12345; BUDGET_MS=180000; BASELINE=down; RELEASE=abc-1',
    'mkdir -p "$STATE_DIR"',
    'say() { printf "%s deploy: %s\\n" "$(window_stamp)" "$*"; }',
    'audit() { mkdir -p "$STATE_DIR"; printf "%s %s\\n" "$(window_stamp)" "$*" >> "$AUDIT_LOG"; AUDIT_WRITTEN=1; }',
    'trap \'fail_on_err "$LINENO" "$BASH_COMMAND"\' ERR',
    'trap \'fail_on_exit; window_say "lock: released"\' EXIT',
  ].join('\n');
}

describe('a dying deploy says why, once, and leaves an audit line', () => {
  it('a utility dying inside the window prints one line, before the lock release, and audits once', async () => {
    const stateDir = temp();
    const bin = fakes({ 'burning-utility': 'echo "burning-utility: cannot measure" >&2; exit 7' });
    const { code, out } = await failRun(`${reporter(stateDir, 'health window')}\nburning-utility\n`, {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    });

    expect(code, out).not.toBe(0);
    const said = out.split('\n').filter((line) => line.includes('deploy: FAILED'));
    expect(said, out).toHaveLength(1);
    expect(said[0]).toMatch(
      /FAILED at health window: burning-utility \(line \d+\) — health=fail health_ms=12345 budget_ms=180000 baseline=down release=abc-1; nothing further will be restarted/u,
    );
    expect(out.indexOf('deploy: FAILED at health window:'), 'the reason comes before the lock`.release`').toBeLessThan(
      out.indexOf('lock: released'),
    );

    const audit = readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8').trim().split('\n');
    expect(audit, out).toHaveLength(1);
    expect(audit[0]).toMatch(
      / failed mode=deploy ref=main sha=unknown step=health window health=fail restart_ms=unknown budget_ms=180000 baseline=down release=abc-1 cause=burning-utility$/u,
    );
  });

  it('a status nobody explained still prints one line, and audits once', async () => {
    const stateDir = temp();
    const { code, out } = await failRun(`${reporter(stateDir, 'publish')}\n( exit 4 )\n`);

    expect(code, out).toBe(4);
    const said = out.split('\n').filter((line) => line.includes('deploy: FAILED'));
    expect(said, out).toHaveLength(1);
    expect(said[0]).toMatch(/FAILED at publish: no reason recorded — health=fail health_ms=12345 budget_ms=180000 baseline=down release=abc-1/u);
    expect(readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('a red deploy.sh run names its step and leaves exactly one failed audit line', () => {
    const stateDir = temp();
    const { code, out } = deploy(['--phase', 'run', '--root', gitRoot()], { BOOK_STATE_DIR: stateDir });

    expect(code, out).toBe(1);
    const said = out.split('\n').filter((line) => line.includes('deploy: FAILED'));
    expect(said, out).toHaveLength(1);
    expect(said[0]).toMatch(/FAILED: npm ci failed at /u);

    const audit = readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8').trim().split('\n');
    expect(audit, out).toHaveLength(1);
    expect(audit[0]).toMatch(/ failed mode=deploy ref=main sha=unknown step=gate: npm ci /u);
    // The lock is gone: the trap ran after the reason, and nothing was left behind.
    expect(existsSync(join(stateDir, 'deploy.lock'))).toBe(false);
  });

  it('a green run prints no FAILED and leaves exactly one ok audit line', async () => {
    const stateDir = temp();
    const { code, out } = await failRun(
      `${reporter(stateDir, 'frame')}\naudit "ok mode=deploy ref=main sha=abc1234 health=fast frame=ok restart=ran"\nexit 0\n`,
    );

    expect(code, out).toBe(0);
    expect(out).not.toMatch(/FAILED/u);
    const audit = readFileSync(join(stateDir, 'deploy-audit.log'), 'utf8').trim().split('\n');
    expect(audit, out).toHaveLength(1);
    expect(audit[0]).toMatch(/^.+ ok mode=deploy ref=main sha=abc1234 health=fast frame=ok restart=ran$/u);
  });
});
