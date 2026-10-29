/**
 * The totality matrix's machinery: one chain (site app, real engine, real control API, the
 * writer's own client, scripted providers), the rows a decision leaves, and the two sinks
 * asserted in one place — so no cell of the matrix can check half a fact.
 *
 * What a cell asserts, together and every time (owner's rule, 2026-10-29):
 *
 *   · the chapter's revision — it moves only when the change is `done · applied`;
 *   · `changes.status/outcome` — `done · applied` or `void · dropped`, never a third word;
 *   · `comments.status` — the row's own word and the DTO the page reads, which is what the
 *     frame prints; the screen and the chapter cannot disagree;
 *   · the frames the page receives — one `change:decided` for the change and one
 *     `comment:decision` for the filing, each exactly once (a second bridge tick repeats none).
 *
 * The sentences are checked here too: a cell that ends in a refusal must never print one of
 * the retired words, and a technical failure must say it was ours.
 */

import { expect } from 'vitest';

import { readCommentRow, toCommentDto } from '../../src/comments/repo.ts';
import { EngineBridge } from '../../src/engineState/bridge.ts';
import { listStages } from '../../src/stages/repo.ts';
import { createEngineClient, type EngineClient } from '../../src/writer/client.ts';
import type { PassDeps, PassResult } from '../../src/writer/pass.ts';
import { runPass } from '../../src/writer/pass.ts';
import { ProviderError, type ProviderRequest, type ProviderResult } from '../../src/writer/provider.ts';
import { INTENT, bootTriage, shim, TOKEN, type Context } from '../filingTriageHarness.ts';
import { BOOK_ROOT } from '../writer/harness.ts';

export { INTENT };

/** The chapter the ordinary filing lives on: written before the chain starts. */
export const CHAPTER = 8;
/** An empty slot: its filing is a premise, and its first pass has no paragraph to patch. */
export const EMPTY_CHAPTER = 9;
/** A wording the floor's own intent guard refuses: the sixth attempt cannot apply «как сказано». */
export const GUARDED = 'сократи абзац и убери повтор';

/** The words the owner retired: a filing's last sentence may not end in one of them. */
export const RETIRED = ['исчерпано', 'остановлено', 'застряло', 'остаётся в очереди', 'проверка не ответила'] as const;

/** The one sentence a technical failure owes: it says the idea was not judged. */
/**
 * The word our failure keeps in the merged vocabulary (BOOK-218): `не дошло` — the filing was
 * never judged, and no sentence about the idea may appear beside it.
 */
export const TECHNICAL = 'не дошло';

const FILLER = 'Служебный абзац для проверки объёма страницы. Он не является текстом книги. ';
/** 1 215 characters: under the wall bound, and ten of them clear the 10 000 thin line. */
const BLOCK = FILLER.repeat(12).trim();
/** The same length in short sentences: every one is under the tier-0 bound (320 code points). */
const SHORT = 'Служебное предложение для объёма страницы, не текст книги. ';

/**
 * The chain's chapter 8: a written page above the thin line, so a pass that lands it buys no
 * continuation. The first paragraph carries the quote every block filing anchors to.
 */
export function longChapter(): string {
  const short = SHORT.repeat(22).trim();
  const blocks = ['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.', ...Array.from({ length: 9 }, () => short)];
  return `Глава восемь\n\n${blocks.join('\n\n')}\n`;
}

/** The one chain every cell runs on: the site's app, the engine, the control API and the client. */
export function bootChain(): Promise<Context> {
  return bootTriage({ chapters: { 'ch08.md': longChapter() } });
}

/**
 * A valid chapter answer: a title line and eight paragraphs, long enough that the pass buys no
 * continuation. `marker` lands in the last block — a fact-shaped carrier when a cell needs one.
 */
export function longAnswer(marker = ''): string {
  const blocks = Array.from({ length: 10 }, () => BLOCK);
  if (marker.length > 0) blocks[7] = `${BLOCK} ${marker}`;
  return `Глава восемь\n\n${blocks.join('\n\n')}\n`;
}

