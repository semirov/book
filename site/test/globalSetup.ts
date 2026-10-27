/**
 * The suite run's isolation proof (BOOK-107). Before the run, snapshot the two data dirs a test
 * must never touch — `site/.data` (the dev server's) and `$HOME/book-site-data` (production) —
 * and compare in teardown.
 *
 * What is **fatal** is a structural change: an entry added or removed anywhere under either dir,
 * a dir that appears or vanishes, or a non-database file whose size or mtime moved. That is the
 * mistake a test can make — a token file, a feedback batch, a version snapshot, a stray DB.
 *
 * What is **reported, never fatal**: the live SQLite files (`book.db`, `-wal`, `-shm`) — a
 * running service rewrites them in place, so `stat` cannot attribute a write — and the row
 * counts read from them. They are printed as before → after pairs, so a reader sees the same
 * numbers the incident would have changed, without the run being a coin flip while the site is up.
 *
 * Neither directory is created here: an absent one is recorded as absent and reported (on CI the
 * production dir is simply not there), and it is compared the same way if it appears.
 */

import { lstatSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';

const SITE = resolve(import.meta.dirname, '..');

type Target = { label: string; dir: string };
type Snapshot = { present: boolean; entries: Map<string, string> };
/** The evidence a reader wants when a data dir is in question (never a gate). */
type Rows = { chapters: number; blocks: number; changes: number; comments: number; lastScan: string | null };

/** Every entry under `dir` as `relative path → "size:mtime"`, recursively, sorted. */
function snapshot(dir: string): Snapshot {
  const entries = new Map<string, string>();
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(dir);
  } catch {
    // Absent is a state, not an error: the snapshot records it and the run reports it.
    return { present: false, entries };
  }
  if (!stats.isDirectory()) {
    // The path exists but is not a directory: record the path itself, so a test that turns
    // `site/.data` into a file is still a difference, not "absent twice".
    entries.set('.', `${String(stats.size)}:${String(stats.mtimeMs)}`);
    return { present: true, entries };
  }
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
      const entry = lstatSync(path);
      entries.set(relative, `${String(entry.size)}:${String(entry.mtimeMs)}`);
      if (entry.isDirectory()) walk(path, relative);
    }
  };
  walk(dir, '');
  return { present: true, entries };
}

/**
 * The book's shape, read through a read-only connection (`fileMustExist`, never created, never
 * written). `null` when there is no readable database: absent, locked or not this book's file.
 */
function rowsOf(dir: string): Rows | null {
  let db: Database.Database;
  try {
    db = new Database(join(dir, 'book.db'), { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const count = (table: string): number =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const scan = db.prepare(`SELECT v FROM meta WHERE k = 'last_scan_at'`).get() as { v?: string } | undefined;
    return {
      chapters: count('chapters'),
      blocks: count('blocks'),
      changes: count('changes'),
      comments: count('comments'),
      lastScan: scan?.v ?? null,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** SQLite's live files at the root of a data dir; a nested `book.db` stays an ordinary entry. */
function isLiveDbFile(key: string): boolean {
  return !key.includes('/') && (key === 'book.db' || key === 'book.db-wal' || key === 'book.db-shm');
}

const sizeOf = (value: string | undefined): string => (value === undefined ? '-' : (value.split(':')[0] ?? '-'));
const mtimeOf = (value: string | undefined): string => (value === undefined ? '-' : (value.split(':')[1] ?? '-'));

/** A changed data dir can be huge; the log names the first entries and counts the rest. */
const SHOWN = 30;

function rowsLine(dir: string, before: Rows | null, after: Rows | null, present: boolean): string {
  const head = `test: isolation — ${dir} rows:`;
  if (before === null || after === null) {
    return `${head} n/a (${present ? 'no readable book.db' : 'absent'})`;
  }
  const pair = (name: string, from: number | string | null, to: number | string | null): string =>
    `${name} ${String(from ?? 'none')} → ${String(to ?? 'none')}`;
  return (
    `${head} ${pair('chapters', before.chapters, after.chapters)}, ${pair('blocks', before.blocks, after.blocks)}, ` +
    `${pair('changes', before.changes, after.changes)}, ${pair('comments', before.comments, after.comments)}, ` +
    `${pair('last_scan_at', before.lastScan, after.lastScan)}`
  );
}

export default function isolationSnapshot(): () => void {
  const targets: Array<Target & { snap: Snapshot; rows: Rows | null }> = [
    { label: 'site/.data (dev)', dir: resolve(SITE, '.data') },
    { label: 'production data dir (prod)', dir: resolve(homedir(), 'book-site-data') },
  ].map((target) => ({ ...target, snap: snapshot(target.dir), rows: rowsOf(target.dir) }));

  for (const target of targets) {
    const state = target.snap.present ? `${String(target.snap.entries.size)} entries` : 'absent';
    console.log(`test: isolation — ${target.label} (${target.dir}): ${state}`);
  }

  return () => {
    const problems: string[] = [];
    const reported: string[] = [];
    const summary: string[] = [];
    for (const target of targets) {
      const after = snapshot(target.dir);
      const rowsAfter = rowsOf(target.dir);
      console.log(rowsLine(target.dir, target.rows, rowsAfter, after.present));

      if (!target.snap.present && !after.present) {
        summary.push(`${target.label} absent`);
        continue;
      }
      if (target.snap.present !== after.present) {
        problems.push(`${target.dir}: ${target.snap.present ? 'removed' : 'created'} during the run`);
        continue;
      }
      const keys = [...new Set([...target.snap.entries.keys(), ...after.entries.keys()])].sort();
      for (const key of keys) {
        const was = target.snap.entries.get(key);
        const now = after.entries.get(key);
        if (was === now) continue;
        const path = join(target.dir, key);
        if (isLiveDbFile(key)) {
          reported.push(
            `${path}: size ${sizeOf(was)} → ${sizeOf(now)}, mtime ${mtimeOf(was)} → ${mtimeOf(now)} ` +
              '(a live server owns this file; stat cannot attribute a write)',
          );
        } else if (was === undefined) problems.push(`${path}: added (${String(now)})`);
        else if (now === undefined) problems.push(`${path}: removed (was ${was})`);
        else problems.push(`${path}: changed (${was} -> ${now})`);
      }
      summary.push(`${target.label} unchanged (${String(after.entries.size)} entries)`);
    }

    for (const line of reported) console.log(`test: isolation — ${line}`);
    if (problems.length > 0) {
      const shown = problems.slice(0, SHOWN).map((line) => `  ${line}`).join('\n');
      const rest = problems.length > SHOWN ? `\n  … and ${String(problems.length - SHOWN)} more` : '';
      throw new Error(
        `the test run touched a data dir that tests must never touch (BOOK-107):\n${shown}${rest}\n` +
          'site/.data belongs to the dev server, $HOME/book-site-data to the live site; ' +
          'a test builds its own mkdtemp fixture instead',
      );
    }
    console.log(`test: isolation — ${summary.join('; ')}`);
  };
}
