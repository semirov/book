#!/usr/bin/env node
/**
 * bin/admin.mjs — the operator's commands (BOOK-113, BOOK-137).
 *
 *   node bin/admin.mjs budget reset --identity <id|display-name|alias>
 *   node bin/admin.mjs budget exempt <id|display-name|alias> on|off
 *   node bin/admin.mjs reset book [--dry-run | --yes] [--backup-ok] [--url <url>]
 *   node bin/admin.mjs pass start --chapter <n> [--url <url>]
 *   node bin/admin.mjs doctor [--json] [--url <url>]
 *
 * Why a CLI: the owner has to see the effect of a change *now*, while the product's rule is
 * one edit a day. The budget commands change budget state (the `rate_events` rows, the
 * exemption flag), never the book — the site still has no write API for `manuscript/` (§13.1).
 *
 * `reset book` (BOOK-137) empties the book's content and progress before a launch. It is an
 * HTTP client like the budget commands: the wipe runs inside the running server, so one
 * process owns the database. Without a flag it is a dry run — the table of counts is the
 * answer, and nothing is written; `--yes` performs it. A dry run also names the two things
 * that would make the wipe refuse: chapter files the manuscript still holds (`MANUSCRIPT_WRITTEN`
 * — a boot scan would restore them; engine-written chapters are untracked, so the remedy is
 * `git clean -fd manuscript/`) and a live engine (`ENGINE_BUSY`).
 *
 * Token: `ADMIN_TOKEN`, else the file at `ADMIN_TOKEN_FILE` when it is set (a declared file
 * that is missing, unreadable or empty is an error, never a silent fallback), else
 * `<DATA_DIR>/admin.token`, else `site/.data/admin.token`. Only the path is printed, never a
 * value.
 *
 * Target: `--url` or `BOOK_ADMIN_URL`, default `http://127.0.0.1:8091`. A non-local target is
 * refused, because this tool speaks with the admin token: loopback is the rule, plus this
 * machine's own interface addresses — production binds `HOST=192.168.1.76`, so loopback is
 * not the only local address there.
 *
 * Exit codes: 0 done · 2 usage/config/target · 5 the server refused — that is the budget
 * contract, and it stays. `reset book` refines it, because an operator has to tell «no token»
 * from «this target is not mine» from «the backup failed»:
 *   0 done · 2 usage · 3 no admin token · 4 non-local target
 *   5 the server refused (`MANUSCRIPT_WRITTEN`, `FRAME_MISSING`, `FRAME_NOT_BASIS`,
 *     `ENGINE_BUSY`, 401, `INVALID`, …)
 *   6 DATA_DIR is inside the checkout · 7 the backup failed and `--backup-ok` was not given
 *
 * Node builtins only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'http://127.0.0.1:8091';
import { parseDoctorArgs, printDoctorReport, runDoctor } from './adminDoctor.mjs';
import { parsePassArgs, runPassStart } from './adminPass.mjs';
import { post } from './adminPost.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const USAGE = `usage:
  node bin/admin.mjs budget reset --identity <id|display-name|alias>
  node bin/admin.mjs budget exempt <id|display-name|alias> on|off
  node bin/admin.mjs reset book [--dry-run | --yes] [--backup-ok] [--url <url>]
  node bin/admin.mjs pass start --chapter <n> [--url <url>]
  node bin/admin.mjs doctor [--json] [--url <url>]

flags:
  --chapter <n>        pass start: which chapter to open now (1..the book's last)
  --identity <value>   budget: who (also accepted positionally)
  --yes                reset book: perform the wipe (without it the command is a dry run)
  --dry-run            reset book: counts only; the default, and refused together with --yes
  --backup-ok          reset book: wipe even when the backup could not be taken and verified
  --json               doctor: the report as one JSON object, for a driver; no table
  --url <url>          target; default BOOK_ADMIN_URL or ${DEFAULT_URL}
                       must be loopback or one of this machine's own addresses
  --help               this text

token: ADMIN_TOKEN, else the file at ADMIN_TOKEN_FILE (when set), else <DATA_DIR>/admin.token,
       else site/.data/admin.token (the path is named, the value never printed)
exit: 0 done · 2 usage or config · 3 no admin token · 4 non-local target
      5 the server refused the command (MANUSCRIPT_WRITTEN, FRAME_MISSING, FRAME_NOT_BASIS,
        ENGINE_BUSY, INVALID, a refused token)
        PASS_RUNNING, INVALID_CHAPTER, ENGINE_UNREACHABLE)
      6 DATA_DIR inside the checkout · 7 the backup failed and --backup-ok was not given
      (budget keeps 0/2/5)
doctor (BOOK-188) — read-only, writes nothing; exit 0 ready · 1 not ready (the table names it)
      the doctor itself keeps 2 usage · 3 no admin token · 4 non-local target`;

/** `node:os` addresses, minus the zone suffix (`fe80::1%en0`). */
export function localAddresses() {
  const found = new Set();
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) found.add(entry.address.split('%')[0]);
  }
  return found;
}

