#!/usr/bin/env node
/**
 * scripts/affected-tests.mjs — which tests a PR has to run (BOOK-198).
 *
 * The whole suite protects `main`; a PR only pays for what it can break. The answer comes from
 * `git diff` alone, deterministically:
 *
 *   node scripts/affected-tests.mjs --base=origin/main --json   # { "mode": …, "files": […] }
 *   node scripts/affected-tests.mjs --base=origin/main          # runs vitest on that set
 *
 * Two modes:
 *   full     — a gate-infrastructure path changed (`vitest.config.ts`, `package.json`, the
 *              lockfile, a root `tsconfig`, `site/test/**`, `site/shared/**`, this script,
 *              `gate-verdict.mjs`, the workflow). Nothing smaller is honest there: the change can
 *              move every test. `shared` is in the list because server and web import
 *              `@book/shared`: one line there is felt across all 425 files.
 *   affected — the fixed core set (engine, db, ledger, the frame set) plus the changed
 *              workspaces' tests. A docs- or manuscript-only PR gets the core set, never nothing.
 *
 * `vitest --changed` is deliberately not used: in CI its base ref is a local guess and it says
 * nothing about deletions. Selection here is a pure function of the path list (`classify`), so a
 * test can pin it; the CLI is only git + glob expansion + one `spawnSync`.
 *
 * No third-party imports on purpose: the workflow's `changes` job runs this before `npm ci`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** `site/`: the workspace the patterns are relative to. */
const SITE = resolve(import.meta.dirname, '..');
/** The repository root, where git paths are relative to. */
const REPO = resolve(SITE, '..');

const DEFAULT_BASE = 'origin/main';

/**
 * Gate infrastructure: a change here changes how every test is collected or run, so the suite
 * runs whole. Paths are repository-root relative, the way `git diff --name-only` prints them.
 *
 * `site/shared/**` belongs here and not among the workspaces: server and web import
 * `@book/shared`, so a shared edit is a cross-package edit and the sharded full path is the only
 * selection that can prove it.
 */
const INFRASTRUCTURE = [
  /^site\/vitest\.config\.ts$/u,
  /^site\/package\.json$/u,
  /^site\/package-lock\.json$/u,
  /^site\/tsconfig[^/]*\.json$/u,
  /^site\/test\//u,
  /^site\/shared\//u,
  /^\.github\/workflows\/gate\.yml$/u,
  /^site\/scripts\/affected-tests\.mjs$/u,
  /^site\/scripts\/gate-verdict\.mjs$/u,
];

/**
 * The core set, always run in `affected` mode, relative to `site/`: the state machine, the
 * database layer, the minimal-edit applier (ledger) and the frame — the surfaces where a change
 * in one package is felt in another. If one of these goes red, the PR is red wherever it edited.
 *
 * `server/test/engine/**` is also the gates/accept surface the owner named: it holds
 * `gates.test.ts`, `gateWindow.test.ts` and `acceptance.test.ts`.
 */
const CORE = [
  'server/test/engine/**/*.test.ts',
  'server/test/db/**/*.test.ts',
  'server/test/ledger/**/*.test.ts',
  'server/test/*frame*.test.ts',
  // Case matters: `landFrame`, `migrateFrame`, `passFrames`, `watcherFrame` would be missed by
  // the lowercase glob alone, and they are exactly the frame surface the core set exists for.
  'server/test/*Frame*.test.ts',
  // Today a `site/shared/**` edit escalates to full mode, so these two are only reached if that
  // ever changes; they stay because the core set is the definition of the frame surface.
  'shared/test/frame.test.ts',
  'shared/test/validate/frame.test.ts',
  'web/src/**/*Frame*.test.{ts,tsx}',
  'web/src/appHistoryFrame.dom.test.tsx',
];

/** A changed workspace and the tests that cover it (`shared` is infrastructure: cross-package). */
const WORKSPACES = [
  { prefix: 'site/server/', patterns: ['server/test/**/*.test.ts'] },
  { prefix: 'site/web/', patterns: ['web/src/**/*.test.{ts,tsx}'] },
];

/** `./site/x`, `site\x` and `site/x/` are one path. */
function normalizePath(path) {
  const slashed = path.replaceAll('\\', '/');
  const trimmed = slashed.startsWith('./') ? slashed.slice(2) : slashed;
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * The selection for a list of changed repository paths. Pure: no git, no fs, no clock.
 *
 * @param {readonly string[]} changedPaths
 * @returns {{ mode: 'full' | 'affected', files: string[] }} patterns relative to `site/`
 */
export function classify(changedPaths) {
  const paths = (changedPaths ?? []).map(normalizePath).filter((path) => path.length > 0);
  if (paths.some((path) => INFRASTRUCTURE.some((pattern) => pattern.test(path)))) {
    return { mode: 'full', files: [] };
  }
  const files = [...CORE];
  for (const workspace of WORKSPACES) {
    if (paths.some((path) => path.startsWith(workspace.prefix))) files.push(...workspace.patterns);
  }
  return { mode: 'affected', files };
}

/** `a/{b,c}/d` → `a/b/d`, `a/c/d`; no nesting beyond one level is needed here. */
export function braceExpand(pattern) {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close === -1) return [pattern];
  const before = pattern.slice(0, open);
  const after = pattern.slice(close + 1);
  return pattern
    .slice(open + 1, close)
    .split(',')
    .flatMap((part) => braceExpand(before + part + after));
}

