/**
 * BOOK-107: the frame smoke check, run the way the gates run it — as the CLI, spawned like
 * `deploy.sh` spawns it, never as a function call. What is asserted is the contract `deploy.sh`
 * reads: exit 0 with the readout, exit 1 with `expected`/`actual`, exit 2 for bad usage, and a
 * mismatch (not a crash) for a missing file, a wrong block and a non-200 answer.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { TOTAL_TIMEOUT_MS, checkServer } from '../../scripts/lib/frame.mjs';
import { databaseFile, openDatabase } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';

const SITE = resolve(import.meta.dirname, '..', '..');
const REPO = resolve(SITE, '..');
const CLI = join(SITE, 'scripts', 'frame-check.mjs');

/** The wrong text of the owner's report: an ordinary morning, not the frozen frame. */
const WRONG_FIRST = 'Рано утром я проснулся по будильнику, был обычный будний день.';

type RunResult = { status: number; stdout: string; stderr: string };

/**
 * The CLI as a real process, spawned the way `deploy.sh` spawns it. Asynchronous on purpose:
 * a `spawnSync` here would block the test's own event loop, and the `node:http` stub below
 * could not answer the child.
 */
async function run(...args: string[]): Promise<RunResult> {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number>((done) => child.on('close', (code) => done(code ?? 1)));
  return { status, stdout, stderr };
}

/** `manuscript/ch67.md` as the repository holds it: the canon is read, never retyped here. */
function canonOf(name: string): string {
  return readFileSync(join(REPO, 'manuscript', name), 'utf8');
}

const tmpDirs: string[] = [];
function tmpDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  tmpDirs.push(dir);
  return dir;
}

/** A repository root with exactly the manuscript files a test asks for. */
function repoWith(files: Record<string, string>): string {
  const root = tmpDir('book-frame-root-');
  mkdirSync(join(root, 'manuscript'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'manuscript', name), text, 'utf8');
  return root;
}

let server: Server | null = null;
/** A `node:http` stub on a loopback port, answering the two chapter routes through `handler`. */
async function serve(handler: (url: string, response: ServerResponse) => void): Promise<string> {
  const instance = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    handler(request.url ?? '', response);
  });
  await new Promise<void>((ready) => instance.listen(0, '127.0.0.1', ready));
  server = instance;
  const address = instance.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

