#!/usr/bin/env node
/**
 * scripts/arch.mjs — the architecture gate (§20 M0: "the arch test is green").
 *
 * Rules, all checked without building anything:
 *   1. no source file above 500 lines;
 *   2. layers: shared is platform-neutral, the server never imports the SPA, the SPA
 *      never imports the server or Node built-ins;
 *   3. the site never writes to the book repository (text is read-only for the site);
 *   4. the book's invariants are where the UI expects them (67 chapters, engine tables,
 *      the rule ids covered by tests);
 *   5. the engine calls no model and no network: it is a deterministic state machine;
 *   6. F023 — support files (`bible/`, `outline/`, `process/`, `concept/`, `style/`) stay
 *      internal: no line of them appears in the built bundle;
 *   7. F024 — no names in prompts: no dossier name and no chapter title line appears in a
 *      writer/gate template (§6E.2, §6E.4).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { checkPromptNames, promptGuardNames } from '../shared/src/validate/prompts.ts';

const ROOT = resolve(import.meta.dirname, '..');
/** The book repository: `site/` lives inside it (§21.1). */
const BOOK_ROOT = resolve(ROOT, '..');
const MAX_LINES = 500;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.data', 'fonts', 'shots', '.git']);
const SOURCE_EXT = /\.(ts|tsx|mjs|js|css|sql)$/u;

const problems = [];
const report = (file, message) => problems.push(`${relative(ROOT, file)}: ${message}`);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const files = ['shared', 'server', 'web/src', 'bin', 'scripts', 'config'].flatMap((dir) => walk(join(ROOT, dir)));

