/**
 * bin/adminDoctor.mjs — BOOK-188: `node bin/admin.mjs doctor [--json] [--url <url>]`.
 *
 * One command the owner runs before saying «скидываем»: eight one-line verdicts with evidence
 * (a path, a count or a digest — never a secret), exit 0 when the machine is ready to be reset
 * and opened, 1 when it is not, and the table names what is not.
 *
 * Half of the facts are the running stack's and half are this host's, so the doctor cannot live
 * in either place alone:
 *
 *   - the stack's facts arrive through the admin token (`GET /api/admin/doctor`, and the reset
 *     dry run) — this CLI never opens `book.db` itself (BOOK-183: two kernels in WAL);
 *   - the host's facts are read here and in `adminDoctorHost.mjs`: docker, the container's
 *     `/proc/self/mountinfo`, the working tree, the host backups and the drill log, `git ls-files`.
 *
 * Read-only by construction: `docker inspect`/`exec cat`, `fetch`, and sqlite opened
 * `{readonly: true, fileMustExist: true}`. Nothing is created, nothing is written, no state is
 * healed — a failed preflight stops the launch, it does not retry.
 *
 * Exit codes (the caller owns them): 0 ready · 1 not ready · 2 usage · 3 no admin token ·
 * 4 non-local target. A `not shipped` row (stage 3 absent) is a warning and never fails a run.
 */

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, OPENING_CHAPTER, TOTAL_CHAPTERS } from '../shared/src/book.ts';
import {
  ageOfMs,
  callJson,
  checkBackups,
  checkRuntime,
  execDocker,
  execGitLsFiles,
  manuscriptProse,
  oneLine,
  openReadonlyDefault,
  reasonOf,
  sha256,
} from './adminDoctorHost.mjs';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** BOOK-185: the ancestors closure has to answer faster than a reader blinks. */
const CLOSURE_LIMIT_MS = 50;

/** The eight rows, their fixed order and the words the table prints. */
const LABELS = {
  runtime: 'runtime',
  schema: 'schema',
  db_home: 'data dir is the home',
  frame: 'frame',
  reset_dry_run: 'reset dry-run',
  graph: 'graph',
  backups: 'backups',
  git_prose: 'no prose in git',
};

/** `doctor [--json] [--url <url>]` — and nothing else. Junk throws; the caller exits 2. */
export function parseDoctorArgs(argv) {
  const args = [...argv];
  if (args[0] !== 'doctor') throw new Error(`unknown command: ${String(args[0])}`);
  let json = false;
  let url = null;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--json') {
      json = true;
      continue;
    }
    const inline = /^--url=(.*)$/u.exec(arg);
    if (inline !== null) {
      if (inline[1].length === 0) throw new Error('flag --url needs a value');
      url = inline[1];
      continue;
    }
    if (arg === '--url') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error('flag --url needs a value');
      url = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    throw new Error(`unexpected argument: ${arg}`);
  }
  return { kind: 'doctor', json, ...(url === null ? {} : { url }) };
}

/* ------------------------------------------------------------------------- the checks -- */

function payloadMissing(ctx, what) {
  const reason = ctx.payloadError ?? 'the doctor route did not answer';
  return { verdict: 'fail', evidence: reason, failures: [`${what}: ${reason}`] };
}

/** 2 — the DB's `user_version` is this image's, and a pre-migration dump opens. */
function checkSchema(ctx) {
  if (ctx.payload === null) return payloadMissing(ctx, 'schema');
  const failures = [];
  const userVersion = ctx.payload.schema?.userVersion;
  const expected = ctx.payload.schema?.expected;
  if (!Number.isInteger(userVersion) || !Number.isInteger(expected)) {
    failures.push('the doctor answer carries no schema version');
  } else if (userVersion > expected) {
    failures.push(`SCHEMA_FUTURE: the DB is at v${String(userVersion)}, this image expects v${String(expected)}`);
  } else if (userVersion < expected) {
    failures.push(`migration pending v${String(userVersion)} → v${String(expected)}`);
  }
  const dump = ctx.payload.dumps?.preMigration ?? null;
  if (dump === null) failures.push('no pre-migration dump in the volume (backups/pre-v*.db)');
  else if (dump.integrity !== 'ok') failures.push(`pre-migration dump ${String(dump.file)} integrity ${String(dump.integrity)}`);

  const evidence = [
    Number.isInteger(userVersion) && Number.isInteger(expected) ? `v${String(userVersion)} = build v${String(expected)}` : 'no schema version',
    dump === null
      ? 'no pre-migration dump'
      : `dump pre-v${String(dump.userVersion ?? '?')} ${ageOfMs(ctx.now - Number(dump.mtimeMs))} ago integrity ${String(dump.integrity)}`,
  ].join(' · ');
  return { verdict: failures.length === 0 ? 'pass' : 'fail', evidence: failures.length === 0 ? evidence : failures[0], failures };
}

