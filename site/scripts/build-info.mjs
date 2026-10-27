#!/usr/bin/env node
/**
 * scripts/build-info.mjs — the stamp every build carries (BOOK-109).
 *
 * The owner's phone kept printing the old ch01/ch67 while this host served the canon, and
 * nothing on the page said which build it was: a client cache, a second host and an unbuilt
 * bundle all looked the same. So each build bakes its identity in — `commit`, the moment, and a
 * short Moscow stamp — and the colophon prints it under the imprint line.
 *
 * Run by `npm run build` (as `prebuild`), so the CI gate, `deploy.sh` and the Dockerfile all
 * regenerate it without a second step. Plain Node ESM on purpose: a TS file here would need the
 * build it is part of.
 *
 * Inputs, in order of preference:
 *   commit  — `BOOK_BUILD_COMMIT` (an explicit deploy/build-arg override), `git rev-parse
 *             --short HEAD` in `site/`, `GITHUB_SHA` (7 chars; a git-less build in CI),
 *             `'dev'` (no tree, no sha);
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

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TZ = 'Europe/Moscow';

/** `5558449` — the commit this build is from, never an empty string. */
function commitOf() {
  const explicit = (process.env.BOOK_BUILD_COMMIT ?? '').trim();
  if (explicit.length > 0) return explicit;
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
  const sha = (process.env.GITHUB_SHA ?? '').trim();
  if (sha.length >= 7) return sha.slice(0, 7);
  return 'dev';
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
const info = { commit: commitOf(), builtAt, stamp };
const out = process.env.BOOK_BUILD_OUT ?? resolve(SITE, 'build-info.json');

writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
// One line, greppable in a CI log: which build is being shipped, and where its stamp went.
console.log(`build-info: ${info.commit} · ${info.stamp} → ${out}`);