/** `**` spans directories, `*` and `?` do not cross a `/`. Anchored, case-sensitive. */
export function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] !== '*') {
        source += '[^/]*';
        continue;
      }
      index += 1;
      if (pattern[index + 1] === '/') {
        index += 1;
        source += '(?:[^/]+/)*';
      } else {
        source += '.*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += '\\^$+.|()[]{}'.includes(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`, 'u');
}

/** The directory a pattern starts in: everything before its first wildcard, minus the last slash. */
function staticPrefix(pattern) {
  const wildcard = pattern.search(/[*?{]/u);
  if (wildcard === -1) return pattern;
  const head = pattern.slice(0, wildcard);
  const slash = head.lastIndexOf('/');
  return slash === -1 ? '' : head.slice(0, slash);
}

/** Every file under `dir` (relative to it), never descending into `node_modules`. */
function walk(dir) {
  const found = [];
  const queue = [''];
  while (queue.length > 0) {
    const relative = queue.pop();
    let entries;
    try {
      entries = readdirSync(resolve(dir, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') queue.push(path);
      } else {
        found.push(path);
      }
    }
  }
  return found;
}

/** Turn the selection's patterns into the actual file list vitest gets as arguments. */
export function expand(patterns, root = SITE) {
  const matched = new Set();
  for (const pattern of patterns) {
    for (const expanded of braceExpand(pattern)) {
      if (!/[*?]/u.test(expanded)) {
        // An exact path (the core set names two files outright).
        if (existsSync(resolve(root, expanded))) matched.add(expanded);
        continue;
      }
      const matcher = globToRegExp(expanded);
      const prefix = staticPrefix(expanded);
      for (const file of walk(resolve(root, prefix))) {
        const path = prefix === '' ? file : `${prefix}/${file}`;
        if (matcher.test(path)) matched.add(path);
      }
    }
  }
  return [...matched].sort();
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * The paths this branch changed since it forked from `base`, or `null` when git cannot say.
 *
 * `--no-renames`: with rename detection a moved file arrives as `R site/web/a.ts site/web/b.ts`,
 * so the package it *left* is not in the list. As A+D both sides are, and the source package's
 * tests run too.
 */
function changedSince(base) {
  const mergeBase = git(['merge-base', base, 'HEAD']);
  if (mergeBase.length === 0) return null;
  const diff = git(['diff', '--no-renames', '--name-only', '--diff-filter=ACMRD', mergeBase, 'HEAD']);
  return diff.length === 0 ? [] : diff.split('\n');
}

/** `node_modules/vitest/vitest.mjs`, spawned with this node — no npm shim in the path. */
function vitest(files) {
  const cli = resolve(SITE, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(cli)) {
    process.stderr.write('affected-tests: vitest is not installed (site/node_modules is missing) — run npm ci\n');
    return 1;
  }
  const result = spawnSync(process.execPath, [cli, 'run', ...files], { cwd: SITE, stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`affected-tests: could not start vitest: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

function parseArgs(argv) {
  const options = { base: process.env.GATE_BASE_REF || DEFAULT_BASE, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--base' || arg.startsWith('--base=')) {
      const value = arg === '--base' ? argv[++index] : arg.slice('--base='.length);
      if (value === undefined || value.length === 0) {
        process.stderr.write('affected-tests: --base needs a ref\n');
        process.exit(2);
      }
      options.base = value;
      continue;
    }
    process.stderr.write(`affected-tests: unknown argument ${arg}\n`);
    process.exit(2);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  let changed = null;
  try {
    changed = changedSince(options.base);
  } catch (error) {
    process.stderr.write(`affected-tests: cannot diff against ${options.base}: ${String(error.message).split('\n')[0]}\n`);
  }

  // Git cannot answer (shallow clone, a base ref that does not exist yet): fail towards the whole
  // suite. A PR that runs too much is slow; a PR that runs too little is a hole in `main`.
  const selection = changed === null ? { mode: 'full', files: [] } : classify(changed);
  const files = selection.mode === 'affected' ? expand(selection.files) : [];

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ mode: selection.mode, files: selection.files })}\n`);
    return 0;
  }

  if (selection.mode === 'full') {
    process.stdout.write('affected-tests: mode full — gate infrastructure changed; running the whole suite\n');
  } else {
    process.stdout.write(`affected-tests: mode affected — ${files.length} files from ${selection.files.length} patterns\n`);
    for (const pattern of selection.files) process.stdout.write(`  ${pattern}\n`);
    // An empty expansion would otherwise hand vitest nothing to run; no arguments means the suite.
    if (files.length === 0) process.stdout.write('affected-tests: no file matched — running the whole suite\n');
  }
  return vitest(files);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename);
if (invokedDirectly) process.exit(main());
