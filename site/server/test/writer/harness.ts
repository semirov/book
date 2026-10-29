/**
 * The writer lane's harness: a real engine, a real control API on a loopback port, a real engine
 * client, and a **scripted provider** — no network, no model, no key beyond a temp file.
 *
 * Since BOOK-187 nobody writes a manuscript: the engine fixture seeds chapters as rows, and the
 * writer lane sends its answer to `land`. A test that finds a `manuscript/` under the fixture root
 * is a regression, and several of them assert exactly that.
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { AddressInfo } from 'node:net';

import type { BudgetDto, WriterAssignment } from '@book/shared';

import { buildControl } from '../../src/engine/control.ts';
import { admitPremise } from '../../src/engine/premise.ts';
import { newChangeId } from '../../src/util/ulid.ts';
import { toIso } from '../../src/util/time.ts';
import { loadWriterConfig, type WriterConfig } from '../../src/writer/config.ts';
import { createEngineClient, type EngineClient, type EngineStateView } from '../../src/writer/client.ts';
import type { PipelineUsage } from '../../src/writer/pipeline.ts';
import { runPass, type PassDeps, type PassResult } from '../../src/writer/pass.ts';
import type { ProviderRequest, ProviderResult, WriterMessage } from '../../src/writer/provider.ts';
import { createEngineFixture, type Fixture } from '../engine/helpers.ts';

export const SITE_ROOT = resolve(import.meta.dirname, '..', '..', '..');
/** The book's own root: the canon is read from here, never written. */
export const BOOK_ROOT = resolve(SITE_ROOT, '..');
const PIPELINE = join(SITE_ROOT, 'config', 'pipeline.json');

/** The files the writer's and the gates' prompts quote; a fixture book needs the real canon. */
const CANON_FILES = ['process/ROLE_PROMPTS.md', 'concept/CONCEPT.md', 'concept/CLIMAX.md', 'style/VOICE.md', 'outline/PLAN.md'];

function copyCanon(root: string): void {
  for (const file of CANON_FILES) {
    const target = join(root, file);
    mkdirSync(resolve(target, '..'), { recursive: true });
    copyFileSync(join(BOOK_ROOT, file), target);
  }
}

export const TOKEN = 'writer-harness-token';
export const FAKE_KEY = 'sk-writer-harness-never-print-2b91';

/** Inert Russian prose: long enough for the floor, plain enough for every shape rule. */
const FILLER = 'служебный абзац для проверки объёма страницы, он не является текстом книги. ';

/** A valid chapter answer for any chapter: a title line, four paragraphs, ~2 400 characters. */
export function chapterAnswer(title = 'Глава сорок', marker = ''): string {
  const paragraph = `${FILLER.repeat(4).trim()} ${FILLER.repeat(4).trim()}`;
  const blocks = [0, 1, 2, 3].map(() => (marker.length === 0 ? paragraph : `${paragraph} ${marker}`.trim()));
  return `${title}\n\n${blocks.join('\n\n')}\n`;
}

export type Scripted = string | { text: string; usage: Partial<PipelineUsage> };

export type CallRecord = { messages: WriterMessage[]; maxTokens: number; apiModel: string };

/**
 * The fake engine's money and its call log: what a test needs to prove a guard held, without
 * waiting for a real ledger to fill up.
 */
export type HarnessHooks = {
  /**
   * What the engine answers as `budget`. `undefined` keeps the real snapshot (the fixture's
   * empty ledger), `null` stands for an engine from before the cap.
   */
  budget?: BudgetDto | null;
  /** Runs before every engine call: how a test moves the ledger between the guard and the assignment. */
  beforeCall?: (name: string) => void;
};

