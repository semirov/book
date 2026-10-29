/**
 * The engine's control API, from the writer's side (`docs/writer-lane.md` §3–§4).
 *
 * The engine answers `{ ok, data }` or `{ code, message, detail }`; a refusal is mapped to a
 * typed `EngineRefusalError` with a stable `code`, so the pass branches on the code and never on
 * the message (a message is Russian prose for a human and may be reworded).
 *
 * Two invariants live here rather than in the pass:
 *  · the bearer token is read from `ENGINE_TOKEN_FILE` **once**, at construction, and travels
 *    only in the `authorization` header — never in a URL, a log line or an error message;
 *  · every request is bounded (`WRITER_ENGINE_TIMEOUT_MS`, 60 s): a hung engine must not hang the
 *    supervised writer, and a busy one must not lose a pass whose text has already landed. The
 *    engine is local but single-threaded, and the measured pass (chapter 65) had `land` outrun the
 *    old hard-coded 10 s;
 *  · a **transport** failure (timeout, connection reset) is retried once, because every call here
 *    is idempotent by design: `land` on the same sha is a no-op, `verdict` replaces the one row
 *    per role, `done` on a closed step answers `STEP_CLOSED`. A refusal — a 4xx code — is the
 *    engine's answer and is never retried.
 *
 * The transport is injected so the tests need no network, and this file lives outside
 * `engine/**`, which is where the architecture rule forbids `fetch` (ADR-012).
 */

import { readFileSync } from 'node:fs';

import type { BudgetDto, Finding, WriterAssignment } from '@book/shared';

import type { Provenance } from '../engine/model.ts';
import type { ChapterTextView } from '../engine/text.ts';
import type { PremiseCause } from '../engine/types.ts';

export type { ChapterTextView };

export const ENGINE_TIMEOUT_MS = 60_000;

/** One retry, and only on the transport: every call of this client is idempotent by design. */
const TRANSPORT_ATTEMPTS = 2;

/** The two codes this client owns: the engine did not answer, which is not a refusal. */
export function isEngineTransportCode(code: string | null | undefined): boolean {
  // BOOK-145: a busy database is a fact about the moment, like a timeout — retried once.
  return code === 'ENGINE_TIMEOUT' || code === 'ENGINE_UNREACHABLE' || code === 'DB_BUSY';
}

/** `fetch` (or a test double): the only seam this client has to the outside. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type EngineRefusal = { code: string; message: string; status: number };

export class EngineRefusalError extends Error implements EngineRefusal {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'EngineRefusalError';
    this.code = code;
    this.status = status;
  }
}

export type EngineClientOptions = {
  /** `http://127.0.0.1:8081` — loopback or the compose network, never a public host. */
  baseUrl: string;
  /** `ENGINE_TOKEN_FILE`; the value is read once and never printed. */
  tokenFile?: string;
  /** Test seam: a literal token instead of a file. */
  token?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
};

export type EngineStateView = {
  status: string;
  lane: { holder: string | null; heartbeatAt: string | null };
  queue: { pending: number; processing: number; openCascades: number };
  steps: { open: number; leased: number };
  /** Information, not a bound: the day is bounded by money (`budget`). */
  tokens: { today: number; dailyBudget: number };
  /** The money answer (BOOK-117); `null` from an engine that does not report caps. */
  budget: BudgetDto | null;
};

/**
 * BOOK-206 (ADR-045 §3): one filing the engine claims for a read. The envelope is the filing as
 * the server wrote it (the four untrusted values plus the world); `recordedVerdict` is gate C's
 * stored answer, when there is one — then only the missing half is asked.
 */
export type TriageAskView = {
  commentId: string;
  attempt: number;
  chapter: number;
  kind: string | null;
  envelope: Record<string, unknown>;
  world: string | null;
  recordedVerdict: 'FITS' | 'OFF' | null;
};

/** `assignment: null` with `reason: 'budget'` is the engine's own stop for a paused day. */
export type TriageNextView = { assignment: TriageAskView | null; reason: 'budget' | null };

/** What `verdict` sends: the model's answer and the money it cost. */
export type TriageVerdictInput = {
  commentId: string;
  n: number;
  verdict: unknown;
  spend: { model: string; tokensIn: number; tokensOut: number; usd: number };
};

export type TriageVerdictView = { stored: boolean; already?: true };

/** A failed call: a code the engine records, never the reader's text. */
/**
 * BOOK-206 (AC5): a failed call is still money. `spend` is present when the provider answered
 * with usage (a shape failure, a recorded-verdict conflict, an engine refusal of the answer) and
 * absent for a transport failure that never reported any.
 */