/**
 * The rule the CLI enforces: the admin token never leaves this machine. A URL whose host is
 * loopback or one of this machine's own interfaces is local; anything else is refused.
 */
export function assertLocalTarget(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`refusing a non-HTTP target: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[/u, '').replace(/\]$/u, '');
  if (LOOPBACK.has(host) || localAddresses().has(host)) return url;
  throw new Error(`refusing a non-local target: ${host} is not loopback and not one of this machine's addresses`);
}

/** `--url <value>` / `--url=<value>`: one reader for both commands. */
function urlArg(arg, args, index) {
  const inline = /^--url=(.*)$/u.exec(arg);
  if (inline !== null) return { url: inline[1], spent: 0 };
  if (arg !== '--url') return null;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) throw new Error('flag --url needs a value');
  return { url: value, spent: 1 };
}

/**
 * The two documented forms and nothing else. Throws on junk; the caller exits 2 with the
 * message and the usage.
 */
export function parseBudgetArgs(argv) {
  const args = [...argv];
  const first = args[0];
  if (first === undefined) throw new Error('no command given');
  if (first === '--help' || first === '-h' || first === 'help') return { kind: 'help' };
  if (first !== 'budget') throw new Error(`unknown command: ${first}`);

  const command = args[1];
  if (command === '--help' || command === '-h') return { kind: 'help' };
  if (command !== 'reset' && command !== 'exempt') throw new Error(`unknown budget command: ${String(command)}`);

  const positional = [];
  let identity = null;
  let url = null;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    const flag = /^--identity=(.*)$/u.exec(arg);
    if (flag !== null) {
      identity = flag[1];
      continue;
    }
    const target = urlArg(arg, args, index);
    if (target !== null) {
      url = target.url;
      index += target.spent;
      continue;
    }
    if (arg === '--identity') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`flag ${arg} needs a value`);
      identity = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    positional.push(arg);
  }

  const who = identity ?? positional.shift() ?? null;
  if (who === null || who.trim().length === 0) throw new Error('who? give an id, a display name or a 12-hex alias');
  if (positional.length > (command === 'exempt' ? 1 : 0)) throw new Error(`unexpected argument: ${positional[0]}`);

  if (command === 'reset') {
    return { kind: 'reset', identity: who.trim(), ...(url === null ? {} : { url }) };
  }

  const onOff = positional.shift() ?? null;
  if (onOff !== 'on' && onOff !== 'off') throw new Error('the second argument must be on or off');
  return { kind: 'exempt', identity: who.trim(), exempt: onOff === 'on', ...(url === null ? {} : { url }) };
}

/**
 * `reset book`. No flag is a dry run; `--yes` is the only way to write. `--yes --dry-run` and
 * `--backup-ok` without `--yes` are contradictions, and a contradiction is a usage error, not
 * the safer half.
 */
export function parseResetArgs(argv) {
  const args = [...argv];
  if (args[0] !== 'reset') throw new Error(`unknown command: ${String(args[0])}`);
  if (args[1] === '--help' || args[1] === '-h') return { kind: 'help' };
  const target = args[1];
  if (target === undefined) throw new Error('reset what? the only target is book');
  if (target !== 'book') throw new Error(`unknown reset target: ${target} (the only target is book)`);

  let yes = false;
  let dryRun = false;
  let backupOk = false;
  let url = null;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--yes') {
      yes = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--backup-ok') {
      backupOk = true;
      continue;
    }
    const found = urlArg(arg, args, index);
    if (found !== null) {
      url = found.url;
      index += found.spent;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    throw new Error(`unexpected argument: ${arg}`);
  }
  if (yes && dryRun) throw new Error('--yes and --dry-run contradict each other');
  if (backupOk && !yes) throw new Error('--backup-ok only means something together with --yes');
  return { kind: 'reset-book', dryRun: !yes, backupOk, ...(url === null ? {} : { url }) };
}


