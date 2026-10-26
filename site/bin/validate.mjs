#!/usr/bin/env node
/**
 * bin/validate.mjs — the integrity gate (ARCHITECTURE.md §13.4).
 *
 * Runs the structure and law rules (F001, F002, F005–F007, F009, F019–F022) over the
 * manuscript. Reads only: nothing here writes a chapter file. Node 22.18+ executes the
 * TypeScript rules in shared/src/validate directly (type stripping), so the gate works
 * before any build.
 *
 *   node bin/validate.mjs                          # whole repository
 *   node bin/validate.mjs --staged                 # what this commit would contain (git hook)
 *   node bin/validate.mjs --root=/book             # explicit root
 *   node bin/validate.mjs --json                   # machine-readable result
 *   node bin/validate.mjs --rule=F021,F022         # run a subset
 *   node bin/validate.mjs --denylist=path.json     # test fixture for F005
 *   node bin/validate.mjs --imprint=path.json      # test fixture for F020
 *   node bin/validate.mjs --strict                 # exit 1 on warnings too (CI)
 *
 * F003, F004, F008, F013, F016 and F018 are retired in v3; F011–F018 and F023–F028 live
 * in the engine, git hooks and build tests (§23.5). `--staged` is the pre-commit hook's
 * mode: it reads the index, not the working tree, and adds F010 (one book file per commit).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkCommitScope, commitSubject, runValidation } from '../shared/src/validate/index.ts';
import { readStagedCommit } from './lib/staged.ts';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ROOT = resolve(SITE_ROOT, '..');
const DEFAULT_DENYLIST = join(SITE_ROOT, 'config', 'legal.denylist.json');
const DEFAULT_IMPRINT = join(SITE_ROOT, 'config', 'imprint.json');

const PLANNING_GLOBS = [
  'outline/PLAN.md',
  'outline/structure.md',
  'process/write.log.md',
  'process/write.fwd.log.md',
  'process/write.back.log.md',
  'process/run.log.md',
  'process/WRITE_FWD_TEMPLATE.md',
  'process/WRITE_BACK_TEMPLATE.md',
];

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    denylistPath: DEFAULT_DENYLIST,
    imprintPath: DEFAULT_IMPRINT,
    json: false,
    rules: null,
    strict: false,
    staged: false,
  };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--staged') options.staged = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--root=')) options.root = resolve(arg.slice('--root='.length));
    else if (arg.startsWith('--denylist=')) options.denylistPath = resolve(arg.slice('--denylist='.length));
    else if (arg.startsWith('--imprint=')) options.imprintPath = resolve(arg.slice('--imprint='.length));
    else if (arg.startsWith('--rule=')) {
      options.rules = new Set(
        arg
          .slice('--rule='.length)
          .split(',')
          .map((value) => value.trim().toUpperCase())
          .filter(Boolean),
      );
    } else {
      options.error = `unknown argument: ${arg}`;
    }
  }
  return options;
}

const asList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readManuscriptFiles(root) {
  const dir = join(root, 'manuscript');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isFile();
      } catch {
        return false;
      }
    })
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}

function readPlanningFiles(root) {
  return PLANNING_GLOBS.filter((relative) => existsSync(join(root, relative))).map((relative) => ({
    name: relative,
    text: readFileSync(join(root, relative), 'utf8'),
  }));
}

function readDossiers(root) {
  const relative = 'bible/dossiers.md';
  if (!existsSync(join(root, relative))) return null;
  return { name: relative, text: readFileSync(join(root, relative), 'utf8') };
}

function readDenylist(document) {
  return {
    version: typeof document.version === 'number' ? document.version : 1,
    note: typeof document.note === 'string' ? document.note : undefined,
    persons: asList(document.persons),
    characters: asList(document.characters),
    organisations: asList(document.organisations),
    patterns: asList(document.patterns),
  };
}

function readImprint(document) {
  return {
    author: typeof document.author === 'string' ? document.author : '',
    copyright: typeof document.copyright === 'string' ? document.copyright : '',
    publisher: typeof document.publisher === 'string' ? document.publisher : null,
    year: typeof document.year === 'string' ? document.year : 'auto',
  };
}

function printReport(result) {
  for (const item of result.findings) {
    const excerpt = item.excerpt ? `  ·  ${item.excerpt}` : '';
    const severity = item.severity === 'error' ? 'error' : 'warn ';
    console.log(`${item.rule} ${severity} ${item.file}:${item.line}  ${item.message}${excerpt}`);
  }
  if (result.findings.length > 0) console.log('');
  const written = result.chapters.length;
  const chars = result.chapters.reduce((sum, chapter) => sum + chapter.chars, 0);
  const front = result.front;
  const frontLine = front === null ? 'front matter: absent' : `front matter: «${front.title ?? '—'}»`;
  console.log(
    `manuscript: ${written} chapter files · ${result.totalChapters - written} empty slots · ${chars} characters`,
  );
  console.log(frontLine);
  console.log(`${result.errors} errors · ${result.warnings} warnings`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node bin/validate.mjs [--root=DIR] [--json] [--rule=F001,..] [--strict] [--staged]');
    console.log('       [--denylist=path] [--imprint=path]');
    console.log('runs F001, F002, F005–F007, F009 and F019–F022 (+ F010 with --staged)');
    console.log('F003/F004/F008/F013/F016/F018 are retired in v3');
    return 0;
  }
  if (options.error) {
    console.error(`validate: ${options.error}`);
    return 2;
  }

  let denylist;
  let imprint;
  try {
    denylist = readDenylist(readJson(options.denylistPath, 'legal denylist'));
    imprint = readImprint(readJson(options.imprintPath, 'imprint'));
  } catch (error) {
    console.error(`validate: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let staged = null;
  if (options.staged) {
    try {
      staged = readStagedCommit(options.root);
    } catch (error) {
      console.error(`validate: cannot read the staged commit: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    if (staged.files.length === 0) {
      // Nothing in the manuscript is staged: the gate has nothing to say, and says so.
      console.log(`commit gate: ${staged.staged.length} staged file(s), no book files`);
      return 0;
    }
  }

  const result = runValidation({
    files: staged === null ? readManuscriptFiles(options.root) : staged.files,
    planning: readPlanningFiles(options.root),
    denylist,
    imprint,
    dossiers: readDossiers(options.root),
  });

  const scope = staged === null ? [] : checkCommitScope(staged.staged, staged.message);
  const all = [...scope, ...result.findings].sort((left, right) => {
    if (left.file !== right.file) return left.file.localeCompare(right.file);
    if (left.line !== right.line) return left.line - right.line;
    return left.rule.localeCompare(right.rule);
  });
  const withScope = {
    ...result,
    findings: all,
    errors: all.filter((finding) => finding.severity === 'error').length,
    warnings: all.filter((finding) => finding.severity === 'warn').length,
  };

  const filtered = options.rules
    ? { ...withScope, findings: withScope.findings.filter((item) => options.rules.has(item.rule)) }
    : withScope;
  const errors = filtered.findings.filter((item) => item.severity === 'error').length;
  const warnings = filtered.findings.filter((item) => item.severity === 'warn').length;
  const output = { ...filtered, errors, warnings };

  if (options.json) console.log(JSON.stringify(output, null, 2));
  else {
    if (staged !== null) {
      console.log(`commit gate: «${commitSubject(staged.message) || '—'}» · ${staged.staged.length} file(s) staged`);
    }
    printReport(output);
  }

  if (errors > 0) return 1;
  if (options.strict && warnings > 0) return 1;
  return 0;
}

process.exitCode = main();
