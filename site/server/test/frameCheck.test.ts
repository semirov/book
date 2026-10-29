/**
 * BOOK-107 / BOOK-187: the frame smoke check, run the way the gates run it — as the CLI, spawned
 * like `deploy.sh` spawns it, never as a function call. What is asserted is the contract
 * `deploy.sh` reads: exit 0 with the readout, exit 1 with `expected`/`actual`, exit 2 for bad
 * usage, and a mismatch (not a crash) for a wrong row, a missing row, a chapter that lost the
 * sentence and a non-200 answer. Since v28 the check reads the volume, not the manuscript, so a
 * checkout with no `book.db` has nothing to fail about — that case is asserted too.
 *
 * The cases that drive `checkServer` directly inject the clock, so the deadline is decided, not
 * measured.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, TOTAL_CHAPTERS } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { databaseFile, openDatabase } from '../src/db/db.ts';
import { migrate } from '../src/db/migrate.ts';

const SITE = resolve(import.meta.dirname, '..', '..');
const CLI = join(SITE, 'scripts', 'frame-check.mjs');

/** The wrong text of the owner's report: an ordinary morning, not the frozen frame. */
const WRONG_FIRST = 'Рано утром я проснулся по будильнику, был обычный будний день.';

type RunResult = { status: number; stdout: string; stderr: string };

/**
 * The CLI as a real process, spawned the way `deploy.sh` spawns it. Asynchronous on purpose:
 * a `spawnSync` here would block the test's own event loop, and the `node:http` stub below
 * could not answer the child.
 */
async function run(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const child = spawn(process.execPath, [CLI, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
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

const tmpDirs: string[] = [];
function tmpDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), name));
  tmpDirs.push(dir);
  return dir;
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
    if (url === `/api/chapters/${String(TOTAL_CHAPTERS)}`) {
      response.end(
        JSON.stringify({
          n: TOTAL_CHAPTERS,
          blocks: [{ id: 'ch42#a', i: 0, text: FRAME_LAST_SENTENCE, hash: 'x' }],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ code: 'NOT_FOUND' }));
  });
}

/**
 * A migrated `book.db` — the shape the service reads: v28, so the frame rows are seeded by the
 * migration, plus one block per frame chapter when the case asks for prose.
 */
function writeBookDb(
  dataDir: string,
  texts: { ch01First?: string | null; lastLast?: string | null; lastScanAt?: string | null } = {},
): void {
  const db = openDatabase(databaseFile(dataDir));
  migrate(db);
  const at = '2026-10-27T16:42:53Z';
  const chapter = db.prepare(
    `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, written_at, updated_at)
     VALUES (?, 1, NULL, 'sha', 0, 1, ?, ?)`,
  );
  const block = db.prepare(
    `INSERT INTO blocks (id, chapter, idx, text, hash, first_rev, last_rev) VALUES (?, ?, 0, ?, 'hash', 1, 1)`,
  );
  if (typeof texts.ch01First === 'string') {
    chapter.run(1, at, at);
    block.run('ch01#a', 1, texts.ch01First);
  }
  if (typeof texts.lastLast === 'string') {
    chapter.run(TOTAL_CHAPTERS, at, at);
    block.run('ch42#b', TOTAL_CHAPTERS, texts.lastLast);
  }
  if (typeof texts.lastScanAt === 'string') {
    db.prepare(`INSERT INTO meta (k, v) VALUES ('last_scan_at', ?)`).run(texts.lastScanAt);
  }
  db.close();
}

