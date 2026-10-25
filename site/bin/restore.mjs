#!/usr/bin/env node
/**
 * bin/restore.mjs — the operator's rollback (§13.3 step 1–2).
 *
 * A rollback is an operator action on the host, never a web action: the site has no write
 * API for `manuscript/` (§13.1). This tool only chooses the revision and copies the
 * content-addressed snapshot back over the chapter. The *site* then does the honest part: it
 * observes an unattributed write, recognises the text as an earlier revision, and publishes
 * `attributed:false` + `kind:restore` — the chapter stays `ungated` until `reconcile`.
 *
 *   node bin/restore.mjs --chapter 9 --list
 *   node bin/restore.mjs --chapter 9 --rev 3 [--dry-run]
 *   node bin/restore.mjs --chapter 9 --rev 3 --because "restore rev 3"   # prints the next step
 *
 * Environment: BOOK_ROOT (default: the repository above site/), DATA_DIR (default site/.data).
 * Flags override them. Nothing here writes to the database.
 */

import { copyFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { databaseFile, openDatabase } from '../server/src/db/db.ts';
import { readRestoreSource } from '../server/src/history/restore.ts';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE =
  'usage: restore.mjs --chapter N (--list | --rev R [--dry-run] [--because "…"]) [--root DIR] [--data-dir DIR]';

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
  if (!Number.isInteger(n) || n < 1 || n > 67) throw new Error('--chapter must be an integer between 1 and 67');
  return n;
}

function fileName(n) {
  return `ch${String(n).padStart(2, '0')}.md`;
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
  const bookRoot = absolute(flags.get('root') ?? process.env.BOOK_ROOT ?? join(SITE_ROOT, '..'));
  const dataDir = absolute(flags.get('data-dir') ?? process.env.DATA_DIR ?? join(SITE_ROOT, '.data'));
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
  const target = join(bookRoot, 'manuscript', fileName(n));
  const text = source.text;

  if (rev === currentRev) {
    console.log(`глава ${n} уже на rev ${rev}: ничего не меняется`);
    return 0;
  }

  if (flags.get('dry-run')) {
    console.log(`проверка: версия ${rev} → ${target} (${text.length} знаков), без записи`);
    return 0;
  }

  const sourceFile = join(dataDir, String(chosen.snapshot));
  copyFileSync(sourceFile, target);
  console.log(`глава ${n} восстановлена из rev ${rev} (${text.length} знаков) → ${target}`);
  console.log('дальше — обычный путь:');
  console.log('  node site/bin/validate.mjs');
  const because = flags.get('because') ?? `restore rev ${rev}`;
  console.log(`  node site/bin/engine.mjs reconcile ${n} --because ${JSON.stringify(because)}`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`restore: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
