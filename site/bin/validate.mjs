#!/usr/bin/env node
/**
 * bin/validate.mjs — the integrity gate (ARCHITECTURE.md §13.4), in three modes since BOOK-187.
 *
 *   node bin/validate.mjs --from-db <dataDir>     the deploy gate: the text as stored, rendered
 *                                                 to a temp tree and checked by the same rules
 *   node bin/validate.mjs --staged                the pre-commit hook: no `manuscript/` path may
 *                                                 be staged (the text lives in the database)
 *   node bin/validate.mjs                         image mode: the imprint, the denylist and the
 *                                                 planning files only, saying what it skipped
 *   node bin/validate.mjs --root=<dir>            an explicit tree on disk (tests, an old
 *                                                 checkout): `manuscript/*.md` as files
 *
 * The rules (F001, F002, F005–F007, F009, F020–F022, F029) are the shared ones and are unchanged;
 * what changed is where the text comes from. In `--from-db` the rows are **projected** into a
 * `mkdtemp` tree — `chNN.md` and `00-front.md` as the applier would write them — the existing
 * validator runs over it, and the tree is deleted in a `finally`. The projection is never a home:
 * nothing is written to the volume, and no `manuscript/` survives the run.
 *
 * Every mode keeps the same `--strict`, `--json` and `--rule=` flags and the same exit codes:
 * 0 clean (or, with `--strict`, no warnings), 1 findings, 2 usage.
 *
 * Node 22.18+ executes the TypeScript rules in shared/src/validate directly (type stripping), so
 * the gate works before any build.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runValidation } from '../shared/src/validate/index.ts';
import { readStagedCommit } from './lib/staged.ts';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ROOT = resolve(SITE_ROOT, '..');
const DEFAULT_DENYLIST = join(SITE_ROOT, 'config', 'legal.denylist.json');
const DEFAULT_IMPRINT = join(SITE_ROOT, 'config', 'imprint.json');

/** The rules that need the book's text; image mode cannot run them and says so. */
const TEXT_RULES = ['F001', 'F002', 'F007', 'F009', 'F021', 'F022', 'F029'];

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
    rootGiven: false,
    dataDir: null,
    denylistPath: DEFAULT_DENYLIST,
    imprintPath: DEFAULT_IMPRINT,
    json: false,
    rules: null,
    strict: false,
    staged: false,
  };
  const takeValue = (arg, name, index) => {
    if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), index };
    if (arg === name) return { value: argv[index + 1] ?? '', index: index + 1 };
    return null;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const data = takeValue(arg, '--from-db', index);
    if (data !== null) {
      options.dataDir = resolve(data.value);
      index = data.index;
      continue;
    }
    const root = takeValue(arg, '--root', index);
    if (root !== null) {
      options.root = resolve(root.value);
      options.rootGiven = true;
      index = root.index;
      continue;
    }
    const denylist = takeValue(arg, '--denylist', index);
    if (denylist !== null) {
      options.denylistPath = resolve(denylist.value);
      index = denylist.index;
      continue;
    }
    const imprint = takeValue(arg, '--imprint', index);
    if (imprint !== null) {
      options.imprintPath = resolve(imprint.value);
      index = imprint.index;
      continue;
    }
    if (arg === '--json') options.json = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--staged') options.staged = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
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

function readFilesIn(dir) {
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

/**
 * The book's text as the volume holds it, written into `dir` as a manuscript tree: the title
 * line, a blank line and the paragraphs, exactly the projection the applier writes. A slot with
 * no row or no blocks writes no file — an empty slot is absence, and every rule already reads
 * absence as an empty slot.
 *
 * The connection is the project's own driver (`better-sqlite3`, the server's dependency), opened
 * `{readonly: true, fileMustExist: true}`: `node:sqlite` is still experimental and prints its
 * warning on a later tick, so a Node without that module — or with the warning on stderr — must
 * not be how the deploy gate fails. Nothing is created by this read.
 */
async function projectRowsTo(dbFile, dir) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  const chapters = db
    .prepare(
      `SELECT c.n AS n, c.title AS title, COUNT(b.id) AS blocks
         FROM chapters c LEFT JOIN blocks b ON b.chapter = c.n
        WHERE c.n BETWEEN 1 AND 42
        GROUP BY c.n ORDER BY c.n`,
    )
    .all();
  const blocksOf = db.prepare('SELECT text FROM blocks WHERE chapter = ? ORDER BY idx');
  const front = db.prepare('SELECT title, about FROM front_matter WHERE id = 1').get();
  const files = [];
  try {
    mkdirSync(join(dir, 'manuscript'), { recursive: true });
    for (const chapter of chapters) {
      if (Number(chapter.blocks) === 0) continue;
      const body = blocksOf
        .all(chapter.n)
        .map((row) => String(row.text))
        .join('\n\n');
      const text = chapter.title === null ? `${body}\n` : `${String(chapter.title)}\n\n${body}\n`;
      const name = `ch${String(chapter.n).padStart(2, '0')}.md`;
      writeFileSync(join(dir, 'manuscript', name), text, 'utf8');
      files.push({ name, text });
    }
    if (front !== undefined) {
      const text = `${String(front.title)}\n\n${String(front.about)}\n`;
      writeFileSync(join(dir, 'manuscript', '00-front.md'), text, 'utf8');
      files.push({ name: '00-front.md', text });
    }
  } finally {
    db.close();
  }
  return files;
}

