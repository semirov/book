/**
 * BOOK-187 AC12 — the volume cutover, proved on a temp volume shaped like the live one.
 *
 * The live volume still holds what the old image wrote: `writer/state.json`, `writer/pre/`,
 * `writer/transcripts/` and a legacy singular `backup/`. The code stopped writing them and the
 * deploy gate names them, so this one command folds such a volume into the allow-list. The tests
 * are the CLI as a real process (`node bin/home-migrate.mjs`), because the contract the deploy
 * reads is its argv, its exit codes and the paths it prints — and a stub would prove none of the
 * three. Every case runs on `mkdtemp`: the real volume is never touched.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { SITE_ROOT } from '../src/config.ts';
import { openDatabase } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { SCHEMA_VERSION } from '../src/db/schema.ts';

const exec = promisify(execFile);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ABOUT =
  'Служебная аннотация для проверки миграции тома. Она состоит из служебных предложений и не является текстом книги. '.repeat(3);

/** A v28 volume: a front-matter row and one written chapter — the shape a live book has. */
function liveVolume(prefix = 'book-migrate-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, 'book.db'));
  migrate(db);
  db.prepare(
    `INSERT INTO front_matter (id, title, about, rev, sha256, about_sha256, updated_at)
     VALUES (1, 'Бланк', ?, 1, 'sha-front', 'sha-about', '2026-10-28T10:00:00Z')`,
  ).run(ABOUT);
  db.prepare(
    `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, basis, written_at, updated_at)
     VALUES (2, 1, NULL, 'sha-ch02', 1200, 3, 0, '2026-10-28T10:00:00Z', '2026-10-28T10:00:00Z')`,
  ).run();
  db.close();
  return dataDir;
}

/** The old writer's files beside the database, and the singular dump directory. */
function oldVolume(): string {
  const dataDir = liveVolume();
  mkdirSync(join(dataDir, 'writer', 'pre'), { recursive: true });
  mkdirSync(join(dataDir, 'writer', 'transcripts'), { recursive: true });
  writeFileSync(join(dataDir, 'writer', 'state.json'), '{"passes":3}\n');
  writeFileSync(join(dataDir, 'writer', 'pre', 'ch08-old.md'), 'прежний текст\n');
  writeFileSync(join(dataDir, 'writer', 'transcripts', 'stp_one.json'), '{"role":"writer"}\n');
  mkdirSync(join(dataDir, 'backup'), { recursive: true });
  writeFileSync(join(dataDir, 'backup', 'old.db'), 'legacy dump bytes\n');
  mkdirSync(join(dataDir, 'archive'), { recursive: true });
  mkdirSync(join(dataDir, 'versions'), { recursive: true });
  return dataDir;
}

