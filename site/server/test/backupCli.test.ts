/**
 * BOOK-183 — `node bin/backup.mjs`, the backup that runs inside the `site` container.
 *
 * The CLI is spawned, never imported: what is under test is the operator's contract — argv in,
 * one line (or one JSON object) out, and the exit codes a host wrapper scripts against. Every
 * directory here is a `mkdtemp` under the system temp dir; `/data`, `/backups` and the live data
 * dirs are never opened, and the Docker daemon is never involved.
 *
 * The fixture database carries **only the seven tables the CLI counts**, not `schema.ts`. The
 * contract being proved is "a consistent copy with the right row counts and a good integrity
 * check", and the table list is that contract; copying §8's columns in would tie a backup test to
 * a schema that moves, and the schema is not what a backup can get wrong.
 *
 * The fixture's connection stays **open** with `journal_mode=WAL` while the CLI runs. Those rows
 * are therefore still in `book.db-wal`, not in the main file — which is exactly the case that a
 * plain `cp` loses and the online backup API must not.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

const SITE = resolve(import.meta.dirname, '..', '..');
const CLI = join(SITE, 'bin', 'backup.mjs');

/** The rows the fixture writes, per table — the counts the manifest must report. */
const ROWS = { chapters: 3, blocks: 2, changes: 4, comments: 5, identities: 1, revisions: 2, events: 3 };
const VERSIONS = { 'ch01/rev1.md': '# глава первая\n', 'ch02/rev1.md': '# глава вторая\n' };
const HOUR = 60 * 60 * 1000;

type Run = { status: number; stdout: string; stderr: string };
type Fixture = { root: string; data: string; out: string; token: string };

const tmpDirs: string[] = [];
const connections: Database.Database[] = [];

afterEach(() => {
  for (const db of connections.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by the test: nothing to release.
    }
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), label));
  tmpDirs.push(dir);
  return dir;
}

/** The shell's environment minus every variable that could point a run at a real volume. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ['DATA_DIR', 'BACKUP_ROOT', 'NODE_ENV', 'NODE_PATH']) delete env[name];
  return env;
}

async function runCli(args: string[], extra: Record<string, string> = {}): Promise<Run> {
  return runCliFrom(CLI, args, extra);
}

/** The same runner for a CLI copied elsewhere — the missing-dependency case needs one. */
async function runCliFrom(cli: string, args: string[], extra: Record<string, string> = {}): Promise<Run> {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...cleanEnv(), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number>((done) => child.on('close', (code) => done(code ?? 1)));
  return { status, stdout, stderr };
}

