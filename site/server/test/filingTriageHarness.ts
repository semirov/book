/**
 * The BOOK-206 (ADR-045) harness: the real site app, the real engine, the real control API and
 * the writer's own client — with a **scripted** provider and no port, no model, no key beyond a
 * temp file.
 *
 * It is a module rather than a describe block because the chain and its guards are two suites:
 * one proves a filing moves, the other proves every way it must not. Both need the same seven
 * seams, so the seams live here once.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';

import { bootComments, commentBody, type Harness } from './comments/helpers.ts';
import { insertComment } from '../src/comments/repo.ts';
import type { Db } from '../src/db/db.ts';
import { buildControl } from '../src/engine/control.ts';
import { createEngine } from '../src/engine/service.ts';
import type { EngineAlert } from '../src/engine/types.ts';
import { poll } from '../src/feedback/triageApplier.ts';
import { chapterVocabulary } from '../src/feedback/vocabulary.ts';
import { createEngineClient, type EngineClient, type FetchLike } from '../src/writer/client.ts';
import { loadWriterConfig, type WriterConfig } from '../src/writer/config.ts';
import type { PipelineUsage } from '../src/writer/pipeline.ts';
import type { ProviderRequest, ProviderResult } from '../src/writer/provider.ts';
import { runTriage } from '../src/writer/triage.ts';

const SITE_ROOT = resolve(import.meta.dirname, '..', '..');
/** The book's own root: the role prompt is read from here, never written. */
export const BOOK_ROOT = resolve(SITE_ROOT, '..');
const PIPELINE = join(SITE_ROOT, 'config', 'pipeline.json');
const TOKEN = 'triage-test-token';
export const QUOTE = 'Тестовый абзац номер один.';
export const BLOCK_TEXT = 'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.';
export const WORDING = 'В регистратуре выдают уведомление: срок тридцать дней и подпись.';
/** A goal sentence that is not a prose order and names nothing new in the chapter. */
export const INTENT = 'в абзаце сказано, что это служебный текст';
const EVIDENCE = 'Это служебный текст, он не является текстом книги';

export type Call = { request: ProviderRequest; itemId: string; world: string; system: string; user: string };

export type Context = {
  h: Harness;
  db: Db;
  engine: ReturnType<typeof createEngine>;
  client: EngineClient;
  config: WriterConfig;
  alerts: EngineAlert[];
  calls: Call[];
  frames: Array<{ type: string; data: unknown }>;
  post: (overrides?: { body?: string; quote?: string; proposedText?: string }) => Promise<string>;
  script: Array<Record<string, unknown>>;
  /** What the scripted provider reports as usage; `estimated` is BOOK-219's «read off the text». */
  reportUsage: (usage: PipelineUsage) => void;
  pulse: () => Promise<void>;
  place: () => number;
  close: () => Promise<void>;
};

/** The prompt's payload: the fence line, the JSON between two identical fence lines. */
function payloadOf(user: string): { envelope: Record<string, unknown>; world: string | null } {
  const lines = user.split('\n');
  const start = lines.findIndex((line) => line.startsWith('<<<DATA'));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.indexOf(lines[start] ?? '', start + 1);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(lines.slice(start + 1, end).join('\n')) as {
    envelope: Record<string, unknown>;
    world: string | null;
  };
}

/** The writer's client over the control app's own `inject` — no port, no socket. */
function shim(control: FastifyInstance): FetchLike {
  return async (url, init) => {
    const parsed = new URL(url);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    const answer = await control.inject({
      // The client's GETs (`/internal/state`, `/internal/writer-state`) are the same app, so the
      // method travels: a shim that always POSTed made those two doors look like a 500.
      method: (init.method === 'GET' ? 'GET' : 'POST'),
      url: `${parsed.pathname}${parsed.search}`,
      headers,
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
    });
    return new Response(answer.body, { status: answer.statusCode, headers: { 'content-type': 'application/json' } });
  };
}

