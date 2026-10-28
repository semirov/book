#!/usr/bin/env node
/**
 * bin/home-migrate.mjs — BOOK-187 AC12: the one-time cutover of a volume that still holds the
 * old writer's files.
 *
 * The code stopped writing them (`writer/state.json`, `writer/pre/`, `writer/transcripts/` are
 * `writer_state`/`pass_transcripts` rows now) and `backups/` was always the dumps' home — but a
 * volume that served the old image keeps the files, and the deploy gate (`bin/home-check.mjs`)
 * names them and refuses to pass. This is the one command that folds such a volume into the
 * allow-list. It touches **nothing else in the volume**: no `book.db`/`-wal`/`-shm`, no `*.token`,
 * no `versions/`, `index/`, `archive/`, `exchange/`.
 *
 *   node bin/home-migrate.mjs                  # dry run: print every path it would remove/move
 *   node bin/home-migrate.mjs --apply           # do it (the deploy runs this once, writer stopped)
 *   node bin/home-migrate.mjs --data-dir /path  # the volume ($DATA_DIR, else ~/book-site-data)
 *
 * **Dry run is the default**, and it changes nothing at all: it reads the directory tree and
 * opens no database, so it cannot even leave a `-wal` behind. `--apply` first proves the volume is
 * this book by its **rows**, not by its version: `book.db` opens read-only, holds a `front_matter`
 * row with a title and at least one written chapter (`chapters.block_count > 0`) — both exist
 * since v1, so the proof holds on the v25 volume a live host still has. A schema NEWER than this
 * build is refused (`SCHEMA_FUTURE`: an older image does not clean a newer book); an older one is
 * the case this script exists for, and this step runs **before** the boot that would migrate it.
 * Any check failing is a refusal with the reason and **nothing is touched** — a volume that is not
 * the book is not ours to clean.
 *
 * The writer half is a closed list: the three paths BOOK-187 retired are removed and the then
 * empty `writer/` with them; **anything else under `writer/` is a refusal**, printed by path, and
 * the run stops before the first removal — a script that cannot name a file must not delete it.
 *
 * The dumps half is a fold, not a delete: `backup/` (singular, from before BOOK-187) is merged
 * into `backups/` (created 0700 when absent), one entry at a time, never overwriting — a name
 * already taken gets a `-1` suffix and the pair is printed, so a dump can never be lost to a
 * silent rename. The empty `backup/` goes last.
 *
 * Exit codes: 0 done (or nothing to do), 1 refused or failed, 2 usage. Idempotent: a second run
 * finds neither directory and says so.
 */

