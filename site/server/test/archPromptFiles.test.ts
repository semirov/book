import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GUARDED_DIRS,
  PUBLIC_TEXT,
  collectCanaries,
  decodeEscapes,
  f023Problems,
  missingDistProblem,
  normaliseForCompare,
} from '../../scripts/containment.mjs';

/**
 * F023, the prompt half (BOOK-5). The build gate (`scripts/arch.mjs`) prints `f023Problems` and
 * exits 1 on a non-empty list; the route half is `containment.test.ts`.
 *
 * A skill is a prompt, so `.opencode/skills/**` must be read like `process/`: the claim is
 * behavioural — the leak/clean pair below is the same call the gate makes, so the exit path is
 * proven here and not only by reading the source.
 */
const BOOK_ROOT = resolve(import.meta.dirname, '../../..');
const SITE_ROOT = resolve(import.meta.dirname, '../..');
const SKILL_PATH = '.opencode/skills/writing-pass/SKILL.md';
const CANARY = 'ПОДСКАЗКА-АГЕНТУ-7f4c1e — a line a shipped bundle must never carry, whatever it says';
const CANARY_MESSAGE = 'F023: ships a line of the support file .opencode/skills/probe/SKILL.md';

/** `\uXXXX` for every non-ASCII character — the form a minifier writes Cyrillic in. */
const escapeUnicode = (text: string) =>
  text.replace(/[^\x20-\x7e]/gu, (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`);

/** The gate, spawned exactly as CI and the deploy run it; `BOOK_DIST_DIR` is its documented seam. */
const arch = (args: readonly string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['scripts/arch.mjs', ...args], {
    cwd: SITE_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });

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

/**
 * BOOK-46. AC1 (a reflow — plain, escaped or entity-encoded — is still a leak; m7 dash symmetry),
 * AC2 (`notes/` is canon, so it is guarded), the frozen frame as public text (M2), AC3 (a release
 * run without a bundle fails, a dev/test run does not; m6 the fresh-checkout branch), m4 (an
 * unknown flag is an error) and the false-positive regression for the normalised comparison.
 *
 * AC4 — zero hits on the real `web/dist` — is proven by the CI step
 * `npm run arch -- --require-dist` after the build; a local test cannot prove it without building
 * the bundle.
 */
describe('F023 — the guard survives a reflow (BOOK-46)', () => {
  it('catches a support line in every form a build emits', () => {
    const root = mkdtempSync(join(tmpdir(), 'book-f023-reflow-'));
    try {
      const skillDir = join(root, '.opencode', 'skills', 'probe');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `# probe\n\n${CANARY}\n`, 'utf8');
      const distDir = join(root, 'web', 'dist');
      mkdirSync(distDir, { recursive: true });
      const bundle = join(distDir, 'app.js');
      const expected = [{ file: bundle, message: CANARY_MESSAGE }];
      const report = () => f023Problems({ bookRoot: root, distDir });

      // A formatter reflows the sentence: newline plus indentation. Everything below is a build's
      // way of carrying that same reflow.
      const reflowed = CANARY.replace('a line a shipped', 'a line a\n            shipped');
      const jsxSplit = CANARY.replace('a line a shipped', "a line '}{'a shipped");
      expect(normaliseForCompare(reflowed)).toBe(normaliseForCompare(CANARY));

      const carriers: ReadonlyArray<readonly [string, string]> = [
        ['verbatim', `console.log(${JSON.stringify(CANARY)});`],
        ['newline and indentation inside one string', `const t = \`${reflowed}\`;`],
        ['JSX text split into two chunks', `<p>{'${jsxSplit}'}</p>`],
        ['escaped newline in a single-quoted string', `const t = '${reflowed.replace(/\n/gu, '\\n')}';`],
        ['JSON payload', `const data = ${JSON.stringify({ text: reflowed })};`],
        ['\\uXXXX-escaped Cyrillic', `const t = "${escapeUnicode(reflowed)}";`],
        ['em dash written as a hyphen (m7)', `console.log("${CANARY.replace('—', '-')}");`],
        ['em dash written as an entity (m7)', `<p>${CANARY.replace('—', '&mdash;')}</p>`],
      ];
      for (const [label, payload] of carriers) {
        writeFileSync(bundle, payload, 'utf8');
        expect(report(), label).toEqual(expected);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('decodes the escapes a build emits, in the order that matters (M1)', () => {
    expect(decodeEscapes('a\\nb')).toBe('a\nb');
    expect(decodeEscapes('a\\tb')).toBe('a\tb');
    expect(decodeEscapes('\\b\\f')).toBe('  ');
    expect(decodeEscapes('\\u0416')).toBe('Ж');
    expect(decodeEscapes('\\u{416}')).toBe('Ж');
    expect(decodeEscapes('&laquo;X&raquo;')).toBe('«X»');
    expect(decodeEscapes('&mdash;&ndash;&nbsp;')).toBe('—– ');
    expect(decodeEscapes('&amp;&lt;&gt;&quot;')).toBe('&<>"');
    expect(decodeEscapes('&#1046;&#x416;')).toBe('ЖЖ');
    expect(decodeEscapes('\\\\')).toBe('\\');
    // A broken escape is text, not a crash: the gate must still answer.
    expect(decodeEscapes('&#99999999;')).toBe('&#99999999;');
  });

  it('guards notes/ and the canon constraints it holds', () => {
    // AC2c: the tree is guarded, not only read.
    expect(GUARDED_DIRS).toContain('notes');

    // AC2a: the real repository yields canaries from notes/canon-constraints.md.
    const canonFile = join(BOOK_ROOT, 'notes', 'canon-constraints.md');
    const canonTexts = collectCanaries(BOOK_ROOT)
      .filter((canary) => canary.file === canonFile)
      .map((canary) => canary.text);
    expect(canonTexts.length, 'the guard read no line of notes/canon-constraints.md').toBeGreaterThan(1);
    const [first, second] = canonTexts;
    if (first === undefined || second === undefined) throw new Error('notes/canon-constraints.md yielded too few canaries');
    expect(readFileSync(canonFile, 'utf8')).toContain(first);

    // AC2b: a real canon line leaked into a fixture bundle is one problem, and it names `notes/`.
    const root = mkdtempSync(join(tmpdir(), 'book-f023-notes-'));
    try {
      mkdirSync(join(root, 'notes'), { recursive: true });
      writeFileSync(join(root, 'notes', 'canon-constraints.md'), `# canon\n\n${first}\n${second}\n`, 'utf8');
      const distDir = join(root, 'web', 'dist');
      mkdirSync(distDir, { recursive: true });
      const bundle = join(distDir, 'app.js');
      writeFileSync(bundle, `console.log(${JSON.stringify(first)});`, 'utf8');
      expect(f023Problems({ bookRoot: root, distDir })).toEqual([
        { file: bundle, message: 'F023: ships a line of the support file notes/canon-constraints.md' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats the frozen frame as public text, not as a leak (M2)', () => {
    const [ch01, ch42] = PUBLIC_TEXT;
    if (ch01 === undefined || ch42 === undefined) throw new Error('PUBLIC_TEXT lost a frozen-frame sentence');
    // (a) the allowlist cannot drift away from the book it excuses.
    expect(readFileSync(join(BOOK_ROOT, 'manuscript', 'ch01.md'), 'utf8')).toContain(ch01);
    expect(readFileSync(join(BOOK_ROOT, 'manuscript', 'ch42.md'), 'utf8')).toContain(ch42);

    const extra = 'the sentence after it is the part the site must never print, on any page.';
    const root = mkdtempSync(join(tmpdir(), 'book-f023-frame-'));
    try {
      const notesDir = join(root, 'notes');
      mkdirSync(notesDir, { recursive: true });
      const support = join(notesDir, 'canon.md');
      const distDir = join(root, 'web', 'dist');
      mkdirSync(distDir, { recursive: true });
      const bundle = join(distDir, 'app.js');

      // (b) a note-style line whose only content is the frame is collected, yet cannot match it.
      writeFileSync(support, `# canon\n\n- chapter 42: «${ch42}»\n`, 'utf8');
      expect(collectCanaries(root), 'the note line is long enough to be a canary').toHaveLength(1);
      writeFileSync(bundle, `<p>${ch42}</p>`, 'utf8');
      expect(f023Problems({ bookRoot: root, distDir }), 'the frame is printed by design').toEqual([]);

      // (c) the same line with words of its own still has to match — even shipped as HTML.
      writeFileSync(support, `# canon\n\n- chapter 42: «${ch42}» — ${extra}\n`, 'utf8');
      writeFileSync(bundle, `<p>chapter 42: &laquo;${ch42}&raquo; &mdash; ${extra}</p>`, 'utf8');
      expect(f023Problems({ bookRoot: root, distDir })).toEqual([
        { file: bundle, message: 'F023: ships a line of the support file notes/canon.md' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not match a punctuation-heavy bundle of unrelated UI text', () => {
    const root = mkdtempSync(join(tmpdir(), 'book-f023-noise-'));
    try {
      const skillDir = join(root, '.opencode', 'skills', 'probe');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `# probe\n\n${CANARY}\n`, 'utf8');
      const distDir = join(root, 'web', 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(
        join(distDir, 'app.js'),
        [
          'const s="Глава 1 — начало";const t={"k":"Главная — все главы","n":67};',
          '.a{border-left:1px solid #eee;font-weight:600;content:"\\2014 "}',
          '.b::before{content:"«»—…•"}.c{--x:1;margin:0 -2px}',
          'const u=`${s}|${t.n}`;if(a<b&&c>d){return null}',
          'export const copy="Главы - Хроника &mdash; Правка";',
        ].join('\n'),
        'utf8',
      );
      expect(f023Problems({ bookRoot: root, distDir })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves a canary too short to be distinctive out of the comparison', () => {
    // A long line of pure markup normalises down to a word or two; matching it would be a
    // false-positive machine, so the normalised floor skips it even when the line leaks verbatim.
    const markup = `x ${'-- ** || ## () {} <> «» —– … '.repeat(3)}`;
    expect(markup.length).toBeGreaterThan(60);
    expect(normaliseForCompare(markup).length).toBeLessThan(40);
    const root = mkdtempSync(join(tmpdir(), 'book-f023-floor-'));
    try {
      const skillDir = join(root, '.opencode', 'skills', 'probe');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `# probe\n\n${markup}\n`, 'utf8');
      const distDir = join(root, 'web', 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, 'app.js'), `const t = ${JSON.stringify(markup)};`, 'utf8');
      expect(f023Problems({ bookRoot: root, distDir })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a build path that is a file, and never walks it (n8)', () => {
    const root = mkdtempSync(join(tmpdir(), 'book-f023-filedist-'));
    try {
      const distFile = join(root, 'dist');
      writeFileSync(distFile, 'not a directory\n', 'utf8');
      expect(missingDistProblem({ distDir: distFile, requireDist: false })).toBeNull();
      expect(missingDistProblem({ distDir: distFile, requireDist: true })?.message).toBe(
        'F023: the build path is a file, not a bundle directory — nothing to guard',
      );
      expect(f023Problems({ bookRoot: root, distDir: distFile }), 'no ENOTDIR').toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails in release mode and passes in dev mode when web/dist is empty', () => {
    // AC3 is the exit code of the gate itself, so the gate is spawned, not re-implemented.
    const emptyDist = mkdtempSync(join(tmpdir(), 'book-f023-nodist-'));
    try {
      const release = arch(['--require-dist'], { BOOK_DIST_DIR: emptyDist });
      expect(release.status).toBe(1);
      expect(release.stderr).toMatch(/F023: web\/dist is missing/u);
      expect(release.stdout).toContain('arch: F023 release mode — scanning');

      const dev = arch([], { BOOK_DIST_DIR: emptyDist });
      expect(dev.status, dev.stderr).toBe(0);
    } finally {
      rmSync(emptyDist, { recursive: true, force: true });
    }
  }, 180_000);

  it('fails in release mode and passes in dev mode when the dist path does not exist (m6)', () => {
    // The fresh-checkout branch of `missingDistProblem`: nothing on disk at all, not even a dir.
    const absent = join(tmpdir(), `book-f023-absent-${process.pid}-${Date.now()}`);
    const release = arch(['--require-dist'], { BOOK_DIST_DIR: absent });
    expect(release.status).toBe(1);
    expect(release.stderr).toMatch(/F023: web\/dist is missing/u);

    const dev = arch([], { BOOK_DIST_DIR: absent });
    expect(dev.status, dev.stderr).toBe(0);
  }, 180_000);

  it('refuses an unknown argument instead of passing in dev mode (m4)', () => {
    const run = arch(['--require-dsit']);
    expect(run.status, run.stdout).toBe(1);
    expect(run.stderr).toContain('arch: unknown argument "--require-dsit"');
  }, 180_000);

  it('reads an empty BOOK_DIST_DIR as unset, not as an empty path (n9)', () => {
    const run = arch(['--require-dist'], { BOOK_DIST_DIR: '' });
    expect(run.stdout).toMatch(/arch: F023 release mode — scanning web\/dist/u);
  }, 180_000);
});
