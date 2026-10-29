/**
 * The two CLI edges (BOOK-DOC-80): `ledger.mjs audit` opening its own database, and the boot marker.
 *
 * The audit is an **operator** command (`site/bin/ledger.mjs audit`), so it opens the volume the
 * way `bin/restore.mjs` does; the cases here are the interface a supervisor sees — 0 drained,
 * 1 flagged, 2 could not run. The marker is the writer's, and it goes through the engine: the
 * writer process holds no database handle (BOOK-187, BOOK-183), so this file proves the call and
 * its one rule — a failed marker is a line, never a parked pass.
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { databaseFile, openDatabase } from '../../../src/db/db.ts';
import { migrate } from '../../../src/db/migrate.ts';
import { recordVerification } from '../../../src/ledger/graph/verification.ts';
import type { WriterConfig } from '../../../src/writer/config.ts';
import type { ProviderRequest, ProviderResult } from '../../../src/writer/provider.ts';
import { markWriterBoot, runAuditCli } from '../../../src/writer/verify/cli.ts';
import type { EngineClient } from '../../../src/writer/client.ts';
import { seedChapter } from '../../ledger/helpers.ts';
import { inertProse } from '../inert.ts';

const AT = '2026-10-28T12:00:00Z';
const CHAPTER = 12;
const SITE_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const BOOK_ROOT = resolve(SITE_ROOT, '..');
const CANON = ['process/ROLE_PROMPTS.md', 'concept/CONCEPT.md', 'concept/CLIMAX.md', 'style/VOICE.md', 'outline/PLAN.md'];

const CONFIG = {
  endpoint: 'http://127.0.0.1:1',
  apiKey: 'test-key-never-sent',
  model: 'deepseek/deepseek-flash',
  apiModel: 'deepseek-flash',
  gateTokens: 1_000,
  timeoutMs: 1_000,
  pipeline: {
    provider: 'deepseek',
    model: 'deepseek/deepseek-flash',
    endpoint: 'http://127.0.0.1:1',
    pricing: { currency: 'USD', per: 1_000_000, source: 'test', date: AT, input: 1, output: 2, cacheRead: 0.1 },
  },
} as unknown as WriterConfig;

function bookRoot(withChapter: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'book-cli-root-'));
  mkdirSync(join(root, 'manuscript'), { recursive: true });
  for (const file of CANON) {
    const target = join(root, file);
    mkdirSync(resolve(target, '..'), { recursive: true });
    copyFileSync(join(BOOK_ROOT, file), target);
  }
  if (withChapter) mkdirSync(join(root, 'manuscript'), { recursive: true });
  return root;
}

function dataDirWithSample(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'book-cli-data-'));
  const db = openDatabase(databaseFile(dataDir));
  migrate(db);
  db.prepare(
    `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
                          status, enqueued_at, seq)
     VALUES ('chg_ten', 'operator', ?, 'служебное намерение', 1, 'sha', '[]', 'phrase', 'done', ?, 10)`,
  ).run(CHAPTER, AT);
  db.prepare(
    `INSERT INTO change_plans (id, change_id, chapter, outcome, closure, patches, bounds, created_at)
     VALUES ('pln_ten', 'chg_ten', ?, 'local', '{}', '[]', '{}', ?)`,
  ).run(CHAPTER, AT);
  recordVerification(db, { changeId: 'chg_ten', chapter: CHAPTER, stepId: 'stp_ten' }, { gatesMode: 'local only', why: null, tier1Verdict: 'HOLDS', tier1Usd: 0.003 }, AT);
  // BOOK-187: the chapter the audit reads is rows, not a file.
  seedChapter(db, { chapter: CHAPTER, title: 'Глава двенадцатая', texts: [inertProse(2_000)], at: AT });
  db.close();
  return dataDir;
}

function provider(answer: string): (request: ProviderRequest) => Promise<ProviderResult> {
  return async (request) => ({
    text: answer,
    responseModel: request.apiModel,
    usage: { in: 10, out: 2, cachedIn: 0 },
    latencyMs: 1,
    attempts: 1,
    finishReason: 'stop',
  });
}

describe('--audit-samples', () => {
  it('answers 2 when there is no database to drain', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'book-cli-empty-'));
    const root = bookRoot(false);
    try {
      const lines: string[] = [];
      const code = await runAuditCli({
        dataDir,
        config: CONFIG,
        bookRoot: root,
        provider: provider('HOLDS'),
        log: (line) => lines.push(line),
        now: () => Date.parse(AT),
        limit: null,
      });
      expect(code).toBe(2);
      expect(lines.join('\n')).toContain('образцов нет');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drains a queued sample through its own connection and answers 0', async () => {
    const dataDir = dataDirWithSample();
    const root = bookRoot(true);
    try {
      const code = await runAuditCli({
        dataDir,
        config: CONFIG,
        bookRoot: root,
        provider: provider('HOLDS'),
        log: () => undefined,
        now: () => Date.parse(AT),
        limit: 3,
      });
      expect(code).toBe(0);
      const db = openDatabase(databaseFile(dataDir));
      try {
        expect(db.prepare('SELECT sample_verdict FROM change_plans WHERE change_id = ?').get('chg_ten')).toEqual({
          sample_verdict: 'ok',
        });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the boot marker', () => {
  it('asks the engine once, and a failed marker is a log line rather than a park', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const engine = {
      writerBoot: async () => {
        calls.push('writerBoot');
        return { marked: true };
      },
    } as unknown as EngineClient;

    await markWriterBoot(engine, (line) => logs.push(line));
    expect(calls).toEqual(['writerBoot']);
    expect(logs).toEqual([]);

    // An engine that cannot answer is evidence, not a refusal: the pass's text still matters.
    const broken = {
      writerBoot: async () => {
        throw new Error('engine is down');
      },
    } as unknown as EngineClient;
    await markWriterBoot(broken, (line) => logs.push(line));
    expect(logs.join('\n')).toContain('boot marker не записан');
  });
});