/** 1 — file size */
for (const file of files) {
  if (!SOURCE_EXT.test(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n').length;
  if (lines > MAX_LINES) report(file, `${lines} lines, limit is ${MAX_LINES}`);
}

const isTs = (file) => /\.(ts|tsx)$/u.test(file);
const importsOf = (source) =>
  [...source.matchAll(/from\s+'([^']+)'/gu)].map((match) => match[1]).concat(
    [...source.matchAll(/import\s+'([^']+)'/gu)].map((match) => match[1]),
  );

/** 2 — layer boundaries */
for (const file of files.filter(isTs)) {
  const source = readFileSync(file, 'utf8');
  const imports = importsOf(source);
  const inShared = file.startsWith(join(ROOT, 'shared'));
  const inServer = file.startsWith(join(ROOT, 'server'));
  const inWeb = file.startsWith(join(ROOT, 'web'));

  if (inShared) {
    for (const specifier of imports) {
      if (specifier.startsWith('node:')) report(file, `shared must stay platform-neutral, imports ${specifier}`);
      if (/(^|\/)(server|web)\//u.test(specifier)) report(file, `shared must not import ${specifier}`);
    }
  }
  if (inServer) {
    for (const specifier of imports) {
      if (specifier === 'react' || specifier.startsWith('react-dom')) report(file, `the server must not import ${specifier}`);
      if (specifier.startsWith('@book/web')) report(file, 'the server must not import the SPA');
    }
  }
  if (inWeb) {
    for (const specifier of imports) {
      if (specifier.startsWith('node:')) report(file, `the SPA must not use ${specifier}`);
      if (specifier === 'fastify' || specifier === 'better-sqlite3' || specifier.startsWith('@book/server')) {
        report(file, `the SPA must not import ${specifier}`);
      }
    }
  }
}

/** 3 — the repository is read-only for the site (tests may build temp fixtures) */
const WRITE_CALL = /\b(writeFileSync|appendFileSync|writeFile|createWriteStream|rmSync|unlinkSync|renameSync|mkdirSync)\s*\(/gu;
const isProductionSource = (file) => isTs(file) && !/[\\/](test|tests)[\\/]/u.test(file) && !/\.test\.ts$/u.test(file);
for (const file of files.filter(isProductionSource)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(WRITE_CALL)) {
    const window = source.slice(match.index, match.index + 240);
    if (/manuscript/u.test(window)) report(file, `write call near the manuscript: ${window.split('\n')[0]?.trim()}`);
  }
}

/** 5 — the engine is a deterministic state machine, never a model caller (ADR-012) */
const ENGINE_DIR = join(ROOT, 'server/src/engine');
for (const file of files.filter((path) => path.startsWith(ENGINE_DIR) && isTs(path))) {
  const source = readFileSync(file, 'utf8');
  if (/\bfetch\s*\(/u.test(source)) {
    report(file, 'the engine must not call out (no model calls — ADR-012)');
  }
}
/** 4 — invariants the UI and the DB depend on */
const bookModel = readFileSync(join(ROOT, 'shared/src/book.ts'), 'utf8');
if (!/export const TOTAL_CHAPTERS = 67;/u.test(bookModel)) {
  report(join(ROOT, 'shared/src/book.ts'), 'TOTAL_CHAPTERS must be 67');
}
if (!/export const PART_RANGES/u.test(bookModel)) {
  report(join(ROOT, 'shared/src/book.ts'), 'PART_RANGES must live next to TOTAL_CHAPTERS');
}

// Two tables live in `schema/tables.ts` (they are also built by an incremental migration);
// the schema as a whole is the two files together.
const schema =
  readFileSync(join(ROOT, 'server/src/db/schema.ts'), 'utf8') +
  readFileSync(join(ROOT, 'server/src/db/tables.ts'), 'utf8');
const REQUIRED_SCHEMA_TABLES = [
  'chapters',
  'front_matter',
  'blocks',
  'revisions',
  'changes',
  'cascades',
  'steps',
  'gate_verdicts',
  'gate_dispatches',
  'leases',
  'lane',
  'comments',
  'identities',
  'sessions',
  'events',
  'front_revisions',
  'block_lineage',
  'block_versions',
  'overwrites',
  'change_impact',
  'contribution_history',
  'reconciles',
];
for (const table of REQUIRED_SCHEMA_TABLES) {
  if (!new RegExp(`CREATE TABLE ${table} \\(`, 'u').test(schema)) {
    report(join(ROOT, 'server/src/db/schema.ts'), `missing table ${table}`);
  }
}
if (/CREATE TABLE obligations \(/u.test(schema)) {
  report(join(ROOT, 'server/src/db/schema.ts'), 'obligations are retired in v3 (ADR-023)');
}

const validateRules = readFileSync(join(ROOT, 'shared/src/validate/text.ts'), 'utf8');
for (const id of [
  'F001', 'F002', 'F003', 'F004', 'F005', 'F006', 'F007', 'F008', 'F009', 'F010',
  'F015', 'F019', 'F020', 'F021', 'F022', 'F023', 'F024', 'F025',
]) {
  if (!validateRules.includes(`'${id}'`)) report(join(ROOT, 'shared/src/validate/text.ts'), `rule ${id} is missing`);
}

/** The title line and the front matter have one parser with two callers (§23.5). */
const parseChapter = readFileSync(join(ROOT, 'server/src/ingest/parseChapter.ts'), 'utf8');
if (!parseChapter.includes('parseTitleLine')) {
  report(join(ROOT, 'server/src/ingest/parseChapter.ts'), 'must parse the title line with parseTitleLine');
}
const parseFront = readFileSync(join(ROOT, 'server/src/ingest/parseFront.ts'), 'utf8');
if (!parseFront.includes('parseFrontMatter')) {
  report(join(ROOT, 'server/src/ingest/parseFront.ts'), 'must parse page 2 with parseFrontMatter');
}

const vitestConfig = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
for (const included of ['shared/src/**/*.ts', 'server/src/**/*.ts', 'web/src/lib/**/*.ts']) {
  if (!vitestConfig.includes(included)) report(join(ROOT, 'vitest.config.ts'), `coverage.include lacks ${included}`);
}

/**
 * 6 — F023, support-file containment. The guard is a canary: every long line of every
 * support file is a string that must not appear in what the site ships. `web/dist` is
 * skipped by `walk`, so it is read directly; a missing build is not a failure here — the
 * build gate runs after this one.
 */
const SUPPORT_DIRS = ['bible', 'outline', 'process', 'concept', 'style'];
const TEXT_FILE = /\.(md|txt|json)$/u;

function walkAll(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkAll(path, out);
    else out.push(path);
  }
  return out;
}

const canaries = [];
for (const dir of SUPPORT_DIRS) {
  const root = join(BOOK_ROOT, dir);
  if (!existsSync(root)) continue;
  for (const file of walkAll(root)) {
    if (!TEXT_FILE.test(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const text = line.replace(/^[\s#>*\-]+/u, '').trim();
      if (text.length >= 60) canaries.push({ file, text });
    }
  }
}

const distDir = join(ROOT, 'web', 'dist');
if (canaries.length > 0 && existsSync(distDir)) {
  const shipped = walkAll(distDir).filter((file) => /\.(js|css|html|svg|json)$/u.test(file));
  for (const file of shipped) {
    const content = readFileSync(file, 'utf8');
    const hit = canaries.find((canary) => content.includes(canary.text));
    if (hit !== undefined) {
      report(file, `F023: ships a line of the support file ${relative(BOOK_ROOT, hit.file)}`);
    }
  }
}

/**
 * 7 — F024, no names in prompts. A prompt that carried a person would let hostile input
 * reach the cast instead of one sentence (§6E.2), so a dossier name or a chapter title line
 * inside a template is a build error. The decision lives in `shared/src/validate/prompts.ts`
 * so it has a test; this only reads the files.
 */
const PROMPT_FILES = [
  'process/WRITE_FWD_TEMPLATE.md',
  'process/WRITE_BACK_TEMPLATE.md',
  'process/WRITE_TEMPLATE.md',
  'process/REWRITE_TEMPLATE.md',
  'process/RUN_TEMPLATE.md',
  'process/ROLE_PROMPTS.md',
];

const dossiersPath = join(BOOK_ROOT, 'bible', 'dossiers.md');
const dossiers = existsSync(dossiersPath) ? readFileSync(dossiersPath, 'utf8') : '';
const titles = [];
const manuscriptDir = join(BOOK_ROOT, 'manuscript');
if (existsSync(manuscriptDir)) {
  for (const name of readdirSync(manuscriptDir)) {
    if (!/^ch\d{2}\.md$/u.test(name)) continue;
    titles.push(readFileSync(join(manuscriptDir, name), 'utf8').split('\n')[0] ?? '');
  }
}
const guardNames = promptGuardNames(dossiers, titles);
const prompts = PROMPT_FILES.map((relativePath) => join(BOOK_ROOT, relativePath))
  .filter((path) => existsSync(path))
  .map((path) => ({ file: relative(BOOK_ROOT, path), text: readFileSync(path, 'utf8') }));
for (const finding of checkPromptNames(prompts, guardNames)) {
  report(join(BOOK_ROOT, finding.file), `F024: ${finding.message}`);
}

if (problems.length > 0) {
  console.error(`arch: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`arch: ok — ${files.length} files checked, limit ${MAX_LINES} lines, layers and invariants hold`);