import { existsSync, mkdirSync, readdirSync, rmdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { SCHEMA_VERSION } from '../server/src/db/schema.ts';

/** The files BOOK-187 retired: `state.json` is a file, `pre/` and `transcripts/` are trees. */
const WRITER_FILES = ['state.json'];
const WRITER_DIRS = ['pre', 'transcripts'];
/** The legacy dump directory and its home. */
const LEGACY_DUMPS = 'backup';
const DUMPS = 'backups';
/** The one directory the fold writes into, mode 0700 — the same mode boot's dumps take. */
const DUMPS_MODE = 0o700;

const USAGE = 'usage: node bin/home-migrate.mjs [--data-dir <dir>] [--apply]';

function parseArgs(argv) {
  const options = { dataDir: null, apply: false, help: false, error: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--data-dir=')) options.dataDir = arg.slice('--data-dir='.length);
    else if (arg === '--data-dir') {
      const value = argv[index + 1];
      if (value !== undefined) index += 1;
      options.dataDir = value ?? '';
    } else options.error = `unknown argument: ${arg}`;
  }
  if (options.dataDir !== null && options.dataDir.trim().length === 0) options.error = '--data-dir needs a value';
  return options;
}

/** Where the volume is when nobody says: `$DATA_DIR`, then the deploy host's own data dir. */
function defaultDataDir() {
  const fromEnv = (process.env.DATA_DIR ?? '').trim();
  return fromEnv.length > 0 ? fromEnv : join(homedir(), 'book-site-data');
}

function reasonOf(error) {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
}

/** Is this path a directory? A missing path, a file and an unreadable one all answer false. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The volume is this book or the cutover refuses. Read-only, through the project's own driver
 * (the same `better-sqlite3` the server runs): a hole in the checks is a volume cleaned by
 * accident, and the run must say *which* check failed.
 */
async function verifyVolume(dataDir) {
  const file = join(dataDir, 'book.db');
  if (!existsSync(file)) return { ok: false, reason: `no database at ${file} — this is not a book volume` };
  let Database;
  try {
    ({ default: Database } = await import('better-sqlite3'));
  } catch (error) {
    return { ok: false, reason: `better-sqlite3 is not installed (${reasonOf(error)}) — run from site/ after npm ci` };
  }
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (error) {
    return { ok: false, reason: `${file} could not be opened read-only (${reasonOf(error)})` };
  }
  try {
    const version = Number(db.pragma('user_version', { simple: true }) ?? 0);
    if (!Number.isFinite(version)) {
      return { ok: false, reason: `${file} reports no usable user_version — the volume is not this book` };
    }
    // A FUTURE schema is the one thing this script must never touch: a newer image wrote that
    // volume, and a cutover against rules this build does not know is how a book is corrupted
    // (the same refusal boot makes, and for the same reason). An OLDER one is exactly the case
    // this script exists for — a v25 volume on the live host has to be foldable before the boot
    // that migrates it, or the deploy deadlocks in front of its own gate.
    if (version > SCHEMA_VERSION) {
      return {
        ok: false,
        reason:
          `${file} is at schema v${String(version)}, this build understands v${String(SCHEMA_VERSION)} ` +
          '(SCHEMA_FUTURE: an older image does not clean a newer book)',
      };
    }
    // The book is proved by its ROWS, not by its version: `front_matter` and `chapters` exist
    // since v1, so a title row and one written chapter are evidence any version can carry.
    const front = db.prepare('SELECT COUNT(*) AS n FROM front_matter WHERE length(trim(title)) > 0').get();
    if (Number(front?.n ?? 0) === 0) {
      return { ok: false, reason: `${file} holds no front_matter row with a title — the volume is not this book` };
    }
    const written = db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE block_count > 0').get();
    if (Number(written?.n ?? 0) === 0) {
      return { ok: false, reason: `${file} holds no written chapter — the volume is not this book` };
    }
    return { ok: true, version };
  } catch (error) {
    return { ok: false, reason: `${file} could not be read (${reasonOf(error)})` };
  } finally {
    try {
      db.close();
    } catch {
      /* a connection that never opened has nothing to close */
    }
  }
}

/** `name` with `-1`, `-2`… before the extension until it is free of `taken`. */
export function freeName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${stem}-${String(suffix)}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * What `--apply` would do, as steps with absolute paths, plus the refusals that stop it and the
 * directories that are left empty. No filesystem change happens here — the walk only reads
 * (`readdir`, `stat`) — so the dry run and the applied run answer from the same plan.
 *
 * A step is `{kind: 'remove', path, directory}` or `{kind: 'move', from, to, renamed}`; the two
 * directories `writer/` and `backup/` are reported apart, so «paths this run acts on» stays the
 * three retired writer paths plus one move per legacy dump.
 */
export function planOf(dataDir, exists = existsSync, list = readdirSync) {
  const steps = [];
  const refusals = [];
  const emptyDirs = [];
  const writerDir = join(dataDir, 'writer');

  if (exists(writerDir)) {
    let entries = [];
    if (!isDirectory(writerDir)) {
      refusals.push({ path: writerDir, reason: 'is not a directory' });
    } else {
      try {
        entries = list(writerDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
      } catch (error) {
        refusals.push({ path: writerDir, reason: `could not be listed (${reasonOf(error)})` });
      }
    }
    for (const entry of entries) {
      const path = join(writerDir, entry.name);
      // The shape has to be the one the old writer produced: a `pre` that is a file is not the
      // tree this script knows how to remove, so it is a refusal and not a guess.
      if (WRITER_FILES.includes(entry.name) && entry.isFile()) steps.push({ kind: 'remove', path, directory: false });
      else if (WRITER_DIRS.includes(entry.name) && entry.isDirectory()) steps.push({ kind: 'remove', path, directory: true });
      else refusals.push({ path, reason: 'is not one of the writer files this cutover knows' });
    }
    if (refusals.length === 0) emptyDirs.push(writerDir);
  }

  const legacyDir = join(dataDir, LEGACY_DUMPS);
  const dumpsDir = join(dataDir, DUMPS);
  if (exists(legacyDir)) {
    if (!isDirectory(legacyDir)) {
      refusals.push({ path: legacyDir, reason: `is not a directory — ${LEGACY_DUMPS}/ is the legacy dumps' home` });
    } else {
      const taken = new Set();
      if (isDirectory(dumpsDir)) {
        try {
          for (const entry of list(dumpsDir, { withFileTypes: true })) taken.add(entry.name);
        } catch (error) {
          // Without the names, every collision would be invisible — and a rename onto an
          // existing dump overwrites it. So an unreadable `backups/` is a refusal, not a guess.
          refusals.push({ path: dumpsDir, reason: `could not be listed (${reasonOf(error)})` });
        }
      }
      let names = [];
      try {
        names = list(legacyDir).map(String).sort();
      } catch (error) {
        refusals.push({ path: legacyDir, reason: `could not be listed (${reasonOf(error)})` });
      }
      for (const name of names) {
        const to = freeName(name, taken);
        taken.add(to);
        steps.push({ kind: 'move', from: join(legacyDir, name), to: join(dumpsDir, to), renamed: to !== name });
      }
      emptyDirs.push(legacyDir);
    }
  }

  return { steps, refusals, emptyDirs, dumpsDir, legacyDir, writerDir };
}

/** The first path segment: only `writer/` and `backup/`→`backups/` may ever be written. */
function touchable(dataDir, path) {
  const relative = path.startsWith(`${dataDir}/`) ? path.slice(dataDir.length + 1) : path;
  const top = relative.split('/')[0];
  return top === 'writer' || top === LEGACY_DUMPS || top === DUMPS;
}

function say(line) {
  console.log(line);
}

async function run(options) {
  const dataDir = resolve(options.dataDir ?? defaultDataDir());
  // A dry run reads the directory tree and nothing else: it opens no database, so it cannot
  // leave a `-wal`/`-shm` of its own in the volume it is only describing.
  const verification = options.apply ? await verifyVolume(dataDir) : { ok: true, reason: '' };
  if (!verification.ok) {
    console.error(`home-migrate: refused — ${verification.reason}`);
    return 1;
  }

  const plan = planOf(dataDir);
  if (plan.refusals.length > 0) {
    for (const refusal of plan.refusals) console.error(`home-migrate: refused — ${refusal.path} ${refusal.reason}`);
    console.error('home-migrate: nothing was changed — a path this script cannot name is never deleted');
    return 1;
  }

  if (plan.steps.length === 0 && plan.emptyDirs.length === 0) {
    say(`home-migrate: nothing to do — ${dataDir} holds no writer leftovers and no legacy ${LEGACY_DUMPS}/`);
    return 0;
  }

  const createsDumps = plan.steps.some((step) => step.kind === 'move') && !existsSync(plan.dumpsDir);
  const verb = options.apply ? '' : 'would ';
  if (!options.apply) say(`home-migrate: dry run of ${dataDir} — nothing is changed`);

  for (const step of plan.steps) {
    const path = step.kind === 'move' ? step.from : step.path;
    if (!touchable(dataDir, path) || (step.kind === 'move' && !touchable(dataDir, step.to))) {
      console.error(`home-migrate: refused — ${path} is outside writer/ and ${LEGACY_DUMPS}/; nothing was changed`);
      return 1;
    }
    if (step.kind === 'remove') {
      if (options.apply) rmSync(step.path, { recursive: step.directory });
      say(`${verb}remove ${step.path}`);
      continue;
    }
    if (options.apply) {
      mkdirSync(plan.dumpsDir, { recursive: true, mode: DUMPS_MODE });
      // `rename` replaces its target silently on POSIX, so the last moment is asked once more: a
      // dump that appeared while the fold ran stops the run instead of being overwritten.
      if (existsSync(step.to)) {
        console.error(`home-migrate: refused — ${step.to} appeared while the fold ran; nothing was moved over it`);
        return 1;
      }
      renameSync(step.from, step.to);
    }
    say(`${verb}move ${step.from} -> ${step.to}${step.renamed ? ' (that name was taken)' : ''}`);
  }

  // The directories themselves, and only when they are empty: a `writer/` that still holds
  // something was refused above, and a `backup/` that gained a file meanwhile stays.
  for (const dir of plan.emptyDirs) {
    if (!existsSync(dir) || readdirSync(dir).length > 0) continue;
    if (options.apply) rmdirSync(dir);
    say(`  ${dir}: ${verb}removed too (left empty)`);
  }

  if (options.apply) {
    say(
      `home-migrate: done — ${String(plan.steps.length)} path(s) in ${dataDir}` +
        `${createsDumps ? `, ${DUMPS}/ created` : ''}; run bin/home-check.mjs --data-dir ${dataDir}`,
    );
  } else {
    say(
      `home-migrate: ${String(plan.steps.length)} path(s); nothing was changed` +
        `${createsDumps ? ` — ${DUMPS}/ would be created (0${DUMPS_MODE.toString(8)})` : ''}. ` +
        'Run again with --apply once the writer is stopped',
    );
  }
  return 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    say(USAGE);
    say('  0 done (or nothing to do) · 1 refused/failed (nothing was changed) · 2 usage');
    say('  dry run is the default; --apply removes writer/state.json, writer/pre/, writer/transcripts/');
    say(`  and folds a legacy ${LEGACY_DUMPS}/ into ${DUMPS}/ (mode 0${DUMPS_MODE.toString(8)}), never overwriting`);
    return 0;
  }
  if (options.error !== null) {
    console.error(`home-migrate: ${options.error}`);
    console.error(USAGE);
    return 2;
  }
  return run(options);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`home-migrate: failed — ${reasonOf(error)}`);
    process.exitCode = 1;
  });
