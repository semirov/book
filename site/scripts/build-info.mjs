#!/usr/bin/env node
/**
 * scripts/build-info.mjs — the stamp every build carries (BOOK-109, BOOK-187).
 *
 * The owner's phone kept printing the old ch01/ch42 while this host served the canon, and
 * nothing on the page said which build it was: a client cache, a second host and an unbuilt
 * bundle all looked the same. So each build bakes its identity in — `commit`, the moment, a
 * short Moscow stamp — and the colophon prints it under the imprint line.
 *
 * BOOK-187 / ADR-043 G3, G8: the image is the only home of the prompts and of its own identity,
 * so two more facts are baked with it:
 *   · `promptBundleSha` — sha256 over the ordered lines `<relpath>:<sha256(file)>` of the prompt
 *     and canon files the image carries (see PROMPT_FILES). «Which rules judged this text» is
 *     then a digest the DB can record and compare, and a rollback that changes it raises
 *     `PROMPT_DRIFT` at boot. A file that is missing fails the build: a bundle that cannot be
 *     hashed is not a bundle;
 *   · `imageDigest` — `BOOK_IMAGE_DIGEST` when the image build passes it, else null.
 *
 * Runtime never asks git (G8): this script runs *at build time*, and `BOOK_BUILD_NO_GIT=1` proves
 * it — the image build sets it, so a `git` that is not there cannot be consulted by accident.
 *
 * Run by `npm run build` (as `prebuild`), so the CI gate, `deploy.sh` and the Dockerfile all
 * regenerate it without a second step. Plain Node ESM on purpose: a TS file here would need the
 * build it is part of.
 *
 * Inputs, in order of preference:
 *   commit  — `BOOK_BUILD_COMMIT` (an explicit build arg/deploy override), `git rev-parse
 *             --short HEAD` in `site/` unless `BOOK_BUILD_NO_GIT=1`, `GITHUB_SHA` (7 chars; a
 *             git-less build in CI), `'dev'` (no tree, no sha);
 *   time    — `BOOK_BUILD_TIME` (ISO; tests), now;
 *   output  — `BOOK_BUILD_OUT` (tests), `site/build-info.json`.
 *
 * The tree outranks `GITHUB_SHA` on purpose (BOOK-109 review): the workflow runs `deploy.sh`
 * inside an Actions step, so `GITHUB_SHA` names the *trigger* commit, while the script may
 * check out `origin/<ref>`, a tag or the last good release. A tree in hand is the only
 * authority for what is being built — after a rollback the stamp must not name the commit the
 * rollback was triggered from.
 *
 * The stamp is formatted in `Europe/Moscow` explicitly — the build machine's zone is not a
 * fact about the reader, and a CI runner is UTC.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The book's root: prompts and canon live one level above `site/` (ADR-043 G1). */
const BOOK_ROOT = resolve(SITE, '..');
const TZ = 'Europe/Moscow';

/**
 * The files whose text decides how a pass behaves, in the order they hash (ADR-043 G3). Paths are
 * the *logical* paths of the bundle — the names the digest records — looked up under the book root
 * first and then under `site/`: the canon lives at the root, while the pipeline pin this tree
 * carries is `site/config/pipeline.json`. The order is part of the digest, so the list may be
 * appended to but never reordered without changing every recorded bundle.
 */
const PROMPT_FILES = [
  'process/ROLE_PROMPTS.md',
  'concept/CONCEPT.md',
  'concept/CLIMAX.md',
  'style/VOICE.md',
  'config/pipeline.json',
];

const NO_GIT = (process.env.BOOK_BUILD_NO_GIT ?? '').trim() === '1';

/** `5558449` — the commit this build is from, never an empty string. */
function commitOf() {
  const explicit = (process.env.BOOK_BUILD_COMMIT ?? '').trim();
  if (explicit.length > 0) return explicit;
  if (!NO_GIT) {
    try {
      const short = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: SITE,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (short.length > 0) return short;
    } catch {
      /* no repository here (the Docker image, a tarball): fall back to the CI's sha */
    }
  }
  const sha = (process.env.GITHUB_SHA ?? '').trim();
  if (sha.length >= 7) return sha.slice(0, 7);
  return 'dev';
}

/**
 * `sha256` over `<relpath>:<sha256(file)>` for every prompt file, in PROMPT_FILES order, one line
 * each. A missing file is a build failure, not a partial digest: the image would then carry rules
 * no digest names.
 */
function promptBundleSha(root = BOOK_ROOT) {
  const lines = [];
  for (const relpath of PROMPT_FILES) {
    let bytes;
    try {
      bytes = readFileSync(join(root, relpath));
    } catch {
      // The pipeline pin ships under `site/` in this tree; the digest still names it logically.
      try {
        bytes = readFileSync(join(SITE, relpath));
      } catch {
        throw new Error(
          `prompt bundle: ${relpath} is missing under ${root} — a bundle that cannot be hashed is not a bundle`,
        );
      }
    }
    lines.push(`${relpath}:${createHash('sha256').update(bytes).digest('hex')}`);
  }
  return createHash('sha256').update(`${lines.join('\n')}\n`, 'utf8').digest('hex');
}

/** `2026-10-27T17:52:00.000Z` — the moment the build ran. */
function builtAtOf() {
  const explicit = (process.env.BOOK_BUILD_TIME ?? '').trim();
  if (explicit.length > 0) {
    const parsed = new Date(explicit);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }
  return new Date().toISOString();
}

/** `27.10 20:52` — day/month and time in Moscow, whatever the host's zone is. */
function stampOf(iso) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const value = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${value('day')}.${value('month')} ${value('hour')}:${value('minute')}`;
}

const builtAt = builtAtOf();
const stamp = stampOf(builtAt);
let promptBundle;
try {
  promptBundle = promptBundleSha();
} catch (error) {
  console.error(`build-info: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const info = {
  commit: commitOf(),
  builtAt,
  stamp,
  promptBundleSha: promptBundle,
  imageDigest: (process.env.BOOK_IMAGE_DIGEST ?? '').trim() || null,
};
const out = process.env.BOOK_BUILD_OUT ?? resolve(SITE, 'build-info.json');

writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
// One line, greppable in a CI log: which build is being shipped, and where its stamp went.
console.log(`build-info: ${info.commit} · ${info.stamp} · bundle ${info.promptBundleSha.slice(0, 12)} → ${out}`);
