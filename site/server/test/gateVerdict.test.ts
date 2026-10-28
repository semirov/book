/**
 * BOOK-198: the one required check. Branch protection asks for `gate`; six jobs report into it,
 * and the only thing standing between "a shard was skipped" and a green `main` is this decision.
 * The cases below are the whole rule: a required job skipped is red, a job the mode skips by
 * design is not, and nothing that failed, was cancelled or never reported can pass.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { verdict, type NeedEntry } from '../../scripts/gate-verdict.mjs';

const SITE = resolve(import.meta.dirname, '..', '..');
const CLI = resolve(SITE, 'scripts', 'gate-verdict.mjs');

/**
 * The `needs` object GitHub sends for a healthy run of the given mode: full mode runs the sharded
 * suite and skips `affected`; affected mode does the opposite.
 */
function healthy(mode: 'full' | 'affected'): Record<string, NeedEntry> {
  const full = mode === 'full';
  return {
    changes: { result: 'success', outputs: { mode } },
    static: { result: 'success', outputs: {} },
    tests: { result: full ? 'success' : 'skipped', outputs: {} },
    coverage: { result: full ? 'success' : 'skipped', outputs: {} },
    affected: { result: full ? 'skipped' : 'success', outputs: {} },
    build: { result: 'success', outputs: {} },
  };
}

function withJob(needs: Record<string, NeedEntry>, job: string, result: string): Record<string, NeedEntry> {
  return { ...needs, [job]: { ...needs[job], result } };
}

describe('verdict', () => {
  it('is green when every needed job succeeded', () => {
    const decision = verdict(healthy('full'), 'push');
    expect(decision.ok).toBe(true);
    expect(decision.mode).toBe('full');
    expect(decision.reasons).toEqual([]);
    expect(decision.rows.map((row) => row.job)).toEqual([
      'changes',
      'static',
      'tests',
      'coverage',
      'affected',
      'build',
    ]);
    expect(decision.rows.every((row) => row.ok)).toBe(true);
  });

  it('is red when one shard failed (the matrix folds into `tests`)', () => {
    const decision = verdict(withJob(healthy('full'), 'tests', 'failure'), 'push');
    expect(decision.ok).toBe(false);
    expect(decision.reasons.join('\n')).toContain('tests is failure');
  });

  it('is red when a dependency was cancelled', () => {
    const decision = verdict(withJob(healthy('affected'), 'static', 'cancelled'), 'pull_request');
    expect(decision.ok).toBe(false);
    expect(decision.reasons.join('\n')).toContain('static is cancelled');
  });

  it('is red when a required job timed out (GitHub reports it as failure)', () => {
    expect(verdict(withJob(healthy('full'), 'coverage', 'failure'), 'push').ok).toBe(false);
  });

  it('is red when the shards were skipped in full mode', () => {
    const decision = verdict(withJob(healthy('full'), 'tests', 'skipped'), 'push');
    expect(decision.ok).toBe(false);
    expect(decision.reasons.join('\n')).toContain('tests was skipped, but full mode requires it');
  });

  it('is green when `affected` was skipped in full mode', () => {
    expect(verdict(healthy('full'), 'pull_request').ok).toBe(true);
  });

  it('is red when a non-required job failed', () => {
    // Skipped is what full mode does to `affected`; a failure there is still a failed job, and the
    // required check must not call the run green because the job was "optional".
    const decision = verdict(withJob(healthy('full'), 'affected', 'failure'), 'push');
    expect(decision.ok).toBe(false);
    expect(decision.reasons.join('\n')).toContain('affected is failure');
    expect(verdict(withJob(healthy('full'), 'affected', 'cancelled'), 'push').ok).toBe(false);
  });

  it('is green when the sharded jobs were skipped in affected mode', () => {
    expect(verdict(healthy('affected'), 'pull_request').ok).toBe(true);
  });

  it('is red when `affected` was skipped in affected mode', () => {
    const decision = verdict(withJob(healthy('affected'), 'affected', 'skipped'), 'pull_request');
    expect(decision.ok).toBe(false);
    expect(decision.reasons.join('\n')).toContain('affected was skipped, but affected mode requires it');
  });

  it('ignores the mode `changes` reports on a push: main always gets the whole suite', () => {
    // A PR-shaped run on main (tests skipped, affected green) must not pass as a push.
    const decision = verdict(healthy('affected'), 'push');
    expect(decision.mode).toBe('full');
    expect(decision.ok).toBe(false);
    expect(decision.reasons.join('\n')).toContain('tests was skipped');
  });

  it('is red when a job is missing from `needs` altogether', () => {
    const needs = healthy('affected');
    delete needs.build;
    const decision = verdict(needs, 'pull_request');
    expect(decision.ok).toBe(false);
    expect(decision.reasons.join('\n')).toContain('build is missing');
  });

  it('is red on a PR whose changes job reported no usable mode', () => {
    const needs = { ...healthy('affected'), changes: { result: 'skipped', outputs: {} } };
    const decision = verdict(needs, 'pull_request');
    expect(decision.ok).toBe(false);
    // The mode falls back to full (the safe direction), so the skipped shards are also red.
    expect(decision.mode).toBe('full');
    expect(decision.reasons.length).toBeGreaterThan(1);
  });

  it('treats a non-object `needs` as a red run instead of throwing', () => {
    const decision = verdict(null as unknown as Record<string, NeedEntry>, 'push');
    expect(decision.ok).toBe(false);
    expect(decision.rows.every((row) => row.result === 'missing')).toBe(true);
  });
});

describe('the CLI', () => {
  function run(needs: Record<string, NeedEntry>, event: string) {
    const result = spawnSync(process.execPath, [CLI], {
      env: { ...process.env, NEEDS: JSON.stringify(needs), EVENT: event },
      encoding: 'utf8',
    });
    return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  }

  it('prints one line per job, then PASS, and exits 0', () => {
    const result = run(healthy('full'), 'push');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('gate verdict — event: push, mode: full');
    for (const job of ['changes', 'static', 'tests', 'coverage', 'affected', 'build']) {
      expect(result.stdout).toContain(`${job}`);
    }
    expect(result.stdout).toContain('verdict: PASS');
    expect(result.stdout.indexOf('build')).toBeLessThan(result.stdout.indexOf('verdict:'));
  });

  it('names what failed and exits 1', () => {
    const result = run(withJob(healthy('affected'), 'affected', 'failure'), 'pull_request');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('verdict: FAIL — affected is failure (required)');
  });

  it('refuses to decide without `needs`', () => {
    const result = spawnSync(process.execPath, [CLI], {
      env: { ...process.env, NEEDS: '', EVENT: 'push' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NEEDS');
  });
});
