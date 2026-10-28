/**
 * BOOK-145: `node bin/admin.mjs pass start --chapter N` — open one pass now and print its id.
 *
 * The owner's trigger («как посмотреть, как книга печатается»): the show starts on demand
 * instead of being waited for. The server refuses when a pass is already running, and the
 * refusal is printed as it came — a command that hides the reason is a support ticket.
 */

import { post } from './adminPost.mjs';

/** `pass start --chapter N [--url <url>]`; the only pass command there is. */
export function parsePassArgs(argv) {
  if (argv[1] !== 'start') throw new Error(`unknown pass command: ${String(argv[1])} (only start)`);
  let chapter = null;
  let url = null;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--chapter') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--chapter needs a number');
      chapter = Number(value);
      i += 1;
      continue;
    }
    if (arg === '--url') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--url needs a value');
      url = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    throw new Error(`unexpected argument: ${arg}`);
  }
  if (chapter === null || !Number.isInteger(chapter) || chapter < 1) {
    throw new Error('pass start needs --chapter <n> (a whole number, 1 or more)');
  }
  return { kind: 'pass-start', chapter, ...(url === null ? {} : { url }) };
}

/** The answer as the operator reads it: the step id, and where to watch it. */
export async function runPassStart(parsed, target, token) {
  const result = await post(target, '/api/admin/pass/start', token, { chapter: parsed.chapter });
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
    console.error(`admin: ${body?.code ?? `HTTP_${String(response.status)}`}: ${body?.message ?? 'no message'}`);
    return 5;
  }
  if (body === null || typeof body.stepId !== 'string') {
    console.error('admin: the server answered without a step id');
    return 5;
  }
  console.log(`pass: глава ${body.chapter ?? parsed.chapter}, шаг ${body.stepId} открыт`);
  console.log(`watch: /api/chapters/${String(body.chapter ?? parsed.chapter)}/stages`);
  return 0;
}
