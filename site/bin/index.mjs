#!/usr/bin/env node
/**
 * bin/index.mjs — the derived index, visible and rebuildable without the engine.
 *
 *   index.mjs show     → the artifact's path, hash and counts; exit 1 when it is missing
 *   index.mjs rebuild  → rebuild from the rows of the volume and replace the artifact; exit 1 on failure
 *
 * BOOK-187: the index summarises `chapters`/`blocks` (the book's only home), so this CLI opens
 * `DATA_DIR/book.db` and hands the connection in — there is no directory of files to read.
 *
 * Environment: DATA_DIR, with the same default as the site config (`site/.data`). `show` always
 * prints the data directory it looked in, so a mis-set DATA_DIR is visible instead of silently
 * yielding «no slice».
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
  const { loadConfig } = await import(pathToFileURL(join(DIST, 'config.js')).href);
  const { runIndex } = await import(pathToFileURL(entry).href);
  const { databaseFile, openDatabase } = await import(pathToFileURL(join(DIST, 'db', 'db.js')).href);
  const config = loadConfig();
  const db = openDatabase(databaseFile(config.dataDir));
  try {
    return runIndex(
      process.argv.slice(2),
      { log: (line) => console.log(line), error: (line) => console.error(line) },
      { db, dataDir: config.dataDir },
    );
  } finally {
    db.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`index: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