/** 3 — the data dir is the home: no writer's state, no stray entry, no prose in the tree. */
function checkDbHome(ctx) {
  if (ctx.payload === null) return payloadMissing(ctx, 'db_home');
  const dataDir = ctx.payload.dataDir ?? null;
  // An absent section is not a clean data dir: a check that cannot see the answer must not pass.
  if (dataDir === null || typeof dataDir !== 'object') {
    const reason = 'the doctor answer carries no data dir section';
    return { verdict: 'fail', evidence: reason, failures: [reason] };
  }
  const denied = dataDir.denied;
  const stray = dataDir.stray;
  if (!Array.isArray(denied) || !Array.isArray(stray)) {
    const reason = 'the data dir answer carries no denied/stray lists';
    return { verdict: 'fail', evidence: reason, failures: [reason] };
  }
  const failures = [];
  for (const path of denied) failures.push(`the data dir holds ${String(path)} — the engine's state has no home here`);
  for (const path of stray) failures.push(`the data dir has a stray entry ${String(path)} — not on the allow-list`);

  const prose = manuscriptProse(ctx.repoRoot);
  for (const name of prose) failures.push(`manuscript/${name} holds prose — a boot scan would put it back`);

  const dataPart =
    denied.length === 0 && stray.length === 0
      ? 'data dir clean'
      : `data dir: ${String(denied.length)} denied, ${String(stray.length)} stray`;
  const prosePart = prose.length === 0 ? 'manuscript/ no prose' : `manuscript/ ${String(prose.length)} file(s) hold prose`;
  const evidence = `${dataPart} · ${prosePart}`;
  return { verdict: failures.length === 0 ? 'pass' : 'fail', evidence: failures.length === 0 ? evidence : failures[0], failures };
}

/** 4 — the frozen frame: baked constant ↔ DB row (sha256) ↔ the served text. */
async function checkFrame(ctx) {
  if (ctx.payload === null) return payloadMissing(ctx, 'frame');
  const failures = [];
  const baked = [
    { chapter: OPENING_CHAPTER, position: 'first', sentence: FRAME_FIRST_SENTENCE },
    { chapter: TOTAL_CHAPTERS, position: 'last', sentence: FRAME_LAST_SENTENCE },
  ];
  const rows = Array.isArray(ctx.payload.frame?.rows) ? ctx.payload.frame.rows : [];
  const digests = [];
  for (const item of baked) {
    const name = `ch${String(item.chapter).padStart(2, '0')}/${item.position}`;
    const expected = sha256(item.sentence);
    digests.push(expected.slice(0, 8));
    const row = rows.find((entry) => Number(entry?.chapter) === item.chapter && entry?.position === item.position) ?? null;
    if (row === null) {
      failures.push(`frame ${name}: no row in the DB`);
      continue;
    }
    if (String(row.sha256 ?? '') !== expected) {
      failures.push(`frame ${name}: the DB sha ${String(row.sha256 ?? 'none').slice(0, 8)} ≠ baked ${expected.slice(0, 8)}`);
    }
  }

  let served = false;
  try {
    const { checkServer } = await import('../scripts/lib/frame.mjs');
    const answers = await checkServer({ baseUrl: String(ctx.target), fetchImpl: ctx.fetchImpl });
    for (const answer of answers) {
      if (answer.ok === true) continue;
      const part = Array.isArray(answer.parts) ? answer.parts[0] : null;
      failures.push(`${answer.label}: ${oneLine(part?.actual ?? 'no answer', 60)}`);
    }
    served = answers.length > 0 && answers.every((answer) => answer.ok === true);
  } catch (error) {
    failures.push(`the served frame could not be read: ${reasonOf(error)}`);
  }

  const evidence = `ch01 ${digests[0] ?? '?'} · ch${String(TOTAL_CHAPTERS)} ${digests[1] ?? '?'} · served ${served ? 'ok' : 'mismatch'}`;
  return { verdict: failures.length === 0 ? 'pass' : 'fail', evidence: failures.length === 0 ? evidence : failures[0], failures };
}

