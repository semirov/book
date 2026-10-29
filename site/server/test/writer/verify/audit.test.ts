/**
 * `writer --audit-samples` (BOOK-DOC-80 §"The safeguard"): the editor re-reads a queued `local
 * only` change and its answer is compared with the Tier-1 word the change was closed on.
 *
 * Three outcomes, three records, and the exit code that says which happened:
 *
 *   · agreement → `sample_verdict = ok`, `0`;
 *   · disagreement → an alert, the finding attached to the change, `local_only_rechecked`, `1`;
 *   · the editor fails → `sample_verdict = error`, the sample **stays queued**, `2` when nothing
 *     could be read at all.
 *
 * The provider is scripted and the book is a temp directory: no model is called and nothing outside
 * the fixture database is written.
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../src/db/db.ts';
import { migrate } from '../../../src/db/migrate.ts';
import { recordVerification } from '../../../src/ledger/graph/verification.ts';
import type { WriterConfig } from '../../../src/writer/config.ts';
import type { ProviderRequest, ProviderResult } from '../../../src/writer/provider.ts';
import { AUDIT_WATERMARK_KEY, runAuditSamples } from '../../../src/writer/verify/audit.ts';
import { seedChapter } from '../../ledger/helpers.ts';
import { inertProse } from '../inert.ts';

const AT = '2026-10-28T12:00:00Z';
const SITE_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const BOOK_ROOT = resolve(SITE_ROOT, '..');
/** The gate prompt quotes the canon, so the fixture book carries it (read-only, copied in). */
const CANON = ['process/ROLE_PROMPTS.md', 'concept/CONCEPT.md', 'concept/CLIMAX.md', 'style/VOICE.md', 'outline/PLAN.md'];
const CHAPTER = 12;
const LOCAL = { gatesMode: 'local only' as const, why: null, tier1Verdict: 'HOLDS' as const, tier1Usd: 0.003 };

