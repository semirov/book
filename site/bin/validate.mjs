#!/usr/bin/env node
/**
 * bin/validate.mjs — the integrity gate (ARCHITECTURE.md §13.4).
 *
 * Runs F001–F009 over the manuscript. Reads only: nothing here writes a chapter file.
 * Node 22.18+ executes the TypeScript rules in shared/src/validate directly (type
 * stripping), so the gate works before any build.
 *
 *   node bin/validate.mjs                          # whole repository
 *   node bin/validate.mjs --root=/book             # explicit root
 *   node bin/validate.mjs --json                   # machine-readable result
 *   node bin/validate.mjs --allow-new-name=Тюрин    # accept a name for this run only
 *   node bin/validate.mjs --refresh-cast            # regenerate `cast` from the dossiers
 *   node bin/validate.mjs --rule=F003,F008          # run a subset
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EMPTY_ALLOWLIST,
  castFromDossiers,
  runValidation,
} from '../shared/src/validate/index.ts';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ROOT = resolve(SITE_ROOT, '..');
const ALLOWLIST_PATH = join(SITE_ROOT, 'config', 'cast.allowlist.json');
const ALLOWLIST_NOTE =
  'F005 allowlist. `cast` is generated from bible/dossiers.md (Имя: lines) by ' +
  '`node bin/validate.mjs --refresh-cast` and must be edited there, not here. `places` follows ' +
  'ARCHITECTURE.md §13.4; `manual` holds abbreviations and proper names the editor allowed on ' +
  'purpose. Matching is case-insensitive and stem-based, so one nominative name covers its case forms.';
const PLANNING_GLOBS = [
  'manuscript/PLAN.md',
  'outline/structure.md',
  'process/write.log.md',
  'process/write.fwd.log.md',
  'process/write.back.log.md',
  'process/run.log.md',
  'process/WRITE_TEMPLATE.md',
  'process/WRITE_FWD_TEMPLATE.md',
  'process/WRITE_BACK_TEMPLATE.md',
  'process/REWRITE_TEMPLATE.md',
];

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, json: false, rules: null, allowNewNames: [], refreshCast: false };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--refresh-cast') options.refreshCast = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--root=')) options.root = resolve(arg.slice('--root='.length));
    else if (arg.startsWith('--allow-new-name=')) options.allowNewNames.push(arg.slice('--allow-new-name='.length));
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

function readAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return { allowlist: EMPTY_ALLOWLIST, document: null };
  const document = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  return {
    allowlist: {
      cast: asList(document.cast),
      places: asList(document.places),
      manual: asList(document.manual),
    },
    document,
  };
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

function refreshCast(root, document) {
  const dossiers = join(root, 'bible', 'dossiers.md');
  if (!existsSync(dossiers)) {
    console.error(`--refresh-cast: ${dossiers} not found; allowlist left untouched`);
    return false;
  }
  const cast = castFromDossiers(readFileSync(dossiers, 'utf8'));
  // Only `cast` is generated; places, the curated list and the note survive the refresh.
  const next = {
    version: document?.version ?? 1,
    note: document?.note ?? ALLOWLIST_NOTE,
    cast,
    places: asList(document?.places),
    manual: asList(document?.manual),
  };
  writeFileSync(ALLOWLIST_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.error(`--refresh-cast: ${cast.length} names from bible/dossiers.md → config/cast.allowlist.json`);
  return true;
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
  console.log(
    `manuscript: ${written} chapter files · ${result.totalChapters - written} empty slots · ${chars} characters`,
  );
  console.log(`${result.errors} errors · ${result.warnings} warnings`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node bin/validate.mjs [--root=DIR] [--json] [--rule=F001,..]');
    console.log('       [--allow-new-name=NAME] [--refresh-cast]');
    return 0;
  }
  if (options.error) {
    console.error(`validate: ${options.error}`);
    return 2;
  }

  let { allowlist, document } = readAllowlist();
  if (options.refreshCast && refreshCast(options.root, document)) {
    ({ allowlist } = readAllowlist());
  }

  const result = runValidation({
    files: readManuscriptFiles(options.root),
    planning: readPlanningFiles(options.root),
    allowlist,
    allowNewNames: options.allowNewNames,
  });

  const filtered = options.rules
    ? { ...result, findings: result.findings.filter((item) => options.rules.has(item.rule)) }
    : result;
  const errors = filtered.findings.filter((item) => item.severity === 'error').length;
  const warnings = filtered.findings.filter((item) => item.severity === 'warn').length;
  const output = { ...filtered, errors, warnings };

  if (options.json) console.log(JSON.stringify(output, null, 2));
  else printReport(output);

  return errors === 0 ? 0 : 1;
}

process.exitCode = main();
