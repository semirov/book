/**
 * `--revert --chapter N` (`docs/writer-lane.md` §5): put the chapter back the way the pass found it.
 *
 * The writer takes a pre-image before it writes anything (`${dataDir}/writer/pre/chNN.json` plus
 * the text when the slot had one), and that snapshot is the first choice: `absent` removes the
 * file, `present` copies the text back. When a pass from before this lane left no snapshot, the
 * fallback is the site's own history — the revision *before* the current one, read from
 * `revisions` and copied out of the content-addressed store, the way `bin/restore.mjs` does it.
 *
 * The revert verifies itself: the sha256 of the file now has to equal the snapshot's (or the file
 * has to be gone), and both hashes are printed — a restore nobody checked is a claim, not a fact.
 * Then the operator's mark (`POST /internal/reconcile`) re-runs the gates over the restored text.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { TOTAL_CHAPTERS, chapterLabel, isChapterNumber } from '@book/shared';

import { databaseFile, openDatabase } from '../db/db.ts';
import { assertDataDirIsolation, isProductionEnv } from '../dataDirGuard.ts';
import { chapterPath } from '../engine/text.ts';
import { readSnapshot } from '../versions/snapshots.ts';
import { sha256Hex } from '../util/hash.ts';
import type { EngineClient } from './client.ts';

export type RevertInput = {
  chapter: number;
  bookRoot: string;
  dataDir: string;
  engine: EngineClient;
  dryRun?: boolean;
  log?: (line: string) => void;
};

export type RevertOutcome = {
  status: 'reverted' | 'nothing' | 'failed';
  chapter: number;
  /** Which pre-image was used: this lane's own, or the site's history. */
  source: 'writer-pre' | 'site-history' | null;
  /** The snapshot's own sha; null when the slot was empty before the pass. */
  snapshotSha: string | null;
  /** The file's sha after the revert; null when the file is gone. */
  fileSha: string | null;
  verified: boolean;
  reconciled: boolean;
  reason?: string;
};

type PreSnapshot = { chapter: number; state: 'absent' | 'present'; sha: string | null; at: number };

function preDir(dataDir: string): string {
  return join(dataDir, 'writer', 'pre');
}

function readPreSnapshot(dataDir: string, chapter: number): { stamp: PreSnapshot; text: string | null } | null {
  const json = join(preDir(dataDir), `ch${chapterLabel(chapter)}.json`);
  if (!existsSync(json)) return null;
  let stamp: PreSnapshot;
  try {
    stamp = JSON.parse(readFileSync(json, 'utf8')) as PreSnapshot;
  } catch {
    return null;
  }
  if (stamp.chapter !== chapter || (stamp.state !== 'absent' && stamp.state !== 'present')) return null;
  if (stamp.state === 'absent') return { stamp, text: null };
  try {
    return { stamp, text: readFileSync(join(preDir(dataDir), `ch${chapterLabel(chapter)}.md`), 'utf8') };
  } catch {
    // A stamp whose text is gone cannot restore anything: fall back to the site's history.
    return null;
  }
}

/**
 * The revision before the current one, from the site's own rows. One short-lived connection: the
 * CLI is a reader here, and the site owns both the table and the files. `null` with `created`
 * means the current revision is the only one — this pass created the chapter.
 */
function previousRevision(
  dataDir: string,
  chapter: number,
): { kind: 'text'; text: string; sha: string; rev: number } | { kind: 'created' } | null {
  assertDataDirIsolation(
    { dataDir, adminTokenFile: '', engineTokenFile: '', feedbackDir: '' },
    isProductionEnv(),
  );
  const file = databaseFile(dataDir);
  if (!existsSync(file)) return null;
  const db = openDatabase(file);
  try {
    const rows = db
      .prepare('SELECT rev, snapshot FROM revisions WHERE chapter = ? ORDER BY rev DESC LIMIT 2')
      .all(chapter) as Array<{ rev: number; snapshot: string }>;
    if (rows.length === 0) return null;
    if (rows.length === 1) return { kind: 'created' };
    const previous = rows[1];
    if (previous === undefined) return { kind: 'created' };
    const text = readSnapshot(dataDir, previous.snapshot);
    if (text === null) return null;
    return { kind: 'text', text, sha: sha256Hex(text), rev: previous.rev };
  } finally {
    db.close();
  }
}

function fileSha(path: string): string | null {
  if (!existsSync(path)) return null;
  return sha256Hex(readFileSync(path, 'utf8'));
}

