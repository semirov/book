#!/usr/bin/env node
/**
 * bin/restore.mjs — the operator's revision browser (§13.3 step 1).
 *
 * **BOOK-187: a restore is a revision, and this tool writes nothing.** The text has no file to
 * copy a snapshot over, so the apply half is a refusal that names the row path: the site
 * publishes a `cause_kind='restore'` revision through `POST /internal/restore` (the writer
 * lane's `npm run writer -- --revert --chapter N`), and the chapter stays `ungated` until the
 * operator's `reconcile` mark. What is left here is what a host-side tool is good at: showing
 * the revisions, and previewing which text a restore would publish.
 *
 *   node bin/restore.mjs --chapter 9 --list
 *   node bin/restore.mjs --chapter 9 --rev 3 --dry-run   # what a restore would publish
 *   node bin/restore.mjs --chapter 9 --rev 3             # refused: names the row path
 *
 * Environment: DATA_DIR (default site/.data). Flags override it. Nothing here writes.
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { databaseFile, openDatabase } from '../server/src/db/db.ts';
import { assertDataDirIsolation, isProductionEnv, productionDataDirs } from '../server/src/dataDirGuard.ts';
import { readRestoreSource } from '../server/src/history/restore.ts';
import { TOTAL_CHAPTERS } from '../shared/src/book.ts';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: restore.mjs --chapter N (--list | --rev R --dry-run) [--data-dir DIR]';

function parse(argv) {
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const [rawName, inline] = arg.slice(2).split('=', 2);
    const name = rawName ?? '';
    if (inline !== undefined) {
      flags.set(name, inline);
      continue;
    }
    if (name === 'list' || name === 'dry-run' || name === 'help') {
      flags.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`flag --${name} needs a value`);
    flags.set(name, value);
    index += 1;
  }
  return flags;
}

function absolute(value) {
  return isAbsolute(value) ? value : resolve(SITE_ROOT, value);
}

function chapterNumber(flags) {
  const raw = flags.get('chapter');
  if (raw === undefined) throw new Error('--chapter N is required');
  const n = Number(raw);
  // The book's last chapter (`TOTAL_CHAPTERS`); the site refuses the rest.
  if (!Number.isInteger(n) || n < 1 || n > TOTAL_CHAPTERS) {
    throw new Error(`--chapter must be an integer between 1 and ${String(TOTAL_CHAPTERS)}`);
  }
  return n;
}

/** One short-lived connection: the CLI is a reader, and the site owns the file. */
function withDatabase(dataDir, read) {
  const db = openReadOnly(dataDir);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function openReadOnly(dataDir) {
  const file = databaseFile(dataDir);
  if (!existsSync(file)) throw new Error(`no database at ${file}: was the site ever started?`);
  return openDatabase(file);
}

function rows(db, n) {
  return db
    .prepare(
      `SELECT rev, at, kind, cause_kind, attributed, snapshot, log_note
         FROM revisions WHERE chapter = ? ORDER BY rev DESC`,
    )
    .all(n);
}

function printList(n, revisions, currentRev) {
  if (revisions.length === 0) {
    console.log(`глава ${n}: ревизий нет — восстанавливать нечего`);
    return;
  }
  console.log(`глава ${n} · ${revisions.length} ревизий (новые сверху)`);
  for (const row of revisions) {
    const marks = [
      row.rev === currentRev ? '← сейчас' : '',
      row.attributed === 0 ? 'без авторства' : '',
      row.log_note ? String(row.log_note) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    console.log(`  rev ${String(row.rev).padStart(3)}  ${row.at}  ${row.kind}/${row.cause_kind}  ${marks}`.trimEnd());
  }
  console.log('восстановить: node bin/restore.mjs --chapter ' + n + ' --rev <R>');
}

function main() {
  const flags = parse(process.argv.slice(2));
  if (flags.get('help')) {
    console.log(USAGE);
    return 0;
  }
  const n = chapterNumber(flags);
  const dataDir = absolute(flags.get('data-dir') ?? process.env.DATA_DIR ?? join(SITE_ROOT, '.data'));
  // BOOK-107: this tool opens `book.db`, so it uses the boot's wall too — a dev shell pointed at
  // the prod data dir is refused before any open.
  assertDataDirIsolation(
    { dataDir, adminTokenFile: '', engineTokenFile: '', feedbackDir: '' },
    isProductionEnv(),
    { prodDirs: productionDataDirs() },
  );
  const { revisions, currentRev } = withDatabase(dataDir, (db) => ({
    revisions: rows(db, n),
    currentRev: (db.prepare('SELECT rev FROM chapters WHERE n = ?').get(n) ?? { rev: 0 }).rev,
  }));

  if (flags.get('list')) {
    printList(n, revisions, currentRev);
    return 0;
  }

  const rawRev = flags.get('rev');
  if (rawRev === undefined) throw new Error('pass --list or --rev R');
  const rev = Number(rawRev);
  const chosen = revisions.find((row) => row.rev === rev);
  if (chosen === undefined) throw new Error(`глава ${n} не имеет ревизии ${rev}`);

  // The snapshot is read through the site's own reader (`history/restore.ts`), so the CLI
  // and the history agree on which text a revision means.
  const source = withDatabase(dataDir, (db) => readRestoreSource(db, dataDir, n, rev));
  if (source === null) throw new Error(`снимок ревизии ${rev} не найден в ${join(dataDir, 'versions')}`);

  if (rev === currentRev) {
    console.log(`глава ${n} уже на rev ${rev}: ничего не меняется`);
    return 0;
  }

  if (flags.get('dry-run')) {
    console.log(`проверка: rev ${rev} даст ${source.text.length} знаков — ревизия, а не файл; без записи`);
    return 0;
  }

  // BOOK-187: nothing is copied anywhere. The restore is a revision the site publishes, and the
  // operator's command is the lane's own — one write path, one history.
  console.error(`restore: глава ${n} не восстановлена — текст живёт в базе, копировать нечего`);
  console.error('путь: POST /internal/restore {chapter, rev} — или с хоста:');
  console.error(`  npm run writer -- --revert --chapter ${n}`);
  console.error(`  node site/bin/engine.mjs reconcile ${n} --because "restore rev ${rev}"`);
  return 2;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`restore: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