/** The one command parser: `--help`, the two budget forms, the reset, the pass trigger, the doctor. */
export function parseCommand(argv) {
  const first = argv[0];
  if (first === undefined) throw new Error('no command given');
  if (first === '--help' || first === '-h' || first === 'help') return { kind: 'help' };
  if (first === 'budget') return parseBudgetArgs(argv);
  if (first === 'reset') return parseResetArgs(argv);
  if (first === 'pass') return parsePassArgs(argv);
  if (first === 'doctor') return parseDoctorArgs(argv);
  throw new Error(`unknown command: ${first}`);
}

/**
 * The token, or a message naming where it was looked for — never a value.
 *
 * `ADMIN_TOKEN_FILE` is a declaration, not a hint: when it is set, that file is the only one
 * this command reads, and a missing, unreadable or empty file is an error naming the variable
 * and the path. Silently falling back to `<DATA_DIR>/admin.token` is how a command runs with a
 * token the operator did not choose.
 */
export function resolveAdminToken(env = process.env) {
  const inline = (env.ADMIN_TOKEN ?? '').trim();
  if (inline.length > 0) return inline;
  const file = (env.ADMIN_TOKEN_FILE ?? '').trim();
  if (file.length > 0) {
    let value;
    try {
      value = readFileSync(file, 'utf8').trim();
    } catch (error) {
      const code = error.code ?? 'unreadable';
      throw new Error(`cannot read ADMIN_TOKEN_FILE (${file}): ${code}`);
    }
    if (value.length === 0) throw new Error(`ADMIN_TOKEN_FILE (${file}) is empty`);
    return value;
  }
  const candidates = [];
  const dataDir = (env.DATA_DIR ?? '').trim();
  if (dataDir.length > 0) candidates.push({ label: '<DATA_DIR>/admin.token', path: join(dataDir, 'admin.token') });
  candidates.push({ label: 'site/.data/admin.token', path: join(SITE_ROOT, '.data', 'admin.token') });
  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    try {
      const value = readFileSync(candidate.path, 'utf8').trim();
      if (value.length > 0) return value;
    } catch {
      // Unreadable: try the next documented place, then report the list.
    }
  }
  throw new Error(
    'no admin token found: set ADMIN_TOKEN, or make ADMIN_TOKEN_FILE / ' +
      '<DATA_DIR>/admin.token / site/.data/admin.token readable',
  );
}

function requestBody(parsed) {
  if (parsed.kind === 'reset') return { identity: parsed.identity };
  return { identity: parsed.identity, exempt: parsed.exempt };
}

function printBudgetResult(parsed, body) {
  const identity = body.identity ?? {};
  const name = `«${identity.displayName ?? ''}»`;
  if (parsed.kind === 'reset') {
    const removed = body.removed ?? {};
    console.log(`identity ${identity.id ?? '?'} ${name}`);
    console.log(`removed edit:id ${removed.editId ?? 0} · edit:ip ${removed.editIp ?? 0} · cmt:id ${removed.commentId ?? 0}`);
    return;
  }
  console.log(`identity ${identity.id ?? '?'} ${name} · edit_exempt ${body.previous ?? 0} → ${body.current ?? 0}`);
}

/**
 * The reset answer as the operator reads it: one line per counter, the total, what survived,
 * and what happened to the backup. Counts only — the server never sends a row and this printer
 * never asks for one.
 */
function printResetResult(body) {
  const dryRun = body.dryRun !== false;
  console.log(dryRun ? 'reset book — dry run, nothing is written' : 'reset book — done');
  const tables = Array.isArray(body.tables) ? body.tables : [];
  const suffix = dryRun ? '' : ' rows removed';
  for (const entry of tables) {
    console.log(`  ${entry.label ?? entry.key ?? '?'}  ${entry.rows ?? 0}${suffix}`);
  }
  console.log(`  ${tables.length} entries, ${body.total ?? 0} rows${dryRun ? '' : ' removed'}`);
  const kept = Array.isArray(body.kept) ? body.kept : [];
  console.log(`kept: ${kept.map((entry) => `${entry.key} ${entry.rows ?? 0}`).join(' · ')}`);
  console.log('frame: ch01, ch42 re-read from the manuscript');
  if (dryRun) {
    // The two refusals a dry run can see coming. They are the operator's next action, and both
    // are invisible in the counts — a manuscript file is not a row, and a live engine refuses
    // the wipe rather than being reset under.
    const prose = body.manuscript?.proseChapters ?? 0;
    if (prose > 0) {
      console.log(
        `manuscript: ${prose} chapter files hold prose — a boot scan would restore them; clear manuscript/ first`,
      );
    }
    const openSteps = body.engine?.openSteps ?? 0;
    const liveLeases = body.engine?.liveLeases ?? 0;
    if (openSteps > 0 || liveLeases > 0) {
      console.log(`engine: ${openSteps} open step(s) · ${liveLeases} live lease(s) — a wipe would be refused`);
    }
    return;
  }
  const backup = body.backup ?? null;
  if (backup !== null) {
    console.log(`backup: ${backup.file} (${backup.mode}, integrity ${backup.integrity}, counts match)`);
  } else if (typeof body.backupSkipped === 'string') {
    console.log(`backup: skipped (${body.backupSkipped})`);
  } else {
    console.log('backup: none (backupOk was given)');
  }
  // BOOK-137: the server's own warning is the operator's business — «no backup» and a bridge
  // that could not be re-primed are invisible in the counts, and a silent one is a lie.
  if (typeof body.warning === 'string' && body.warning.length > 0) console.log(`warning: ${body.warning}`);
}