export type Harness = {
  fixture: Fixture;
  config: WriterConfig;
  client: EngineClient;
  bookRoot: string;
  dataDir: string;
  calls: CallRecord[];
  script: Scripted[];
  logs: string[];
  /** Every method the pass called on the engine, in order (`state`, `pass`, `escalate`, …). */
  engineCalls: string[];
  hooks: HarnessHooks;
  /** The environment the writer's config was loaded from: what a CLI test hands to `main`. */
  env: NodeJS.ProcessEnv;
  tokenFile: string;
  provider: PassDeps['provider'];
  /**
   * BOOK-187: a chapter is rows, and the fixture published them at creation. `ingest(n)` is the
   * old «the site serves this file» step kept for the tests that say it out loud: it publishes
   * the chapter the harness was created with, and is a no-op when the row is already there.
   */
  ingest(chapter: number): void;
  assignment(chapter: number, session?: string): WriterAssignment;
  premised(chapter: number, intent: string): string;
  /**
   * BOOK-166: a pass exists only to serve a filing. `filed: false` is the no-filing case a test
   * asks for explicitly; anything else gets the reader's premise on the chapter it writes.
   */
  run(options?: {
    chapter?: number | null;
    lanes?: Array<'fwd' | 'bwd' | 'filing'>;
    dryRun?: boolean;
    filed?: boolean;
  }): Promise<PassResult>;
  close(): Promise<void>;
};

/**
 * BOOK-187 AC7: a pass's receipt as the rows it is now — the call rows in order, and the pass's
 * own facts, which travel on the last row (`pass_transcripts.content_redacted`).
 */
export function receiptsOf(
  harness: Harness,
  passId: string,
): {
  rows: Array<{ seq: number; role: string; tokensIn: number; tokensOut: number; facts: Record<string, unknown> }>;
  pass: Record<string, unknown>;
} {
  const rows = harness.fixture.db
    .prepare('SELECT seq, role, tokens_in, tokens_out, content_redacted FROM pass_transcripts WHERE pass_id = ? ORDER BY seq')
    .all(passId) as Array<{ seq: number; role: string; tokens_in: number; tokens_out: number; content_redacted: string }>;
  const parsed = rows.map((row) => ({
    seq: row.seq,
    role: row.role,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    facts: JSON.parse(row.content_redacted) as Record<string, unknown>,
  }));
  const pass = (parsed.at(-1)?.facts.pass ?? {}) as Record<string, unknown>;
  return { rows: parsed, pass };
}

/** The engine's own state, read straight from the fixture's database. */
export function stepRow(fixture: Fixture, stepId: string): Record<string, unknown> | undefined {
  return fixture.db.prepare('SELECT * FROM steps WHERE step_id = ?').get(stepId) as Record<string, unknown> | undefined;
}

export function chapterRow(fixture: Fixture, chapter: number): Record<string, unknown> | undefined {
  return fixture.db.prepare('SELECT * FROM chapters WHERE n = ?').get(chapter) as Record<string, unknown> | undefined;
}