/** One provider step: an answer, or the provider's own failure (the transport's error). */
export type Step = string | { fail: 'PROVIDER_SHAPE' | 'PROVIDER_TIMEOUT' };

/** A provider that plays a plan; a call past its end is a test error, never a silent default. */
export function scripted(apiModel: string, steps: readonly Step[]): {
  provider: PassDeps['provider'];
  calls: () => number;
} {
  let index = 0;
  const provider = async (request: ProviderRequest): Promise<ProviderResult> => {
    const step = steps[index];
    index += 1;
    if (step === undefined) {
      throw new Error(`the provider was called ${String(index)} times, the plan holds ${String(steps.length)}: ${request.apiModel}`);
    }
    if (typeof step === 'string') {
      return {
        text: step,
        responseModel: apiModel,
        usage: { in: 1_000, out: 200, cachedIn: 0 },
        latencyMs: 1,
        attempts: 1,
        finishReason: 'stop',
      };
    }
    throw new ProviderError(step.fail, 2);
  };
  return { provider, calls: () => index };
}

/**
 * A patch answer in the shape BOOK-173's writer asks for: one named block, its old text and the
 * new one. The landing cells write a candidate; a chapter-length answer is not what a phrase
 * filing's prompt asks for.
 */
export function patchAnswer(ctx: Context, chapter = 8): string {
  const row = ctx.db
    .prepare('SELECT id, text FROM blocks WHERE chapter = ? ORDER BY idx LIMIT 1')
    .get(chapter) as { id: string; text: string } | undefined;
  if (row === undefined) throw new Error(`chapter ${String(chapter)} has no blocks to patch`);
  return JSON.stringify({
    mode: 'patch',
    edits: [{ blockId: row.id, oldText: row.text, newText: `${row.text} Так сказано в заявке.` }],
    facts: [],
    note: 'totality: one phrase',
  });
}

/**
 * The answers a whole pass needs, chosen by the prompt it is sent: the pen's one patch, `HOLDS`
 * for the prose gates, `CLEAR` for Gate B. The rights gate is the only one whose header says so.
 */
export function chainedAnswers(ctx: Context): { provider: PassDeps['provider']; calls: () => number } {
  let index = 0;
  const provider = async (request: ProviderRequest): Promise<ProviderResult> => {
    index += 1;
    const prompt = request.messages.map((message) => message.content).join('\n');
    const text = index === 1 ? patchAnswer(ctx) : prompt.includes('# RIGHTS') ? 'CLEAR' : 'HOLDS';
    return {
      text,
      responseModel: request.apiModel,
      usage: { in: 1_000, out: 200, cachedIn: 0 },
      latencyMs: 1,
      attempts: 1,
      finishReason: 'stop',
    };
  };
  return { provider, calls: () => index };
}

/** One client over the same control app, whose `land` route fails `times` transport attempts. */
export function landThatFails(ctx: Context, times: number): { client: EngineClient; attempts: () => number } {
  const delegate = shim(ctx.control);
  let left = times;
  let attempts = 0;
  const client = createEngineClient({
    baseUrl: 'http://engine.test',
    token: TOKEN,
    fetch: async (url, init) => {
      if (new URL(url).pathname === '/internal/land') {
        attempts += 1;
        if (left > 0) {
          left -= 1;
          throw new Error('injected transport failure');
        }
      }
      return await delegate(url, init);
    },
  });
  return { client, attempts: () => attempts };
}

/** Run one real pass on the chain's lane: the oldest undecided filing, as the container does. */
export function runThePass(
  ctx: Context,
  provider: PassDeps['provider'],
  engine: EngineClient = ctx.client,
): Promise<PassResult> {
  return runPass({
    config: ctx.config,
    bookRoot: BOOK_ROOT,
    engine,
    provider,
    now: () => ctx.h.clock.ms,
    log: () => {},
    chapter: null,
    lanes: ['filing'],
  });
}