/** The one request both commands make: JSON in, JSON out, both halves of a refusal visible. */
async function runBudget(parsed, target, token) {
  const path = `/api/admin/budget/${parsed.kind === 'reset' ? 'reset' : 'exempt'}`;
  const result = await post(target, path, token, requestBody(parsed));
  if ('error' in result) {
    console.error(result.error);
    return 5;
  }
  const { response, body } = result;
  if (!response.ok) {
    if (response.status === 401) {
      console.error('admin: the token was refused — check ADMIN_TOKEN or the token file (the value is not printed)');
      return 5;
    }
    const code = body?.code ?? `HTTP_${String(response.status)}`;
    const message = body?.message ?? 'no message';
    const candidates = Array.isArray(body?.candidates)
      ? ` (${body.candidates.map((entry) => `${entry.id} «${entry.displayName}»`).join(' · ')})`
      : '';
    console.error(`admin: ${code}: ${message}${candidates}`);
    return 5;
  }
  if (body === null) {
    console.error('admin: the server answered with something that is not JSON');
    return 5;
  }
  printBudgetResult(parsed, body);
  return 0;
}

async function runReset(parsed, target, token) {
  const result = await post(target, '/api/admin/reset/book', token, {
    dryRun: parsed.dryRun,
    backupOk: parsed.backupOk,
  });
  if ('error' in result) {
    console.error(result.error);
    return 5;
  }
  const { response, body } = result;
  if (!response.ok) {
    if (response.status === 401) {
      console.error('admin: the token was refused — check ADMIN_TOKEN or the token file (the value is not printed)');
      return 5;
    }
    const code = body?.code ?? `HTTP_${String(response.status)}`;
    const message = body?.message ?? 'no message';
    const names = Array.isArray(body?.files) ? ` (${body.files.join(', ')})` : '';
    const detail =
      code === 'ENGINE_BUSY'
        ? ` (open steps ${body?.openSteps ?? '?'} · live leases ${body?.liveLeases ?? '?'})`
        : names;
    console.error(`admin: ${code}: ${message}${detail}`);
    if (code === 'DATA_DIR_IN_REPO') return 6;
    if (code === 'BACKUP_FAILED') return parsed.backupOk ? 5 : 7;
    return 5;
  }
  if (body === null) {
    console.error('admin: the server answered with something that is not JSON');
    return 5;
  }
  printResetResult(body);
  return 0;
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseCommand(argv);
  } catch (error) {
    console.error(`admin: ${error.message}`);
    console.error(USAGE);
    return 2;
  }
  if (parsed.kind === 'help') {
    console.log(USAGE);
    return 0;
  }

  // BOOK-137/BOOK-188: the reset and the doctor distinguish «no token» (3) from «not my
  // machine» (4); the budget contract keeps one code (2) for both, and that stays as it was.
  const guarded = parsed.kind === 'reset-book' || parsed.kind === 'pass-start' || parsed.kind === 'doctor';
  let target;
  try {
    target = assertLocalTarget(parsed.url ?? process.env.BOOK_ADMIN_URL ?? DEFAULT_URL);
  } catch (error) {
    console.error(`admin: ${error.message}`);
    return guarded ? 4 : 2;
  }
  let token;
  try {
    token = resolveAdminToken();
  } catch (error) {
    console.error(`admin: ${error.message}`);
    return guarded ? 3 : 2;
  }

  if (parsed.kind === 'pass-start') return runPassStart(parsed, target, token);
  // BOOK-188: the doctor answers with a report, not a refusal — `--json` prints it either way,
  // because the driver reads stdout and the exit code, never the table.
  if (parsed.kind === 'doctor') {
    const report = await runDoctor({ target, token });
    printDoctorReport(report, { json: parsed.json === true });
    return report.exitCode;
  }
  return parsed.kind === 'reset-book' ? runReset(parsed, target, token) : runBudget(parsed, target, token);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
