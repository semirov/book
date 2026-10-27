#!/usr/bin/env node
/**
 * bin/feedback.mjs — the host-side triage CLI (ARCHITECTURE.md §12.6).
 *
 * The rules live in `server/src/feedback/cli.ts` so they are unit-tested against a real
 * database; this wrapper resolves paths, opens the same SQLite file the site and the engine
 * use, and returns the exit code.
 *
 *   node site/bin/feedback.mjs inbox --limit 20
 *   node site/bin/feedback.mjs audit cmt_… --verdict FITS --by triage-1
 *   node site/bin/feedback.mjs decide cmt_… accepted --reason "…" --intent "…" --rev ch08@3
 *
 * Every comment is audited before it can be decided (BOOK-9); `OFF` refuses it to the reader
 * with the auditor's reason. Exit codes: 0 recorded, 1 refused/error, 2 usage.
 *
 * Environment: DATA_DIR (default `site/.data`), FEEDBACK_DIR (default `site/data/feedback`),
 * EDIT_SUBMISSIONS_PER_DAY (default 1). No network, no model call.
 */

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { databaseFile, openDatabase } from '../server/src/db/db.ts';
import { migrate } from '../server/src/db/migrate.ts';
import { assertDataDirIsolation, isProductionEnv, productionDataDirs } from '../server/src/dataDirGuard.ts';
import { runFeedback } from '../server/src/feedback/cli.ts';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function pathFromEnv(value, fallback) {
  if (value === undefined || value.length === 0) return fallback;
  return isAbsolute(value) ? value : resolve(SITE_ROOT, value);
}

const dataDir = pathFromEnv(process.env.DATA_DIR, join(SITE_ROOT, '.data'));
const feedbackDir = pathFromEnv(process.env.FEEDBACK_DIR, join(SITE_ROOT, 'data', 'feedback'));
const editsPerDay = Number.parseInt(process.env.EDIT_SUBMISSIONS_PER_DAY ?? '1', 10);

// BOOK-107: this CLI opens `book.db` writable, so it uses the boot's wall — a dev shell that
// exported the prod data dir is refused here, before anything is opened or migrated.
try {
  assertDataDirIsolation(
    { dataDir, adminTokenFile: '', engineTokenFile: '', feedbackDir },
    isProductionEnv(),
    { prodDirs: productionDataDirs() },
  );
} catch (error) {
  console.error(`feedback: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const db = openDatabase(databaseFile(dataDir));
try {
  migrate(db);
  const code = runFeedback(process.argv.slice(2), {
    db,
    dir: feedbackDir,
    print: (line) => console.log(line),
    editsPerDay: Number.isInteger(editsPerDay) && editsPerDay > 0 ? editsPerDay : 1,
  });
  process.exitCode = code;
} finally {
  db.close();
}
