#!/usr/bin/env node
/**
 * scripts/frame-check.mjs — the frozen frame (F029) must be what the site serves (BOOK-107,
 * BOOK-187).
 *
 * The canon lives once, in `shared/src/book.ts`. The owner twice saw ch01 and the finale serve
 * text that is not the canon while the manuscript, the data dir and the backups held only the
 * canon; this check answers «what does each of those places actually say now» in one read-only
 * pass. Since v23 there is no file in the chain (ADR-043 G6): the letters are compared with the
 * `book_frame` rows in the volume, the rows are compared with the blocks they are carried by, and
 * both are compared with what the running site answers.
 *
 *   node scripts/frame-check.mjs                       # $DATA_DIR / ~/book-site-data + the guard
 *   node scripts/frame-check.mjs --server http://127.0.0.1:8091
 *   node scripts/frame-check.mjs --data-dir /path --json
 *
 * Exit codes (the contract `deploy.sh` reads):
 *   0 — every check passed
 *   1 — at least one mismatch: the constant differs from the row, a row is missing, the served or
 *       stored text lost the sentence, the site is unreachable, an answer is not 200
 *   2 — bad usage only (an unknown flag, or a flag without a value)
 *
 * It owns no state: it writes nothing, opens sqlite `{readonly: true, fileMustExist: true}`, and
 * prints no secret — only paths, statuses and the two sentences. A checkout with no volume has no
 * `book.db`; the DB legs then say so and are skipped rather than failed, because there is no book
 * to be wrong here (CI, a developer's tree). Given a database, every leg must pass.
 */

import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { DEFAULT_PRODUCTION_DATA_DIR, assertDataDirIsolation, productionDataDirs } from '../server/src/dataDirGuard.ts';
import { checkFrame, checkServer } from './lib/frame.mjs';

const USAGE =
  'usage: node scripts/frame-check.mjs [--server|--url <url>] [--data-dir|--data <dir>] [--json]';

/** Where the volume is when nobody says: `$DATA_DIR`, then the deploy host's own data dir. */
function defaultDataDir() {
  const fromEnv = (process.env.DATA_DIR ?? '').trim();
  return fromEnv.length > 0 ? fromEnv : DEFAULT_PRODUCTION_DATA_DIR;
}

/** The value flags, and the short names the owner asks for (`--url`, `--data`). */
const VALUE_FLAGS = new Map([
  ['--server', 'server'],
  ['--url', 'server'],
  ['--data-dir', 'dataDir'],
  ['--data', 'dataDir'],
]);

function bail(message) {
  process.stderr.write(`frame: ${message}\n${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { server: null, dataDir: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (name === '--json') {
      if (equals !== -1) bail('--json takes no value');
      options.json = true;
      continue;
    }
    const key = VALUE_FLAGS.get(name);
    if (key === undefined) bail(`unknown argument: ${arg}`);
    let value;
    if (equals === -1) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) bail(`${name} needs a value`);
      index += 1;
      value = next;
    } else {
      value = arg.slice(equals + 1);
    }
    if (value.length === 0) bail(`${name} needs a value`);
    options[key] = value;
  }
  return options;
}

/**
 * The guard itself, asserted as a property: non-production at a prod data dir throws, production
 * with data inside the repository throws, and production at a prod data dir is allowed. A guard
 * that went missing or started letting either direction through fails here, not in an incident.
 */
function isolationCheck() {
  const label = 'isolation guard';
  const probe = join(tmpdir(), 'book-frame-guard-probe');
  const paths = {
    dataDir: probe,
    adminTokenFile: join(probe, 'admin.token'),
    engineTokenFile: join(probe, 'engine.token'),
    feedbackDir: join(probe, 'feedback'),
  };
  const prodDirs = productionDataDirs({ PRODUCTION_DATA_DIR: probe }, tmpdir());
  const throws = (production, options) => {
    try {
      assertDataDirIsolation(paths, production, options);
      return false;
    } catch {
      return true;
    }
  };
  const devRefused = throws(false, { prodDirs });
  // The probe lives under `tmpdir()`, so that is the "repository" it must be judged inside of.
  const prodInsideRepoRefused = throws(true, { repoRoot: tmpdir() });
  const productionAllowed = !throws(true, {});
  const ok = devRefused && prodInsideRepoRefused && productionAllowed;
  return {
    label,
    ok,
    parts: ok
      ? []
      : [
          {
            expected:
              'a non-production boot at a production data dir is refused, production inside the repository is ' +
              'refused, and a production boot at a production data dir is allowed',
            actual:
              `non-production refused=${String(devRefused)} production-in-repo refused=${String(prodInsideRepoRefused)} ` +
              `production allowed=${String(productionAllowed)}`,
          },
        ],
  };
}

function printReadout(readout) {
  // Discoverable with grep: one line per fact, values never truncated.
  const lines = [
    ['ch01 first block:', readout.ch01First ?? 'none'],
    ['ch42 first block:', readout.lastFirst ?? 'none'],
    ['ch42 last block:', readout.lastLast ?? 'none'],
    ['last ingest:', readout.lastScanAt ?? 'none'],
  ];
  for (const [label, value] of lines) console.log(`frame:   ${label.padEnd(17)} ${value}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataDir = resolve(options.dataDir ?? defaultDataDir());
  const frame = checkFrame({ dataDir });
  const checks = [...frame.checks, isolationCheck()];
  if (options.server !== null) checks.push(...(await checkServer({ baseUrl: options.server })));

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: checks.every((check) => check.ok),
          checks,
          dataDir,
          absent: frame.absent === true,
          readout: frame.readout,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    if (frame.absent) {
      // No volume: there is no book to be wrong, so this is a fact, not a mismatch (CI, a tree).
      console.log(`frame:   no database at ${join(dataDir, 'book.db')} — the frame rows are checked on a volume`);
    }
    for (const check of checks) {
      if (check.ok) {
        console.log(`frame: ${check.label} — ok`);
        continue;
      }
      console.log(`frame: ${check.label} — MISMATCH`);
      for (const part of check.parts) {
        // One pair of `expected`/`actual` per part; a label line only when there are several,
        // so the keyword stays exactly `expected:` for every line a grep looks for.
        if (part.label !== undefined && check.parts.length > 1) console.log(`frame:   ${part.label}:`);
        console.log(`frame:   expected: ${part.expected}`);
        console.log(`frame:   actual:   ${part.actual}`);
      }
    }
    if (frame.readout !== null) printReadout(frame.readout);
    const failed = checks.filter((check) => !check.ok);
    const count = (n) => `${String(n)} ${n === 1 ? 'check' : 'checks'}`;
    if (failed.length === 0) console.log(`frame: ok — ${count(checks.length)}`);
    else console.log(`frame: FAILED — ${String(failed.length)} of ${count(checks.length)}`);
  }
  process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
}

await main();