/** One `book.verdict/v1` answer quoting the world, with the reading the test wants to place. */
export function answerOf(
  call: Pick<Call, 'itemId'>,
  verdict: 'FITS' | 'OFF',
  reading: Record<string, unknown>,
  evidence: Array<{ field: string; quote: string }> = [{ field: 'world', quote: EVIDENCE }],
): Record<string, unknown> {
  return {
    envelope: 'book.verdict/v1',
    itemId: call.itemId,
    gate: 'C',
    verdict,
    rule: null,
    evidence,
    reason: verdict === 'OFF' ? 'вне книги: бумага не меняет ни одного факта' : null,
    reading,
  };
}

/** The FITS reading every ordinary filing gets: the words stand as said. */
export function asSaid(): Record<string, unknown> {
  return { rung: 'as_said', lock: null, intent: INTENT, carrier: null, refusal: null };
}

/** A `through_paper` reading whose carrier cannot be licensed (two kept words, not five). */
export function unlicensedPaper(): Record<string, unknown> {
  return {
    rung: 'through_paper',
    lock: null,
    intent: INTENT,
    carrier: { kind: 'document', quoteKept: 'тридцать дней', factsChanged: 1 },
    refusal: null,
  };
}

export function attemptOf(db: Db, id: string, n = 1): Record<string, unknown> {
  return db.prepare('SELECT * FROM comment_attempts WHERE comment_id = ? AND n = ?').get(id, n) as Record<string, unknown>;
}

export function changeOf(db: Db): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM changes').get() as Record<string, unknown> | undefined;
}

export async function bootTriage(): Promise<Context> {
  const h = await bootComments();
  const alerts: EngineAlert[] = [];
  const engine = createEngine({
    db: h.db,
    // A pass is handed out only while the owner's switch is on; the lane claim is part of the
    // chain the suite proves, so the switch is on here exactly as it is in the writer container.
    config: { ...h.config, drafting: 'on' },
    bookRoot: h.fixture.root,
    clock: { now: () => h.clock.ms },
    alert: (alert) => alerts.push(alert),
  });
  const control = await buildControl({
    engine,
    token: TOKEN,
    db: h.db,
    logger: false,
    vocabulary: (chapter) => chapterVocabulary(h.db, chapter),
  });
  const client = createEngineClient({ baseUrl: 'http://engine.test', token: TOKEN, fetch: shim(control) });

  const secrets = mkdtempSync(join(tmpdir(), 'book-triage-secrets-'));
  const keyFile = join(secrets, 'deepseek.key');
  writeFileSync(keyFile, 'sk-triage-test-never-print\n', { mode: 0o600 });
  const config = loadWriterConfig({
    NODE_ENV: 'test',
    BOOK_ROOT: h.fixture.root,
    DATA_DIR: h.fixture.dataDir,
    PIPELINE_PATH: PIPELINE,
    DEEPSEEK_API_KEY_FILE: keyFile,
    ENGINE_TOKEN_FILE: join(secrets, 'engine.token'),
    WRITER_SESSION: 'writer-triage-test',
  });

  const calls: Call[] = [];
  const script: Array<Record<string, unknown>> = [];
  const frames: Array<{ type: string; data: unknown }> = [];
  // What the provider says it spent. A test sets it to `estimated: true` for the BOOK-219 shape:
  // an answer with no usage object, whose counts the writer read off the text.
  let reportedUsage: PipelineUsage = { in: 1_200, out: 300, cachedIn: 0 };
  // The scripted provider: it answers the next scripted object, standing in for the pinned model.
  // An empty script is a broken call, which is what the failure bounds are proven against.
  const provider = async (request: ProviderRequest): Promise<ProviderResult> => {
    const user = request.messages.find((message) => message.role === 'user')?.content ?? '';
    const system = request.messages.find((message) => message.role === 'system')?.content ?? '';
    const payload = payloadOf(user);
    calls.push({ request, itemId: String(payload.envelope.itemId), world: payload.world ?? '', system, user });
    const next = script.shift();
    if (next === undefined) throw new Error('the provider was called more times than scripted');
    return {
      text: JSON.stringify(next),
      responseModel: config.apiModel,
      usage: reportedUsage,
      latencyMs: 1,
      attempts: 1,
      finishReason: 'stop',
    };
  };

  return {
    h,
    db: h.db,
    engine,
    client,
    config,
    alerts,
    calls,
    frames,
    script,
    reportUsage: (usage) => {
      reportedUsage = usage;
    },
    post: async (overrides = {}) => {
      const block = h.db.prepare('SELECT id FROM blocks WHERE chapter = 8 ORDER BY idx LIMIT 1').get() as {
        id: string;
      };
      const posted = await h.app.inject({
        method: 'POST',
        url: '/api/comments',
        headers: h.headers(),
        payload: commentBody({
          chapter: 8,
          blockId: block.id,
          quote: overrides.quote ?? QUOTE,
          body: overrides.body ?? 'Бумага вместо сцены.',
          proposedText: overrides.proposedText ?? WORDING,
        }),
      });
      expect(posted.statusCode).toBe(201);
      return posted.json().comment.id as string;
    },
    pulse: async () => {
      await runTriage({ config, bookRoot: BOOK_ROOT, engine: client, provider, now: () => h.clock.ms, log: () => {} });
    },
    place: () =>
      poll({
        db: h.db,
        emit: (type, data) => frames.push({ type, data }),
        notify: () => {},
        now: h.clock.now,
      }),
    close: async () => {
      await control.close();
      await h.close();
      rmSync(secrets, { recursive: true, force: true });
    },
  };
}

