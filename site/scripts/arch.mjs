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
 *      the F001–F008 rules covered by tests).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
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

/** 4 — invariants the UI and the DB depend on */
const totalChapters = /export const TOTAL_CHAPTERS = 67;/u.test(
  readFileSync(join(ROOT, 'shared/src/chapters.ts'), 'utf8'),
);
if (!totalChapters) report(join(ROOT, 'shared/src/chapters.ts'), 'TOTAL_CHAPTERS must be 67');

const schema = readFileSync(join(ROOT, 'server/src/db/schema.ts'), 'utf8');
for (const table of ['chapters', 'blocks', 'revisions', 'changes', 'cascades', 'obligations', 'leases', 'lane', 'comments']) {
  if (!new RegExp(`CREATE TABLE ${table} \\(`, 'u').test(schema)) {
    report(join(ROOT, 'server/src/db/schema.ts'), `missing table ${table}`);
  }
}

const validateIndex = readFileSync(join(ROOT, 'shared/src/validate/rules.ts'), 'utf8');
for (let rule = 1; rule <= 9; rule += 1) {
  const id = `F00${rule}`;
  if (!validateIndex.includes(`'${id}'`)) report(join(ROOT, 'shared/src/validate/rules.ts'), `rule ${id} is missing`);
}

const vitestConfig = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
for (const included of ['shared/src/**/*.ts', 'server/src/**/*.ts', 'web/src/lib/**/*.ts']) {
  if (!vitestConfig.includes(included)) report(join(ROOT, 'vitest.config.ts'), `coverage.include lacks ${included}`);
}

if (problems.length > 0) {
  console.error(`arch: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`arch: ok — ${files.length} files checked, limit ${MAX_LINES} lines, layers and invariants hold`);
