#!/usr/bin/env node
/**
 * scripts/position-seed.ts — one fresh volume, one book: the fixture `position-cdp.mjs` boots.
 *
 * The measurement has to run against a real site, so it needs a real database. Two sources, both
 * of them the product's own:
 *
 *   - **a book tree** — a fresh `DATA_DIR` is booted (`db/boot.ts`: schema, dump, stamps) and then
 *     filled by the one-shot import (`ingest/reconcile.ts`), exactly as an operator brings a
 *     restored checkout into a volume. The measurement harness's own default arrives through this
 *     door: a fixture `manuscript/` it writes into a temp directory and deletes with the run;
 *   - **a seeded volume** — since ADR-043 the text's home is the database, so a checkout may hold
 *     no `manuscript/` at all. `--volume <dir>` copies a volume's `book.db` (with its WAL) into
 *     the scratch directory; a volume written by a *newer* schema is skipped, because this build
 *     would refuse to serve it.
 *
 *   npx tsx scripts/position-seed.ts --data <DATA_DIR> --book <BOOK_ROOT> [--session]
 *   npx tsx scripts/position-seed.ts --data <DATA_DIR> --volume <VOLUME> [--volume <VOLUME>…] [--session]
 *
 * `--session` mints one identity and one live session in the scratch volume and prints its cookie
 * on one line: BOOK-209's place is the reader's own row, so a second device can only be measured
 * by a request that is signed in. The identity is the harness's own (`position-harness`), the
 * volume is a copy, and the cookie never leaves the run.
 *
 * The import is idempotent by text, so a second run over the same volume is a no-op. Exit 2 when
 * no source fits; the lines it prints are counts and paths, never prose.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { bootDatabase } from '../server/src/db/boot.ts';
import { databaseFile, openDatabase } from '../server/src/db/db.ts';
import { upsertIdentity } from '../server/src/db/repo/identities.ts';
import { SCHEMA_VERSION } from '../server/src/db/schema.ts';
import { SESSION_COOKIE, SessionStore } from '../server/src/identity/session.ts';
import { reconcile } from '../server/src/ingest/reconcile.ts';
import { sha256Hex } from '../server/src/util/hash.ts';

const ARGS = process.argv.slice(2);

function flags(name: string): string[] {
  const found: string[] = [];
  ARGS.forEach((arg, at) => {
    if (arg !== `--${name}`) return;
    const value = ARGS[at + 1];
    if (value !== undefined && !value.startsWith('--')) found.push(value);
  });
  return found;
}

const dataDir = flags('data')[0] ?? null;
const withSession = ARGS.includes('--session');
const bookRoot = flags('book')[0] ?? null;
const volumes = flags('volume');

if (dataDir === null || (bookRoot === null && volumes.length === 0)) {
  process.stderr.write(
    'position-seed: --data <DATA_DIR> plus either --book <BOOK_ROOT> or --volume <VOLUME> is required\n',
  );
  process.exit(2);
}

const data = resolve(dataDir);

/** The boot's warnings (a legacy volume marker, prompt drift) are not this script's answer. */
function quiet(): void {
  /* one line of counts is the whole answer */
}

function countRows(volume: string): number {
  const db = new Database(join(volume, 'book.db'), { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/** Copy a volume the way an operator copies one: the database and its two WAL companions. */
function copyVolume(source: string): void {
  for (const name of ['book.db', 'book.db-wal', 'book.db-shm']) {
    const from = join(source, name);
    if (existsSync(from)) copyFileSync(from, join(data, name));
  }
}

/**
 * One identity and one session in the scratch volume, through the product's own store: the row
 * `identities` requires is `upsertIdentity`'s business, the cookie is `SessionStore.issue`'s, and
 * both live in a copy the run deletes. The cookie is printed for the parent process and nowhere
 * else — no log line, no report, no file.
 */
function mintSession(): void {
  const db = openDatabase(databaseFile(data));
  try {
    const at = new Date();
    const identity = upsertIdentity(db, {
      yandexSub: 'position-harness',
      displayName: 'position harness',
      at: at.toISOString(),
    });
    const sessions = new SessionStore({
      db,
      ttlMs: 3_600_000,
      secure: false,
      now: () => new Date(),
      ipHash: (value: string) => sha256Hex(value),
    });
    const issued = sessions.issue(identity.id, { userAgent: 'position-cdp' });
    process.stdout.write(
      `position-session: ${JSON.stringify({ name: SESSION_COOKIE, value: issued.cookie, identityId: identity.id })}\n`,
    );
  } finally {
    db.close();
  }
}

/** The first volume this build can serve, or a failure naming every one it refused. */
function seedFromVolume(): void {
  const refused: string[] = [];
  for (const candidate of volumes) {
    const volume = resolve(candidate);
    if (!existsSync(join(volume, 'book.db'))) {
      refused.push(`${volume}: no book.db`);
      continue;
    }
    const source = new Database(join(volume, 'book.db'), { readonly: true, fileMustExist: true });
    let version = 0;
    try {
      version = Number(source.pragma('user_version', { simple: true }) ?? 0);
    } finally {
      source.close();
    }
    if (version > SCHEMA_VERSION) {
      refused.push(`${volume}: schema v${String(version)} is newer than this build's v${String(SCHEMA_VERSION)}`);
      continue;
    }
    copyVolume(volume);
    process.stdout.write(
      `position-seed: volume=${volume} schema=${String(version)} rows=${String(countRows(data))}\n`,
    );
    return;
  }
  process.stderr.write(`position-seed: no usable seeded volume\n${refused.join('\n')}\n`);
  process.exitCode = 2;
}

async function seedFromTree(root: string): Promise<void> {
  const db = await bootDatabase({ dataDir: data, log: quiet });
  try {
    const report = reconcile(db, { bookRoot: root, dataDir: data });
    if (report.missing) {
      process.stderr.write(`position-seed: ${root} holds no book tree — nothing to import\n`);
      process.exitCode = 2;
      return;
    }
    if (report.readErrors.length > 0) {
      process.stderr.write(`position-seed: ${String(report.readErrors.length)} file(s) could not be read\n`);
      process.exitCode = 2;
      return;
    }
    const chapters = db.prepare('SELECT COUNT(*) AS n FROM chapters').get() as { n: number };
    // `written` is a projection, not a column: a basis slot is the frame's one sentence (BOOK-6).
    const written = db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE basis = 0').get() as { n: number };
    process.stdout.write(
      `position-seed: book=${root} scanned=${String(report.scanned)} created=${String(report.created.length)} ` +
        `frameRejected=${String(report.frameRejected.length)} front=${report.front} ` +
        `rows=${String(chapters.n)} written=${String(written.n)}\n`,
    );
  } finally {
    db.close();
  }
}

mkdirSync(data, { recursive: true, mode: 0o700 });
if (bookRoot !== null) await seedFromTree(resolve(bookRoot));
else seedFromVolume();
if (process.exitCode !== 2 && withSession) mintSession();
