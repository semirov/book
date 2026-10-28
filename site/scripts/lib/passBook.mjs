/**
 * lib/passBook.mjs — the scratch book a pass replay runs on, and the one transaction it needs.
 *
 * Everything here touches **the temp copy**: a read-only `VACUUM INTO` of the production store,
 * this checkout's manuscript beside it, the two `pass_stages` rows of one pass, and the readback
 * the report prints. Production is opened read-only and never written; the caller removes the
 * directory when it is done.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { spawnLogged } from './cdp.mjs';

/** `site/` and the checkout above it, from `site/scripts/lib/`. */
export const SITE = resolve(import.meta.dirname, '..', '..');
export const WORKTREE = resolve(SITE, '..');
/** The live store: read-only source of the copy. */
export const PROD_DB = join(homedir(), 'book-site-data', 'book.db');

/** Run a command to its exit, keeping its output for the failure report. */
export async function run(command, args, cwd) {
  const child = spawnLogged(command, args, { cwd });
  const code = await new Promise((resolveExit) => {
    child.once('exit', (status) => resolveExit(status ?? -1));
    child.once('error', () => resolveExit(-1));
  });
  return { code, output: child.output };
}

/** Build the shipped bundle (the frames are of it, and its `sw.js` is served, not shadowed). */
export async function buildSite({ skip, log }) {
  if (skip) {
    if (!existsSync(join(SITE, 'server', 'dist', 'index.js')) || !existsSync(join(SITE, 'web', 'dist', 'staging', 'index.html'))) {
      throw new Error('--no-build was asked but there is no build in server/dist and web/dist/staging');
    }
    return;
  }
  log('building the site (npm run build)');
  const build = await run('npm', ['run', 'build'], SITE);
  if (build.code !== 0) throw new Error(`npm run build failed (${build.code}):\n${build.output.split('\n').slice(-25).join('\n')}`);
}

/** The temp directory: prod's store copied, this checkout's manuscript, a scratch feedback dir. */
export async function prepareTemp() {
  if (!existsSync(PROD_DB)) throw new Error(`no production database at ${PROD_DB}`);
  const dir = mkdtempSync(join(tmpdir(), 'pass-frames-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  mkdirSync(join(dir, 'feedback'), { recursive: true });
  const target = join(dir, 'data', 'book.db');
  // `sqlite3 -readonly` + VACUUM INTO: the copy is read out of prod, never written back to it.
  const vacuum = await run('sqlite3', ['-readonly', PROD_DB, `VACUUM INTO '${target}'`], dir);
  if (vacuum.code !== 0) throw new Error(`sqlite3 VACUUM INTO failed (${vacuum.code}): ${vacuum.output}`);
  cpSync(join(WORKTREE, 'manuscript'), join(dir, 'book', 'manuscript'), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  // Schema v21 (this branch understands v20) only added two nullable columns; pin the marker.
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 20) db.exec('PRAGMA user_version = 20');
  db.close();
  return dir;
}

/**
 * One transaction: the temp chapter file gets the edit, then the two rows the tailer publishes
 * (`landed`, then `typing` of the same pass). `at` is the moment of the write.
 */
export function replayPass(run, dir, passId) {
  const now = Date.now();
  const rows = [
    {
      stage: 'landed',
      stageSeq: 1,
      at: new Date(now - 50).toISOString(),
      summary: 'внесено: 1 абзац',
      span: JSON.stringify([{ blockId: run.block.id, before: run.block.text, after: run.after, truncated: false }]),
      tokensIn: 120_000,
      tokensOut: 6_099,
      costUsd: 0.08,
    },
    {
      stage: 'typing',
      stageSeq: 2,
      at: new Date(now).toISOString(),
      summary: 'правка на странице: текст печатается',
      span: null,
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
    },
  ];
  writeFileSync(run.file, run.source.replace(run.phrase, run.replacement));
  const db = new DatabaseSync(join(dir, 'data', 'book.db'));
  db.exec('PRAGMA busy_timeout = 5000;');
  const insert = db.prepare(`INSERT INTO pass_stages
    (pass_id, chapter, stage_seq, stage, at, actor_process, actor_model, change_id, summary, span,
     tokens_in, tokens_out, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(
      passId,
      run.chapter,
      row.stageSeq,
      row.stage,
      row.at,
      row.stage === 'typing' ? 'site' : 'writer',
      row.stage === 'typing' ? null : 'deepseek/deepseek-flash',
      null,
      row.summary,
      row.span,
      row.tokensIn,
      row.tokensOut,
      row.costUsd,
    );
  }
  db.close();
}

/** The store's own rows for the pass, read back for the report. */
export function storedStages(dir, passId) {
  const db = new DatabaseSync(join(dir, 'data', 'book.db'), { readOnly: true });
  const rows = db
    .prepare('SELECT stage, stage_seq, at, summary, span FROM pass_stages WHERE pass_id = ? ORDER BY stage_seq')
    .all(passId);
  db.close();
  return rows.map((row) => ({
    stage: row.stage,
    stageSeq: row.stage_seq,
    at: row.at,
    summary: row.summary,
    span: row.span === null ? null : JSON.parse(row.span),
  }));
}