export type TriageFailInput = {
  commentId: string;
  n: number;
  code: string;
  detail?: string;
  spend?: TriageVerdictInput['spend'];
};

export type TriageFailView = { tries: number; nextAt: string | null; cap: boolean };

/** What a gate session receives (`engine/gates.ts` `GateAssignment`), narrowed to what we read. */
/** Gate B's assignment: its own shape (a rule, no prose findings), `rule: null` for a clean scan. */
export type RightsAssignmentView = {
  stepId: string;
  role: 'rights';
  session: string;
  pass: string;
  chapter: number | null;
  landedSha: string | null;
  rule: string | null;
  block: number | null;
  expiresAt: string;
};

export type GateAssignmentView = {
  stepId: string;
  role: 'editor' | 'consultant';
  session: string;
  pass: string;
  chapter: number | null;
  boundary: string;
  cycle: number;
  landedSha: string | null;
  note: string | null;
  indexSlice: string | null;
  expiresAt: string;
};

/** What `land` sends: the writer's text, held in memory and never written to a file (BOOK-187). */
export type LandInput = {
  text?: string;
  frontRaw?: string;
  noWrite?: boolean;
  rev?: number;
};

/** `--revert` as a restore revision: what the engine published, and what it replaced. */
export type RestoreView = { rev: number; sha: string; previousRev: number };

/**
 * BOOK-187 AC5: the lane's counter, as the engine's row answers it. A day other than the row's
 * reads as a fresh day (`passes: 0`), so the writer never has to reset anything at midnight.
 */
export type WriterStateView = { day: string; passes: number; lastPassAt: string | null; pauseUntil: string | null };

/** What `recordPass` sends: one pass counted, and optionally when the lane may run again. */
export type RecordPassInput = { day: string; spent: boolean; pauseUntil?: string | null };

/**
 * BOOK-187 AC7: the redacted receipt of a pass, as the writer built it. The shape is `transcript.ts`'s
 * `TranscriptRow` seen from the wire side; `storeTranscript` is where the two meet, so the compiler
 * keeps them equal without the modules importing each other.
 */
export type TranscriptRowInput = {
  seq: number;
  at: number;
  role: 'draft' | 'repair' | 'continue' | 'gate:editor' | 'gate:consultant' | 'gate:rights';
  tokensIn: number;
  tokensOut: number;
  promptBundle: string | null;
  content: string;
};

export type TranscriptStored = { stored: number; pruned: number };

export type StartView = {
  leaseId: string;
  stepId?: string;
  chapter?: number | 'front';
  expectedRev?: number;
  sha: string;
  chars: number;
};

export type LandView = {
  landed: true;
  revAfter: number;
  sha: string;
  changed: boolean;
  deltaRatio: number;
  blocksTouched: number;
};

export type VerdictView = {
  action: 'close' | 'revise' | 'publish_with_finding';
  cycle: number;
  verdict: 'HOLDS' | 'GAP';
  downgraded: boolean;
  late: boolean;
};

/**
 * What a close answers. `STEP_CLOSED` from `done` is not a failure — the step is closed either way,
 * and the pass reads it as the close it asked for (`pass.ts`, the owner's rule of 2026-10-28).
 */
export type DoneView = {
  stepId: string;
  outcome: string;
  cascadeId: string | null;
  changeStatus: string | null;
};

export type VerdictInput = {
  stepId: string;
  role: 'editor' | 'consultant';
  session: string;
  verdict: 'HOLDS' | 'GAP';
  findings: Finding[];
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
};

/** BOOK-61: Gate B answers another question with another enum; `rule` accompanies a REFUSED. */
export type RightsVerdictInput = {
  stepId: string;
  role: 'rights';
  session: string;
  verdict: 'CLEAR' | 'REFUSED';
  rule?: string | null;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
};

export type DoneInput = {
  leaseId: string;
  note?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  seams?: unknown[];
  /**
   * BOOK-219: `pipeline-estimated` when any call of the pass had its usage read off the text.
   * The ledger row is still priced (`priced = 1`) — the word says the numbers are an estimate.
   */
  provenance?: Provenance;
};

/** What an escalation reports about the model calls it made before it parked (BOOK-117). */
export type EscalateSpend = {
  /** The model that ran; omitted when none did — the engine's own default is `null` (ADR-038 §2). */
  model?: string;
  tokensIn: number;
  tokensOut: number;
  /** BOOK-219: a park after a paid call is priced too, and says whether its numbers are estimated. */
  provenance?: Provenance;
};

