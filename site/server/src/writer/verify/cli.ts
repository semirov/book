/**
 * The two CLI edges of tiered verification (BOOK-173, BOOK-DOC-80): the boot marker a writer
 * process writes once, and the `--audit-samples` command.
 *
 * The **writer** writes no database (BOOK-187, BOOK-183): the boot marker goes through the
 * engine's control route (`POST /internal/writer-boot`) like every other lane store. The sample
 * audit is an operator command (`site/bin/ledger.mjs audit`), so it is the one place here that
 * opens the volume — the way `bin/restore.mjs` and `bin/index.mjs` do, outside the writer process.
 */

import { existsSync } from 'node:fs';

import { databaseFile, openDatabase } from '../../db/db.ts';
import type { EngineClient } from '../client.ts';
import type { WriterConfig } from '../config.ts';
import type { ProviderCall } from '../passLane.ts';
import { reasonOf } from '../reasons.ts';
import { runAuditSamples } from './audit.ts';

/**
 * Write the per-process marker through the engine. A failed marker is a line, never a refusal: a
 * pass whose text can land must not park because the safeguard's bookkeeping did not.
 */
export async function markWriterBoot(engine: EngineClient, log: (line: string) => void): Promise<void> {
  try {
    await engine.writerBoot();
  } catch (error) {
    log(`[writer] boot marker не записан: ${reasonOf(error)}`);
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

/** `ledger.mjs audit [N]`: `0` drained, `1` something was flagged, `2` it could not run. */
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