/** `--from-db`: a temp projection, the shared rules, and the temp tree gone whatever happens. */
async function validateFromDb(options, denylist, imprint) {
  const dbFile = join(options.dataDir, 'book.db');
  if (!existsSync(dbFile)) throw new Error(`no database at ${dbFile} (DATA_DIR=${options.dataDir})`);
  const dir = mkdtempSync(join(tmpdir(), 'book-validate-'));
  try {
    const files = await projectRowsTo(dbFile, dir);
    return runValidation({ files, planning: readPlanningFiles(options.root), denylist, imprint });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function printReport(result, mode) {
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
  const source = mode === 'db' ? 'text (DB)' : mode === 'tree' ? 'manuscript' : 'text';
  if (mode === 'image') {
    console.log('text: not checked here — the book lives in the database; run --from-db <DATA_DIR> for its rules');
    console.log(`skipped for that reason: ${TEXT_RULES.join(', ')}`);
  } else {
    console.log(`${source}: ${written} chapters · ${result.totalChapters - written} empty slots · ${chars} characters`);
    console.log(frontLine);
  }
  console.log(`${result.errors} errors · ${result.warnings} warnings`);
}

/** The staged mode: there is no prose in git any more, so the only rule left is that none returns. */
function stagedGate(options) {
  let staged;
  try {
    staged = readStagedCommit(options.root);
  } catch (error) {
    console.error(`validate: cannot read the staged commit: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const offenders = staged.staged.filter((path) => path === 'manuscript' || path.startsWith('manuscript/'));
  if (offenders.length > 0) {
    for (const path of offenders) {
      console.log(
        `validate: ${path} is staged — the book's text lives in the database (BOOK-187); ` +
          'nothing under manuscript/ may be committed',
      );
    }
    console.log('');
    console.log(`commit gate: ${String(offenders.length)} manuscript path(s) staged; the commit is refused`);
    return 1;
  }
  console.log(`commit gate: ${String(staged.staged.length)} staged file(s), no manuscript path`);
  return 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node bin/validate.mjs --from-db <dataDir> [--json] [--rule=F001,..] [--strict]');
    console.log('       node bin/validate.mjs --staged');
    console.log('       node bin/validate.mjs [--root=DIR] [--denylist=path] [--imprint=path]');
    console.log('runs F001, F002, F005–F007, F009, F020–F022 and F029 over the book');
    console.log('--from-db renders the rows into a temp tree; --staged refuses a staged manuscript path;');
    console.log('with neither, only the image files are checked and the text rules are named as skipped');
    return 0;
  }
  if (options.error) {
    console.error(`validate: ${options.error}`);
    return 2;
  }
  if (options.staged && options.dataDir !== null) {
    console.error('validate: --staged and --from-db are different gates; run them one at a time');
    return 2;
  }
  if (options.staged) return stagedGate(options);

  let denylist;
  let imprint;
  try {
    denylist = readDenylist(readJson(options.denylistPath, 'legal denylist'));
    imprint = readImprint(readJson(options.imprintPath, 'imprint'));
  } catch (error) {
    console.error(`validate: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const mode = options.dataDir !== null ? 'db' : options.rootGiven ? 'tree' : 'image';
  let result;
  try {
    if (mode === 'db') result = await validateFromDb(options, denylist, imprint);
    else if (mode === 'tree') {
      result = runValidation({
        files: readFilesIn(join(options.root, 'manuscript')),
        planning: readPlanningFiles(options.root),
        denylist,
        imprint,
      });
    } else {
      // The image holds the imprint, the denylist and the planning files; the text is a row.
      // F021 is dropped for the same reason: there is no first sheet to be missing here.
      result = runValidation({ files: [], planning: readPlanningFiles(options.root), denylist, imprint });
      result = { ...result, findings: result.findings.filter((finding) => finding.rule !== 'F021') };
    }
  } catch (error) {
    console.error(`validate: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const all = [...result.findings].sort((left, right) => {
    if (left.file !== right.file) return left.file.localeCompare(right.file);
    if (left.line !== right.line) return left.line - right.line;
    return left.rule.localeCompare(right.rule);
  });
  const filtered = options.rules
    ? { ...result, findings: all.filter((item) => options.rules.has(item.rule)) }
    : { ...result, findings: all };
  const errors = filtered.findings.filter((item) => item.severity === 'error').length;
  const warnings = filtered.findings.filter((item) => item.severity === 'warn').length;
  const output = {
    mode,
    ...filtered,
    errors,
    warnings,
    ...(mode === 'image' ? { skipped: TEXT_RULES } : {}),
  };

  if (options.json) console.log(JSON.stringify(output, null, 2));
  else printReport(output, mode);

  if (errors > 0) return 1;
  if (options.strict && warnings > 0) return 1;
  return 0;
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

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`validate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
