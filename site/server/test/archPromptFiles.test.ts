import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GUARDED_DIRS, collectCanaries, f023Problems } from '../../scripts/containment.mjs';

/**
 * F023, the prompt half (BOOK-5). The build gate (`scripts/arch.mjs`) prints `f023Problems` and
 * exits 1 on a non-empty list; the route half is `containment.test.ts`.
 *
 * A skill is a prompt, so `.opencode/skills/**` must be read like `process/`: the claim is
 * behavioural — the leak/clean pair below is the same call the gate makes, so the exit path is
 * proven here and not only by reading the source.
 */
const BOOK_ROOT = resolve(import.meta.dirname, '../../..');
const SKILL_PATH = '.opencode/skills/writing-pass/SKILL.md';
const CANARY = 'ПОДСКАЗКА-АГЕНТУ-7f4c1e — a line a shipped bundle must never carry, whatever it says';

describe('F023 — the prompt-file guard covers .opencode/skills (BOOK-5)', () => {
  it('guards the skill tree', () => {
    expect(GUARDED_DIRS).toContain('.opencode/skills');
  });

  it('collects a canary from the writing-pass skill of this repository', () => {
    const canaries = collectCanaries(BOOK_ROOT);
    const fromSkill = canaries.filter((canary) => canary.file.endsWith(SKILL_PATH));
    expect(fromSkill.length, `the guard read no line of ${SKILL_PATH}`).toBeGreaterThan(0);
  });

  it('reports a leaked skill line, and nothing when the bundle is clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'book-f023-'));
    try {
      const skillDir = join(root, '.opencode', 'skills', 'probe');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `# probe\n\n${CANARY}\n`, 'utf8');
      const distDir = join(root, 'web', 'dist', 'assets');
      mkdirSync(distDir, { recursive: true });
      const bundle = join(distDir, 'app.js');

      writeFileSync(bundle, `console.log(${JSON.stringify(CANARY)});`, 'utf8');
      const leaked = f023Problems({ bookRoot: root, distDir: join(root, 'web', 'dist') });
      expect(leaked).toHaveLength(1);
      expect(leaked[0]?.file).toBe(bundle);
      expect(leaked[0]?.message).toBe(
        `F023: ships a line of the support file ${relative(root, join(skillDir, 'SKILL.md'))}`,
      );

      writeFileSync(bundle, 'console.log("clean");', 'utf8');
      expect(f023Problems({ bookRoot: root, distDir: join(root, 'web', 'dist') })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads no skill and no build when neither exists, so a bare checkout is not a failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'book-f023-empty-'));
    try {
      expect(collectCanaries(root)).toEqual([]);
      expect(f023Problems({ bookRoot: root, distDir: join(root, 'web', 'dist') })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