/** One cell of the matrix: the chain it ran on, and the rows a sink is read from. */
export type Cell = {
  ctx: Context;
  chapter: number;
  commentId: string;
  /** `null` when no change was ever created (a read refused before the lane saw it). */
  changeId: string | null;
  /** The chapter's revision before the stage started. */
  revBefore: number;
  result?: PassResult;
  /** The provider calls the stage spent. */
  calls?: number;
};

export type Frame = { type: string; data: Record<string, unknown> };

export type Facts = {
  rev: number;
  change: { status: string; outcome: string | null; reason: string | null; attempts: number } | null;
  row: { status: string; disposition: string | null; reason: string | null };
  dto: { status: string; reason: string | null; retryable: boolean; applied: { chapter: number; rev: number } | null; disposition: string | null };
  frames: Frame[];
  changeFrames: Frame[];
  commentFrames: Frame[];
  readingFrames: Frame[];
  stages: Array<{ stage: string; summary: string }>;
  alerts: string[];
};

/** The chapter's current revision; 0 for a chapter that has no row yet. */
export function chapterRev(ctx: Context, chapter: number): number {
  const row = ctx.db.prepare('SELECT rev FROM chapters WHERE n = ?').get(chapter) as { rev: number } | undefined;
  return row?.rev ?? 0;
}

/** Every frame the page can receive for this chain, plus a second tick that must repeat none. */
function framesOf(ctx: Context): { frames: Frame[]; repeated: number } {
  const drained: Frame[] = [];
  const bridge = new EngineBridge({
    db: ctx.db,
    emit: (type, data) => drained.push({ type: String(type), data: data as Record<string, unknown> }),
    replay: true,
    progressThrottleMs: 0,
    now: () => ctx.h.clock.ms,
  });
  bridge.prime();
  bridge.tick();
  const first = drained.length;
  bridge.tick();
  const frames: Frame[] = [
    ...ctx.frames.map((frame) => ({ type: frame.type, data: frame.data as Record<string, unknown> })),
    ...drained,
  ];
  return { frames, repeated: drained.length - first };
}

export function factsOf(cell: Cell): Facts {
  const { ctx } = cell;
  const raw = readCommentRow(ctx.db, cell.commentId);
  expect(raw).toBeDefined();
  const dto = toCommentDto(ctx.db, raw!, ctx.h.clock.ms);
  const change =
    cell.changeId === null
      ? null
      : (ctx.db
          .prepare('SELECT status, outcome, reason, attempts FROM changes WHERE id = ?')
          .get(cell.changeId) as Facts['change']);
  const { frames, repeated } = framesOf(ctx);
  expect(repeated, 'a second tick re-narrated a fact the first one already told').toBe(0);
  const changeFrames = frames.filter((frame) => frame.type === 'change:decided' && frame.data.id === cell.changeId);
  const commentFrames = frames.filter((frame) => frame.type === 'comment:decision' && frame.data.id === cell.commentId);
  // §10.1 (BOOK-220): the reading's own frames are the page's word while a filing is being read.
  const readingFrames = frames.filter(
    (frame) => frame.type === 'filing:reading' && frame.data.commentId === cell.commentId,
  );
  return {
    rev: chapterRev(ctx, cell.chapter),
    change: change ?? null,
    row: { status: raw!.status, disposition: raw!.disposition ?? null, reason: raw!.reason ?? null },
    dto: {
      status: dto.status,
      reason: dto.reason ?? null,
      retryable: dto.retryable === true,
      applied: dto.applied ?? null,
      disposition: dto.disposition ?? null,
    },
    frames,
    changeFrames,
    commentFrames,
    readingFrames,
    stages: listStages(ctx.db, cell.chapter, { limit: 200 }).map((stage) => ({
      stage: String(stage.stage),
      summary: stage.summary,
    })),
    alerts: ctx.alerts.map((alert) => alert.detail ?? ''),
  };
}

/** `written` and `refused` are the two sinks; `accepted` is the triage read placed at its rung. */
export type Sink = 'written' | 'refused' | 'accepted';

