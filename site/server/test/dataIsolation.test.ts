/**
 * BOOK-107: one environment, one data dir, and no test that reaches for a real one.
 *
 * Two things are asserted here. First, the forcing works **by effect**: the data dir this file
 * sees is a real directory under the temp root, not the dev dir, not the production one, and
 * `NODE_ENV` is not production (the setup file deletes both). Second, no test file in the tree
 * *names* a real data dir or reads the variable to decide a path — a test that does is one rename
 * away from writing into the dev dir or the production one, which is the incident class.
 *
 * Every needle is assembled from parts so that this file cannot match itself, and the scan is
 * strings only — it reads the tree, it never stats or writes what it finds.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { expect, it } from 'vitest';

import { DEFAULT_PRODUCTION_DATA_DIR } from '../src/dataDirGuard.ts';

const SITE = resolve(import.meta.dirname, '..', '..');

/**
 * Assembled, never literal: the variable read, the prod name, the dev path, a home lookup.
 * `allowSelf` marks the one rule this file is the referee for: it reads the variable to prove the
 * forcing, so it is exempt from *that* needle only — it may still not name a real data dir.
 */
const NEEDLES: ReadonlyArray<{ name: string; pattern: RegExp; allowSelf?: true }> = [
  {
    name: 'a DATA_DIR read from the environment',
    allowSelf: true,
    pattern: new RegExp('process\\.env(?:\\.|\\[\\s*[\'"])DATA_DIR', 'u'),
  },
  { name: 'the production data dir name', pattern: new RegExp(['book', 'site', 'data'].join('-'), 'u') },
  { name: 'the dev data dir path', pattern: new RegExp(['site', '\\.data'].join('/'), 'u') },
  { name: 'a home-relative path', pattern: new RegExp(`${['home', 'dir'].join('')}\\(\\)`, 'u') },
];
const SETUP_ASSIGNMENT = `${['process', 'env', 'DATA_DIR'].join('.')} = `;

/** Every `.ts`/`.tsx` under the three test trees, as paths. */
function testFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string, testOnly: boolean): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path, testOnly);
        continue;
      }
      if (testOnly ? /\.test\.tsx?$/u.test(name) : /\.tsx?$/u.test(name)) files.push(path);
    }
  };
  walk(resolve(SITE, 'server/test'), false);
  walk(resolve(SITE, 'shared/test'), false);
  walk(resolve(SITE, 'web/src'), true);
  return files;
}

it('the suite data dir is a temp dir by effect, and the suite is not production', () => {
  const value = String(process.env.DATA_DIR);
  const tempRoot = realpathSync.native(tmpdir());
  const devDir = resolve(SITE, '.data');
  expect(statSync(value).isDirectory()).toBe(true);
  expect(realpathSync.native(value).startsWith(`${tempRoot}/`)).toBe(true);
  expect(value).not.toBe(devDir);
  expect(resolve(value)).not.toBe(resolve(DEFAULT_PRODUCTION_DATA_DIR));
  expect(process.env.NODE_ENV).not.toBe('production');
});

it('no test file names a real data dir or reads DATA_DIR to decide a path', () => {
  const self = relative(SITE, resolve(import.meta.dirname, 'dataIsolation.test.ts'));
  const offenders: string[] = [];
  for (const file of testFiles()) {
    const name = relative(SITE, file);
    const source = readFileSync(file, 'utf8');
    for (const needle of NEEDLES) {
      if (needle.allowSelf === true && name === self) continue;
      if (needle.pattern.test(source)) offenders.push(`${name} — ${needle.name}`);
    }
  }
  expect(offenders.sort()).toEqual([]);
});

it('test/setup.ts forces the data dir and refuses an ambient NODE_ENV (the rule has a producer)', () => {
  const setup = readFileSync(resolve(SITE, 'test/setup.ts'), 'utf8');
  expect(setup).toContain(SETUP_ASSIGNMENT);
  expect(setup).toContain('mkdtempSync');
  expect(setup).toContain(`delete ${['process', 'env', 'NODE_ENV'].join('.')}`);
});