/** 5 — the reset's dry run: counts only, their total, the keep-list, both tokens. */
async function checkReset(ctx) {
  const failures = [];
  const answer = await callJson({
    fetchImpl: ctx.fetchImpl,
    url: new URL('/api/admin/reset/book', ctx.target),
    token: ctx.token,
    method: 'POST',
    body: { dryRun: true },
  });
  const body = answer.body ?? null;
  if (answer.error !== undefined) {
    failures.push(`POST /api/admin/reset/book: ${answer.error}`);
  } else if (answer.ok !== true) {
    const code = typeof body?.code === 'string' ? ` ${body.code}` : '';
    failures.push(`POST /api/admin/reset/book answered ${String(answer.status)}${code}`);
  } else if (body === null) {
    failures.push('POST /api/admin/reset/book answered something that is not JSON');
  }

  const tables = Array.isArray(body?.tables) ? body.tables : [];
  const total = typeof body?.total === 'number' ? body.total : null;
  if (body !== null && total === null) failures.push('the dry run carries no total');
  if (body !== null && total !== null) {
    const sum = tables.reduce((carry, entry) => carry + (Number(entry?.rows) || 0), 0);
    if (sum !== total) failures.push(`the dry run's total ${String(total)} ≠ the sum of its counters ${String(sum)}`);
  }
  const kept = Array.isArray(body?.kept) ? body.kept : [];
  const keptRows = (key) => {
    const entry = kept.find((item) => item?.key === key) ?? null;
    return entry === null ? null : Number(entry.rows ?? 0);
  };
  const identities = keptRows('identities');
  const frontMatter = keptRows('front_matter');
  if (identities === null) failures.push('the keep-list has no identities');
  if (frontMatter === null) failures.push('the keep-list has no front_matter');

  const tokens = ctx.payload?.dataDir?.tokens ?? null;
  const missing = [];
  if (tokens === null) failures.push('the doctor answer carries no data dir token flags');
  else {
    if (tokens.admin !== true) missing.push('admin');
    if (tokens.engine !== true) missing.push('engine');
    if (missing.length > 0) failures.push(`the data dir has no ${missing.join(' or ')} token`);
  }

  const evidence =
    `${String(tables.length)} counters · ${String(total ?? 0)} rows · ` +
    `kept identities ${String(identities ?? 'missing')} · front_matter ${String(frontMatter ?? 'missing')} · tokens ${missing.length === 0 ? 'admin+engine' : `missing ${missing.join(',')}`}`;
  return { verdict: failures.length === 0 ? 'pass' : 'fail', evidence: failures.length === 0 ? evidence : failures[0], failures };
}

/** 6 — the graph is populated, or stage 3 is not in this image (a warning, never a failure). */
function checkGraph(ctx) {
  if (ctx.payload === null) return payloadMissing(ctx, 'graph');
  const graph = ctx.payload.graph ?? null;
  if (graph === null) {
    return { verdict: 'fail', evidence: 'the doctor answer carries no graph section', failures: ['the doctor answer carries no graph section'] };
  }
  if (graph.shipped !== true) {
    return { verdict: 'not_shipped', evidence: 'fact_dependency absent — stage 3 not in this image (warning)', failures: [] };
  }
  const failures = [];
  for (const label of ['facts', 'threads', 'edges']) {
    const value = Number(graph[label]);
    if (!Number.isFinite(value) || value <= 0) failures.push(`the graph has no ${label} (${String(graph[label] ?? 0)})`);
  }
  const closureMs = graph.closureMs === undefined ? null : graph.closureMs;
  if (closureMs === null || !Number.isFinite(closureMs)) failures.push('the closure was not measured');
  else if (closureMs >= CLOSURE_LIMIT_MS) failures.push(`the closure answers in ${String(Math.round(closureMs))} ms (limit ${String(CLOSURE_LIMIT_MS)} ms)`);

  const evidence = `facts ${String(graph.facts)} · threads ${String(graph.threads)} · edges ${String(graph.edges)} · closure ${String(closureMs ?? '?')} ms`;
  return { verdict: failures.length === 0 ? 'pass' : 'fail', evidence: failures.length === 0 ? evidence : failures[0], failures };
}

/** 8 — no prose is tracked by git; a host without a checkout has nothing to track. */
async function checkGitProse(ctx) {
  const tracked = await ctx.gitLsFiles(ctx.repoRoot);
  if (tracked === null) return { verdict: 'pass', evidence: 'no git checkout — nothing tracked', failures: [] };
  if (tracked.length === 0) return { verdict: 'pass', evidence: 'no manuscript files tracked', failures: [] };
  const named = tracked.slice(0, 3).join(', ');
  const more = tracked.length > 3 ? ' …' : '';
  return {
    verdict: 'fail',
    evidence: `${String(tracked.length)} tracked: ${named}${more}`,
    failures: [`git tracks ${String(tracked.length)} manuscript file(s): ${named}${more}`],
  };
}

/* ---------------------------------------------------------------------------- the run -- */

const CHECKS = [
  ['runtime', checkRuntime],
  ['schema', checkSchema],
  ['db_home', checkDbHome],
  ['frame', checkFrame],
  ['reset_dry_run', checkReset],
  ['graph', checkGraph],
  ['backups', checkBackups],
  ['git_prose', checkGitProse],
];