export async function createHarness(options: { chapters?: Record<number, string>; env?: NodeJS.ProcessEnv; token?: string } = {}): Promise<Harness> {
  const fixture = createEngineFixture({ chapters: options.chapters ?? {} });
  copyCanon(fixture.root);
  const app = await buildControl({ engine: fixture.engine, db: fixture.db, token: options.token ?? TOKEN, logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  const engineUrl = `http://127.0.0.1:${String(address.port)}`;

  const secrets = mkdtempSync(join(tmpdir(), 'book-writer-secrets-'));
  const keyFile = join(secrets, 'deepseek.key');
  const tokenFile = join(secrets, 'engine.token');
  writeFileSync(keyFile, `${FAKE_KEY}\n`, { mode: 0o600 });
  writeFileSync(tokenFile, `${options.token ?? TOKEN}\n`, { mode: 0o600 });

  const writerEnv: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    BOOK_ROOT: fixture.root,
    DATA_DIR: fixture.dataDir,
    PIPELINE_PATH: PIPELINE,
    DEEPSEEK_API_KEY_FILE: keyFile,
    ENGINE_TOKEN_FILE: tokenFile,
    WRITER_ENGINE_URL: engineUrl,
    WRITER_SESSION: 'writer-test',
    // A test that wants continuations sets WRITER_CONTINUE_MAX itself.
    WRITER_CONTINUE_MAX: '0',
    ...options.env,
  };
  const config = loadWriterConfig(writerEnv);
  const calls: CallRecord[] = [];
  const logs: string[] = [];
  const script: Scripted[] = [];

  const provider = async (request: ProviderRequest): Promise<ProviderResult> => {
    calls.push({
      messages: request.messages.map((message) => ({ ...message })),
      maxTokens: request.maxTokens,
      apiModel: request.apiModel,
    });
    const next = script.shift();
    if (next === undefined) throw new Error('the provider was called more times than scripted');
    const step = typeof next === 'string' ? { text: next, usage: {} } : next;
    const usage: PipelineUsage = { in: 1_000, out: 200, cachedIn: 0, ...step.usage };
    return { text: step.text, responseModel: config.apiModel, usage, latencyMs: 1, attempts: 1, finishReason: 'stop' };
  };

  const client = createEngineClient({ baseUrl: engineUrl, tokenFile });
  const engineCalls: string[] = [];
  const hooks: HarnessHooks = {};

  /**
   * The real client with two test seams: every call is logged by name, and `state` may answer a
   * scripted `budget`. Nothing else about the engine is faked — the queue, the leases and the
   * stages are the real ones.
   */
  const engine = new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const name = String(property);
      return (...args: unknown[]): unknown => {
        engineCalls.push(name);
        hooks.beforeCall?.(name);
        const result = (value as (...rest: unknown[]) => unknown).apply(target, args);
        if (name !== 'state' || !(result instanceof Promise)) return result;
        return result.then((view: unknown) => {
          if (hooks.budget === undefined) return view;
          return { ...(view as EngineStateView), budget: hooks.budget };
        });
      };
    },
  }) as EngineClient;

  const harness: Harness = {
    fixture,
    config,
    client,
    bookRoot: fixture.root,
    dataDir: fixture.dataDir,
    calls,
    script,
    logs,
    engineCalls,
    hooks,
    env: writerEnv,
    tokenFile,
    provider,
    ingest: (chapter: number) => {
      const text = (options.chapters ?? {})[chapter];
      if (text !== undefined && fixture.readChapter(chapter) === null) fixture.seedChapter(chapter, text);
    },
    assignment: (chapter, session = 'writer-test') => fixture.engine.openChapterPass(chapter, session) as WriterAssignment,
    premised: (chapter, intent) => {
      // The owner's intervention on an empty slot: base_rev 0, no anchor, no FIFO lane (BOOK-7).
      const id = newChangeId(fixture.clock.now());
      admitPremise(fixture.db, {
        id,
        kind: 'operator',
        chapter,
        intent,
        interventionKind: 'document',
        sourceComment: null,
        sourceSession: null,
        at: toIso(fixture.clock.now()),
      });
      return id;
    },
    run: (runOptions = {}) => {
      // BOOK-166: the default is a real filing on the chapter the pass writes — a pass without
      // one is exactly what the lane now refuses, so a test that wants it says `filed: false`.
      if (runOptions.filed !== false && runOptions.dryRun !== true && runOptions.chapter != null) {
        const chapter = runOptions.chapter;
        const existing = fixture.db
          .prepare(`SELECT COUNT(*) AS n FROM changes WHERE premise = 1 AND chapter = ? AND status = 'pending'`)
          .get(chapter) as { n: number };
        if (existing.n === 0) {
          harness.premised(chapter, `замысел главы ${String(chapter)}: читатель просит начать с документа`);
        }
      }
      return runPass({
        config,
        bookRoot: fixture.root,
        engine,
        provider,
        now: () => fixture.clock.now(),
        log: (line) => logs.push(line),
        chapter: runOptions.chapter ?? null,
        lanes: runOptions.lanes ?? ['fwd', 'bwd'],
        dryRun: runOptions.dryRun ?? false,
      });
    },
    close: async () => {
      await app.close();
      fixture.close();
      rmSync(secrets, { recursive: true, force: true });
    },
  };
  return harness;
}