export type Want = {
  sink: Sink;
  /** The reader's sentence: it appears in the DTO, the frame and (for a stop) the record. */
  reader?: string | RegExp;
  /** The change's own public line when the record says it differently than the reader's stop. */
  record?: string | RegExp;
  /** The pass's own status, when the cell ran one. */
  status?: PassResult['status'];
  /** The pass's own sentence, which for a technical failure is never the record's. */
  passSentence?: string | RegExp;
  /** A technical failure says it was ours; a lock and a content refusal keep their own words. */
  kind?: 'technical' | 'content' | 'lock' | 'queue';
};

function expectSentence(value: string | null, want: string | RegExp, where: string): void {
  expect(value, `${where} is empty`).toBeTruthy();
  if (typeof want === 'string') expect(value, where).toContain(want);
  else expect(value, where).toMatch(want);
}

/** Frames in the order the page hears them: every payload names its own moment. */
function byMoment(frames: Frame[]): Frame[] {
  const moment = (frame: Frame): number => {
    const at = frame.data.decidedAt ?? frame.data.at;
    return typeof at === 'string' ? Date.parse(at) : 0;
  };
  return [...frames].sort((left, right) => moment(left) - moment(right));
}

function expectNoRetiredWords(facts: Facts): void {
  const sentences = [
    facts.dto.reason ?? '',
    facts.change?.reason ?? '',
    facts.row.reason ?? '',
    ...facts.stages.map((stage) => stage.summary),
    ...facts.frames.map((frame) => String(frame.data.reason ?? '')),
    ...facts.alerts,
  ];
  for (const sentence of sentences) {
    for (const word of RETIRED) {
      expect(sentence, `a reachable sentence carries «${word}»`).not.toContain(word);
    }
  }
}

/**
 * Assert one cell's end, all four facts at once. A `written` cell moved the chapter by exactly
 * one revision; a refused one left it where it was — that is the three-way state made impossible.
 */