/** A check that throws is a failed check with its reason — never a stack trace and no report. */
async function guarded(id, run) {
  try {
    const result = await run();
    return { id, label: LABELS[id], verdict: result.verdict, evidence: result.evidence, failures: result.failures ?? [] };
  } catch (error) {
    return { id, label: LABELS[id], verdict: 'fail', evidence: reasonOf(error), failures: [reasonOf(error)] };
  }
}

/** `/healthz`: `ok:true` and the commit the answering process is. */
async function readHealth({ fetchImpl, target }) {
  const answer = await callJson({ fetchImpl, url: new URL('/healthz', target), token: '' });
  if (answer.error !== undefined) return { ok: false, reason: answer.error };
  if (answer.ok !== true) return { ok: false, reason: `/healthz answered ${String(answer.status)}` };
  if (answer.body?.ok !== true) return { ok: false, reason: '/healthz does not say ok:true' };
  const commit = answer.body?.commit;
  if (typeof commit !== 'string' || commit.length === 0) return { ok: false, reason: '/healthz names no commit' };
  return { ok: true, commit };
}

/**
 * `runDoctor({target, token, …})` — the whole preflight, as a report. `target` and `token` are
 * already resolved by the caller (this module never looks a token up); every other seam has a
 * real default so the CLI calls it with two arguments.
 */
export async function runDoctor(options = {}) {
  const env = process.env;
  const now = (options.now ?? (() => Date.now()))();
  const target = options.target;
  const token = options.token ?? '';
  const repoRoot = options.repoRoot ?? ((env.BOOK_REPO_ROOT ?? '').trim() || resolve(SITE_ROOT, '..'));
  const backupRoot = options.backupRoot ?? ((env.BACKUP_ROOT ?? '').trim() || join(homedir(), 'book-site-backups'));
  const drillLog = options.drillLog ?? ((env.LOG_FILE ?? '').trim() || join(homedir(), 'Library', 'Logs', 'book-backup.log'));

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const answer = await callJson({ fetchImpl, url: new URL('/api/admin/doctor', target), token });
  const payloadError =
    answer.error !== undefined
      ? answer.error
      : answer.status === 401
        ? 'the admin token was refused (401)'
        : answer.ok !== true
          ? `GET /api/admin/doctor answered ${String(answer.status)}`
          : answer.body === null
            ? 'GET /api/admin/doctor answered something that is not JSON'
            : null;

  const ctx = {
    now,
    target,
    token,
    repoRoot,
    backupRoot,
    drillLog,
    fetchImpl,
    project: (env.BOOK_PROJECT ?? '').trim() || 'book',
    hostDataDir: (env.DATA_DIR ?? '').trim(),
    docker: options.docker ?? execDocker,
    gitLsFiles: options.gitLsFiles ?? execGitLsFiles,
    openReadonly: options.openReadonly ?? openReadonlyDefault,
    payload: payloadError === null ? answer.body : null,
    payloadError,
    health: await readHealth({ fetchImpl, target }),
  };

  const checks = [];
  for (const [id, run] of CHECKS) checks.push(await guarded(id, () => run(ctx)));
  const exitCode = checks.some((check) => check.verdict === 'fail') ? 1 : 0;
  return { ok: exitCode === 0, exitCode, at: new Date(now).toISOString(), checks };
}

/* -------------------------------------------------------------------------- the table -- */

function verdictText(verdict) {
  if (verdict === 'not_shipped') return 'not shipped';
  return verdict === 'pass' ? 'pass' : 'fail';
}

function pad(value, width) {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/**
 * The operator's answer: `check | verdict | evidence`, one line per failure, and the verdict of
 * the whole run last. `--json` prints the report and nothing else, so a driver parses stdout.
 */
export function printDoctorReport(report, options = {}) {
  if (options.json === true) {
    console.log(JSON.stringify(report));
    return;
  }
  const rows = report.checks.map((check) => [check.label, verdictText(check.verdict), String(check.evidence ?? '')]);
  const header = ['check', 'verdict', 'evidence'];
  const widths = [0, 1].map((column) => Math.max(header[column].length, ...rows.map((row) => row[column].length)));
  const line = (cells) => `${[pad(cells[0], widths[0]), pad(cells[1], widths[1]), cells[2]].join(' | ')}`.trimEnd();
  console.log(line(header));
  for (const row of rows) console.log(line(row));
  for (const check of report.checks) {
    for (const failure of check.failures ?? []) console.log(`  - ${check.id}: ${failure}`);
  }
  const failed = report.checks.filter((check) => check.verdict === 'fail').length;
  console.log(failed === 0 ? 'ready' : `not ready — ${String(failed)} check(s) failed`);
}

/** The two host readers the tests drive directly: the volume rule and the mountinfo line. */
export { judgeVolume, parseMountInfo } from './adminDoctorHost.mjs';
