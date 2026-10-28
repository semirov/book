/**
 * The two CLI edges of tiered verification (BOOK-173, BOOK-DOC-80): the boot marker a writer
 * process writes once, and the `--audit-samples` command.
 *
 * They live beside the audit rather than in `main.ts` because `main.ts` is the argument parser and
 * is at the file-size wall; both need the database the writer shares with the engine, which is why
 * each opens it for exactly its own call and closes it again.
 */

import { existsSync } from 'node:fs';

import { databaseFile, openDatabase } from '../../db/db.ts';
import { markWriterBoot } from '../../ledger/graph/verification.ts';
import { ulid } from '../../util/ulid.ts';
import type { WriterConfig } from '../config.ts';
import type { ProviderCall } from '../passLane.ts';
import { runAuditSamples } from './audit.ts';

/**
 * Write the per-process marker, when there is a database to write it into. A missing file is a
 * fresh install: the marker will be written by the first process that finds one.
 */
export function markWriterBootAt(dataDir: string, log: (line: string) => void): void {
  const file = databaseFile(dataDir);
  if (!existsSync(file)) return;
  let db;
  try {
    db = openDatabase(file);
    markWriterBoot(db, ulid());
  } catch (error) {
    log(`[writer] boot marker не записан: ${error instanceof Error ? error.message.slice(0, 120) : 'ошибка'}`);
  } finally {
    db?.close();
  }
}

export type AuditCliInput = {
  dataDir: string;
  config: WriterConfig;
  bookRoot: string;
  provider: ProviderCall;
  log: (line: string) => void;
  now: () => number;
  /** `--audit-samples N`, or `null` for the default. */
  limit: number | null;
};

/** `--audit-samples [N]`: `0` drained, `1` something was flagged, `2` it could not run. */
export async function runAuditCli(input: AuditCliInput): Promise<number> {
  const file = databaseFile(input.dataDir);
  if (!existsSync(file)) {
    input.log('[writer] аудит образцов: базы нет — образцов нет');
    return 2;
  }
  const db = openDatabase(file);
  try {
    return await runAuditSamples({
      db,
      config: input.config,
      bookRoot: input.bookRoot,
      provider: input.provider,
      log: input.log,
      now: input.now,
      ...(input.limit === null ? {} : { limit: input.limit }),
    });
  } finally {
    db.close();
  }
}