/** Every path under `dir`, with a file's bytes — the whole tree, so "nothing changed" is literal. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (path: string, prefix: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(join(path, entry.name), rel);
      } else {
        out.push(`${rel}:${readFileSync(join(path, entry.name), 'utf8')}`);
      }
    }
  };
  walk(dir, '');
  return out;
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  delete env.DATA_DIR;
  try {
    const { stdout, stderr } = await exec('node', ['bin/home-migrate.mjs', ...args], { cwd: SITE_ROOT, env });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('bin/home-migrate.mjs — the dry run', () => {
  it('prints the four paths it would act on and changes nothing', async () => {
    const dataDir = oldVolume();
    const before = snapshot(dataDir);

    const result = await run(['--data-dir', dataDir]);

    expect(result.code, result.out).toBe(0);
    expect(snapshot(dataDir)).toEqual(before);
    // One line per path: the three retired writer paths, then the legacy dump's move.
    const actions = result.out.split('\n').filter((line) => /^would (remove|move) /u.test(line));
    expect(actions).toHaveLength(4);
    expect(actions).toEqual([
      `would remove ${join(dataDir, 'writer', 'pre')}`,
      `would remove ${join(dataDir, 'writer', 'state.json')}`,
      `would remove ${join(dataDir, 'writer', 'transcripts')}`,
      `would move ${join(dataDir, 'backup', 'old.db')} -> ${join(dataDir, 'backups', 'old.db')}`,
    ]);
    // Nothing beyond the allow-list is planned: the database and the trees stay.
    expect(result.out).not.toContain('book.db');
    expect(result.out).not.toContain('versions');
    expect(result.out).not.toContain('archive');
  });

  it('opens no database, so it cannot leave a -wal in a volume it only describes', async () => {
    const dataDir = oldVolume();
    const before = readdirSync(dataDir).sort();
    await run(['--data-dir', dataDir]);
    expect(readdirSync(dataDir).sort()).toEqual(before);
  });
});

describe('bin/home-migrate.mjs — --apply', () => {
  it('leaves only allow-listed entries, keeps the dump, and the home guard passes on that tree', async () => {
    const dataDir = oldVolume();

    const result = await run(['--data-dir', dataDir, '--apply']);

    expect(result.code, result.out).toBe(0);
    expect(existsSync(join(dataDir, 'writer'))).toBe(false);
    expect(existsSync(join(dataDir, 'backup'))).toBe(false);
    expect(readFileSync(join(dataDir, 'backups', 'old.db'), 'utf8')).toBe('legacy dump bytes\n');
    // 0700 on the directory the dumps land in, the same mode boot's dumps take.
    expect(statSync(join(dataDir, 'backups')).mode & 0o777).toBe(0o700);
    // The book and the trees it owns are untouched.
    for (const name of ['book.db', 'archive', 'versions']) expect(existsSync(join(dataDir, name)), name).toBe(true);

    // The guard the deploy runs, on the migrated tree: exit 0.
    const { stdout, stderr } = await exec('node', ['bin/home-check.mjs', '--data-dir', dataDir, '--manuscript', join(dataDir, '..', 'none')], {
      cwd: SITE_ROOT,
      env: { ...process.env },
    });
    expect(`${stdout}${stderr}`).toContain('ok');
  });

  it('never overwrites a dump: a taken name gets a -1 suffix and the pair is printed', async () => {
    const dataDir = oldVolume();
    mkdirSync(join(dataDir, 'backups'), { recursive: true });
    writeFileSync(join(dataDir, 'backups', 'old.db'), 'the newer dump\n');

    const result = await run(['--data-dir', dataDir, '--apply']);

    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`${join(dataDir, 'backup', 'old.db')} -> ${join(dataDir, 'backups', 'old-1.db')}`);
    expect(result.out).toContain('that name was taken');
    expect(readFileSync(join(dataDir, 'backups', 'old.db'), 'utf8')).toBe('the newer dump\n');
    expect(readFileSync(join(dataDir, 'backups', 'old-1.db'), 'utf8')).toBe('legacy dump bytes\n');
  });

  it('is idempotent: the second run finds nothing and says so', async () => {
    const dataDir = oldVolume();
    expect((await run(['--data-dir', dataDir, '--apply'])).code).toBe(0);
    const again = await run(['--data-dir', dataDir, '--apply']);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toContain('nothing to do');
  });
});

describe('bin/home-migrate.mjs — what it refuses', () => {
  it('refuses a writer/ it cannot name, names the path, and removes nothing', async () => {
    const dataDir = oldVolume();
    writeFileSync(join(dataDir, 'writer', 'unknown.txt'), 'who wrote this?\n');

    const result = await run(['--data-dir', dataDir, '--apply']);

    expect(result.code).toBe(1);
    expect(result.out).toContain(join(dataDir, 'writer', 'unknown.txt'));
    expect(result.out).toContain('nothing was changed');
    // The three paths it does know are still there: a refusal is before the first removal.
    expect(existsSync(join(dataDir, 'writer', 'state.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'writer', 'pre'))).toBe(true);
    expect(existsSync(join(dataDir, 'backup', 'old.db'))).toBe(true);
  });

  it('folds an OLDER schema: the row proof is what decides, not the version', async () => {
    // The deploy deadlock this test exists for: the launchd cutover runs BEFORE the restart that
    // migrates the volume, so a live v25 volume must be foldable — refusing it would gate the
    // deploy behind the boot it precedes. Rows exist since v1, so the proof holds.
    const dataDir = oldVolume();
    const db = openDatabase(join(dataDir, 'book.db'));
    db.pragma('user_version = 25');
    db.close();

    const result = await run(['--data-dir', dataDir, '--apply']);

    expect(result.code, result.out).toBe(0);
    expect(existsSync(join(dataDir, 'writer', 'state.json'))).toBe(false);
    expect(readFileSync(join(dataDir, 'backups', 'old.db'), 'utf8')).toBe('legacy dump bytes\n');
  });

  it('refuses a FUTURE schema with SCHEMA_FUTURE semantics, and touches nothing', async () => {
    const dataDir = oldVolume();
    const db = openDatabase(join(dataDir, 'book.db'));
    db.pragma(`user_version = ${String(SCHEMA_VERSION + 1)}`);
    db.close();

    const result = await run(['--data-dir', dataDir, '--apply']);

    expect(result.code).toBe(1);
    expect(result.out).toContain(`v${String(SCHEMA_VERSION + 1)}`);
    expect(result.out).toContain(`v${String(SCHEMA_VERSION)}`);
    expect(result.out).toContain('SCHEMA_FUTURE');
    expect(existsSync(join(dataDir, 'writer', 'state.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'backup', 'old.db'))).toBe(true);
  });

  it('refuses a database with no front-matter row', async () => {
    const dataDir = oldVolume();
    const db = openDatabase(join(dataDir, 'book.db'));
    db.prepare('DELETE FROM front_matter').run();
    db.close();

    const result = await run(['--data-dir', dataDir, '--apply']);

    expect(result.code).toBe(1);
    expect(result.out).toContain('front_matter');
    expect(existsSync(join(dataDir, 'writer', 'state.json'))).toBe(true);
  });

  it('refuses a database whose front row has no title', async () => {
    const dataDir = oldVolume();
    const db = openDatabase(join(dataDir, 'book.db'));
    db.prepare("UPDATE front_matter SET title = '   ' WHERE id = 1").run();
    db.close();

    const result = await run(['--data-dir', dataDir, '--apply']);

    expect(result.code).toBe(1);
    expect(result.out).toContain('no front_matter row with a title');
    expect(existsSync(join(dataDir, 'writer', 'state.json'))).toBe(true);
  });

  it('refuses a database with no written chapter', async () => {
    const dataDir = oldVolume();
    const db = openDatabase(join(dataDir, 'book.db'));
    db.prepare('DELETE FROM chapters').run();
    db.close();

    const result = await run(['--data-dir', dataDir, '--apply']);

    expect(result.code).toBe(1);
    expect(result.out).toContain('no written chapter');
  });

  it('refuses a directory with no book.db at all', async () => {
    const root = mkdtempSync(join(tmpdir(), 'book-migrate-empty-'));
    roots.push(root);
    const result = await run(['--data-dir', root, '--apply']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('no database at');
  });

  it('exits 2 on usage: no value for --data-dir, and an unknown flag', async () => {
    expect((await run(['--data-dir'])).code).toBe(2);
    expect((await run(['--bogus'])).code).toBe(2);
  });
});