/**
 * One filing in the shape the old ladder left behind: gate C answered OFF, the author's question
 * was written on the row, and the audit's answer closed attempt 1 as `held`. Seeded with SQL
 * rather than the CLI so a test states the shape it is testing.
 */
export function seedEscalated(context: Context, id: string): void {
  const { db, h } = context;
  const block = db.prepare('SELECT id FROM blocks WHERE chapter = 8 ORDER BY idx LIMIT 1').get() as { id: string };
  const sentence = db.prepare('SELECT id FROM sentences WHERE block_id = ? ORDER BY idx LIMIT 1').get(block.id) as {
    id: string;
  };
  insertComment(db, {
    id,
    identityId: h.identity.id,
    chapter: 8,
    blockId: block.id,
    blockIndex: 0,
    baseRev: 1,
    quote: QUOTE,
    prefix: null,
    suffix: null,
    sentenceId: sentence.id,
    selStart: 0,
    selEnd: QUOTE.length,
    author: 'Аня',
    body: 'он чихнул',
    proposedText: WORDING,
    interventionKind: 'decision',
    bodySha: `sha-${id}`,
    flags: [],
    ipHash: `ip-${id}`,
    status: 'escalated',
    guard: null,
    reason: 'можно ли оформить это бумагой?',
    createdAt: new Date(h.clock.ms).toISOString(),
    idemKey: null,
  });
  const at = new Date(h.clock.ms).toISOString();
  db.prepare(
    `UPDATE comments
        SET disposition = 'escalated', audit_verdict = 'OFF', audit_reason = 'вне книги', audited_at = ?,
            audited_by = 'cli', decided_at = ?, rights_verdict = 'CLEAR', rights_source = 'scan', rights_at = ?
      WHERE id = ?`,
  ).run(at, at, at, id);
  db.prepare(
    `INSERT INTO comment_attempts (comment_id, n, at, day, body_sha, anchor_sha, quote, outcome, decided_at)
     VALUES (?, 1, ?, ?, ?, 'anchor-owner', ?, 'held', ?)`,
  ).run(id, at, at.slice(0, 10), `sha-${id}`, QUOTE, at);
}