/** A config whose provider seam the test scripts: nothing here reaches the network. */
function config(): WriterConfig {
  return {
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
}

type Fixture = { db: Db; bookRoot: string; close: () => void };

function fixture(chapterText: string | null = null): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'book-audit-root-'));
  mkdirSync(join(root, 'manuscript'), { recursive: true });
  for (const file of CANON) {
    const target = join(root, file);
    mkdirSync(resolve(target, '..'), { recursive: true });
    copyFileSync(join(BOOK_ROOT, file), target);
  }
  const db = openDatabase(':memory:');
  migrate(db);
  // BOOK-187: the book is rows, so the fixture publishes the chapter the audit reads.
  if (chapterText !== null) {
    const [title, ...blocks] = chapterText.trim().split('\n\n');
    seedChapter(db, { chapter: CHAPTER, title: title ?? '', texts: blocks, at: AT });
  }
  return {
    db,
    bookRoot: root,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** One closed `local only` change at a sampled `seq`, with the plan row the audit drains. */
function queuedSample(database: Db, seq: number): string {
  database.prepare(
    `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
                          status, enqueued_at, seq)
     VALUES (?, 'operator', ?, 'служебное намерение', 1, 'sha', '[]', 'phrase', 'done', ?, ?)`,
  ).run(`chg_${String(seq)}`, CHAPTER, AT, seq);
  database
    .prepare(
      `INSERT INTO change_plans (id, change_id, chapter, outcome, closure, patches, bounds, created_at)
       VALUES (?, ?, ?, 'local', '{}', '[]', '{}', ?)`,
    )
    .run(`pln_${String(seq)}`, `chg_${String(seq)}`, CHAPTER, AT);
  recordVerification(database, { changeId: `chg_${String(seq)}`, chapter: CHAPTER, stepId: `stp_${String(seq)}` }, LOCAL, AT);
  return `chg_${String(seq)}`;
}

function providerOf(answers: Array<string | Error>): (request: ProviderRequest) => Promise<ProviderResult> {
  return async (request) => {
    const next = answers.shift();
    if (next === undefined) throw new Error('the provider was called more times than scripted');
    if (next instanceof Error) throw next;
    return {
      text: next,
      responseModel: request.apiModel,
      usage: { in: 100, out: 20, cachedIn: 0 },
      latencyMs: 1,
      attempts: 1,
      finishReason: 'stop',
    };
  };
}

function sampleRow(database: Db, changeId: string): { sample_verdict: string | null; sampled_at: string | null; gates_mode: string } {
  return database
    .prepare('SELECT sample_verdict, sampled_at, gates_mode FROM change_plans WHERE change_id = ?')
    .get(changeId) as { sample_verdict: string | null; sampled_at: string | null; gates_mode: string };
}

function alertCount(database: Db): number {
  const row = database.prepare(`SELECT v FROM meta WHERE k = 'engine.alerts'`).get() as { v: string } | undefined;
  return row === undefined ? 0 : Number((JSON.parse(row.v) as { count: number }).count);
}

let fixtureNow: Fixture;

beforeEach(() => {
  fixtureNow = fixture(`Глава двенадцатая\n\n${inertProse(2_000)}`);
});

afterEach(() => {
  fixtureNow.close();
});

describe('an audit that agrees', () => {
  it('records `ok` and answers 0', async () => {
    const changeId = queuedSample(fixtureNow.db, 10);
    const lines: string[] = [];
    const code = await runAuditSamples({
      db: fixtureNow.db,
      config: config(),
      bookRoot: fixtureNow.bookRoot,
      provider: providerOf(['HOLDS']),
      log: (line) => lines.push(line),
      now: () => Date.parse(AT),
    });
    expect(code).toBe(0);
    expect(sampleRow(fixtureNow.db, changeId)).toMatchObject({ sample_verdict: 'ok', gates_mode: 'local only' });
    expect(sampleRow(fixtureNow.db, changeId).sampled_at).not.toBeNull();
    expect(alertCount(fixtureNow.db)).toBe(0);
    expect(lines.join('\n')).toContain('согласны');
  });
});

describe('an audit that disagrees', () => {
  it('raises the alert, corrects the record and answers 1', async () => {
    const changeId = queuedSample(fixtureNow.db, 10);
    const lines: string[] = [];
    const code = await runAuditSamples({
      db: fixtureNow.db,
      config: config(),
      bookRoot: fixtureNow.bookRoot,
      provider: providerOf(['GAP\nmajor · первый час шёл снег · образ не держит · вернуть прежнее']),
      log: (line) => lines.push(line),
      now: () => Date.parse(AT),
    });
    expect(code).toBe(1);
    // The row no longer claims a clean local read, and the sample is done.
    expect(sampleRow(fixtureNow.db, changeId)).toMatchObject({ sample_verdict: 'gap', gates_mode: 'local_only_rechecked' });
    // The finding is attached to the change itself.
    const events = fixtureNow.db
      .prepare(`SELECT type, meta FROM change_events WHERE change_id = ? AND type = 'sample_gap'`)
      .all(changeId) as Array<{ type: string; meta: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.meta ?? '{}').finding).toContain('образ не держит');
    expect(alertCount(fixtureNow.db)).toBe(1);
    expect(lines.join('\n')).toContain('расхождение');
  });

  it('raises a second alert when two of the last twenty samples disagree', async () => {
    // Two samples, both disagreements: the judge is drifting, not the change.
    queuedSample(fixtureNow.db, 10);
    queuedSample(fixtureNow.db, 20);
    const gap = 'GAP\nmajor · цитата из фрагмента · дефект · правка';
    const code = await runAuditSamples({
      db: fixtureNow.db,
      config: config(),
      bookRoot: fixtureNow.bookRoot,
      provider: providerOf([gap, gap]),
      log: () => undefined,
      now: () => Date.parse(AT),
    });
    expect(code).toBe(1);
    // Two sample alerts plus the drift alert.
    expect(alertCount(fixtureNow.db)).toBe(3);
    const last = fixtureNow.db.prepare(`SELECT v FROM meta WHERE k = 'engine.alerts'`).get() as { v: string };
    expect((JSON.parse(last.v) as { last: { detail: string } }).last.detail).toContain('дрейфует');
  });
});

