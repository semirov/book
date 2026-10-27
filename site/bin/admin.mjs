#!/usr/bin/env node
/**
 * bin/admin.mjs — the operator's budget commands (BOOK-113).
 *
 *   node bin/admin.mjs budget reset --identity <id|display-name|alias>
 *   node bin/admin.mjs budget exempt <id|display-name|alias> on|off
 *
 * Why a CLI: the owner has to see the effect of a change *now*, while the product's rule is
 * one edit a day. Both commands change budget state (the `rate_events` rows, the exemption
 * flag), never the book — the site still has no write API for `manuscript/` (§13.1).
 *
 * Token: `ADMIN_TOKEN`, else the file at `ADMIN_TOKEN_FILE`, else `<DATA_DIR>/admin.token`,
 * else `site/.data/admin.token`. Only the path is ever printed, never a value.
 *
 * Target: `--url` or `BOOK_ADMIN_URL`, default `http://127.0.0.1:8091`. A non-local target is
 * refused, because this tool speaks with the admin token: loopback is the rule, plus this
 * machine's own interface addresses — production binds `HOST=192.168.1.76`, so loopback is
 * not the only local address there.
 *
 * Exit codes: 0 done · 2 usage/config/target · 5 the server refused. Node builtins only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'http://127.0.0.1:8091';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const USAGE = `usage:
  node bin/admin.mjs budget reset --identity <id|display-name|alias>
  node bin/admin.mjs budget exempt <id|display-name|alias> on|off

flags:
  --identity <value>   who (also accepted positionally)
  --url <url>          target; default BOOK_ADMIN_URL or ${DEFAULT_URL}
                       must be loopback or one of this machine's own addresses
  --help               this text

token: ADMIN_TOKEN, else the file at ADMIN_TOKEN_FILE, else <DATA_DIR>/admin.token,
       else site/.data/admin.token (the path is named, the value never printed)
exit: 0 done · 2 usage or config · 5 the server refused the command`;

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
    const flag = /^--(identity|url)=(.*)$/u.exec(arg);
    if (flag !== null) {
      if (flag[1] === 'identity') identity = flag[2];
      else url = flag[2];
      continue;
    }
    if (arg === '--identity' || arg === '--url') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`flag ${arg} needs a value`);
      if (arg === '--identity') identity = value;
      else url = value;
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

/** The token, or a message naming where it was looked for — never a value. */
export function resolveAdminToken(env = process.env) {
  const inline = (env.ADMIN_TOKEN ?? '').trim();
  if (inline.length > 0) return inline;
  const candidates = [];
  const file = (env.ADMIN_TOKEN_FILE ?? '').trim();
  if (file.length > 0) candidates.push({ label: 'ADMIN_TOKEN_FILE', path: file });
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
    `no admin token found: set ADMIN_TOKEN, or make ADMIN_TOKEN_FILE (${file || 'unset'}) / ` +
      '<DATA_DIR>/admin.token / site/.data/admin.token readable',
  );
}

function requestBody(parsed) {
  if (parsed.kind === 'reset') return { identity: parsed.identity };
  return { identity: parsed.identity, exempt: parsed.exempt };
}

function printResult(parsed, body) {
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

async function main(argv) {
  let parsed;
  try {
    parsed = parseBudgetArgs(argv);
  } catch (error) {
    console.error(`admin: ${error.message}`);
    console.error(USAGE);
    return 2;
  }
  if (parsed.kind === 'help') {
    console.log(USAGE);
    return 0;
  }

  let target;
  let token;
  try {
    target = assertLocalTarget(parsed.url ?? process.env.BOOK_ADMIN_URL ?? DEFAULT_URL);
    token = resolveAdminToken();
  } catch (error) {
    console.error(`admin: ${error.message}`);
    return 2;
  }

  const url = new URL(`/api/admin/budget/${parsed.kind === 'reset' ? 'reset' : 'exempt'}`, target);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify(requestBody(parsed)),
    });
  } catch (error) {
    console.error(`admin: cannot reach ${url.origin}: ${error.cause?.code ?? error.message}`);
    return 5;
  }

  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

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
  printResult(parsed, body);
  return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
