#!/usr/bin/env node
/**
 * scripts/pwa-smoke.mjs — BOOK-157: an install must be possible, and the worker must be a file.
 *
 * `deploy.sh` runs this inside `finish_green`, before `last-good` is written: `/healthz` and the
 * frozen frame say the book is served, and this says the two surfaces an install reads are
 * served *as what they are*. Both failures it exists for are silent in a browser — a manifest
 * answered as `text/html`, or a `sw.js` a cache may keep past the next release — and neither is
 * visible in a response body.
 *
 *   node scripts/pwa-smoke.mjs --server http://127.0.0.1:8091
 *
 * Exit codes (the contract `deploy.sh` reads, the same three the frame check uses):
 *   0 — both surfaces answered as required
 *   1 — at least one mismatch: a non-200, a wrong content type, an unparseable manifest, or a
 *       `cache-control` that is not `no-cache`
 *   2 — bad usage only (an unknown flag, a flag without a value)
 *
 * It writes nothing and prints what it read — a status and a header, never a body and never a
 * secret: the manifest names the book, which is public by design.
 */

const USAGE = 'usage: node scripts/pwa-smoke.mjs --server <url>';
const TIMEOUT_MS = 10_000;

const VALUE_FLAGS = new Map([
  ['--server', 'server'],
  ['--url', 'server'],
]);

function bail(message) {
  process.stderr.write(`pwa: ${message}\n${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { server: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const key = VALUE_FLAGS.get(name);
    if (key === undefined) bail(`unknown argument: ${arg}`);
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
    options[key] = value;
  }
  if (options.server === null) bail('--server needs a value: the site to check');
  return options;
}

/** One GET, bounded; a transport failure is `{ error }`, never a throw out of the check. */
async function read(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
    return {
      status: response.status,
      contentType: String(response.headers.get('content-type') ?? ''),
      cacheControl: String(response.headers.get('cache-control') ?? ''),
      body: await response.text(),
    };
  } catch (error) {
    const reason = error instanceof Error ? (error.name === 'TimeoutError' ? 'timeout' : error.message) : String(error);
    return { error: reason };
  }
}

const manifestCheck = {
  label: 'GET /manifest.webmanifest',
  async run(base) {
    const answer = await read(`${base}/manifest.webmanifest`);
    if (answer.error !== undefined) return { ok: false, detail: `unreachable: ${answer.error}` };
    let manifest = null;
    try {
      manifest = JSON.parse(answer.body);
    } catch {
      manifest = null;
    }
    const fields = manifest !== null && typeof manifest === 'object' ? manifest : null;
    const iconCount = Array.isArray(fields?.icons) ? fields.icons.length : 0;
    const ok =
      answer.status === 200 &&
      answer.contentType.toLowerCase().includes('application/manifest+json') &&
      fields !== null;
    return {
      ok,
      detail: `status=${String(answer.status)} content-type=${answer.contentType || 'none'} json=${fields === null ? 'FAIL' : 'ok'} icons=${String(iconCount)}`,
    };
  },
};

const workerCheck = {
  label: 'GET /sw.js',
  async run(base) {
    const answer = await read(`${base}/sw.js`);
    if (answer.error !== undefined) return { ok: false, detail: `unreachable: ${answer.error}` };
    // `no-cache`, not `no-store`: the script must be storable (or it cannot be registered) and
    // must be revalidated before every use (or a release outlives itself).
    const ok =
      answer.status === 200 &&
      answer.contentType.toLowerCase().includes('text/javascript') &&
      answer.cacheControl.toLowerCase().includes('no-cache');
    return {
      ok,
      detail: `status=${String(answer.status)} content-type=${answer.contentType || 'none'} cache-control=${answer.cacheControl || 'none'} bytes=${String(answer.body.length)}`,
    };
  },
};

async function main(argv) {
  const options = parseArgs(argv);
  const base = options.server.replace(/\/+$/u, '');
  const checks = [manifestCheck, workerCheck];
  const failed = [];
  for (const check of checks) {
    const result = await check.run(base);
    console.log(`pwa: ${check.label} — ${result.ok ? 'ok' : 'MISMATCH'} ${result.detail}`);
    if (!result.ok) failed.push(check.label);
  }
  if (failed.length === 0) {
    console.log(`pwa: ok — ${String(checks.length)} checks`);
    return 0;
  }
  console.log(`pwa: FAILED — ${String(failed.length)} of ${String(checks.length)} checks`);
  return 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // A check must answer with a code, never a stack: `deploy.sh` reads the status.
  console.error(`pwa: FAILED — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
