#!/usr/bin/env node
/**
 * site/deploy/healthcheck.mjs — what "healthy" means for a book container (BOOK-172).
 *
 * A healthcheck that only proves "something accepted a socket" is the reason the launchd era could
 * not tell a stale build from a served one. This one asks two questions and needs both answered:
 *
 *   site   — does `/healthz` answer 200 with `ok:true`, and does the `commit` it names equal the
 *            commit stamped into THIS image (`/app/build-info.json`, written by the build)?
 *   engine — does the token-guarded `/internal/health` answer 200 `ok:true` with the bearer the
 *            process itself reads (`ENGINE_TOKEN_FILE`)? No commit check: one image serves all three
 *            services, so the image's identity is already that of the site.
 *
 * The commit is read from the image's own file, not from an environment variable: a runtime value
 * could disagree with the bytes that are serving, and `docker inspect` would then carry an identity
 * nobody can trust. Nothing here prints a secret — the bearer never reaches stdout or a log line.
 *
 * Exit 0 healthy, 1 unhealthy. `--print` writes the parsed answer to stdout (read-only, used by
 * `lane-check.sh`); no value from a secret file is ever included.
 */

import { readFileSync } from 'node:fs';

const role = (process.argv[2] ?? 'site').trim();
const print = process.argv.includes('--print');

/** The commit the build wrote into this image; `dev` when the stamp is absent or unreadable. */
function imageCommit() {
  const file = process.env.BOOK_BUILD_INFO_FILE ?? '/app/build-info.json';
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const commit = manifest?.commit;
    return typeof commit === 'string' && commit.length > 0 ? commit : 'dev';
  } catch {
    return 'dev';
  }
}

/** One file, trimmed; a missing file is a configuration problem, said by name only. */
function readToken() {
  const file = process.env.ENGINE_TOKEN_FILE ?? '/data/engine.token';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

function urlFor(roleName) {
  if (roleName === 'engine') {
    const explicit = process.env.BOOK_ENGINE_URL;
    if (explicit) return explicit;
    const port = process.env.ENGINE_PORT ?? process.env.PORT ?? '8081';
    return `http://127.0.0.1:${port}/internal/health`;
  }
  const explicit = process.env.BOOK_HEALTH_URL;
  if (explicit) return explicit;
  const port = process.env.PORT ?? '8080';
  return `http://127.0.0.1:${port}/healthz`;
}

/** A failed check is one line on stderr: the sentence an operator reads in `docker inspect`. */
function fail(message) {
  console.error(`healthcheck: ${message}`);
  process.exit(1);
}

async function main() {
  const url = urlFor(role);
  const headers = {};
  if (role === 'engine') {
    const token = readToken();
    if (token.length === 0) fail(`no engine token at ${process.env.ENGINE_TOKEN_FILE ?? '/data/engine.token'}`);
    headers.authorization = `Bearer ${token}`;
  }

  let status = 0;
  let body = '';
  try {
    const answer = await fetch(url, { headers, // Longer than the DB's own `busy_timeout` (5000 ms): a healthcheck that gives up first would
    // report a container unhealthy exactly while the server is legitimately waiting for the write lock.
    signal: AbortSignal.timeout(7000), cache: 'no-store' });
    status = answer.status;
    body = await answer.text();
  } catch (error) {
    fail(`${url}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (status !== 200) fail(`${url}: HTTP ${status}`);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail(`${url}: the answer is not JSON`);
  }
  if (parsed?.ok !== true) fail(`${url}: ok is not true`);

  if (role === 'site') {
    const expected = imageCommit();
    const reported = typeof parsed.commit === 'string' ? parsed.commit : '';
    if (reported.length === 0) fail('/healthz names no commit');
    if (expected !== 'dev' && reported !== expected) {
      fail(`commit mismatch — image ${expected}, /healthz ${reported}`);
    }
    if (print) process.stdout.write(`${JSON.stringify({ ok: true, commit: reported, image: expected })}\n`);
    return;
  }

  if (print) process.stdout.write(`${JSON.stringify(parsed)}\n`);
}

await main();
