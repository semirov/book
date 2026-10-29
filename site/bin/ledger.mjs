#!/usr/bin/env node
/**
 * bin/ledger.mjs — the operator's ledger commands (BOOK-173, BOOK-DOC-80).
 *
 * The writer process holds no database handle (BOOK-187, BOOK-183): the text lives in rows and
 * every store the lane needs is reached through the engine. These three commands need the plan
 * rows themselves — a plan table, the ripple drain and the sample audit — so they live here, in
 * the operator's own tool, and open the volume exactly the way `bin/restore.mjs`, `bin/index.mjs`
 * and `bin/export.mjs` do: a short-lived host process, never the lane.
 *
 * The graph itself is not filled here: BOOK-185's extractor is `node bin/graph.mjs` (extract, one
 * chapter per call, with the model and its run ledger), and the ripple only reads it.
 *
 *   node bin/ledger.mjs plan <changeId>     → print the reviewable table of that change's plan
 *                                             (exit 1 when the change has none)
 *   node bin/ledger.mjs ripple              → drain the oldest plan still owed work, one chapter
 *                                             per iteration, through normal passes
 *   node bin/ledger.mjs audit [N]           → re-read N queued `local only` samples with the editor
 *
 * Exit codes: `0` done · `1` a plan is parked / something was flagged · `2` could not run
 * (usage, config, no database, an unreachable engine). The interface per command is documented
 * in `server/src/writer/rippleCli.ts` and `verify/cli.ts`.
 *
 * Environment: DATA_DIR and BOOK_ROOT as the site and the lane read them; the ripple and the
 * audit also need the lane's own config (`WRITER_*`, `BOOK_*`) and the engine token.
 */

import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(SITE_ROOT, 'server', 'dist');

const USAGE = [
  'usage: ledger.mjs <plan <changeId>|ripple|audit [N]> [--data-dir DIR]',
  '',
  '  plan <changeId>     print the frozen plan of one change; exit 1 when it has none',
  '  ripple              drain the oldest ripple still owed work, then exit',
  '  audit [N]           re-read N queued local-only samples with the editor (default 3)',
].join('\n');

function parse(argv) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split('=', 2);
    const value = inline ?? argv[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      throw new Error(`flag --${name} needs a value`);
    }
    flags.set(name, value);
    if (inline === undefined) index += 1;
  }
  return { command: positionals.shift() ?? null, positionals, flags };
}

function absolute(value) {
  const raw = (value ?? '').trim();
  if (raw.length === 0) return null;
  return isAbsolute(raw) ? raw : resolve(SITE_ROOT, raw);
}

function pathsOf(env) {
  return {
    bookRoot: absolute(env.BOOK_ROOT) ?? resolve(SITE_ROOT, '..'),
    dataDir: absolute(env.DATA_DIR) ?? resolve(SITE_ROOT, '.data'),
  };
}

async function main() {
  let parsed;
  try {
    parsed = parse(process.argv.slice(2));
  } catch (error) {
    console.error(`ledger: ${error instanceof Error ? error.message : 'bad arguments'}`);
    console.error(USAGE);
    return 2;
  }
  const { command, positionals, flags } = parsed;
  if (command === null || command === 'help') {
    console.log(USAGE);
    return command === null ? 2 : 0;
  }
  if (!['plan', 'ripple', 'audit'].includes(command)) {
    console.error(`ledger: unknown command ${command}`);
    console.error(USAGE);
    return 2;
  }
  const audit = command === 'audit' ? Number(positionals[0] ?? Number.NaN) : null;
  if (command === 'audit' && positionals[0] !== undefined && (!Number.isInteger(audit) || audit < 1)) {
    console.error('ledger: audit takes a positive integer');
    return 2;
  }
  if (command === 'plan' && (positionals[0] ?? '').length === 0) {
    console.error('ledger: plan needs a change id');
    return 2;
  }

  if (!existsSync(DIST)) {
    console.error('ledger: the server is not built — run `npm run build -w @book/server` first');
    return 2;
  }
  const module = (path) => import(pathToFileURL(join(DIST, path)).href);
  const { loadConfig } = await module('config.js');
  const { databaseFile, openDatabase } = await module('db/db.js');
  const { assertDataDirIsolation, isProductionEnv } = await module('dataDirGuard.js');

  const env = process.env;
  const { bookRoot, dataDir } = pathsOf(env);
  const flagDir = absolute(flags.get('data-dir'));
  const volume = flagDir ?? dataDir;
  const now = () => Date.now();
  const log = (line) => console.log(line);

  const file = databaseFile(volume);
  if (!existsSync(file)) {
    console.error(`ledger: ${file} does not exist — nothing to read`);
    return 2;
  }
  try {
    // BOOK-107: this tool opens `book.db`, so it crosses the same wall the boot does.
    assertDataDirIsolation(
      { dataDir: volume, adminTokenFile: '', engineTokenFile: '', feedbackDir: '' },
      isProductionEnv(env),
    );
  } catch (error) {
    console.error(`ledger: ${error instanceof Error ? error.message : 'data dir refused'}`);
    return 2;
  }

  const db = openDatabase(file);
  try {
    if (command === 'plan') {
      const { runPlanCli } = await module('writer/rippleCli.js');
      return runPlanCli({ db, changeId: positionals[0], log });
    }
    // The drain and the audit call a model, so they need the lane's own config and transport.
    const { loadWriterConfig } = await module('writer/config.js');
    const { createEngineClient } = await module('writer/client.js');
    const { callProvider } = await module('writer/provider.js');
    const config = loadWriterConfig(env);
    const provider = (request) => callProvider(request);
    if (command === 'audit') {
      const { runAuditCli } = await module('writer/verify/cli.js');
      return await runAuditCli({
        dataDir: volume,
        config,
        bookRoot,
        provider,
        log,
        now,
        limit: Number.isInteger(audit) ? audit : null,
      });
    }
    if (command === 'ripple') {
      const { runRippleCli } = await module('writer/rippleCli.js');
      const engine = createEngineClient({
        baseUrl: config.engineUrl,
        tokenFile: config.engineTokenFile,
        timeoutMs: config.engineTimeoutMs,
      });
      return await runRippleCli({
        db,
        config,
        bookRoot,
        dataDir: volume,
        engine,
        provider,
        now,
        log,
        claimedBy: `${hostname()}:${String(process.pid)}`,
      });
    }
    return 2;
  } finally {
    db.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`ledger: ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 2;
  });
