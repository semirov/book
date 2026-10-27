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
 *  · every request is bounded (10 s): a hung engine must not hang the supervised writer.
 *
 * The transport is injected so the tests need no network, and this file lives outside
 * `engine/**`, which is where the architecture rule forbids `fetch` (ADR-012).
 */

import { readFileSync } from 'node:fs';

import type { BudgetDto, Finding, WriterAssignment } from '@book/shared';

export const ENGINE_TIMEOUT_MS = 10_000;

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

/** What a gate session receives (`engine/gates.ts` `GateAssignment`), narrowed to what we read. */
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

export type DoneInput = {
  leaseId: string;
  note?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  seams?: unknown[];
};

/** What an escalation reports about the model calls it made before it parked (BOOK-117). */
export type EscalateSpend = {
  /** The model that ran; omitted when none did — the engine's own default is `null` (ADR-038 §2). */
  model?: string;
  tokensIn: number;
  tokensOut: number;
};

export type EngineClient = {
  state(): Promise<EngineStateView>;
  /** The lane's next job, or null when the lane has nothing (never a refusal). */
  next(lane: 'fwd' | 'bwd', session: string): Promise<WriterAssignment | null>;
  /** A gate's dispatch for a landed step, or null when neither role is waiting. */
  nextGate(role: 'editor' | 'consultant', session: string): Promise<GateAssignmentView | null>;
  pass(chapter: number, session: string): Promise<WriterAssignment>;
  start(leaseId: string): Promise<StartView>;
  land(leaseId: string): Promise<LandView>;
  verdict(body: VerdictInput): Promise<VerdictView>;
  done(body: DoneInput): Promise<DoneView>;
  escalate(leaseId: string, because: string, spend?: EscalateSpend): Promise<DoneView>;
  beat(leaseId: string): Promise<{ leaseId: string; expiresAt: string }>;
  reconcile(chapter: number, because: string): Promise<unknown>;
  stage(event: Record<string, unknown>): Promise<unknown>;
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

  async function send(method: 'GET' | 'POST', path: string, body: unknown): Promise<unknown> {
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

  const post = (path: string, body: unknown): Promise<unknown> => send('POST', path, body);

  return {
    state: async () => (await send('GET', '/internal/state', null)) as EngineStateView,
    next: async (lane, session) =>
      (await post('/internal/next', { for: lane, session })) as WriterAssignment | null,
    nextGate: async (role, session) =>
      (await post('/internal/next', { role, session })) as GateAssignmentView | null,
    pass: async (chapter, session) => (await post('/internal/pass', { chapter, session })) as WriterAssignment,
    start: async (leaseId) => (await post('/internal/start', { leaseId })) as StartView,
    land: async (leaseId) => (await post('/internal/land', { leaseId })) as LandView,
    verdict: async (body) => (await post('/internal/verdict', body)) as VerdictView,
    done: async (body) => (await post('/internal/done', body)) as DoneView,
    escalate: async (leaseId, because, spend) =>
      (await post(
        '/internal/escalate',
        spend === undefined ? { leaseId, because } : { leaseId, because, ...spend },
      )) as DoneView,
    beat: async (leaseId) =>
      (await post('/internal/beat', { leaseId })) as { leaseId: string; expiresAt: string },
    reconcile: async (chapter, because) => post('/internal/reconcile', { chapter, because }),
    stage: async (event) => post('/internal/stage', event),
  };
}