describe('frame-check — the CLI contract (BOOK-107)', () => {
  it('passes on a fresh volume: the two rows, and no prose to place them in', async () => {
    const dataDir = tmpDir('book-frame-fresh-');
    writeBookDb(dataDir);
    const result = await run(['--data-dir', dataDir]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('frame: book_frame 1/first — ok');
    expect(result.stdout).toContain('frame: book_frame 42/last — ok');
    expect(result.stdout).toContain('frame: book_frame rows — ok');
    expect(result.stdout).toContain('frame: isolation guard — ok');
    // No chapter has a block, so no span is checked and nothing is claimed about one.
    expect(result.stdout).not.toContain('frame span');
    expect(result.stdout).toContain('frame: ok — 4 checks');
  });

  it('reads the data dir read-only and prints what it holds, including the last ingest', async () => {
    const dataDir = tmpDir('book-frame-data-');
    const at = '2026-10-27T16:42:53Z';
    writeBookDb(dataDir, { ch01First: `${FRAME_FIRST_SENTENCE} И дальше.`, lastLast: FRAME_LAST_SENTENCE, lastScanAt: at });

    const result = await run(['--data-dir', dataDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`frame:   ch01 first block: ${FRAME_FIRST_SENTENCE} И дальше.`);
    expect(result.stdout).toContain(`frame:   ch42 last block:  ${FRAME_LAST_SENTENCE}`);
    expect(result.stdout).toMatch(new RegExp(`frame:   last ingest:\\s+${at}`, 'u'));
    expect(result.stdout).toContain('frame: frame span ch01 first block — ok');
    expect(result.stdout).toContain('frame: frame span ch42 last block — ok');
    expect(result.stdout).toContain('frame: ok — 6 checks');
  });

  it('fails when a row does not carry the sentence the image compiles in', async () => {
    const dataDir = tmpDir('book-frame-wrong-row-');
    writeBookDb(dataDir);
    const db = openDatabase(databaseFile(dataDir));
    db.prepare(`UPDATE book_frame SET text = ? WHERE chapter = 1`).run(WRONG_FIRST);
    db.close();

    const result = await run(['--data-dir', dataDir]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('frame: book_frame 1/first — MISMATCH');
    expect(result.stdout).toContain(`frame:   expected: ${FRAME_FIRST_SENTENCE}`);
    expect(result.stdout).toContain(`frame:   actual:   ${WRONG_FIRST}`);
    expect(result.stdout).toContain('frame: book_frame 42/last — ok');
    expect(result.stdout).toContain('frame: FAILED — 1 of 4 checks');
  });

  it('fails when a row is missing, naming which one', async () => {
    const dataDir = tmpDir('book-frame-missing-row-');
    writeBookDb(dataDir);
    const db = openDatabase(databaseFile(dataDir));
    db.prepare(`DELETE FROM book_frame WHERE chapter = 42`).run();
    db.close();

    const result = await run(['--data-dir', dataDir]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('frame: book_frame 42/last — MISMATCH');
    expect(result.stdout).toContain(`frame:   actual:   no book_frame row for 42/last`);
    expect(result.stdout).toContain('frame: book_frame rows — MISMATCH');
    expect(result.stdout).toContain('1/first, 42/last (2 rows)');
    expect(result.stdout).toContain('1/first (1 rows)');
    expect(result.stdout).toContain('frame: FAILED — 2 of 4 checks');
  });

  it('fails when ch01’s first block lost the sentence, and when the finale’s last one did', async () => {
    const dataDir = tmpDir('book-frame-span-');
    writeBookDb(dataDir, { ch01First: WRONG_FIRST, lastLast: 'Совсем другой финал.' });

    const result = await run(['--data-dir', dataDir]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('frame: frame span ch01 first block — MISMATCH');
    expect(result.stdout).toContain('frame: frame span ch42 last block — MISMATCH');
    expect(result.stdout).toContain(`frame:   expected: ${FRAME_FIRST_SENTENCE}`);
    expect(result.stdout).toContain(`frame:   actual:   ${WRONG_FIRST}`);
    expect(result.stdout).toContain('frame:   actual:   Совсем другой финал.');
    expect(result.stdout).toContain('frame: FAILED — 2 of 6 checks');
  });

  it('fails when a mention marks the frame but its offsets select other words', async () => {
    const dataDir = tmpDir('book-frame-mention-');
    writeBookDb(dataDir, { ch01First: `${FRAME_FIRST_SENTENCE} И дальше.` });
    const db = openDatabase(databaseFile(dataDir));
    // A row that claims to be the frame, pointing one code point past its first letter.
    db.prepare(
      `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, witness)
       VALUES ('sp1', 'ch01#a', 1, 1, 3, 'document', ?)`,
    ).run(FRAME_FIRST_SENTENCE);
    db.close();

    const result = await run(['--data-dir', dataDir]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('frame: mention 1/first (mention 1) — MISMATCH');
    expect(result.stdout).toContain('@ [1, 3)');
    expect(result.stdout).toContain('frame: FAILED — 1 of 6 checks');
  });

  it('counts a mention’s offsets in code points, not UTF-16 units', async () => {
    // An astral character before the sentence is one code point and two UTF-16 units: the offsets
    // `book_frame` and `mentions` use are the former (`substr()` counts them the same way).
    const emoji = '\u{1F600} ';
    const block = `${emoji}${FRAME_LAST_SENTENCE}`;
    const cpLength = (value: string): number => Array.from(value).length;
    const dataDir = tmpDir('book-frame-codepoints-');
    writeBookDb(dataDir, { lastLast: block });
    const addMention = (start: number): void => {
      const db = openDatabase(databaseFile(dataDir));
      db.prepare('DELETE FROM mentions').run();
      db.prepare(
        `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, witness)
         VALUES ('sp1', 'ch42#b', 42, ?, ?, 'document', ?)`,
      ).run(start, cpLength(block), FRAME_LAST_SENTENCE);
      db.close();
    };

    addMention(cpLength(block) - cpLength(FRAME_LAST_SENTENCE));
    const right = await run(['--data-dir', dataDir]);
    expect(right.status).toBe(0);
    expect(right.stdout).not.toContain('mention 42/last');

    // One unit further is what a UTF-16 offset would give: the row then selects another sentence.
    addMention(cpLength(block) - cpLength(FRAME_LAST_SENTENCE) + 1);
    const wrong = await run(['--data-dir', dataDir]);
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toContain('frame: mention 42/last (mention ');
  });

  it('is a mismatch when book.db is not a database, and says so instead of throwing', async () => {
    const dataDir = tmpDir('book-frame-garbage-');
    writeFileSync(join(dataDir, 'book.db'), 'not a database\n', 'utf8');
    const result = await run(['--data-dir', dataDir]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`frame: frame database ${join(dataDir, 'book.db')} — MISMATCH`);
    expect(result.stdout).toMatch(/frame:   actual:   cannot (open|read)/u);
    expect(result.stdout).toContain('frame: FAILED — 1 of 2 checks');
  });

  it('names the missing schema when the volume predates v28', async () => {
    const dataDir = tmpDir('book-frame-v22-');
    writeBookDb(dataDir);
    const db = openDatabase(databaseFile(dataDir));
    db.exec('DROP TABLE book_frame');
    db.close();

    const result = await run(['--data-dir', dataDir]);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/frame:   actual:   .*has no book_frame table/u);
    expect(result.stdout).toContain('the frame rows arrive with v28');
  });

  it('skips the DB legs, without failing, when the data dir holds no book.db', async () => {
    const dataDir = tmpDir('book-frame-nodb-');
    const result = await run(['--data-dir', dataDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`frame:   no database at ${join(dataDir, 'book.db')}`);
    expect(result.stdout).toContain('frame: isolation guard — ok');
    expect(result.stdout).toContain('frame: ok — 1 check');
  });

  it('resolves the data dir from $DATA_DIR when no flag is given', async () => {
    const dataDir = tmpDir('book-frame-env-');
    writeBookDb(dataDir);
    const result = await run([], { DATA_DIR: dataDir });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('frame: book_frame rows — ok');
  });

  /** A stub whose ch01 answer is `first` and whose finale answer is the canon. */
  async function serveFirstAs(first: string): Promise<string> {
    return serve((url, response) => {
      if (url === '/api/chapters/1') {
        response.end(JSON.stringify({ n: 1, blocks: [{ id: 'ch01#a', i: 0, text: first, hash: 'x' }] }));
        return;
      }
      if (url === `/api/chapters/${String(TOTAL_CHAPTERS)}`) {
        response.end(
          JSON.stringify({ n: TOTAL_CHAPTERS, blocks: [{ id: 'ch42#a', i: 0, text: FRAME_LAST_SENTENCE, hash: 'x' }] }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ code: 'NOT_FOUND' }));
    });
  }

  it('fails when the running site serves a first block that is not the frame', async () => {
    const base = await serveFirstAs(WRONG_FIRST);
    const dataDir = tmpDir('book-frame-server-');
    writeBookDb(dataDir);
    const result = await run(['--data-dir', dataDir, '--server', base]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('frame: site /api/chapters/1 — MISMATCH');
    expect(result.stdout).toContain(`frame:   expected: ${FRAME_FIRST_SENTENCE}`);
    expect(result.stdout).toContain(`frame:   actual:   ${WRONG_FIRST}`);
    expect(result.stdout).toContain('frame: site /api/chapters/42 — ok');
    expect(result.stdout).toContain('frame: FAILED — 1 of 6 checks');
  });

  it('reports a non-200 answer as the status and the code', async () => {
    const base = await serve((_url, response) => {
      response.statusCode = 404;
      response.end(JSON.stringify({ code: 'NOT_WRITTEN' }));
    });
    const dataDir = tmpDir('book-frame-non200-');
    writeBookDb(dataDir);
    const result = await run(['--data-dir', dataDir, '--server', base]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('frame:   actual:   404 NOT_WRITTEN');
    expect(result.stdout).toContain('frame: FAILED — 2 of 6 checks');
  });

  it('reports an unreachable site as a mismatch with the reason', async () => {
    // Port 1 on loopback: nothing listens, so the answer is a refused connection, not a hang.
    const dataDir = tmpDir('book-frame-unreachable-');
    writeBookDb(dataDir);
    const result = await run(['--data-dir', dataDir, '--server', 'http://127.0.0.1:1']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('frame:   actual:   unreachable:');
    expect(result.stdout).toContain('frame: FAILED — 2 of 6 checks');
  });

  it('answers the owner form `--url=… --data=…` with the full readout, as JSON too', async () => {
    const base = await serveCanon();
    const dataDir = tmpDir('book-frame-alias-');
    writeBookDb(dataDir, { ch01First: FRAME_FIRST_SENTENCE, lastLast: FRAME_LAST_SENTENCE });
    const result = await run([`--url=${base}`, `--data=${dataDir}`]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('frame: site /api/chapters/1 — ok');
    expect(result.stdout).toContain('frame: site /api/chapters/42 — ok');
    expect(result.stdout).toContain(`frame:   ch01 first block: ${FRAME_FIRST_SENTENCE}`);
    expect(result.stdout).toContain(`frame:   ch42 first block: ${FRAME_LAST_SENTENCE}`);
    expect(result.stdout).toContain(`frame:   ch42 last block:  ${FRAME_LAST_SENTENCE}`);
    expect(result.stdout).toContain('frame:   last ingest:');
    expect(result.stdout).toContain('frame: ok — 8 checks');

    const json = await run([`--data=${dataDir}`, '--json']);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout) as { ok: boolean; dataDir: string; absent: boolean; checks: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.absent).toBe(false);
    expect(parsed.dataDir).toBe(resolve(dataDir));
    expect(parsed.checks).toHaveLength(6);
  });
  it('exits 2 on an unknown flag, on a flag without a value, and on the retired --repo-root', async () => {
    expect((await run(['--nope'])).status).toBe(2);
    expect((await run(['--server'])).status).toBe(2);
    expect((await run(['--data-dir', '--json'])).status).toBe(2);
    // BOOK-187: the manuscript is no longer a source of the frame, so its flag is gone.
    const retired = await run(['--repo-root', SITE]);
    expect(retired.status).toBe(2);
    expect(retired.stderr).toContain('unknown argument: --repo-root');
  });
});