afterEach(() => {
  server?.close();
  server = null;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stub that serves the canon for both chapters: `--url` has to answer with a verdict. */
async function serveCanon(): Promise<string> {
  return serve((url, response) => {
    if (url === '/api/chapters/1') {
      response.end(
        JSON.stringify({ n: 1, blocks: [{ id: 'ch01#a', i: 0, text: FRAME_FIRST_SENTENCE, hash: 'x' }] }),
      );
      return;
    }
    if (url === '/api/chapters/67') {
      response.end(
        JSON.stringify({ n: 67, blocks: [{ id: 'ch67#a', i: 0, text: FRAME_LAST_SENTENCE, hash: 'x' }] }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: 'NOT_FOUND' }));
  });
}

/** A migrated `book.db` with one block per frame chapter — the shape the service reads. */
function writeBookDb(
  dataDir: string,
  texts: { ch01First: string; ch67Last: string; lastScanAt: string | null },
): void {
  const db = openDatabase(databaseFile(dataDir));
  migrate(db);
  const at = '2026-10-27T16:42:53Z';
  const chapter = db.prepare(
    `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, written_at, updated_at)
     VALUES (?, 1, NULL, 'sha', 0, 1, ?, ?)`,
  );
  chapter.run(1, at, at);
  chapter.run(67, at, at);
  const block = db.prepare(
    `INSERT INTO blocks (id, chapter, idx, text, hash, first_rev, last_rev) VALUES (?, ?, 0, ?, 'hash', 1, 1)`,
  );
  block.run('ch01#a', 1, texts.ch01First);
  block.run('ch67#b', 67, texts.ch67Last);
  if (texts.lastScanAt !== null) {
    db.prepare(`INSERT INTO meta (k, v) VALUES ('last_scan_at', ?)`).run(texts.lastScanAt);
  }
  db.close();
}

describe('frame-check — the CLI contract (BOOK-107)', () => {
  it('passes on this repository: the manuscript and the guard', async () => {
    const result = await run('--repo-root', REPO);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('frame: manuscript ch01 first line — ok');
    expect(result.stdout).toContain('frame: manuscript ch67 last line — ok');
    expect(result.stdout).toContain('frame: isolation guard — ok');
    expect(result.stdout).toContain('frame: ok — 3 checks');
  });

  it('fails with expected/actual when ch01 does not open with the frame', async () => {
    const root = repoWith({ 'ch01.md': `${WRONG_FIRST}\n`, 'ch67.md': canonOf('ch67.md') });
    const result = await run('--repo-root', root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('frame: manuscript ch01 first line — MISMATCH');
    expect(result.stdout).toContain(`frame:   expected: ${FRAME_FIRST_SENTENCE}`);
    expect(result.stdout).toContain(`frame:   actual:   ${WRONG_FIRST}`);
    expect(result.stdout).toContain('frame: manuscript ch67 last line — ok');
    expect(result.stdout).toContain('frame: FAILED — 1 of 3 checks');
  });

  it('accepts a rewrapped frame under a title, and fails on one changed word', async () => {
    // A soft wrap is whitespace; the comparison collapses it. The title line is the parser's,
    // not the check's: `parseChapterTitle` reads the frame line as prose (BOOK-32).
    const rewrapped = FRAME_FIRST_SENTENCE.replace('Её', '\nЕё');
    const passes = await run(
      '--repo-root',
      repoWith({
        'ch01.md': `Тестовая глава\n\n${rewrapped} И дальше идёт текст главы.\n`,
        'ch67.md': `Текст главы до финала.\n\n${FRAME_LAST_SENTENCE}\n`,
      }),
    );
    expect(passes.status).toBe(0);
    expect(passes.stdout).toContain('frame: manuscript ch01 first line — ok');
    expect(passes.stdout).toContain('frame: manuscript ch67 last line — ok');

    // One word is enough to make it not the canon.
    const changed = FRAME_FIRST_SENTENCE.replace('яркий', 'тусклый');
    const fails = await run('--repo-root', repoWith({ 'ch01.md': `${changed}\n`, 'ch67.md': canonOf('ch67.md') }));
    expect(fails.status).toBe(1);
    expect(fails.stdout).toContain(`frame:   actual:   ${changed}`);
  });

  it('treats a missing chapter file as a mismatch, not a crash', async () => {
    const result = await run('--repo-root', tmpDir('book-frame-empty-'));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('frame:   actual:   no such file: manuscript/ch01.md');
    expect(result.stdout).toContain('frame: FAILED — 2 of 3 checks');
  });

  it('fails when the running site serves a first block that is not the frame', async () => {
    const base = await serve((url, response) => {
      if (url === '/api/chapters/1') {
        response.end(JSON.stringify({ n: 1, blocks: [{ id: 'ch01#a', i: 0, text: WRONG_FIRST, hash: 'x' }] }));
        return;
      }
      if (url === '/api/chapters/67') {
        response.end(JSON.stringify({ n: 67, blocks: [{ id: 'ch67#a', i: 0, text: FRAME_LAST_SENTENCE, hash: 'x' }] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ code: 'NOT_FOUND' }));
    });
    const result = await run('--repo-root', REPO, '--server', base);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('frame: site /api/chapters/1 — MISMATCH');
    expect(result.stdout).toContain(`frame:   expected: ${FRAME_FIRST_SENTENCE}`);
    expect(result.stdout).toContain(`frame:   actual:   ${WRONG_FIRST}`);
    expect(result.stdout).toContain('frame: site /api/chapters/67 — ok');
    expect(result.stdout).toContain('frame: FAILED — 1 of 5 checks');
  });

  it('reports a non-200 answer as the status and the code', async () => {
    const base = await serve((_url, response) => {
      response.statusCode = 404;
      response.end(JSON.stringify({ code: 'NOT_WRITTEN' }));
    });
    const result = await run('--repo-root', REPO, '--server', base);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('frame:   actual:   404 NOT_WRITTEN');
    expect(result.stdout).toContain('frame: FAILED — 2 of 5 checks');
  });

  it('reports an unreachable site as a mismatch with the reason', async () => {
    // Port 1 on loopback: nothing listens, so the answer is a refused connection, not a hang.
    const result = await run('--repo-root', REPO, '--server', 'http://127.0.0.1:1');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('frame:   actual:   unreachable:');
    expect(result.stdout).toContain('frame: FAILED — 2 of 5 checks');
  });

  it('reads the data dir read-only and prints what it holds, including the last ingest', async () => {
    const dataDir = tmpDir('book-frame-data-');
    const at = '2026-10-27T16:42:53Z';
    writeBookDb(dataDir, { ch01First: FRAME_FIRST_SENTENCE, ch67Last: FRAME_LAST_SENTENCE, lastScanAt: at });

    const result = await run('--repo-root', REPO, '--data-dir', dataDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`frame: data dir ${dataDir} — ok`);
    expect(result.stdout).toContain(`frame:   ch01 first block: ${FRAME_FIRST_SENTENCE}`);
    expect(result.stdout).toContain(`frame:   ch67 last block:  ${FRAME_LAST_SENTENCE}`);
    expect(result.stdout).toMatch(new RegExp(`frame:   last ingest:\\s+${at}`, 'u'));
    expect(result.stdout).toContain('frame: ok — 4 checks');
  });

  it('names every failing block of the data dir when both ends are wrong', async () => {
    const dataDir = tmpDir('book-frame-wrong-');
    writeBookDb(dataDir, { ch01First: WRONG_FIRST, ch67Last: 'Совсем другой финал.', lastScanAt: null });
    const result = await run('--repo-root', REPO, '--data-dir', dataDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`frame: data dir ${dataDir} — MISMATCH`);
    expect(result.stdout).toContain('frame:   ch01 first block:');
    expect(result.stdout).toContain('frame:   ch67 last block:');
    expect(result.stdout).toContain(`frame:   actual:   ${WRONG_FIRST}`);
    expect(result.stdout).toContain('frame:   actual:   Совсем другой финал.');
    expect(result.stdout).toContain('frame: FAILED — 1 of 4 checks');
  });

  it('is a mismatch, not a crash, when the data dir has no database', async () => {
    const result = await run('--repo-root', REPO, '--data-dir', tmpDir('book-frame-nodb-'));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('frame:   actual:   cannot open');
    expect(result.stdout).toContain('frame: FAILED — 1 of 4 checks');
  });

  it('is a mismatch, not a crash, when book.db is not a database', async () => {
    const dataDir = tmpDir('book-frame-garbage-');
    writeFileSync(join(dataDir, 'book.db'), 'not a database\n', 'utf8');
    const result = await run('--repo-root', REPO, '--data-dir', dataDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`frame: data dir ${dataDir} — MISMATCH`);
    expect(result.stdout).toMatch(/frame:   actual:   cannot (open|read)/u);
    expect(result.stdout).toContain('frame: FAILED — 1 of 4 checks');
  });

  it('answers the owner form `--url=… --data=…` with the six-check readout', async () => {
    const base = await serveCanon();
    const dataDir = tmpDir('book-frame-alias-');
    writeBookDb(dataDir, { ch01First: FRAME_FIRST_SENTENCE, ch67Last: FRAME_LAST_SENTENCE, lastScanAt: null });
    const result = await run('--repo-root', REPO, `--url=${base}`, `--data=${dataDir}`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('frame: site /api/chapters/1 — ok');
    expect(result.stdout).toContain('frame: site /api/chapters/67 — ok');
    expect(result.stdout).toContain(`frame: data dir ${dataDir} — ok`);
    expect(result.stdout).toContain(`frame:   ch01 first block: ${FRAME_FIRST_SENTENCE}`);
    expect(result.stdout).toContain(`frame:   ch67 first block: ${FRAME_LAST_SENTENCE}`);
    expect(result.stdout).toContain(`frame:   ch67 last block:  ${FRAME_LAST_SENTENCE}`);
    expect(result.stdout).toContain('frame:   last ingest:');
    expect(result.stdout).toContain('frame: ok — 6 checks');
  });

  it('accepts the space-separated aliases `--url <url> --data <dir>`', async () => {
    const base = await serveCanon();
    const dataDir = tmpDir('book-frame-alias-space-');
    writeBookDb(dataDir, { ch01First: FRAME_FIRST_SENTENCE, ch67Last: FRAME_LAST_SENTENCE, lastScanAt: null });
    const result = await run('--repo-root', REPO, '--url', base, '--data', dataDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`frame: data dir ${dataDir} — ok`);
    expect(result.stdout).toContain('frame: ok — 6 checks');
  });

  it('bounds both chapters by one deadline: a hanging site is `timeout`, the second request is not made', async () => {
    let calls = 0;
    const hanging = (_url: string, init: { signal?: AbortSignal }): Promise<Response> =>
      new Promise((_resolve, reject) => {
        calls += 1;
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        });
      });
    const checks = await checkServer({ baseUrl: 'http://127.0.0.1:1', fetchImpl: hanging, budgetMs: 60 });
    expect(checks.map((check) => check.parts[0]?.actual)).toEqual(['timeout', 'timeout']);
    // 60 ms spent on the first request leaves nothing for the second: the deploy is not waiting twice.
    expect(calls).toBe(1);
    // The claim in deploy.sh: the whole check fits its 30 s allowance with room for node's start.
    expect(TOTAL_TIMEOUT_MS).toBeLessThanOrEqual(25_000);
  });

  it('exits 2 on an unknown flag and on a flag without a value', async () => {
    expect((await run('--nope')).status).toBe(2);
    expect((await run('--server')).status).toBe(2);
    expect((await run('--data-dir', '--json')).status).toBe(2);
  });
});
