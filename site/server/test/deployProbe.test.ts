/**
 * BOOK-119 hotfix — the deploy's *measurement*, as real processes: one plain-curl probe for the
 * baseline and the window, the evidence before a red verdict, the load guard and the recovery of a
 * stopped service.
 *
 * The probe is exercised against a real HTTP server and the real `curl`; `launchctl`, `sysctl` and
 * `uptime` are fakes on `PATH`, because the real ones belong to prod.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OK, SILENT, closeAll, fakes, failRun, lib, serve, temp } from './deployHarness.ts';

// Every test here spawns real processes: a loaded box stretches the clock, and a spawn is not a
// hang, so the timeout is about a wedged child.
vi.setConfig({ testTimeout: 30_000 });

afterEach(closeAll);


describe('the baseline: the same probe as the window', () => {
  it('is `up` on a real 200, with the moment and the commit it served', async () => {
    const url = await serve(() => OK('prev000'));
    const { code, out } = await lib(
      [`baseline_read "${url}"`, 'printf "baseline=%s status=%s at=%s commit=%s err=%s\\n" "$BASELINE" "$BASELINE_STATUS" "$BASELINE_AT" "$BASELINE_COMMIT" "$BASELINE_ERR"'].join('\n'),
    );

    expect(code, out).toBe(0);
    expect(out).toMatch(/baseline=up status=200 at=\d{10,} commit=prev000 err=$/mu);
  });

  it('is `down` only when the site answered something that is not a 200', async () => {
    const url = await serve(() => ({ status: 503, body: { ok: false } }));
    const { code, out } = await lib(
      [`baseline_read "${url}"`, 'printf "baseline=%s status=%s at=%s err=%s\\n" "$BASELINE" "$BASELINE_STATUS" "$BASELINE_AT" "$BASELINE_ERR"'].join('\n'),
    );

    expect(code, out).toBe(0);
    expect(out).toMatch(/baseline=down status=503 at=0 err=none/u);
  });

  it('is `unknown` — not `down` — when the read could not be made, with curl’s exit code', async () => {
    const { code, out } = await lib(
      [`baseline_read "${SILENT}" || true`, 'printf "baseline=%s status=%s at=%s err=%s msg=%s\\n" "$BASELINE" "$BASELINE_STATUS" "$BASELINE_AT" "$BASELINE_ERR" "$BASELINE_MSG"'].join('\n'),
    );

    // `baseline_read` answers 1 ("could not be measured") and the harness swallows it with `|| true`.
    expect(code, out).toBe(0);
    expect(out).toMatch(/baseline=unknown status=0 at=0 err=7 msg=curl: \(7\) Failed to connect/u);
  });
});

// --- one probe: the window ----------------------------------------------------------------------

describe('the window: a real elapsed time, always', () => {
  it('reads once even when it is entered long after the budget began (the reviewer’s repro)', async () => {
    const url = await serve(() => ({ status: 503, body: { ok: false } }));
    const since = Date.now() - 9_000;
    const { code, out } = await lib(
      [
        'BUDGET_MS=2000; GRACE_MS=500',
        `window_read "${url}" build12 "" ${since}`,
        'printf "health=%s ms=%s first_at=%s reads=%s\\n" "$HEALTH" "$HEALTH_MS" "$FIRST_AT" "$WINDOW_READS"',
      ].join('\n'),
    );

    expect(code, out).toBe(0);
    expect(out, `reads: ${out}`).toMatch(/reads=[1-9]/u);
    expect(out).toMatch(/health=fail/u);
    const ms = Number(/ms=(\d+)/u.exec(out)?.[1] ?? '0');
    expect(ms, `the elapsed time is the window’s, not zero: ${out}`).toBeGreaterThanOrEqual(9_000);
  });

  it('reports a fast success with the answer’s own moment', async () => {
    const url = await serve(() => OK('build12'));
    const since = Date.now();
    const { code, out } = await lib(
      [
        'BUDGET_MS=5000; GRACE_MS=500',
        `window_read "${url}" build12 "" ${since}`,
        'printf "health=%s ms=%s first_at=%s reads=%s\\n" "$HEALTH" "$HEALTH_MS" "$FIRST_AT" "$WINDOW_READS"',
      ].join('\n'),
    );

    expect(code, out).toBe(0);
    expect(out).toMatch(/health=fast/u);
    expect(out).toMatch(/reads=[1-9]/u);
    expect(out).toMatch(/first_at=\d{10,}/u);
  });

  it('spends the whole budget before it calls silence `fail`', async () => {
    const url = await serve(() => ({ status: 503, body: { ok: false } }));
    const since = Date.now();
    const { code, out } = await lib(
      [
        'BUDGET_MS=400; GRACE_MS=200',
        `window_read "${url}" build12 "" ${since}`,
        'printf "health=%s ms=%s first_at=%s\\n" "$HEALTH" "$HEALTH_MS" "$FIRST_AT"',
      ].join('\n'),
    );

    expect(code, out).toBe(0);
    expect(out).toMatch(/health=fail/u);
    expect(out).toMatch(/first_at=0/u);
    const ms = Number(/ms=(\d+)/u.exec(out)?.[1] ?? '0');
    expect(ms, out).toBeGreaterThanOrEqual(350);
  });

  it('calls the previous build answering `stale`, not `fail`', async () => {
    const url = await serve(() => OK('prev000'));
    const { code, out } = await lib(
      [
        'BUDGET_MS=300; GRACE_MS=600',
        `window_read "${url}" build12 prev000 ${Date.now()}`,
        'printf "health=%s commit=%s\\n" "$HEALTH" "$REPORTED_COMMIT"',
      ].join('\n'),
    );

    expect(code, out).toBe(0);
    expect(out).toMatch(/health=stale commit=prev000/u);
  });

  it('measures a `fail` that did not spend the budget again instead of returning it', async () => {
    const body = [
      'BUDGET_MS=2000; GRACE_MS=500',
      'READS=0',
      // A window that answers at once with nothing: the shape of "fail after 0 ms".
      'window_read() { READS=$((READS + 1)); HEALTH=fail; HEALTH_MS=1; FIRST_AT=0; REPORTED_COMMIT=""; WINDOW_READS=1; }',
      `window_settle "${SILENT}" build12 "" ${Date.now()}`,
      'printf "reads=%s health=%s ms=%s\\n" "$READS" "$HEALTH" "$HEALTH_MS"',
    ].join('\n');
    const { code, out } = await lib(body);

    expect(code, out).toBe(0);
    expect(out).toMatch(/window: health=fail after 1 ms is less than the 2000 ms budget — not a verdict/u);
    // One retry would be enough for the real window (it spends the budget); the bound is 3.
    expect(out, 'the guard measured again').toMatch(/reads=[23]/u);

    // A fail that did spend the budget is a verdict and is not measured again.
    const settled = await lib(
      [
        'BUDGET_MS=2000; GRACE_MS=500',
        'READS=0',
        'window_read() { READS=$((READS + 1)); HEALTH=fail; HEALTH_MS=2000; FIRST_AT=0; WINDOW_READS=1; }',
        `window_settle "${SILENT}" build12 "" ${Date.now()}`,
        'printf "reads=%s health=%s\\n" "$READS" "$HEALTH"',
      ].join('\n'),
    );
    expect(settled.out).toMatch(/reads=1/u);
  });
});

// --- the evidence before a red verdict ----------------------------------------------------------

describe('the plain read: it upgrades a verdict and stamps its own moment', () => {
  it('upgrades to late — with a moment, so the audit cannot print restart_ms=unknown', async () => {
    const url = await serve(() => OK('build12'));
    const since = Date.now() - 500;
    const { code, out } = await lib(
      [
        'HEALTH=fail; HEALTH_MS=0; FIRST_AT=0; SLOW=0; REPORTED_COMMIT=""; PLAIN_COMMIT=""',
        `KICKSTART_T0=${since}`,
        `plain_verdict "${url}" build12 prev000`,
        'printf "health=%s ms=%s first_at=%s slow=%s plain=%s\\n" "$HEALTH" "$HEALTH_MS" "$FIRST_AT" "$SLOW" "$PLAIN_COMMIT"',
      ].join('\n'),
    );

    expect(code, out).toBe(0);
    expect(out).toMatch(/plain read: prod reports build12 \(200/u);
    expect(out).toMatch(/health=late ms=\d+ first_at=\d+ slow=1 plain=build12/u);
    const first = Number(/first_at=(\d+)/u.exec(out)?.[1] ?? '0');
    expect(first, out).toBeGreaterThanOrEqual(since);
    const ms = Number(/ms=(\d+)/u.exec(out)?.[1] ?? '0');
    expect(ms, out).toBeGreaterThanOrEqual(500);
  });

  it('calls the previous build `stale`, and keeps the verdict when nothing answers', async () => {
    const prev = await serve(() => OK('prev000'));
    const stale = await lib(
      [
        'HEALTH=fail; HEALTH_MS=0; FIRST_AT=0; SLOW=0; REPORTED_COMMIT=""',
        `KICKSTART_T0=${Date.now()}`,
        `plain_verdict "${prev}" build12 prev000`,
        'printf "health=%s commit=%s plain=%s\\n" "$HEALTH" "$REPORTED_COMMIT" "$PLAIN_COMMIT"',
      ].join('\n'),
    );
    expect(stale.out).toMatch(/health=stale commit=prev000 plain=prev000/u);

    const silent = await lib(
      [
        'HEALTH=fail; HEALTH_MS=900; FIRST_AT=0; SLOW=0; REPORTED_COMMIT=""',
        `KICKSTART_T0=${Date.now()}`,
        `if plain_verdict "${SILENT}" build12 prev000 3; then echo answered; fi`,
        'printf "health=%s ms=%s plain=%s\\n" "$HEALTH" "$HEALTH_MS" "$PLAIN_COMMIT"',
      ].join('\n'),
    );
    expect(silent.out).toMatch(/plain read: no answer .* after 3 read\(s\) \(err=7/u);
    expect(silent.out).toMatch(/health=fail ms=900/u);
    expect(silent.out).not.toMatch(/answered/u);
  });
});

describe('the rollback gate: two independent negatives', () => {
  const gate = (ms: number, plain: string): Promise<{ code: number | null; out: string }> =>
    lib(
      [
        'BUDGET_MS=2000; HEALTH=stale',
        `if rollback_allowed ${ms} 2000 "${plain}" build12; then echo allowed; else printf "refused: %s\\n" "$ROLLBACK_WHY"; fi`,
      ].join('\n'),
    );

  it('allows a rollback when the budget is spent and prod does not serve the build', async () => {
    const { out } = await gate(2000, '');
    expect(out).toMatch(/allowed/u);

    const other = await gate(2400, 'other99');
    expect(other.out).toMatch(/allowed/u);
  });

  it('refuses when prod serves the build of this run — there is nothing to roll back to', async () => {
    const { out } = await gate(2400, 'build12');
    expect(out).toMatch(/refused: prod answers build12, the build of this run/u);
  });

  it('refuses when the window has not spent its budget', async () => {
    const { out } = await gate(0, '');
    expect(out).toMatch(/refused: the window spent 0 ms of its 2000 ms budget/u);
  });
});

// --- the load guard -----------------------------------------------------------------------------

describe('the load guard: a number that is there is never `unknown`', () => {
  const run = (bin: string): Promise<{ code: number | null; out: string }> =>
    lib(
      [
        'load_read 2.0',
        'printf "load=%s cores=%s per_core=%s above=%s source=%s msg=%s\\n" "$LOAD_L1" "$LOAD_CORES" "$LOAD_PER_CORE" "$LOAD_ABOVE" "$LOAD_SOURCE" "$LOAD_MSG"',
      ].join('\n'),
      { PATH: `${bin}:${process.env.PATH ?? ''}` },
    );

  it('parses `sysctl -n vm.loadavg` — `{ 34.09 47.37 44.40 }` is a load of 34.09', async () => {
    const bin = fakes({
      sysctl: 'case "$2" in\n  vm.loadavg) echo "{ 34.09 47.37 44.40 }" ;;\n  hw.ncpu) echo 10 ;;\n  *) echo "sysctl: unknown oid $2" >&2; exit 1 ;;\nesac',
    });
    const { code, out } = await run(bin);
    expect(code, out).toBe(0);
    expect(out).toMatch(/load=34.09 cores=10 per_core=3.41 above=1 source=sysctl/u);
  });

  it('reads a quiet box as 0.00, under the threshold', async () => {
    const bin = fakes({
      sysctl: 'case "$2" in\n  vm.loadavg) echo "{ 0.00 0.06 0.12 }" ;;\n  hw.ncpu) echo 8 ;;\n  *) exit 1 ;;\nesac',
    });
    const { out } = await run(bin);
    expect(out).toMatch(/load=0.00 cores=8 per_core=0.00 above=0 source=sysctl/u);
  });

  it('falls back to `uptime` for the load and still reads the cores from sysctl', async () => {
    // Both numbers are injected: the cores fall through to the real `getconf` otherwise, and the
    // test would then assert the machine it runs on (10 cores on the Mac mini, 4 on CI).
    const bin = fakes({
      sysctl: 'case "$2" in\n  vm.loadavg) echo "sysctl: unknown oid vm.loadavg" >&2; exit 1 ;;\n  hw.ncpu) echo 6 ;;\nesac',
      uptime: 'echo "20:12  up 3 days,  4:11, 5 users, load averages: 1.50 2.00 2.50"',
    });
    const { out } = await run(bin);
    expect(out).toMatch(/load=1.50 cores=6 per_core=0.25 above=0 source=uptime msg=sysctl: unknown oid vm.loadavg/u);
  });

  it('reads the cores from `getconf` when sysctl answers for neither oid (the Linux shape)', async () => {
    // A box without `sysctl -n vm.loadavg` (and without `hw.ncpu`): load from `uptime`, cores from
    // `getconf`, and neither number is the host's.
    const bin = fakes({
      sysctl: 'echo "sysctl: unknown oid $2" >&2; exit 1',
      getconf: 'echo 4',
      uptime: 'echo " 20:12:00 up 3 days,  4:11,  5 users,  load average: 1.50, 2.00, 2.50"',
    });
    const { out } = await run(bin);
    expect(out).toMatch(/load=1.50 cores=4 per_core=0.38 above=0 source=uptime msg=sysctl: unknown oid vm.loadavg/u);
  });

  it('says `unavailable` — with sysctl’s own line — only when both fail', async () => {
    const bin = fakes({
      sysctl: 'echo "sysctl: class name not found: vm" >&2; exit 1',
      uptime: 'echo "uptime: not available" >&2; exit 1',
    });
    const { out } = await run(bin);
    expect(out).toMatch(/load=unavailable/u);
    expect(out).toMatch(/per_core=unavailable/u);
    expect(out).toMatch(/msg=sysctl: class name not found: vm/u);
    expect(out).not.toMatch(/load=unknown/u);
  });
});

// --- a stopped service --------------------------------------------------------------------------

describe('kickstart: a job that is not loaded is bootstrapped from its plist', () => {
  it('bootstraps once and retries, and says which path it took', async () => {
    const stateDir = temp();
    const plist = join(stateDir, 'dev.book-site.plist');
    writeFileSync(plist, '<plist/>', 'utf8');
    const bin = fakes({
      launchctl: [
        `LOG="${stateDir}/launchctl.log"`,
        'printf "%s\\n" "$*" >> "$LOG"',
        'case "$1" in',
        '  kickstart)',
        `    if [ -f "${stateDir}/bootstrapped" ]; then exit 0; fi`,
        '    echo "Could not find service \\"dev.book-site\\" in domain for user gui: 501" >&2',
        '    exit 113 ;;',
        `  bootstrap) touch "${stateDir}/bootstrapped"; exit 0 ;;`,
        'esac',
        'exit 1',
      ].join('\n'),
    });
    const { code, out } = await lib(
      [`if service_kickstart dev.book-site "${plist}"; then printf "signalled recovered=%s\\n" "$KICKSTART_RECOVERED"; fi`].join('\n'),
      { PATH: `${bin}:${process.env.PATH ?? ''}` },
    );

    expect(code, out).toBe(0);
    expect(out).toMatch(/restarting dev\.book-site/u);
    expect(out).toMatch(/kickstart: exit 113 — Could not find service/u);
    expect(out).toMatch(new RegExp(`kickstart: not loaded — bootstrapped from ${plist.replaceAll('.', '\\.')}`, 'u'));
    expect(out).toMatch(/signalled recovered=bootstrap/u);
    // kickstart, bootstrap, kickstart — one retry, never a loop.
    const calls = readFileSync(join(stateDir, 'launchctl.log'), 'utf8').trim().split('\n');
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatch(/^kickstart -k gui\/\d+\/dev\.book-site$/u);
    expect(calls[1]).toMatch(/^bootstrap gui\/\d+/u);
  });

  it('reports failure when the bootstrap does not help, and names no recovery', async () => {
    const stateDir = temp();
    const plist = join(stateDir, 'dev.book-site.plist');
    writeFileSync(plist, '<plist/>', 'utf8');
    const bin = fakes({
      launchctl: 'case "$1" in\n  bootstrap) echo "Bootstrap failed: 5: Input/output error" >&2; exit 5 ;;\n  *) echo "Bad request" >&2; exit 1 ;;\nesac',
    });
    const { code, out } = await lib(
      [`if service_kickstart dev.book-site "${plist}"; then echo signalled; else printf "not signalled recovered=%s\\n" "$KICKSTART_RECOVERED"; fi`].join('\n'),
      { PATH: `${bin}:${process.env.PATH ?? ''}` },
    );

    expect(code, out).toBe(0);
    expect(out).toMatch(/kickstart: not loaded — bootstrapped from/u);
    expect(out).toMatch(/kickstart: bootstrap failed \(exit 5\) — Bootstrap failed/u);
    expect(out).toMatch(/not signalled recovered=$/mu);
  });

  it('does not try to bootstrap without a plist', async () => {
    const bin = fakes({ launchctl: 'echo "Could not find service" >&2; exit 113' });
    const { out } = await lib(
      [`if service_kickstart dev.book-site /nonexistent/dev.book-site.plist; then echo signalled; else echo refused; fi`].join('\n'),
      { PATH: `${bin}:${process.env.PATH ?? ''}` },
    );
    expect(out).toMatch(/kickstart: no plist at '\/nonexistent\/dev\.book-site\.plist'/u);
    expect(out).toMatch(/refused/u);
    expect(out).not.toMatch(/bootstrap gui/u);
  });
});

// --- the window under a failing box ------------------------------------------------------------

describe('the window: no single utility may abort the deploy', () => {
  it('completes with a verdict when date, sleep, curl, sed or head fails', async () => {
    // The 00:36 run of a492d1a died here: a probe that returned non-zero under `set -e` took the
    // process down inside the window, leaving `lock: released` as the last line. Each of these
    // utilities is made to fail on its own, and the window still has to answer.
    const url = await serve(() => OK('build12'));
    for (const name of ['date', 'sleep', 'curl', 'sed', 'head']) {
      const bin = fakes({ [name]: 'exit 7' });
      const { code, out } = await failRun(
        [
          'say() { printf "%s deploy: %s\\n" "$(window_stamp)" "$*"; }',
          'audit() { :; }',
          'trap \'fail_on_err "$LINENO" "$BASH_COMMAND"\' ERR',
          'trap \'fail_on_exit\' EXIT',
          'BUDGET_MS=300; GRACE_MS=200',
          `window_read "${url}" build12 "" "$(now_ms)"`,
          'printf "health=%s reads=%s ms=%s\\n" "$HEALTH" "$WINDOW_READS" "$HEALTH_MS"',
        ].join('\n'),
        { PATH: `${bin}:${process.env.PATH ?? ''}` },
      );

      expect(code, `${name} aborted the window: ${out}`).toBe(0);
      expect(out, `${name}: ${out}`).toMatch(/health=(fast|late|stale|fail)/u);
      expect(out, `${name}: a failing utility is not a deployment failure`).not.toMatch(/FAILED/u);
      expect(out, `${name}: the window still read`).toMatch(/reads=[1-9]/u);
    }
  });
});
