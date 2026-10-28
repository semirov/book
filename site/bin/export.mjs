#!/usr/bin/env node
/**
 * bin/export.mjs — BOOK-187 AC11: the book exported **from the volume**, on demand.
 *
 *   npm run export:md  -- --out /tmp/book.md
 *   npm run export:fb2 -- --out /tmp/book.fb2
 *   node bin/export.mjs --format md --out /tmp/book.md --data-dir /path/to/volume
 *
 * The text is rows (`chapters`/`blocks`/`front_matter`); nothing here reads a chapter file.
 * The file is written to the `--out` path **only** — no directory is created implicitly, and
 * nothing generated is ever committed. Prints `<path>: <bytes> bytes`.
 *
 * The volume: `--data-dir`, else `DATA_DIR` (the site's own config default). The imprint, the
 * origin and the cover path come from the same config the site reads, so an export names the
 * same edition `/book.fb2` serves. The database is opened **read-only** (`{readonly: true,
 * fileMustExist: true}`) — an export creates nothing, and a missing `book.db` is an error.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(SITE_ROOT, 'server', 'dist');

/** `book-site <version>` in the file's `program-used`, from the same package the build reads. */
function serverVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(SITE_ROOT, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main() {
  const entry = join(DIST, 'export', 'cli.js');
  if (!existsSync(entry)) {
    console.error('export: the server is not built — run `npm run build -w @book/server` first');
    return 1;
  }
  const { parseExportArgs, runExport } = await import(pathToFileURL(entry).href);
  const { loadConfig } = await import(pathToFileURL(join(DIST, 'config.js')).href);
  const { databaseFile } = await import(pathToFileURL(join(DIST, 'db', 'db.js')).href);
  const { loadImprint } = await import(pathToFileURL(join(DIST, 'imprint.js')).href);

  const args = parseExportArgs(process.argv.slice(2));
  if ('error' in args) {
    console.error(`export: ${args.error}`);
    return 2;
  }
  const config = loadConfig(
    args.dataDir === null ? process.env : { ...process.env, DATA_DIR: resolve(args.dataDir) },
  );
  // BOOK-187 review: the export READS the volume. `openDatabase` sets WAL and would create a file
  // where there is none — so an export into a typo'd path would leave an empty database behind.
  // Read-only, must-exist, exactly as `scripts/frame-check.mjs` opens it.
  const { default: Database } = await import('better-sqlite3');
  const file = databaseFile(config.dataDir);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return runExport(
      args,
      { log: (line) => console.log(line), error: (line) => console.error(line) },
      {
        db,
        imprint: loadImprint(config.imprintPath),
        version: serverVersion(),
        publicOrigin: config.publicOrigin,
        coverPath: config.coverPath,
      },
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
    console.error(`export: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