export type EngineClient = {
  state(): Promise<EngineStateView>;
  /** The lane's next job, or null when the lane has nothing (never a refusal). */
  /** BOOK-166: `filing` is the lane's door — the oldest undecided filing, whatever its kind. */
  next(lane: 'fwd' | 'bwd' | 'filing', session: string): Promise<WriterAssignment | null>;
  /** A gate's dispatch for a landed step, or null when neither role is waiting. */
  nextGate(role: 'editor' | 'consultant', session: string): Promise<GateAssignmentView | null>;
  /** BOOK-61: the rights gate, offered for every prose pass — a clean scan answers mechanically. */
  nextRightsGate(session: string): Promise<RightsAssignmentView | null>;
  pass(chapter: number, session: string): Promise<WriterAssignment>;
  start(leaseId: string): Promise<StartView>;
  land(leaseId: string, input?: LandInput): Promise<LandView>;
  /** The text a prompt may quote, from rows only: `{ n, title, exists, basis, chars, text }`. */
  text(chapters: number[]): Promise<{ chapters: ChapterTextView[] }>;
  /** Bring back a revision as a **new** revision (`cause_kind = 'restore'`), never a file. */
  restore(chapter: number, rev?: number): Promise<RestoreView>;
  verdict(body: VerdictInput): Promise<VerdictView>;
  verdictRights(body: RightsVerdictInput): Promise<{ verdict: 'CLEAR' | 'REFUSED'; action: 'close' | 'escalate'; closed: boolean }>;
  done(body: DoneInput): Promise<DoneView>;
  /** `cause` says whether the pass broke or the model refused the work (`engine/types.ts`). */
  escalate(leaseId: string, because: string, spend?: EscalateSpend, cause?: PremiseCause): Promise<DoneView>;
  beat(leaseId: string): Promise<{ leaseId: string; expiresAt: string }>;
  reconcile(chapter: number, because: string): Promise<unknown>;
  stage(event: Record<string, unknown>): Promise<unknown>;
  /**
   * BOOK-187 AC5: the lane's day, read from `writer_state` through the engine — the writer keeps
   * no file and no database handle. Another day reads as a fresh one.
   */
  writerState(day: string): Promise<WriterStateView>;
  /** Count one pass (one transaction engine-side) and answer the resulting row. */
  recordPass(input: RecordPassInput): Promise<WriterStateView>;
  /** BOOK-187 AC7: store the pass's redacted receipt once, after the outcome is known. */
  transcript(input: { passId: string; rows: readonly TranscriptRowInput[] }): Promise<TranscriptStored>;
  /** BOOK-206: claim one due filing for a read, or learn that there is none (or no money). */
  nextTriage(session: string): Promise<TriageNextView>;
  /** Store one validated answer — once per attempt; a second one answers `already`. */
  verdictTriage(input: TriageVerdictInput): Promise<TriageVerdictView>;
  /** Report the try as failed, so the engine backs off and, at the cap, raises a defect. */
  failTriage(input: TriageFailInput): Promise<TriageFailView>;
};

