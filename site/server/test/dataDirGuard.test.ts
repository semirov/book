/**
 * BOOK-107: three environments, three data dirs, and a wall between them. The tests go through
 * `loadConfig` — the one caller — so what is asserted is the boot the server actually does, plus
 * one direct call for the temp-repository form of the production direction. Every production
 * data dir here is a temp dir (`PRODUCTION_DATA_DIR`), so the suite neither reads nor depends on
 * the live one under the home directory.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SITE_ROOT, loadConfig } from '../src/config.ts';
import {
  DEFAULT_PRODUCTION_DATA_DIR,
  assertDataDirIsolation,
  isProductionEnv,
  productionDataDirs,
} from '../src/dataDirGuard.ts';
import { cleanupSecretFiles, production } from './configFixture.ts';

const scratch = mkdtempSync(join(tmpdir(), 'book-guard-'));
const prodDir = join(scratch, 'prod-data');
const devDir = join(scratch, 'dev-data');
mkdirSync(prodDir, { recursive: true });
mkdirSync(devDir, { recursive: true });
/** The messages print resolved paths, and `/var/…` on macOS is a link to `/private/var/…`. */
const realProd = realpathSync.native(prodDir);
const realSite = realpathSync.native(SITE_ROOT);
const insideRepo = join(realSite, '.data');

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PRODUCTION_DATA_DIR: prodDir, ...extra });

/** `loadConfig`'s refusal, as a message the assertions can compare verbatim. */
function refusal(extra: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env(extra));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('loadConfig did not refuse');
}

afterAll(() => {
  cleanupSecretFiles();
  rmSync(scratch, { recursive: true, force: true });
});

describe('data-dir isolation — non-production may not touch production (BOOK-107)', () => {
  it('refuses a development boot pointed at the production data dir, with the exact message', () => {
    expect(refusal({ DATA_DIR: prodDir })).toBe(
      `invalid configuration: refusing to run non-production against the production data dir (${realProd}); ` +
        'point DATA_DIR at a scratch directory',
    );
  });

  it('refuses a development boot pointed inside the production data dir', () => {
    expect(refusal({ DATA_DIR: join(prodDir, 'scratch') })).toContain(
      `refusing to run non-production against the production data dir (${realProd}/scratch)`,
    );
  });

  it('refuses the same dir written with a trailing slash and a detour', () => {
    expect(refusal({ DATA_DIR: `${prodDir}/./` })).toContain(
      `against the production data dir (${realProd}); point DATA_DIR`,
    );
  });

  it('refuses a symlink to the production data dir', () => {
    const link = join(scratch, 'prod-link');
    symlinkSync(prodDir, link);
    expect(refusal({ DATA_DIR: link })).toContain(
      `against the production data dir (${realProd}); point DATA_DIR at a scratch directory`,
    );
  });

  it('refuses the admin, engine and feedback paths inside the production data dir', () => {
    for (const [name, path] of [
      ['FEEDBACK_DIR', join(prodDir, 'feedback')],
      ['ADMIN_TOKEN_FILE', join(prodDir, 'admin.token')],
      ['ENGINE_TOKEN_FILE', join(prodDir, 'engine.token')],
    ] as const) {
      expect(refusal({ DATA_DIR: devDir, [name]: path })).toContain(`point ${name} at a scratch directory`);
    }
  });

  it('boots a development server on a scratch dir — and a sibling name is not "inside"', () => {
    expect(loadConfig(env({ DATA_DIR: devDir })).dataDir).toBe(devDir);
    // Prefix + separator is the rule: `prod-data-copy` is another directory, not prod.
    expect(loadConfig(env({ DATA_DIR: `${prodDir}-copy` })).dataDir).toBe(`${prodDir}-copy`);
    // An empty path is a disabled file, not a prod write: the panel token may be `''`.
    expect(loadConfig(env({ DATA_DIR: devDir, ADMIN_TOKEN_FILE: '' })).adminTokenFile).toBe('');
  });
});

describe('data-dir isolation — production data lives outside the checkout (BOOK-107)', () => {
  it('boots production on the production data dir, and keeps the site/ defaults for the rest', () => {
    const config = loadConfig(env({ ...production, DATA_DIR: prodDir }));
    expect(config.dataDir).toBe(prodDir);
    // The production direction judges DATA_DIR only: the default token and feedback paths under
    // `site/` must not refuse a real boot.
    expect(config.feedbackDir.startsWith(SITE_ROOT)).toBe(true);
    expect(config.adminTokenFile.startsWith(SITE_ROOT)).toBe(true);
  });

  it('refuses production with DATA_DIR inside the repository', () => {
    expect(refusal({ ...production, DATA_DIR: insideRepo })).toBe(
      `invalid configuration: refusing to boot production with DATA_DIR inside the repository (${insideRepo}); ` +
        'production data lives outside the checkout',
    );
  });

  it('refuses production on the default dev data dir as well', () => {
    expect(refusal({ ...production, DATA_DIR: undefined })).toContain(
      `refusing to boot production with DATA_DIR inside the repository (${insideRepo})`,
    );
  });

  it('refuses a temp repository root, so the rule is the checkout, not this checkout', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'book-repo-'));
    try {
      const paths = { dataDir: join(repoRoot, 'data'), adminTokenFile: '', engineTokenFile: '', feedbackDir: '' };
      expect(() => {
        assertDataDirIsolation(paths, true, { repoRoot });
      }).toThrow(/refusing to boot production with DATA_DIR inside the repository/u);
      // The same dir is a normal scratch dir for a production boot outside that repo.
      expect(() => {
        assertDataDirIsolation(paths, true, { repoRoot: prodDir });
      }).not.toThrow();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('defaults to the real production dirs and this checkout when no options are passed', () => {
    const paths = { dataDir: devDir, adminTokenFile: '', engineTokenFile: '', feedbackDir: '' };
    // A scratch dir is legible in both directions without a caller-supplied list or root.
    expect(() => {
      assertDataDirIsolation(paths, false);
    }).not.toThrow();
    expect(() => {
      assertDataDirIsolation(paths, true);
    }).not.toThrow();
  });

  it('reads the production flag the way loadConfig does — the operator CLIs depend on it', () => {
    expect(isProductionEnv({ NODE_ENV: ' Production ' })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: 'development' })).toBe(false);
    expect(isProductionEnv({})).toBe(false);
  });

  it('names every production dir: the default under the home dir and a :-separated list', () => {
    // The default is asserted without spelling it: the constant is the one productionDataDirs()
    // builds by default, and its name is the parts the product calls it by.
    const home = dirname(DEFAULT_PRODUCTION_DATA_DIR);
    expect(basename(DEFAULT_PRODUCTION_DATA_DIR)).toBe(['book', 'site', 'data'].join('-'));
    expect(productionDataDirs({})).toEqual([DEFAULT_PRODUCTION_DATA_DIR]);
    expect(productionDataDirs({}, home)).toEqual([DEFAULT_PRODUCTION_DATA_DIR]);
    expect(productionDataDirs({ PRODUCTION_DATA_DIR: `${prodDir}:${devDir}` }, home)).toEqual([
      DEFAULT_PRODUCTION_DATA_DIR,
      prodDir,
      devDir,
    ]);
  });
});