describe('an audit run twice over the same queue', () => {
  it('alerts once per failed read, not once per run', async () => {
    queuedSample(fixtureNow.db, 10);
    queuedSample(fixtureNow.db, 20);
    const down = () => providerOf([new Error('the model is down'), new Error('the model is down')]);
    const run = () =>
      runAuditSamples({
        db: fixtureNow.db,
        config: config(),
        bookRoot: fixtureNow.bookRoot,
        provider: down(),
        log: () => undefined,
        now: () => Date.parse(AT),
      });
    // Two samples the editor could not read: one alert about the fact, and the samples stay queued.
    expect(await run()).toBe(2);
    expect(alertCount(fixtureNow.db)).toBe(1);
    // The same queue, the same failure: the alert stands, it is not raised again.
    expect(await run()).toBe(2);
    expect(alertCount(fixtureNow.db)).toBe(1);
  });

  it('raises the drift alert once per crossing, not on every run that still sees it', async () => {    queuedSample(fixtureNow.db, 10);
    queuedSample(fixtureNow.db, 20);
    const gap = 'GAP\nmajor · цитата из фрагмента · дефект · правка';
    const run = (answers: string[]) =>
      runAuditSamples({
        db: fixtureNow.db,
        config: config(),
        bookRoot: fixtureNow.bookRoot,
        provider: providerOf(answers),
        log: () => undefined,
        now: () => Date.parse(AT),
      });
    expect(await run([gap, gap])).toBe(1);
    // Two disagreements, then the drift: the crossing is reported once.
    expect(alertCount(fixtureNow.db)).toBe(3);

    // Two more disagreements inside the same window: their own alerts, and no second drift alert.
    queuedSample(fixtureNow.db, 30);
    queuedSample(fixtureNow.db, 40);
    expect(await run([gap, gap])).toBe(1);
    expect(alertCount(fixtureNow.db)).toBe(5);
  });

  it('alerts again on a watermark nobody can read: a lost record is not a reason to stay silent', async () => {
    queuedSample(fixtureNow.db, 10);
    queuedSample(fixtureNow.db, 20);
    fixtureNow.db
      .prepare(`INSERT INTO meta (k, v) VALUES (?, 'not json') ON CONFLICT(k) DO UPDATE SET v = 'not json'`)
      .bind(AUDIT_WATERMARK_KEY)
      .run();
    const code = await runAuditSamples({
      db: fixtureNow.db,
      config: config(),
      bookRoot: fixtureNow.bookRoot,
      provider: providerOf([new Error('down'), new Error('down')]),
      log: () => undefined,
      now: () => Date.parse(AT),
    });
    expect(code).toBe(2);
    expect(alertCount(fixtureNow.db)).toBe(1);
  });
});

describe('an audit that could not read', () => {
  it('keeps the sample queued and answers 2 when nothing could be read', async () => {
    const changeId = queuedSample(fixtureNow.db, 10);
    const code = await runAuditSamples({
      db: fixtureNow.db,
      config: config(),
      bookRoot: fixtureNow.bookRoot,
      provider: providerOf([new Error('the model is down')]),
      log: () => undefined,
      now: () => Date.parse(AT),
    });
    expect(code).toBe(2);
    expect(sampleRow(fixtureNow.db, changeId)).toMatchObject({ sample_verdict: 'error', gates_mode: 'local only' });
    expect(sampleRow(fixtureNow.db, changeId).sampled_at).toBeNull();
  });

  it('keeps an unparsable editor answer queued too', async () => {
    const changeId = queuedSample(fixtureNow.db, 10);
    const code = await runAuditSamples({
      db: fixtureNow.db,
      config: config(),
      bookRoot: fixtureNow.bookRoot,
      provider: providerOf(['наверное, всё хорошо']),
      log: () => undefined,
      now: () => Date.parse(AT),
    });
    expect(code).toBe(2);
    expect(sampleRow(fixtureNow.db, changeId).sample_verdict).toBe('error');
  });

  it('keeps a sample whose chapter is gone queued, and says so', async () => {
    const changeId = queuedSample(fixtureNow.db, 10);
    // BOOK-187: the chapter is gone when its rows are — there is no file to remove.
    fixtureNow.db.prepare('DELETE FROM blocks WHERE chapter = ?').run(CHAPTER);
    fixtureNow.db.prepare('DELETE FROM chapters WHERE n = ?').run(CHAPTER);
    const lines: string[] = [];
    const code = await runAuditSamples({
      db: fixtureNow.db,
      config: config(),
      bookRoot: fixtureNow.bookRoot,
      provider: providerOf([]),
      log: (line) => lines.push(line),
      now: () => Date.parse(AT),
    });
    expect(code).toBe(2);
    expect(sampleRow(fixtureNow.db, changeId).sample_verdict).toBe('error');
    expect(lines.join('\n')).toContain('остаётся в очереди');
  });

  it('answers 0 with an empty queue: nothing to do is drained', async () => {
    const code = await runAuditSamples({
      db: fixtureNow.db,
      config: config(),
      bookRoot: fixtureNow.bookRoot,
      provider: providerOf([]),
      log: () => undefined,
      now: () => Date.parse(AT),
    });
    expect(code).toBe(0);
  });
});
