/**
 * bin/adminDoctorHost.mjs — the host's half of the BOOK-188 preflight.
 *
 * The checks here are facts about the machine the operator stands on, not about the running
 * stack: the containers, the image identity, `/proc/self/mountinfo` inside the site, the host
 * backups and the drill log. They live here so `adminDoctor.mjs` stays the command (arguments,
 * rows, report) and this file stays the readings.
 *
 * **BOOK-187: no row asks about a checkout.** The prose question («does `manuscript/` hold text?»)
 * and the git one are gone: the text is rows, and the guard that names a prose path at deploy time
 * is `bin/home-check.mjs` (`server/src/dataHome.ts`), not a host that may have no `.git` at all.
 *
 * Read-only by construction: `docker inspect`/`exec cat`, `readdir`/`readFile`, and sqlite
 * opened `{readonly: true, fileMustExist: true}`. Nothing is created, nothing is written.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DAY_MS = 24 * 3_600_000;

/** Whitespace is not text (the same rule `scripts/lib/frame.mjs` applies): one line, trimmed. */
export function flat(value) {
  return String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** One line, bounded: a mismatch is reported as a sentence, never as a chapter of prose. */
export function oneLine(value, max = 70) {
  const text = flat(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function reasonOf(error) {
  const message = error instanceof Error ? error.message : String(error);
  return oneLine(message.split('\n')[0] ?? message, 160);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function shortId(image) {
  const value = String(image ?? '');
  return value.startsWith('sha256:') ? value.slice(7, 19) : value.slice(0, 12);
}

/** `42m` · `6h` · `3d` — a duration an operator reads, never a raw millisecond count. */
export function ageOfMs(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const value = Math.max(0, ms);
  if (value < 3_600_000) return `${String(Math.max(1, Math.round(value / 60_000)))}m`;
  if (value < 48 * 3_600_000) return `${String(Math.round(value / 3_600_000))}h`;
  return `${String(Math.round(value / DAY_MS))}d`;
}

/* --------------------------------------------------------------------------- the seams -- */

/** `docker <args>` → `{code, stdout, stderr}`. A missing binary is `code 1` and its message. */
export function execDocker(args) {
  return new Promise((done) => {
    execFile('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      done({ code, stdout: stdout ?? '', stderr: (stderr ?? '') || (error === null ? '' : error.message) });
    });
  });
}

/**
 * `git -C <repoRoot> ls-files manuscript` is gone (BOOK-187): the prose is rows, and whether a
 * checkout tracks a `manuscript/` file is no longer a question this doctor can fail on — the
 * guard that names such a path is `bin/home-check.mjs`, which the deploy runs. What the preflight
 * still needs the root for is the drill script beside it (`checkBackups`).
 */

/** better-sqlite3 belongs to the server's dependencies and is loaded only when a dump is read. */
export async function openReadonlyDefault(file) {
  const { default: Database } = await import('better-sqlite3');
  return new Database(file, { readonly: true, fileMustExist: true });
}

/** One `docker` call; a non-zero exit becomes a named failure and `null`. */
async function dockerCall(docker, args, failures, what) {
  let answer;
  try {
    answer = await docker(args);
  } catch (error) {
    failures.push(`${what}: ${reasonOf(error)}`);
    return null;
  }
  if (answer === null || answer === undefined) {
    failures.push(`${what}: no answer`);
    return null;
  }
  if (answer.code !== 0) {
    const reason = oneLine(String(answer.stderr ?? '').split('\n')[0] ?? '');
    failures.push(`${what}: ${reason.length > 0 ? reason : `exit ${String(answer.code)}`}`);
    return null;
  }
  return answer;
}

/**
 * JSON over HTTP with the admin token; the failure path returns a sentence, never a stack.
 * `timeoutMs` bounds the whole call: a server that accepts the socket and never answers must not
 * hang a preflight the owner is watching.
 */
export async function callJson({ fetchImpl, url, token, method = 'GET', body = null, timeoutMs = 10_000 }) {
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        ...(token.length > 0 ? { 'x-admin-token': token } : {}),
        ...(body === null ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, ok: response.ok, body: parseJson(await response.text()) };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    if (timedOut) return { error: `cannot reach ${url.origin}: timeout after ${String(timeoutMs)} ms` };
    return { error: `cannot reach ${url.origin}: ${reasonOf(error)}` };
  }
}

/* -------------------------------------------------------------- host facts, pure readers -- */

/**
 * The `/data` lines of `/proc/self/mountinfo`:
 * `id parent maj:min root mountpoint options [optional…] - fstype source superopts`.
 * Mountinfo is in mount order, so a bind stacked over a volume comes later: the **last** match
 * is the mount the container actually sees, and every match with the same target is a thing that
 * was mounted there.
 */
export function parseMountInfos(text, mountPoint = '/data') {
  const found = [];
  for (const line of String(text ?? '').split('\n')) {
    const at = line.indexOf(' - ');
    if (at < 0) continue;
    const left = line.slice(0, at).trim().split(/\s+/u);
    const right = line.slice(at + 3).trim().split(/\s+/u);
    if (left.length < 5 || right.length < 2) continue;
    if (left[4] !== mountPoint) continue;
    found.push({ root: left[3], fstype: right[0], source: right[1] });
  }
  return found;
}

/** The effective mount: the last line that mounts `mountPoint` (for readers that want one). */
export function parseMountInfo(text, mountPoint = '/data') {
  const found = parseMountInfos(text, mountPoint);
  return found.length === 0 ? null : found[found.length - 1];
}

/** FUSE-flavoured filesystems are a host filesystem seen through a mount, not a volume. */
const HOST_BIND_FS = /^(virtiofs|9p|cifs|smb|nfs.*|fuse.*)$/u;
/** The host's own trees, mounted into a container, are a bind whatever the filesystem says. */
const HOST_PATH_PREFIX = /^\/(Users|Volumes|home)\//u;
/** OrbStack `/docker/volumes/<name>/_data`, Docker `/var/lib/docker/volumes/<name>/_data`. */
const VOLUME_ROOT = '/volumes/';

/**
 * BOOK-188 check 1: `/data` must be a volume, and the rule is positive — a bind is recognised by
 * its filesystem (`virtiofs`, `fuse*`, `9p`, `nfs*`, `cifs`, `smb`), by a host path
 * (`/Users`, `/Volumes`, `/home`) or by the host data dir; a volume is recognised by living in a
 * volume store's `/volumes/` root. Anything else is not a volume either: it is a path on some
 * host filesystem, and BOOK-183 removes it.
 */
export function judgeVolume(mount, { hostDataDir = '' } = {}) {
  const fstype = String(mount?.fstype ?? '').toLowerCase();
  const root = String(mount?.root ?? '');
  const bind = (why) => ({ ok: false, reason: `/data is a host bind, not a volume: ${root} (${why}) — BOOK-183` });
  if (HOST_BIND_FS.test(fstype)) return bind(fstype);
  if (HOST_PATH_PREFIX.test(root)) return bind(fstype || 'host path');
  const dir = String(hostDataDir ?? '').replace(/\/+$/u, '');
  if (dir.length > 0 && (root === dir || root.startsWith(`${dir}/`))) return bind('the host data dir');
  if (!root.includes(VOLUME_ROOT)) return { ok: false, reason: `not a volume root: ${root} (${fstype || 'unknown'}) — BOOK-183` };
  return { ok: true, reason: null };
}

/**
 * The tree the preflight still reads: the drill script beside the deploy root (`checkBackups`).
 * It is believed when the directory is there — **no checkout is required** (BOOK-187): a host
 * that serves the book from a volume may have no `.git` and no `manuscript/` at all, and a check
 * that failed such a host would be asking about a tree instead of about the book.
 */
export function resolveRepoRoot(root) {
  const path = String(root ?? '');
  if (existsSync(path)) return { root: path, error: null };
  return { root: path, error: `BOOK_REPO_ROOT is not a directory: ${path}` };
}

/** The newest `<backupRoot>/daily/*​/book.db` by mtime, or `null` when there is none. */
function newestHostDump(backupRoot) {
  const daily = join(backupRoot, 'daily');
  if (!existsSync(daily)) return null;
  let newest = null;
  for (const entry of readdirSync(daily, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(daily, entry.name, 'book.db');
    if (!existsSync(file)) continue;
    const stats = statSync(file);
    if (newest === null || stats.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: stats.mtimeMs };
  }
  return newest;
}

/** The newest line a job wrote to the drill log; the log is append-only. */
function newestJobLine(text, job) {
  const lines = String(text ?? '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.includes(`job=${job}`)) return line.trim();
  }
  return null;
}

/** How much of an append-only log a preflight reads: the drill lines live at the end. */
const LOG_TAIL_BYTES = 64 * 1024;

/** The last `bytes` of a file, or its whole text when it is shorter. A missing file throws. */
function readTail(file, bytes = LOG_TAIL_BYTES) {
  const size = statSync(file).size;
  const start = Math.max(0, size - bytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const handle = openSync(file, 'r');
  try {
    if (length > 0) readSync(handle, buffer, 0, length, start);
  } finally {
    closeSync(handle);
  }
  return buffer.toString('utf8');
}

/** The drill script beside the deploy root: `<root>/deploy` or `<root>/site/deploy`. */
function drillScriptUnder(repoRoot) {
  return [join(repoRoot, 'deploy', 'restore-drill.sh'), join(repoRoot, 'site', 'deploy', 'restore-drill.sh')];
}

/* ------------------------------------------------------------------------- the checks -- */

/** 1 — containers running and healthy, one image, one commit, `/data` a volume. */
export async function checkRuntime(ctx) {
  const failures = [];
  const containers = [
    { name: `${ctx.project}-site-1`, health: true },
    { name: `${ctx.project}-engine-1`, health: true },
    { name: `${ctx.project}-writer-1`, health: false },
  ];
  for (const container of containers) {
    const answer = await dockerCall(ctx.docker, ['inspect', '--format', '{{json .State}}', container.name], failures, `docker inspect ${container.name} state`);
    if (answer === null) continue;
    const state = parseJson(answer.stdout);
    if (state === null) {
      failures.push(`${container.name}: its State is not JSON`);
      continue;
    }
    if (state.Running !== true) {
      failures.push(`${container.name}: not running (${String(state.Status ?? 'unknown')})`);
      continue;
    }
    // The writer has no healthcheck on purpose: an idle lane writes nothing for 15 minutes.
    if (container.health && state.Health?.Status !== 'healthy') {
      failures.push(`${container.name}: health ${String(state.Health?.Status ?? 'missing')} (expected healthy)`);
    }
  }

  const images = [];
  for (const container of containers) {
    const answer = await dockerCall(ctx.docker, ['inspect', '--format', '{{.Image}}', container.name], failures, `docker inspect ${container.name} image`);
    if (answer !== null && answer.stdout.trim().length > 0) images.push(answer.stdout.trim());
  }
  const distinct = new Set(images);
  if (distinct.size > 1) failures.push(`the containers run ${String(distinct.size)} different images (${[...distinct].map(shortId).join(' · ')})`);

  const site = containers[0].name;
  const labelAnswer = await dockerCall(ctx.docker, ['inspect', '--format', '{{index .Config.Labels "book.commit"}}', site], failures, `docker inspect ${site} book.commit`);
  const labelCommit = labelAnswer === null ? null : labelAnswer.stdout.trim();
  const infoAnswer = await dockerCall(ctx.docker, ['exec', site, 'cat', '/app/build-info.json'], failures, `docker exec ${site} cat /app/build-info.json`);
  const imageCommit = infoAnswer === null ? null : (parseJson(infoAnswer.stdout)?.commit ?? null);
  if (labelAnswer !== null && (labelCommit === '' || labelCommit === '<no value>')) {
    failures.push('the image carries no book.commit label (it was built without BOOK_BUILD_COMMIT)');
  }
  if (infoAnswer !== null && typeof imageCommit !== 'string') failures.push('the image has no readable /app/build-info.json commit');
  if (ctx.health.ok !== true) failures.push(`GET /healthz: ${ctx.health.reason}`);
  const commit = ctx.health.ok === true ? ctx.health.commit : null;
  if (commit !== null) {
    if (typeof imageCommit === 'string' && imageCommit !== commit) failures.push(`build-info commit ${imageCommit} ≠ /healthz ${commit}`);
    if (labelCommit !== null && labelCommit !== '' && labelCommit !== '<no value>' && labelCommit !== commit) {
      failures.push(`label book.commit ${labelCommit} ≠ /healthz ${commit}`);
    }
  }

  const mountAnswer = await dockerCall(ctx.docker, ['exec', site, 'cat', '/proc/self/mountinfo'], failures, `docker exec ${site} cat /proc/self/mountinfo`);
  let mount = null;
  if (mountAnswer !== null) {
    // Every `/data` line is judged: a bind stacked over a volume appears later in mount order,
    // and a check that read only the first line would vouch for a mount nobody sees.
    const mounts = parseMountInfos(mountAnswer.stdout, '/data');
    if (mounts.length === 0) failures.push('no /data line in /proc/self/mountinfo');
    for (const line of mounts) {
      const judged = judgeVolume(line, { hostDataDir: ctx.hostDataDir });
      if (!judged.ok) failures.push(judged.reason);
    }
    mount = mounts.length === 0 ? null : mounts[mounts.length - 1];
  }

  const evidence = [
    commit ?? (typeof imageCommit === 'string' ? imageCommit : (labelCommit ?? 'unknown commit')),
    images.length > 0 ? `image ${shortId(images[0])}` : 'image unknown',
    mount === null ? 'volume unknown' : `volume ${mount.root} (${mount.fstype})`,
  ].join(' · ');
  return { verdict: failures.length === 0 ? 'pass' : 'fail', evidence: failures.length === 0 ? evidence : failures[0], failures };
}

/** 7 — the newest dump is younger than a day and opens; the drill ran and said ok. */
export async function checkBackups(ctx) {
  const failures = [];
  const host = newestHostDump(ctx.backupRoot);
  const volume = ctx.payload?.dumps?.preMigration ?? null;
  const candidates = [];
  if (host !== null) candidates.push({ file: host.file, mtimeMs: host.mtimeMs, integrity: null });
  if (volume !== null && Number.isFinite(Number(volume.mtimeMs))) {
    candidates.push({ file: String(volume.file), mtimeMs: Number(volume.mtimeMs), integrity: String(volume.integrity ?? 'unknown') });
  }
  const newest = candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0] ?? null;

  let age = null;
  let integrity = 'none';
  if (newest === null) {
    failures.push(`no backup found: ${join(ctx.backupRoot, 'daily', '*', 'book.db')} and no pre-migration dump in the volume`);
  } else {
    age = Math.max(0, ctx.now - newest.mtimeMs);
    if (age >= DAY_MS) failures.push(`${newest.file} is ${ageOfMs(age)} old (limit ${String(DAY_MS / 3_600_000)}h)`);
    if (newest.integrity !== null) {
      integrity = newest.integrity;
    } else {
      // Opened read-only: the dump is a copy, and this is the only way to know it opens.
      try {
        const db = await ctx.openReadonly(newest.file);
        try {
          integrity = String(db.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown');
        } finally {
          db.close();
        }
      } catch (error) {
        integrity = `unreadable: ${reasonOf(error)}`;
      }
    }
    if (integrity !== 'ok') failures.push(`${newest.file} integrity ${integrity}`);
  }

  // BOOK-188 says `<repoRoot>/deploy/restore-drill.sh`; in this repository the scripts live in
  // `site/deploy/`, so a repo root (or `site/` itself) is answered by one of the two paths.
  // A root that is not there at all is named first: every path under it would be a miss.
  if (ctx.repoError !== null) failures.push(ctx.repoError);
  else if (!drillScriptUnder(ctx.repoRoot).some((path) => existsSync(path))) {
    failures.push(`no restore drill under ${ctx.repoRoot}: deploy/restore-drill.sh or site/deploy/restore-drill.sh`);
  }
  let drillPart = 'drill unknown';
  let log = null;
  try {
    log = readTail(ctx.drillLog);
  } catch {
    failures.push(`no drill log at ${ctx.drillLog}`);
  }
  if (log !== null) {
    const line = newestJobLine(log, 'book-backup-drill');
    if (line === null) {
      failures.push(`no job=book-backup-drill line in ${ctx.drillLog}`);
    } else {
      const status = /status=(\S+)/u.exec(line)?.[1] ?? 'unknown';
      const at = /^\d{4}-\d\d-\d\dT[\d:.]+Z/u.exec(line)?.[0] ?? null;
      if (status !== 'ok') failures.push(`${ctx.drillLog}: the newest drill line has status=${status}`);
      const ranAt = at === null ? Number.NaN : Date.parse(at);
      drillPart = `drill last run ${at ?? 'at an unknown time'}${Number.isFinite(ranAt) ? ` (${ageOfMs(ctx.now - ranAt)} ago)` : ''} status=${status}`;
    }
  }

  const evidence = `${newest?.file ?? 'no backup'} ${age === null ? '?' : ageOfMs(age)} integrity ${integrity} · ${drillPart}`;
  return { verdict: failures.length === 0 ? 'pass' : 'fail', evidence: failures.length === 0 ? evidence : failures[0], failures };
}