function readToken(options: EngineClientOptions): string {
  if (typeof options.token === 'string' && options.token.trim().length > 0) return options.token.trim();
  if (options.tokenFile === undefined || options.tokenFile.trim().length === 0) {
    throw new EngineRefusalError('ENGINE_TOKEN_MISSING', 'the engine token is not configured', 0);
  }
  try {
    const value = readFileSync(options.tokenFile, 'utf8').trim();
    if (value.length === 0) throw new Error('empty');
    return value;
  } catch {
    // The variable name, never the path's contents and never the value.
    throw new EngineRefusalError('ENGINE_TOKEN_MISSING', 'ENGINE_TOKEN_FILE cannot be read', 0);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function createEngineClient(options: EngineClientOptions): EngineClient {
  const token = readToken(options);
  const transport = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? ENGINE_TIMEOUT_MS;
  const base = options.baseUrl.replace(/\/+$/u, '');

  /** One request, bounded by the timeout above. */
  async function request(method: 'GET' | 'POST', path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await transport(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch {
      // The URL is not echoed: it names the socket, and nothing here needs it to be acted on.
      throw new EngineRefusalError(
        controller.signal.aborted ? 'ENGINE_TIMEOUT' : 'ENGINE_UNREACHABLE',
        controller.signal.aborted
          ? `the engine did not answer within ${String(timeoutMs)} ms`
          : 'the engine is unreachable',
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const answer = record(payload);
    if (!response.ok) {
      throw new EngineRefusalError(
        text(answer?.code) ?? `HTTP_${String(response.status)}`,
        text(answer?.message) ?? `the engine refused the request (${String(response.status)})`,
        response.status,
      );
    }
    if (answer?.ok !== true) {
      throw new EngineRefusalError(
        text(answer?.code) ?? 'ENGINE_REFUSED',
        text(answer?.message) ?? 'the engine did not confirm the request',
        response.status,
      );
    }
    return answer.data;
  }

  /**
   * One request, with one retry on the transport and none on a refusal. A failure that survives
   * the retry is `ENGINE_TIMEOUT` / `ENGINE_UNREACHABLE` — never a raw `fetch failed`: the code is
   * what the pass branches on and what the reader's sentence is built from.
   */
  async function send(method: 'GET' | 'POST', path: string, body: unknown): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await request(method, path, body);
      } catch (error) {
        const transport = error instanceof EngineRefusalError && isEngineTransportCode(error.code);
        if (!transport || attempt >= TRANSPORT_ATTEMPTS) throw error;
      }
    }
  }

  const post = (path: string, body: unknown): Promise<unknown> => send('POST', path, body);

  return {
    state: async () => (await send('GET', '/internal/state', null)) as EngineStateView,
    next: async (lane, session) =>
      (await post('/internal/next', { for: lane, session })) as WriterAssignment | null,
    nextGate: async (role, session) =>
      (await post('/internal/next', { role, session })) as GateAssignmentView | null,
    pass: async (chapter, session) => (await post('/internal/pass', { chapter, session })) as WriterAssignment,
    start: async (leaseId) => (await post('/internal/start', { leaseId })) as StartView,
    land: async (leaseId, input) =>
      (await post('/internal/land', {
        leaseId,
        ...(input?.text === undefined ? {} : { text: input.text }),
        ...(input?.frontRaw === undefined ? {} : { frontRaw: input.frontRaw }),
        ...(input?.noWrite === undefined ? {} : { noWrite: input.noWrite }),
        ...(input?.rev === undefined ? {} : { rev: input.rev }),
      })) as LandView,
    text: async (chapters) =>
      (await post('/internal/text', { chapters })) as { chapters: ChapterTextView[] },
    restore: async (chapter, rev) =>
      (await post('/internal/restore', { chapter, ...(rev === undefined ? {} : { rev }) })) as RestoreView,
    nextRightsGate: async (session) =>
      (await post('/internal/next', { role: 'rights', session })) as RightsAssignmentView | null,
    verdict: async (body) => (await post('/internal/verdict', body)) as VerdictView,
    verdictRights: async (body) =>
      (await post('/internal/verdict', body)) as { verdict: 'CLEAR' | 'REFUSED'; action: 'close' | 'escalate'; closed: boolean },
    done: async (body) => (await post('/internal/done', body)) as DoneView,
    escalate: async (leaseId, because, spend, cause) =>
      (await post(
        '/internal/escalate',
        {
          leaseId,
          because,
          ...(spend ?? {}),
          ...(cause === undefined ? {} : { cause }),
        },
      )) as DoneView,
    beat: async (leaseId) =>
      (await post('/internal/beat', { leaseId })) as { leaseId: string; expiresAt: string },
    reconcile: async (chapter, because) => post('/internal/reconcile', { chapter, because }),
    stage: async (event) => post('/internal/stage', event),
    // AC5: one read, one write, both keyed by the caller's day and never by a file.
    writerState: async (day) =>
      (await send('GET', `/internal/writer-state?day=${encodeURIComponent(day)}`, null)) as WriterStateView,
    recordPass: async (input) =>
      (await post('/internal/writer-state', {
        day: input.day,
        spent: input.spent,
        ...(input.pauseUntil === undefined ? {} : { pauseUntil: input.pauseUntil }),
      })) as WriterStateView,
    transcript: async (input) =>
      (await post('/internal/transcript', { passId: input.passId, rows: input.rows })) as TranscriptStored,
    nextTriage: async (session) => {
      const data = await post('/internal/triage/next', { session });
      if (data === null) return { assignment: null, reason: null };
      const answer = data as Record<string, unknown>;
      // The paused day is the engine's answer, not an error: no filing is claimed and none is lost.
      if (answer.assignment === null) return { assignment: null, reason: answer.reason === 'budget' ? 'budget' : null };
      return { assignment: data as TriageAskView, reason: null };
    },
    verdictTriage: async (input) => (await post('/internal/triage/verdict', input)) as TriageVerdictView,
    failTriage: async (input) => (await post('/internal/triage/fail', input)) as TriageFailView,
  };
}