export function expectSink(cell: Cell, want: Want): Facts {
  const facts = factsOf(cell);
  if (want.status !== undefined) expect(cell.result?.status, 'the pass status').toBe(want.status);

  if (want.sink === 'written') {
    expect(facts.change).toMatchObject({ status: 'done', outcome: 'applied' });
    expect(facts.rev, 'a written change publishes exactly one revision').toBe(cell.revBefore + 1);
    expect(facts.dto.status).toBe('applied');
    expect(facts.dto.applied).toEqual({ chapter: cell.chapter, rev: facts.rev });
    expect(facts.changeFrames).toHaveLength(1);
    expect(facts.changeFrames[0]?.data).toMatchObject({ id: cell.changeId, outcome: 'applied' });
    // The triage row keeps its own word; the DTO and the frame are the receipt of the landing.
    expect(facts.row.status).toBe('accepted');
  } else if (want.sink === 'refused') {
    expect(facts.rev, 'a refusal never moves the chapter').toBe(cell.revBefore);
    expect(facts.dto.status).toBe('rejected');
    expect(facts.dto.applied).toBeNull();
    // The row's own word stops at triage: a filing a change holds stays `accepted` (the change
    // is the record; a premise's row never got past `new`), and one refused at the door is
    // `rejected` on the row itself.
    if (cell.changeId === null) expect(facts.row.status).toBe('rejected');
    else expect(['accepted', 'new']).toContain(facts.row.status);
    if (cell.changeId === null) {
      // A read refused before the lane saw it: no change exists, so no change frame may speak.
      expect(facts.change).toBeNull();
      expect(facts.changeFrames).toHaveLength(0);
    } else {
      expect(facts.change).toMatchObject({ status: 'void', outcome: 'dropped' });
      expect(facts.changeFrames).toHaveLength(1);
      expect(facts.changeFrames[0]?.data).toMatchObject({ id: cell.changeId, outcome: 'dropped' });
      if (want.record !== undefined) expectSentence(facts.change?.reason ?? null, want.record, 'the record sentence');
    }
    if (want.reader !== undefined) expectSentence(facts.dto.reason, want.reader, 'the reader sentence');
    if (want.passSentence !== undefined) expectSentence(cell.result?.reason ?? null, want.passSentence, 'the pass sentence');
  } else {
    expect(facts.change).toMatchObject({ status: 'pending' });
    expect(facts.rev, 'placement writes no text').toBe(cell.revBefore);
    expect(facts.dto.status).toBe('accepted');
    expect(facts.dto.disposition).toBe('as_said');
    expect(facts.row.status).toBe('accepted');
    expect(facts.changeFrames, 'a pending change is no decision').toHaveLength(0);
  }

  // The frame and the DTO are one derivation: the screen cannot print what the row does not say.
  // A failed try speaks too (BOOK-206 B5) and carries its own `attempt`; the **decision** frame
  // is the one without it, and only that one is a change's sink word.
  const decisions = facts.commentFrames.filter(
    (frame) => frame.data.attempt === undefined && (frame.data.status === 'applied' || frame.data.status === 'rejected'),
  );
  if (want.sink === 'accepted') {
    const placed = facts.commentFrames.filter((frame) => frame.data.attempt === undefined);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.data).toMatchObject({ id: cell.commentId, status: 'accepted' });
  } else if (cell.changeId === null) {
    // No change was made: either the read itself failed (its audit log carries the one terminal
    // failure) or a lock refused the filing (the applier's own decision frame). Both are one
    // word, told once, and no `change:decided` may exist to contradict it.
    const failed = cell.ctx.db
      .prepare(`SELECT meta FROM comment_events WHERE comment_id = ? AND type = 'triage.failed'`)
      .all(cell.commentId) as Array<{ meta: string }>;
    const terminal = failed
      .map((event) => JSON.parse(event.meta) as { cap?: boolean; reason?: string; desperate?: boolean })
      .filter((meta) => meta.cap === true);
    if (terminal.length > 0) {
      expect(terminal, 'one terminal read failure, exactly once').toHaveLength(1);
      expect(terminal[0]).toMatchObject({ desperate: true, reason: facts.dto.reason });
      expect(decisions).toHaveLength(0);
    } else {
      // The lock's decision: one frame, no failure beside it, and the row decided by the read.
      expect(decisions, 'one lock decision, exactly once').toHaveLength(1);
      expect(decisions[0]?.data).toMatchObject({ status: 'rejected' });
    }
  } else {
    expect(decisions, 'one terminal comment:decision, exactly once').toHaveLength(1);
    expect(decisions[0]?.data).toMatchObject({ id: cell.commentId, status: facts.dto.status });
    expect(String(decisions[0]?.data.reason ?? '')).toBe(facts.dto.reason ?? '');
  }

  // Whichever sink spoke, the last thing the page heard is the row's own word: a decision frame
  // for a change's end, or — since BOOK-220 §10.1 — the reading's own frame when the read itself
  // is what failed.
  const heard = byMoment([...facts.commentFrames, ...facts.readingFrames]);
  expect(heard.length).toBeGreaterThan(0);
  const last = heard.at(-1);
  if (last?.type === 'filing:reading') {
    // The reading's own frame names the failed try; the sink's sentence is the row's (asserted
    // above through the DTO and, for a change, through `change:decided`).
    expect(last.data).toMatchObject({ commentId: cell.commentId, phase: 'failed' });
  } else {
    expect(last?.data).toMatchObject({ id: cell.commentId, status: facts.dto.status });
  }

  if (want.kind === 'technical') expect(String(facts.dto.reason)).toContain(TECHNICAL);
  if (want.kind === 'content' || want.kind === 'lock') {
    // The words are about the text (or the lock): our failure's sentence must not be borrowed.
    expect(String(facts.dto.reason)).not.toContain(TECHNICAL);
  }
  if (want.kind === 'queue') {
    // Six claims were counted, and the change left the queue with the count on it.
    expect(facts.change?.attempts).toBe(6);
  }
  expectNoRetiredWords(facts);
  return facts;
}

