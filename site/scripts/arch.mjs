#!/usr/bin/env node
/**
 * scripts/arch.mjs — the architecture gate (§20 M0: "the arch test is green").
 *
 * Rules, all checked without building anything:
 *   1. no source file above 500 lines;
 *   2. layers: shared is platform-neutral, the server never imports the SPA, the SPA
 *      never imports the server or Node built-ins;
 *   3. the site never writes to the book repository (text is read-only for the site);
 *   4. the book's invariants are where the UI expects them (42 chapters, engine tables,
 *      the rule ids covered by tests);
 *   5. the engine calls no model and no network: it is a deterministic state machine;
 *   6. F023 — support files (`bible/`, `outline/`, `process/`, `concept/`, `style/`), the prompt
 *      tree (`.opencode/skills/`, BOOK-5) and `notes/` stay internal: no line of them appears in
 *      the built bundle. A dev/test run passes with no bundle on disk; a release run
 *      (`--require-dist`, the CI step after the build) fails without one. An unrecognised
 *      argument is an error, not a silent dev-mode run;
 *   7. the type floor and the adaptive regime (BOOK-DOC-35): no `font-size` below 12px and no
 *      `@media (min-width:)` in `web/src/styles` — the floor cannot silently rot again;
 *   8. the chip copy (BOOK-70): the words the two audits removed are not printed again, and
 *      every registered chip keeps its one size, its voice and its two inks.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { f023Problems, missingDistProblem } from './containment.mjs';
import { copyProblems } from './chips.mjs';
import { styleProblems } from './styles.mjs';

const ROOT = resolve(import.meta.dirname, '..');
/** The book repository: `site/` lives inside it (§21.1). */
const BOOK_ROOT = resolve(ROOT, '..');
const MAX_LINES = 500;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.data', 'fonts', 'shots', '.git']);
const SOURCE_EXT = /\.(ts|tsx|mjs|js|css|sql)$/u;

/**
 * `--require-dist` is the release mode (BOOK-46). Any other argument is refused: a typo such as
 * `--require-dsit` used to run dev mode and exit 0, a green gate that proved nothing.
 */
const ARGS = process.argv.slice(2);
const REQUIRE_DIST = ARGS.includes('--require-dist');
const UNKNOWN_ARG = ARGS.find((arg) => arg !== '--require-dist');
if (UNKNOWN_ARG !== undefined) {
  console.error(`arch: unknown argument "${UNKNOWN_ARG}" — the only accepted flag is --require-dist`);
  process.exit(1);
}

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

const files = ['shared', 'server', 'web/src', 'bin', 'scripts', 'config', 'test'].flatMap((dir) => walk(join(ROOT, dir)));

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
if (!/export const TOTAL_CHAPTERS = 42;/u.test(bookModel)) {
  report(join(ROOT, 'shared/src/book.ts'), 'TOTAL_CHAPTERS must be 42');
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
  'F015', 'F020', 'F021', 'F022', 'F023', 'F024', 'F025',
]) {
  if (!validateRules.includes(`'${id}'`)) report(join(ROOT, 'shared/src/validate/text.ts'), `rule ${id} is missing`);
}

/**
 * The title line and the front matter have one parser with two callers (§23.5). A chapter's
 * title decision is `parseChapterTitle` — the title rule plus the line the frame owns (BOOK-32).
 */
const parseChapter = readFileSync(join(ROOT, 'server/src/ingest/parseChapter.ts'), 'utf8');
if (!parseChapter.includes('parseChapterTitle')) {
  report(join(ROOT, 'server/src/ingest/parseChapter.ts'), 'must parse the title line with parseChapterTitle');
}
const validateFrame = readFileSync(join(ROOT, 'shared/src/validate/frame.ts'), 'utf8');
if (!validateFrame.includes('parseChapterTitle')) {
  report(join(ROOT, 'shared/src/validate/frame.ts'), 'must read the prose with parseChapterTitle, not a local title rule');
}
// The validator's own collection must read the same title decision; a second rule drifts.
const validateRulesFile = readFileSync(join(ROOT, 'shared/src/validate/rules.ts'), 'utf8');
for (const [file, source] of [
  ['server/src/ingest/parseChapter.ts', parseChapter],
  ['shared/src/validate/frame.ts', validateFrame],
  ['shared/src/validate/rules.ts', validateRulesFile],
]) {
  if (!source.includes('parseChapterTitle')) report(join(ROOT, file), 'must decide the title line with parseChapterTitle');
}
// And no blank-line heuristic may come back: "line 1 followed by a blank line" is not a title
// rule — it is what dropped the frame of ch01 (BOOK-32).
for (const file of ['shared/src/validate/frame.ts', 'shared/src/validate/rules.ts', 'server/src/ingest/parseChapter.ts']) {
  if (/lines\[1\]/u.test(readFileSync(join(ROOT, file), 'utf8'))) {
    report(join(ROOT, file), 'must not infer a title line from the blank line under it (BOOK-32)');
  }
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
 * 6 — F023, support-file containment. The guard is a canary: every long line of every support
 * file is a string that must not appear in what the site ships. `web/dist` is skipped by
 * `walk`, so it is read directly. A missing build is not a failure in a dev/test run — the build
 * gate runs after this one — but a release run (`--require-dist`) fails, because a bundle that is
 * not there proves nothing.
 *
 * BOOK-5: a skill is a prompt, so `.opencode/skills/**` (`PROMPT_FILES` in `containment.mjs`)
 * is guarded exactly like `process/` — the procedure an agent follows never ships as text.
 */
// BOOK-119: `web/dist` is a release store — `releases/**` is history, not something the site
// serves. The canary walks the tree `current` names (the flat `dist` on a tree without a
// publish yet), so a pruned or older release cannot make the scan either miss or lie.
const currentDir = join(ROOT, 'web', 'dist', 'current');
// `BOOK_DIST_DIR` overrides that path: a test seam, and the deploy's release check (BOOK-46).
// `||`, not `??`: an empty variable means "unset", never "scan the empty path".
const distDir = process.env.BOOK_DIST_DIR || (existsSync(currentDir) ? currentDir : join(ROOT, 'web', 'dist'));
// Say what was scanned: a redirected `BOOK_DIST_DIR` must never silently vouch for another tree.
if (REQUIRE_DIST) console.log(`arch: F023 release mode — scanning ${relative(ROOT, distDir) || '.'}`);
const missingDist = missingDistProblem({ distDir, requireDist: REQUIRE_DIST });
if (missingDist !== null) report(missingDist.file, missingDist.message);
for (const problem of f023Problems({ bookRoot: BOOK_ROOT, distDir })) {
  report(problem.file, problem.message);
}

/**
 * F024, the F024-era prompt-name guard, is gone: it guarded names recorded in the dossier
 * record, and the dossier mandate is retired — with no record and no title lines, the check
 * could only pass vacuously. The rule id stays in `validate/text.ts`.
 */

/** 7 — the type floor, the adaptive regime and the chips (BOOK-DOC-35 §7, BOOK-70). */
for (const problem of styleProblems(join(ROOT, 'web', 'src', 'styles'), { requireChips: true })) {
  report(problem.file, `line ${problem.line}: ${problem.message}`);
}

/** 8 — the chip copy of BOOK-70: a chip states one provable fact, or it does not exist. */
for (const problem of copyProblems(join(ROOT, 'web', 'src'))) {
  report(problem.file, `line ${problem.line}: ${problem.message}`);
}

if (problems.length > 0) {
  console.error(`arch: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`arch: ok — ${files.length} files checked, limit ${MAX_LINES} lines, layers and invariants hold`);