/** The same digest the CLI computes, spelled out here so a broken CLI cannot agree with itself. */
function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** `daily/<YYYYmmddTHHMMSS>` for a moment `days` in the past, as the CLI names them. */
function stampDaysAgo(days: number): string {
  const iso = new Date(Date.now() - days * 24 * HOUR).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/**
 * A data dir with `book.db` (WAL, open, seeded) and `versions/`, plus a backup root. The token
 * file is the real data dir's neighbour (`admin.token`) and its value must never be printed.
 */
function createFixture(options: { db?: boolean; versions?: boolean } = {}): Fixture {
  const root = tmpDir('book-backup-');
  const data = join(root, 'data');
  const out = join(root, 'backups');
  mkdirSync(data, { recursive: true });
  const token = `bk-secret-${randomUUID()}`;
  writeFileSync(join(data, 'admin.token'), `${token}\n`, { mode: 0o600 });

  if (options.db !== false) {
    const db = new Database(join(data, 'book.db'));
    connections.push(db);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE chapters (n INTEGER PRIMARY KEY);
      CREATE TABLE blocks (id TEXT PRIMARY KEY);
      CREATE TABLE changes (id TEXT PRIMARY KEY);
      CREATE TABLE comments (id TEXT PRIMARY KEY);
      CREATE TABLE identities (id TEXT PRIMARY KEY);
      CREATE TABLE revisions (id TEXT PRIMARY KEY);
      CREATE TABLE events (id TEXT PRIMARY KEY);
    `);
    for (let n = 1; n <= ROWS.chapters; n += 1) db.prepare('INSERT INTO chapters (n) VALUES (?)').run(n);
    for (const table of ['blocks', 'changes', 'comments', 'identities', 'revisions', 'events'] as const) {
      for (let index = 1; index <= ROWS[table]; index += 1) {
        db.prepare(`INSERT INTO "${table}" (id) VALUES (?)`).run(`${table}-${String(index)}`);
      }
    }
  }

  if (options.versions !== false) {
    for (const [relative, text] of Object.entries(VERSIONS)) {
      const file = join(data, 'versions', relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  }
  return { root, data, out, token };
}

/** The `dir=` a successful run printed — every assertion below works against what it published. */
function publishedDir(run: Run): string {
  const found = /dir=(\S+)/u.exec(run.stdout);
  if (found === null) throw new Error(`no dir= in stdout: ${JSON.stringify(run.stdout)}`);
  return found[1] ?? '';
}

function manifestLines(dir: string): { head: string; hashes: Map<string, string> } {
  const lines = readFileSync(join(dir, 'manifest.txt'), 'utf8').trimEnd().split('\n');
  const head = lines[0] ?? '';
  const hashes = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
    if (match === null) throw new Error(`manifest line is not "<sha256>  <path>": ${line}`);
    hashes.set(match[2] ?? '', match[1] ?? '');
  }
  return { head, hashes };
}

/** The seven counts the CLI reports, read through one connection. */
function countsOf(db: Database.Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of Object.keys(ROWS)) {
    counts[table] = (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
  }
  return counts;
}

/**
 * The bytes the database's own pages hold: `page_count × page_size`. This is the platform-neutral
 * "every page is in the main file" proof; the on-disk size is not, because page and header details
 * differ between the macOS build used locally and the Debian runner.
 */
const pageBytes = (db: Database.Database): number =>
  Number(db.pragma('page_count', { simple: true })) * Number(db.pragma('page_size', { simple: true }));

describe('bin/backup.mjs', () => {
  it('publishes a consistent, self-contained daily copy and proves it in the manifest', async () => {
    const fixture = createFixture();
    // The rows are in the WAL, not the main file: a plain copy would lose them.
    expect(statSync(join(fixture.data, 'book.db-wal')).size).toBeGreaterThan(0);

    const run = await runCli(['--data', fixture.data, '--out', fixture.out]);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');

    const line = run.stdout.trimEnd();
    expect(line.includes('\n')).toBe(false);
    expect(line).toMatch(
      /^book-backup ts=\d{4}-\d{2}-\d{2}T[\d:.]+Z status=ok dir=\S+ chapters=3 blocks=2 changes=4 comments=5 versions=2 duration_ms=\d+$/u,
    );
    const dir = publishedDir(run);
    expect(dir.startsWith(join(fixture.out, 'daily') + '/')).toBe(true);
    expect(readdirSync(join(fixture.out, 'daily'))).toEqual([dir.slice(dir.lastIndexOf('/') + 1)]);

    // The copy is self-contained: DELETE journal mode, no -wal/-shm beside it, integrity ok, and every
    // page the source holds is inside the copy's main file — `page_count × page_size` is the same on
    // both sides, which the file's byte size is not (page/header layout differs by platform), and the
    // row counts of the copy are the source's row-by-row.
    const copy = new Database(join(dir, 'book.db'), { readonly: true });
    const source = new Database(join(fixture.data, 'book.db'), { readonly: true });
    try {
      expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(statSync(join(dir, 'book.db')).size).toBeGreaterThan(0);
      expect(pageBytes(copy)).toBeGreaterThan(0);
      expect(pageBytes(copy)).toBe(pageBytes(source));
      expect(countsOf(copy)).toEqual(countsOf(source));
      expect(countsOf(copy)).toEqual(ROWS);
    } finally {
      copy.close();
      source.close();
    }
    expect(existsSync(join(dir, 'book.db-wal'))).toBe(false);
    expect(existsSync(join(dir, 'book.db-shm'))).toBe(false);

    // Counts from the copy include the rows that were still in the WAL.
    const { head, hashes } = manifestLines(dir);
    expect(head).toBe(
      'chapters=3 blocks=2 changes=4 comments=5 identities=1 revisions=2 events=3 versions_files=2',
    );
    expect([...hashes.keys()]).toEqual(['book.db', 'versions/ch01/rev1.md', 'versions/ch02/rev1.md']);
    expect(hashes.get('book.db')).toBe(sha256(join(dir, 'book.db')));
    for (const relative of Object.keys(VERSIONS)) {
      expect(hashes.get(`versions/${relative}`)).toBe(sha256(join(fixture.data, 'versions', relative)));
      expect(readFileSync(join(dir, 'versions', relative))).toEqual(readFileSync(join(fixture.data, 'versions', relative)));
    }

    // The first run of the week also makes the weekly snapshot, as a full copy of that daily.
    const weekly = readdirSync(join(fixture.out, 'weekly'));
    expect(weekly).toHaveLength(1);
    expect(weekly[0]).toMatch(/^\d{4}-W\d{2}$/u);
    expect(readFileSync(join(fixture.out, 'weekly', weekly[0] ?? '', 'manifest.txt'))).toEqual(
      readFileSync(join(dir, 'manifest.txt')),
    );

    // `/backups` is a host bind, so the copy is operator data: `umask 077` in the CLI makes the run's
    // directory 0700 and every file 0600 — nothing in it is world-readable on the host, whatever mode
    // the snapshot had in the data volume (the published copy is normalized, not a mode-for-mode clone).
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(fixture.out, 'daily')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'book.db')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'manifest.txt')).mode & 0o777).toBe(0o600);
    // A copied snapshot's exact bits are Node's `fs.cp` behaviour, which differs between macOS and the
    // Debian runner; what the copy must not do is come out MORE open than the file it came from.
    const snapshot = statSync(join(dir, 'versions', 'ch01', 'rev1.md')).mode & 0o777;
    const snapshotSource = statSync(join(fixture.data, 'versions', 'ch01', 'rev1.md')).mode & 0o777;
    expect(snapshot & 0o022).toBe(0);
    expect(snapshot & 0o044).toBeLessThanOrEqual(snapshotSource & 0o044);

    // The lock and the staging dir are gone; the token value never appeared anywhere.
    expect(existsSync(join(fixture.out, '.lock'))).toBe(false);
    expect(readdirSync(fixture.out).filter((name) => name.startsWith('.inprogress'))).toEqual([]);
    expect(run.stdout).not.toContain(fixture.token);
    expect(run.stderr).not.toContain(fixture.token);
    expect(readFileSync(join(dir, 'manifest.txt'), 'utf8')).not.toContain(fixture.token);

    // `--verify` reads the published copy and answers with the same counts, writing nothing.
    const verify = await runCli(['--verify', dir]);
    expect(verify.status).toBe(0);
    expect(verify.stderr).toBe('');
    expect(JSON.parse(verify.stdout)).toMatchObject({
      job: 'book-backup',
      status: 'ok',
      dir,
      integrity: 'ok',
      ...ROWS,
      versions: 2,
    });
  });

  it('--json prints one JSON object instead of the log line', async () => {
    const fixture = createFixture();
    const run = await runCli(['--data', fixture.data, '--out', fixture.out, '--json']);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(run.stdout.trimEnd().includes('\n')).toBe(false);
    expect(parsed).toMatchObject({ job: 'book-backup', status: 'ok', integrity: 'ok', ...ROWS, versions: 2 });
    expect(typeof parsed.dir).toBe('string');
    expect(parsed.dir.startsWith(join(fixture.out, 'daily') + '/')).toBe(true);
    expect(existsSync(join(parsed.dir, 'manifest.txt'))).toBe(true);
    expect(parsed.duration_ms).toBeTypeOf('number');
    // Exactly one JSON object: nothing else shares stdout with it.
    expect(() => JSON.parse(run.stdout)).not.toThrow();
  });

  it('takes --data/--out from the environment when the flags are absent, flags win', async () => {
    const fixture = createFixture({ versions: false });
    const fromEnv = await runCli([], { DATA_DIR: fixture.data, BACKUP_ROOT: fixture.out });
    expect(fromEnv.status).toBe(0);
    expect(publishedDir(fromEnv).startsWith(join(fixture.out, 'daily') + '/')).toBe(true);
    expect(readdirSync(join(fixture.out, 'daily'))).toHaveLength(1);

    const elsewhere = join(fixture.root, 'elsewhere');
    const flagged = await runCli(['--out', elsewhere], { DATA_DIR: fixture.data, BACKUP_ROOT: fixture.out });
    expect(flagged.status).toBe(0);
    expect(publishedDir(flagged).startsWith(elsewhere + '/')).toBe(true);
    expect(readdirSync(join(elsewhere, 'daily'))).toHaveLength(1);
  });

  it('keeps the newest seven dailies and removes the older ones', async () => {
    const fixture = createFixture({ versions: false });
    const daily = join(fixture.out, 'daily');
    mkdirSync(daily, { recursive: true });
    const prepared = [9, 8, 7, 6, 5, 4, 3, 2, 1].map((days) => stampDaysAgo(days));
    for (const name of prepared) mkdirSync(join(daily, name));

    const run = await runCli(['--data', fixture.data, '--out', fixture.out]);
    expect(run.status).toBe(0);
    const published = publishedDir(run);
    const fresh = published.slice(published.lastIndexOf('/') + 1);

    const kept = readdirSync(daily).sort();
    expect(kept).toHaveLength(7);
    expect(kept).toContain(fresh);
    // The three oldest prepared copies are the ones that go; the run's own dir is never pruned.
    expect(kept).not.toContain(prepared[0]);
    expect(kept).not.toContain(prepared[1]);
    expect(kept).not.toContain(prepared[2]);
    expect(kept).toEqual([...prepared.slice(3), fresh].sort());
  });

  it('exits 75 while a lock is held, and takes over one older than six hours', async () => {
    const fixture = createFixture({ versions: false });
    const lock = join(fixture.out, '.lock');
    mkdirSync(lock, { recursive: true });

    const busy = await runCli(['--data', fixture.data, '--out', fixture.out]);
    expect(busy.status).toBe(75);
    expect(busy.stdout).toBe('');
    expect(busy.stderr.trimEnd().includes('\n')).toBe(false);
    expect(busy.stderr).toMatch(/reason=LOCKED/u);
    // Nothing was created next to the live lock: no daily dir, no staging dir.
    expect(existsSync(join(fixture.out, 'daily'))).toBe(false);
    expect(readdirSync(fixture.out).filter((name) => name.startsWith('.inprogress'))).toEqual([]);
    expect(existsSync(lock)).toBe(true);

    const past = (Date.now() - 7 * HOUR) / 1000;
    utimesSync(lock, past, past);
    const taken = await runCli(['--data', fixture.data, '--out', fixture.out]);
    expect(taken.status).toBe(0);
    expect(taken.stderr).toBe('');
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(join(fixture.out, 'daily'))).toHaveLength(1);
  });

  it('--verify refuses a corrupted copy: exit 1 and a named reason', async () => {
    const fixture = createFixture();
    const run = await runCli(['--data', fixture.data, '--out', fixture.out]);
    expect(run.status).toBe(0);
    const dir = publishedDir(run);

    // A torn file: the header is still there, the pages behind it are not.
    const whole = readFileSync(join(dir, 'book.db'));
    writeFileSync(join(dir, 'book.db'), whole.subarray(0, 4096));

    const verify = await runCli(['--verify', dir]);
    expect(verify.status).toBe(1);
    expect(verify.stderr.trimEnd().includes('\n')).toBe(false);
    expect(verify.stderr).toMatch(/reason=(INTEGRITY_FAILED|DB_UNREADABLE)/u);
    const body = JSON.parse(verify.stdout);
    expect(body).toMatchObject({ job: 'book-backup', status: 'fail' });
    expect(body.reason).toMatch(/INTEGRITY_FAILED|DB_UNREADABLE/u);
    expect(verify.stdout).not.toContain(fixture.token);
  });

  it('a failure after staging leaves no staging directory and no lock', async () => {
    const fixture = createFixture({ db: false, versions: false });
    // A file that is not a database: staging is created, the copy is refused, and nothing stays.
    writeFileSync(join(fixture.data, 'book.db'), Buffer.alloc(8192, 0x41));

    const run = await runCli(['--data', fixture.data, '--out', fixture.out]);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr.trimEnd().includes('\n')).toBe(false);
    expect(run.stderr).toMatch(/reason=BACKUP_FAILED/u);
    expect(readdirSync(fixture.out).filter((name) => name.startsWith('.inprogress'))).toEqual([]);
    expect(existsSync(join(fixture.out, '.lock'))).toBe(false);
    expect(readdirSync(join(fixture.out, 'daily'))).toEqual([]);
    // The refusal names the paths it tried, never a body.
    expect(run.stderr).toContain(fixture.data);
  });

  it('a failed publish leaves no .inprogress.* in --out', async () => {
    const fixture = createFixture();
    const daily = join(fixture.out, 'daily');
    mkdirSync(daily, { recursive: true });
    // The artifact is copied into `<out>` first and renamed into `daily/`; a read-only `daily/` makes the
    // rename fail with the copy already on the host bind. Nothing may survive that.
    chmodSync(daily, 0o500);
    try {
      const run = await runCli(['--data', fixture.data, '--out', fixture.out]);
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/reason=[A-Z_]+/u);
      expect(readdirSync(fixture.out).filter((name) => name.startsWith('.inprogress'))).toEqual([]);
      expect(readdirSync(daily)).toEqual([]);
      expect(existsSync(join(fixture.out, '.lock'))).toBe(false);
    } finally {
      chmodSync(daily, 0o700);
    }
  });

  it('names its refusals: a missing database is 1, an unknown flag is 2', async () => {
    const fixture = createFixture({ db: false, versions: false });

    const missing = await runCli(['--data', fixture.data, '--out', fixture.out]);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toMatch(/reason=DB_MISSING/u);

    const usage = await runCli(['--data', fixture.data, '--out', fixture.out, '--nope', 'x']);
    expect(usage.status).toBe(2);
    expect(usage.stderr).toMatch(/reason=USAGE/u);
    expect(usage.stderr).toMatch(/usage:/u);

    const zero = await runCli(['--data', fixture.data, '--out', fixture.out, '--keep-daily', '0']);
    expect(zero.status).toBe(2);
    expect(zero.stderr).toMatch(/reason=USAGE/u);
  });

  it('refuses a copy whose schema misses a counted table instead of reporting zero', async () => {
    const fixture = createFixture({ db: false, versions: false });
    const db = new Database(join(fixture.data, 'book.db'));
    connections.push(db);
    db.exec('CREATE TABLE chapters (n INTEGER PRIMARY KEY); CREATE TABLE blocks (id TEXT PRIMARY KEY)');

    const run = await runCli(['--data', fixture.data, '--out', fixture.out]);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toMatch(/reason=TABLE_MISSING/u);
    // The copy was already staged when the schema refused: nothing is left behind.
    expect(readdirSync(fixture.out).filter((name) => name.startsWith('.inprogress'))).toEqual([]);
    expect(existsSync(join(fixture.out, '.lock'))).toBe(false);
    expect(readdirSync(join(fixture.out, 'daily'))).toEqual([]);
  });

  it('says why it cannot run when better-sqlite3 is absent, in one line', async () => {
    const fixture = createFixture({ db: false, versions: false });
    // A copy of `bin/` outside the workspace: `./lib/backupFs.mjs` resolves, `better-sqlite3`
    // does not. The image ships it as a server dependency, and a pruned tree must still explain.
    const copied = join(tmpDir('book-backup-bin-'), 'bin');
    cpSync(join(SITE, 'bin'), copied, { recursive: true });

    const run = await runCliFrom(join(copied, 'backup.mjs'), ['--data', fixture.data, '--out', fixture.out]);
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr.trimEnd().includes('\n')).toBe(false);
    expect(run.stderr).toMatch(/reason=MODULE_MISSING/u);
    expect(run.stderr).not.toContain(fixture.token);
  });
});
