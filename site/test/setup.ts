/**
 * Per-test-file environment (BOOK-107). The suite's own environment, forced here and nowhere
 * else, removed after the file:
 *
 *   * `DATA_DIR` — a fresh `mkdtemp` on every test file, assigned over whatever the shell had,
 *     so a boot that falls back to the environment can land neither on `site/.data` (dev) nor on
 *     `$HOME/book-site-data` (prod). No test reads it to pick a path
 *     (`server/test/dataIsolation.test.ts` fails the run if one does).
 *   * `NODE_ENV` — deleted. A launchd/deploy shell ships `NODE_ENV=production`, and an ambient
 *     production flag flips `engine.ts` and the config invariants while `DATA_DIR` stays a temp
 *     dir: the data-dir guard cannot catch that, so the suite refuses to inherit it.
 *   * `PRODUCTION_DATA_DIR` — deleted for the same reason: the guard must see the real default,
 *     not a list a shell happened to export.
 *
 * A test that needs a data dir still builds its own fixture (`createFixture`, `mkdtemp`); this
 * one exists to make the ambient environment harmless, not to be shared.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'book-test-data-'));
process.env.DATA_DIR = dataDir;
delete process.env.NODE_ENV;
delete process.env.PRODUCTION_DATA_DIR;

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
