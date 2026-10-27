#!/usr/bin/env node
/**
 * bin/index.mjs — the derived index, visible and rebuildable without the engine.
 *
 *   index.mjs show     → the artifact's path, hash and counts; exit 1 when it is missing
 *   index.mjs rebuild  → rebuild from manuscript/ and replace the artifact; exit 1 on failure
 *
 * Environment: BOOK_ROOT and DATA_DIR, with the same defaults as the site config
 * (`site/..` and `site/.data`). `show` always prints the data directory it looked in, so a
 * mis-set DATA_DIR is visible instead of silently yielding «no slice».
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(SITE_ROOT, 'server', 'dist');

async function main() {
  const entry = join(DIST, 'index', 'cli.js');
  if (!existsSync(entry)) {
    console.error('index: the server is not built — run `npm run build -w @book/server` first');
    return 1;
  }
  const [{ loadConfig }, { runIndex }] = await Promise.all([
    import(pathToFileURL(join(DIST, 'config.js')).href),
    import(pathToFileURL(entry).href),
  ]);
  const config = loadConfig();
  return runIndex(
    process.argv.slice(2),
    { log: (line) => console.log(line), error: (line) => console.error(line) },
    { bookRoot: config.bookRoot, dataDir: config.dataDir },
  );
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`index: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
