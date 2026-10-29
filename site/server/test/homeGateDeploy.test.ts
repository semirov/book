/**
 * BOOK-187 AC12 (re-pinned by BOOK-217) — the volume cutover on the runtime that actually serves
 * prod (compose).
 *
 * The gate is a deploy step, not a script function: what matters is **where** it sits. It used to
 * run after `up -d --wait`, and that order is what turned a refused volume into a 502: `up` is what
 * boots the new image and migrates the volume, so the gate could only judge a volume already
 * written to. It now runs BEFORE the first `up`, in the new image, one-shot — and the same read is
 * repeated after `up` (never `--apply` again: the cutover already ran). `--rollback` still does not
 * run it (an image older than BOOK-187 has no such commands), and both runtimes say the same
 * sentence with the remedy in it. Those are properties of the text, so this file reads the two
 * scripts — with the shape the deploy actually uses, not a paraphrase.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../src/config.ts';

const read = (name: string): string => readFileSync(join(SITE_ROOT, 'deploy', name), 'utf8');

/** The sentence both runtimes must print when the volume holds what it may not. */
const HOME_FAILED = 'the volume holds something it may not (every path above is named) — run bin/home-migrate.mjs --apply once';

describe('compose-release.sh — the home gate', () => {
  const script = read('compose-release.sh');
  /** The body of one shell function, up to the first line that closes it at column 0. */
  const body = (name: string): string => {
    const start = script.indexOf(`${name}() {`);
    expect(start, name).toBeGreaterThan(0);
    return script.slice(start, script.indexOf('\n}\n', start));
  };

  it('runs the cutover in the new image, on the volume, with the service env', () => {
    // The same argv the rehearsal ran: one-shot, no dependencies, the CLI bypassing the role lock.
    expect(script).toContain(
      'bin/home-migrate.mjs --apply',
    );
    // No `--manuscript`: the image carries no book tree (BOOK-187), and a missing one passes.
    expect(script).toContain('bin/home-check.mjs --data-dir /data');
    expect(script).not.toContain('--manuscript /book/manuscript');
    expect(script).toMatch(/dc run --rm -T --no-deps --entrypoint node site "\$@"/);
    // `--no-deps` is what keeps the engine from being started by a check.
    expect(script).toContain('--no-deps');
  });

  it('runs BEFORE the stack is up, so a refused volume stops a deploy that still serves', () => {
    const gate = script.indexOf('if ! home_gate_pre; then');
    const up = script.indexOf('up_and_gate "$IMAGE_TAG" "$SHA7"');
    expect(gate).toBeGreaterThan(0);
    expect(up).toBeGreaterThan(gate);
    // What follows a refusal: the shared sentence, and the proof that nothing was started or migrated.
    const refusal = script.slice(gate, gate + 400);
    expect(refusal).toContain('$HOME_WHY');
    expect(refusal).toContain('the deploy stopped before any DDL: nothing was started and nothing was migrated');
    // The cutover is the pre-up gate's job, in the new image, one-shot.
    expect(body('home_gate_pre')).toContain('bin/home-migrate.mjs --apply');
  });

  it('keeps the post-up home-check, without repeating --apply, before green is recorded', () => {
    const post = script.indexOf('if ! home_check_post; then');
    const green = script.indexOf('printf \'%s\\n\' "$IMAGE_TAG" >"$LAST_GOOD_IMAGE"');
    expect(post).toBeGreaterThan(0);
    expect(green).toBeGreaterThan(post);
    // The stack is what precedes it now: the post-up read judges what the boot left behind.
    expect(script.indexOf('up_and_gate "$IMAGE_TAG" "$SHA7"')).toBeLessThan(post);
    // `--apply` is not repeated after `up`: it already ran, and a second attempt could only hide the
    // refusal it produced.
    expect(body('home_check_post')).toContain('bin/home-check.mjs --data-dir /data');
    expect(body('home_check_post')).not.toContain('home-migrate.mjs');
    // And a red one still goes through the recovery path.
    expect(script).toContain('red "the home gate is red on ${IMAGE_TAG}: ${HOME_WHY}"');
  });

  it('is not part of the rollback, which may land on an image that predates it', () => {
    const rollback = script.slice(script.indexOf('rollback_to() {'), script.indexOf('red() {'));
    expect(rollback).toContain('up_and_gate "$tag" "$expect"');
    expect(rollback).not.toContain('home_gate_pre');
    expect(rollback).not.toContain('home_check_post');
  });

  it('keeps a dry run honest: the plan names the new order', () => {
    expect(script).toContain('dc run --rm -T --no-deps --entrypoint node site bin/home-migrate.mjs --apply');
    expect(script).toContain('bin/home-check.mjs --data-dir /data');
    expect(script).not.toContain('--manuscript /book/manuscript');
    const plan = script.slice(script.indexOf('say "dry run: would build'), script.indexOf('STEP="prepare: lock"'));
    expect(plan.indexOf('bin/home-migrate.mjs --apply')).toBeLessThan(plan.indexOf('up -d --wait'));
    expect(plan).toContain('recovery:');
  });
});

describe('the two runtimes say one sentence, with the remedy', () => {
  it('names the volume, not the data dir, and the command that folds it', () => {
    for (const name of ['deploy.sh', 'compose-release.sh']) {
      const script = read(name);
      expect(script, name).toContain(HOME_FAILED);
      expect(script, name).toContain('bin/home-migrate.mjs --apply once');
    }
  });
});

describe('the recovery rule is one shared helper, not a copy per driver', () => {
  const lib = read('lib.sh');

  it('prints exactly the four fixed lines', () => {
    expect(lib).toContain('recovery: roll-forward — a migration ran (%s), so the previous image is NOT put back; the new image keeps serving (degraded, alive)');
    expect(lib).toContain('recovery: dump-restore — a migration ran (%s) and the new image does not serve, so the pre-deploy dump was restored over book.db and the previous image runs');
    expect(lib).toContain('recovery: image-rollback — no migration ran (%s), so the previous image is restored on the same schema');
    expect(lib).toContain('recovery: none — %s; nothing was rolled back and nothing was restored, a human must look');
  });

  it('picks one of four from the migration fact and whether the new image answers', () => {
    // Both drivers source it: one rule, so the sentence cannot depend on which one ran the release.
    expect(lib).toContain('recovery_choice() {');
    expect(lib).toContain('recovery_line() {');
    expect(read('compose-release.sh')).toContain('recovery_choice "$MIGRATED" "$serving"');
  });
});
