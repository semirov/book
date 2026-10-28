#!/usr/bin/env node
/**
 * scripts/sw-build.mjs — BOOK-157: write `web/dist/staging/sw.js` for the release just built.
 *
 * Run as the last step of `npm run build`, after Vite, because the service worker names files
 * that only exist once Vite has hashed them: the precache list is the staging tree's own
 * `/assets/*.js|css`, the fonts and the icons, and the offline document points at the entry the
 * built `index.html` names. `deploy.sh` and the Docker image both call `npm run build`, so both
 * ship the worker; a publish then renames the whole staging tree into `releases/<id>`, so the
 * worker travels with the release it describes and no second step can forget it.
 *
 * Plain Node ESM, no dependency, no Vite plugin: the logic lives in `scripts/lib/sw.mjs` (pure,
 * and tested) — this file only reads the tree, calls it and writes one file.
 *
 *   node scripts/sw-build.mjs [--web-dist DIR] [--site-root DIR]
 *
 * Exit codes: 0 written; 1 the build cannot be described (no staging tree, no entry, no stamp
 * readable); 2 usage.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cacheNameOf, offlineDocument, precacheList, swSource } from './lib/sw.mjs';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node scripts/sw-build.mjs [--web-dist <dir>] [--site-root <dir>]';

function bail(message) {
  process.stderr.write(`sw: ${message}\n${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { webDist: join(SITE, 'web', 'dist'), siteRoot: SITE };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const key = name === '--web-dist' ? 'webDist' : name === '--site-root' ? 'siteRoot' : null;
    if (key === null) bail(`unknown argument: ${arg}`);
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
    options[key] = resolve(value);
  }
  return options;
}

/** Every file under `dir`, as repo-relative POSIX paths — the shape `precacheList` reads. */
function walkFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkFiles(path, base, out);
    else out.push(relative(base, path).split(/[\\/]/u).join('/'));
  }
  return out;
}

/** The `<script type="module" src>` the built shell names: the release's entry module. */
function entryOf(html) {
  for (const tag of html.matchAll(/<script\b[^>]*>/gu)) {
    const text = tag[0];
    if (!/\btype="module"/u.test(text)) continue;
    const src = /\bsrc="([^"]+)"/u.exec(text)?.[1];
    if (src !== undefined) return src;
  }
  return null;
}

/** The one stylesheet the built shell links, if it links one. */
function stylesheetOf(html) {
  for (const tag of html.matchAll(/<link\b[^>]*>/gu)) {
    const text = tag[0];
    if (!/\brel="stylesheet"/u.test(text)) continue;
    const href = /\bhref="([^"]+)"/u.exec(text)?.[1];
    if (href !== undefined) return href;
  }
  return null;
}

function buildInfoOf(siteRoot) {
  const file = join(siteRoot, 'build-info.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function main(argv) {
  const options = parseArgs(argv);
  const staging = join(options.webDist, 'staging');
  const index = join(staging, 'index.html');
  if (!existsSync(index)) {
    process.stderr.write(`sw: no built shell at ${index} — run \`npm run build\` (or npm run build -w @book/web) first\n`);
    return 1;
  }

  const html = readFileSync(index, 'utf8');
  const js = entryOf(html);
  if (js === null) {
    process.stderr.write(`sw: ${index} names no module entry — the offline document cannot boot the app\n`);
    return 1;
  }
  const css = stylesheetOf(html);
  const info = buildInfoOf(options.siteRoot);
  const cacheName = cacheNameOf(info);
  const precache = precacheList(walkFiles(staging));
  const offline = offlineDocument({ js, css });
  const source = swSource({ cacheName, precache, offline });

  const out = join(staging, 'sw.js');
  writeFileSync(out, source, 'utf8');
  const shown = relative(SITE, out) || out;
  console.log(`sw: ${cacheName} · ${String(precache.length)} files · entry ${js}${css === null ? '' : ` · ${css}`} → ${shown}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
