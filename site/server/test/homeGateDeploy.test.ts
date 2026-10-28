/**
 * BOOK-187 AC12 — the volume cutover on the runtime that actually serves prod (compose).
 *
 * The gate is a deploy step, not a script function: what matters is **where** it sits (after the
 * new image is up and healthy, before `last-good` is written), that `--rollback` does not run it
 * (an image older than BOOK-187 has no such commands), and that both runtimes say the same
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

  it('runs the cutover in the new image, on the volume, with the service env', () => {
    // The same argv the rehearsal ran: one-shot, no dependencies, the CLI bypassing the role lock.
    expect(script).toContain(
      'bin/home-migrate.mjs --apply',
    );
    expect(script).toContain('bin/home-check.mjs --data-dir /data --manuscript /book/manuscript');
    expect(script).toMatch(/dc run --rm -T --no-deps --entrypoint node site "\$@"/);
    // `--no-deps` is what keeps the engine from being started by a check.
    expect(script).toContain('--no-deps');
  });

  it('sits after the stack is up and before green is recorded', () => {
    const gate = script.indexOf('if ! home_gate; then');
    const green = script.indexOf('printf \'%s\\n\' "$IMAGE_TAG" >"$LAST_GOOD_IMAGE"');
    expect(gate).toBeGreaterThan(0);
    expect(green).toBeGreaterThan(gate);
    // The health gate is what precedes it: `up -d --wait` replaced the old writer already.
    expect(script.indexOf('up_and_gate "$IMAGE_TAG" "$SHA7"')).toBeLessThan(gate);
  });

  it('is not part of the rollback, which may land on an image that predates it', () => {
    const rollback = script.slice(script.indexOf('rollback_to() {'), script.indexOf('red() {'));
    expect(rollback).toContain('up_and_gate "$tag" "$expect"');
    expect(rollback).not.toContain('home_gate');
    // And a red home gate goes through the ordinary rollback path.
    expect(script).toContain('red "the home gate is red on ${IMAGE_TAG}: ${HOME_WHY}"');
  });

  it('keeps a dry run honest: the plan names both commands', () => {
    expect(script).toContain('dc run --rm -T --no-deps --entrypoint node site bin/home-migrate.mjs --apply');
    expect(script).toContain('bin/home-check.mjs --data-dir /data --manuscript /book/manuscript');
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