/** Write the snapshot back atomically — a reader never sees half a chapter either way. */
function restoreText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.tmp`;
  writeFileSync(staging, text, 'utf8');
  renameSync(staging, path);
}

/**
 * Put the pre-pass snapshot back on disk, without the history fallback: the one caller is a pass
 * whose `land` answered `STEP_CLOSED`, where the bytes now on disk were never hashed by a gate and
 * must not stay. `absent` removes the file, exactly as `--revert` does; the sha of what was written
 * is returned, so the caller can say it, not claim it. `restored: false` means this lane left no
 * snapshot for the chapter (an older pass) — nothing is put back, nothing is claimed.
 */
export function restorePreSnapshot(
  dataDir: string,
  bookRoot: string,
  chapter: number,
): { restored: boolean; sha: string | null } {
  const pre = readPreSnapshot(dataDir, chapter);
  if (pre === null) return { restored: false, sha: null };
  const target = chapterPath(bookRoot, chapter);
  if (pre.text === null) {
    rmSync(target, { force: true });
    return { restored: true, sha: null };
  }
  restoreText(target, pre.text);
  return { restored: true, sha: fileSha(target) };
}

export async function revertChapter(input: RevertInput): Promise<RevertOutcome> {
  const log = input.log ?? (() => undefined);
  const { chapter } = input;
  const base: RevertOutcome = {
    status: 'failed',
    chapter,
    source: null,
    snapshotSha: null,
    fileSha: null,
    verified: false,
    reconciled: false,
  };
  if (!isChapterNumber(chapter)) {
    return { ...base, reason: `главы ${String(chapter)} нет: глава — число от 1 до ${String(TOTAL_CHAPTERS)}` };
  }

  const target = chapterPath(input.bookRoot, chapter);
  const pre = readPreSnapshot(input.dataDir, chapter);
  let text: string | null = null;
  let snapshotSha: string | null = null;
  let source: RevertOutcome['source'] = null;

  if (pre !== null) {
    source = 'writer-pre';
    text = pre.text;
    snapshotSha = pre.stamp.state === 'absent' ? null : (pre.stamp.sha ?? (pre.text === null ? null : sha256Hex(pre.text)));
    log(
      `глава ${String(chapter)}: снимок писателя до прохода — ${pre.stamp.state === 'absent' ? 'главы не было' : `sha ${String(snapshotSha)}`}`,
    );
  } else {
    let previous: ReturnType<typeof previousRevision>;
    try {
      previous = previousRevision(input.dataDir, chapter);
    } catch (error) {
      // The isolation guard speaks here: a non-production run may not open a production data dir.
      return { ...base, reason: error instanceof Error ? error.message : 'каталог данных не открыт' };
    }
    if (previous === null) {
      return { ...base, reason: 'восстанавливать нечего: нет ни снимка писателя, ни истории главы' };
    }
    source = 'site-history';
    if (previous.kind === 'created') {
      text = null;
      snapshotSha = null;
      log(`глава ${String(chapter)}: в истории нет ревизии до текущей — главу создал этот проход`);
    } else {
      text = previous.text;
      snapshotSha = previous.sha;
      log(`глава ${String(chapter)}: ревизия ${String(previous.rev)} из истории сайта, sha ${previous.sha}`);
    }
  }

  const current = fileSha(target);
  if (text === null) {
    if (current === null) {
      log(`глава ${String(chapter)}: файла уже нет — восстанавливать нечего`);
      return { ...base, status: 'nothing', source, snapshotSha, fileSha: null, verified: true };
    }
    if (input.dryRun !== true) rmSync(target, { force: true });
    const after = input.dryRun === true ? current : fileSha(target);
    log(`глава ${String(chapter)}: файл ${input.dryRun === true ? 'будет удалён' : 'удалён'}; было sha ${current}`);
    return {
      ...base,
      status: input.dryRun === true ? 'nothing' : 'reverted',
      source,
      snapshotSha: null,
      fileSha: after,
      verified: after === null,
      ...(input.dryRun === true ? { reason: 'dry-run: файл не тронут' } : {}),
    };
  }

  if (current === snapshotSha) {
    log(`глава ${String(chapter)}: файл уже совпадает со снимком, sha ${snapshotSha}`);
    return { ...base, status: 'nothing', source, snapshotSha, fileSha: current, verified: true };
  }

  if (input.dryRun === true) {
    log(`глава ${String(chapter)}: будет восстановлен снимок sha ${String(snapshotSha)}, файл не тронут`);
    return { ...base, status: 'nothing', source, snapshotSha, fileSha: current, reason: 'dry-run: файл не тронут' };
  }
  restoreText(target, text);
  const after = fileSha(target);
  const verified = after === snapshotSha;
  log(
    `глава ${String(chapter)}: восстановлен снимок sha ${String(snapshotSha)}, файл sha ${String(after)} — ${verified ? 'совпадает' : 'НЕ совпадает'}`,
  );
  if (!verified) {
    return { ...base, status: 'failed', source, snapshotSha, fileSha: after, reason: 'файл не совпал со снимком' };
  }

  // The restored text is published without gates; the operator's mark is what closes that gap.
  let reconciled = false;
  try {
    await input.engine.reconcile(chapter, `revert: снимок вернул главу к состоянию до прохода (sha ${String(snapshotSha)})`);
    reconciled = true;
  } catch (error) {
    // The file is back either way; a reconcile that cannot run is reported, not fatal.
    log(
      `глава ${String(chapter)}: reconcile не выполнен — ${
        error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'ошибка'
      }`,
    );
  }
  return { ...base, status: 'reverted', source, snapshotSha, fileSha: after, verified, reconciled };
}
