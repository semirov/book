#!/usr/bin/env node
/**
 * bin/home-check.mjs — BOOK-187 AC12: the guard that names the path.
 *
 * Three questions, asked of a deploy and of a laptop alike:
 *   a. does `manuscript/` still hold prose? (the book's text lives in the database)
 *   b. does the data dir hold the writer's own files (`writer/state.json`, `writer/pre/`,
 *      `writer/transcripts/`)? (they are rows)
 *   c. is everything under the data dir in the allow-list? (the volume holds the book, its
 *      dumps and nothing else)
 *
 *   node bin/home-check.mjs --data-dir <dir> [--manuscript <dir>] [--json]
 *
 * Exit 0 (everything the volume and the tree may hold, they hold) or 1 (at least one path is
 * named). One line per failure on stderr; `--json` prints the whole report instead. A **missing**
 * data dir is exit 1 — a deploy with no volume is an incident, not an empty book — while a
 * missing `manuscript/` passes: this tree has none, and that is the point.
 *
 * The rules themselves live in `server/src/dataHome.ts` (pure, injectable listings), so this
 * file is argument parsing and one readdir walk. Node runs the TypeScript directly (type
 * stripping), exactly as `scripts/frame-check.mjs` runs `dataDirGuard.ts`.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDataHome } from '../server/src/dataHome.ts';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The book repository: `site/` lives inside it. */
const DEFAULT_MANUSCRIPT = resolve(SITE_ROOT, '..', 'manuscript');

function parseArgs(argv) {
  const options = { dataDir: '', manuscriptDir: DEFAULT_MANUSCRIPT, json: false };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--data-dir=')) options.dataDir = resolve(arg.slice('--data-dir='.length));
    else if (arg.startsWith('--manuscript=')) options.manuscriptDir = resolve(arg.slice('--manuscript='.length));
    else if (arg === '--data-dir') options.needs = 'dataDir';
    else if (arg === '--manuscript') options.needs = 'manuscriptDir';
    else if (options.needs !== undefined) {
      options[options.needs] = resolve(arg);
      delete options.needs;
    } else options.error = `unknown argument: ${arg}`;
  }
  if (options.needs !== undefined) options.error = `--${options.needs === 'dataDir' ? 'data-dir' : 'manuscript'} needs a value`;
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node bin/home-check.mjs --data-dir <dir> [--manuscript <dir>] [--json]');
    console.log('  0 the volume and manuscript/ hold only what they may');
    console.log('  1 a path is named on stderr (a missing data dir is a failure, a missing manuscript/ is not)');
    console.log('  2 usage');
    return 0;
  }
  if (options.error) {
    console.error(`home-check: ${options.error}`);
    return 2;
  }
  if (options.dataDir.length === 0) {
    console.error('home-check: --data-dir is required (the volume is what this guard is about)');
    return 2;
  }

  const report = checkDataHome({ dataDir: options.dataDir, manuscriptDir: options.manuscriptDir });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const problem of report.problems) console.error(`home-check: ${problem.code} ${problem.message}`);
    console.log(
      `home-check: ${report.ok ? 'ok' : `${String(report.problems.length)} problem(s)`} — ` +
        `data ${report.dataDir}, manuscript ${report.manuscriptDir}`,
    );
  }
  return report.ok ? 0 : 1;
}

process.exitCode = main();
