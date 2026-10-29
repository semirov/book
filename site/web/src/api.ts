import type {
  AuthorsCountDto,
  AuthorsDto,
  BookAtDto,
  CatalogEntry,
  ChangeDto,
  ChangeSummaryDto,
  ChapterDto,
  ChangeImpactDto,
  CommentDto,
  CommentPage,
  ContributorsDto,
  FrontDto,
  HistoryChapterDto,
  HistoryDiffDto,
  HistoryTimelineDto,
  MyDecisionsDto,
  MyFilingsDto,
  MyTraceDto,
  ParagraphChainDto,
  PassStageEvent,
  PostCommentInput,
  PostCommentResponse,
  QueueDto,
  ReviseCommentInput,
  ReviseCommentResponse,
  StateSnapshot,
} from '@book/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
    readonly resetAt?: string,
    readonly currentText?: string,
    /**
     * BOOK-111: a duplicate refusal names the filing that already exists, so the form can open
     * it instead of asking the reader to write the same thing again.
     */
    readonly commentId?: string,
    /**
     * BOOK-158: the day's attempts are spent, and this is when they come back (the next 00:00
     * UTC). It travels with `ATTEMPTS_EXHAUSTED` and with `ATTEMPT_LIMIT`; the page says «в
     * следующий раз» and names the hour when it has one.
     */
    readonly reopenAt?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function requestJson(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { accept: 'application/json', ...(init?.headers ?? {}) },
  });
}

/** The server answers `{code, message, retryAfterMs?, resetAt?}`; keep all of it. */
async function toApiError(response: Response): Promise<ApiError> {
  let code = `HTTP_${response.status}`;
  let message = response.statusText || 'request failed';
  let retryAfterMs: number | undefined;
  let resetAt: string | undefined;
  let currentText: string | undefined;
  let commentId: string | undefined;
  let reopenAt: string | undefined;
  try {
    const body = (await response.json()) as {
      code?: unknown;
      message?: unknown;
      retryAfterMs?: unknown;
      resetAt?: unknown;
      currentText?: unknown;
      commentId?: unknown;
      reopenAt?: unknown;
    };
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.message === 'string') message = body.message;
    if (typeof body.retryAfterMs === 'number') retryAfterMs = body.retryAfterMs;
    if (typeof body.resetAt === 'string') resetAt = body.resetAt;
    if (typeof body.currentText === 'string') currentText = body.currentText;
    if (typeof body.commentId === 'string') commentId = body.commentId;
    if (typeof body.reopenAt === 'string') reopenAt = body.reopenAt;
  } catch {
    /* a non-JSON error is still an error */
  }
  return new ApiError(response.status, code, message, retryAfterMs, resetAt, currentText, commentId, reopenAt);
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await requestJson(path, init);
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

export function getState(): Promise<StateSnapshot> {
  return readJson<StateSnapshot>('/api/state');
}

/**
 * BOOK-63: the counter id is configuration, not a bundle constant. `null` means the
 * deployment has no counter — the page then loads no analytics at all.
 */
export function getAnalyticsConfig(): Promise<{ counter: string | null }> {
  return readJson<{ counter: string | null }>('/api/analytics');
}

export function getChapters(): Promise<CatalogEntry[]> {
  return readJson<CatalogEntry[]>('/api/chapters');
}

/**
 * BOOK-225 — the reader answered the rating's one question. The server writes the cookie and
 * answers the day it wrote; the page keeps that day in its own state and mounts the chapter
 * flow. A refusal throws like every other refusal: the gate then stays and claims nothing.
 */
export async function postAge(): Promise<{ acknowledgedAt: string }> {
  const response = await requestJson('/api/age', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as { acknowledgedAt: string };
}

/** The live title, page 2, the TOC and the imprint in one call (§9). */
export function getFront(): Promise<FrontDto> {
  return readJson<FrontDto>('/api/front');
}

/** `GET /api/queue` — the head of the lane, its depth and its shape (§9). */
export function getQueue(): Promise<QueueDto> {
  return readJson<QueueDto>('/api/queue');
}

/** Newest first; the thread shows a handful, the chronicle will page through it later. */
export function getChanges(limit = 10): Promise<ChangeSummaryDto[]> {
  return readJson<ChangeSummaryDto[]>(`/api/changes?limit=${Math.min(50, Math.max(1, limit))}`);
}

/** The change card's one call (§11.7); `null` for a change the server does not know. */
export async function getChange(id: string): Promise<ChangeDto | null> {
  const response = await requestJson(`/api/changes/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as ChangeDto;
}

/** `null` is the normal answer for an unwritten slot, not a failure. */
export async function getChapter(n: number): Promise<ChapterDto | null> {
  const response = await requestJson(`/api/chapters/${n}`);
  if (response.status === 404) return null;
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as ChapterDto;
}

/** The public thread (§9, §12): one page of comments with their decisions. */
/**
 * BOOK-DOC-34 §6 — one chapter's filings, for the marks in its text. `GET /api/comments`
 * already takes `chapter`; the seam loads it lazily, when the chapter comes into view, and
 * keeps it until a frame for that chapter says otherwise.
 */
export function getChapterComments(chapter: number, limit = 50): Promise<CommentPage> {
  return getComments({ chapter, limit });
}

/**
 * `GET /api/chapters/:n/stages` — what already happened to one chapter's passes
 * (docs/writer-lane.md §3). `pass` narrows the answer to one pass; a reader who was not
 * connected when it ran reads the same stored moments it would have seen.
 */
export function getStages(
  n: number,
  options: { pass?: string; limit?: number } = {},
): Promise<PassStageEvent[]> {
  const params = new URLSearchParams();
  if (options.pass !== undefined) params.set('pass', options.pass);
  if (options.limit !== undefined) params.set('limit', String(Math.min(200, Math.max(1, options.limit))));
  const query = params.toString();
  return readJson<{ stages: PassStageEvent[] }>(
    `/api/chapters/${String(n)}/stages${query === '' ? '' : `?${query}`}`,
  ).then((answer) => answer.stages);
}

export function getComments(options: { chapter?: number; limit?: number; before?: string } = {}): Promise<CommentPage> {
  const params = new URLSearchParams();
  if (options.chapter !== undefined) params.set('chapter', String(options.chapter));
  params.set('limit', String(Math.min(50, Math.max(1, options.limit ?? 20))));
  if (options.before !== undefined) params.set('before', options.before);
  return readJson<CommentPage>(`/api/comments?${params.toString()}`);
}

/**
 * BOOK-111 — one filing by id, for a refusal that names the one already sent. `null` is a
 * normal answer: the row was hidden or never existed, so the form keeps its refusal line.
 */
export async function getComment(id: string): Promise<CommentDto | null> {
  const response = await requestJson(`/api/comments/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as CommentDto;
}

/**
 * The only write the reader has (§9, §12.1): identity comes from the session cookie,
 * `author` is never sent, and BOOK-64: no challenge token travels — the server's gate is
 * the identity plus the rate limits.
 */
export async function postComment(input: PostCommentInput): Promise<PostCommentResponse> {
  const response = await requestJson('/api/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as PostCommentResponse;
}

/**
 * BOOK-DOC-34 §6 — a filing made at a point in the text. `blockId`, the sentence as `quote`
 * and `baseRev` are **required** here, not optional as on the wire type: a filing with no
 * anchor is exactly the object the seam replaced. A premise has no block and says so with
 * `blockId: null`; it still carries the chapter.
 */
export type AnchoredCommentInput = {
  chapter: number;
  blockId: string | null;
  quote: string | null;
  baseRev: number | null;
  prefix?: string | null;
  suffix?: string | null;
  body: string;
  proposedText?: string | null;
  interventionKind?: string | null;
};

export async function postAnchoredComment(input: AnchoredCommentInput): Promise<PostCommentResponse> {
  return postComment({
    chapter: input.chapter,
    blockId: input.blockId,
    quote: input.quote,
    baseRev: input.baseRev,
    ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
    ...(input.suffix === undefined ? {} : { suffix: input.suffix }),
    body: input.body,
    ...(input.proposedText === undefined ? {} : { proposedText: input.proposedText }),
    ...(input.interventionKind === undefined ? {} : { interventionKind: input.interventionKind }),
  });
}

/**
 * BOOK-158 — a revision of the reader's own refused filing. The anchor is **not** sent: the
 * server keeps the row's chapter, block, quote and revision, so a revision cannot move the
 * filing to another paragraph. The answer is the same row, reopened.
 */
export async function reviseComment(id: string, input: ReviseCommentInput): Promise<ReviseCommentResponse> {
  const response = await requestJson(`/api/comments/${encodeURIComponent(id)}/revise`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as ReviseCommentResponse;
}

// ── the history (§6F.2, §11.10) ─────────────────────────────────────────────
/** The record's spine: newest first, one change per entry. */
export function getHistoryTimeline(
  options: { before?: number; limit?: number } = {},
): Promise<HistoryTimelineDto> {
  const params = new URLSearchParams();
  if (options.before !== undefined) params.set('before', String(options.before));
  params.set('limit', String(Math.min(50, Math.max(1, options.limit ?? 50))));
  return readJson<HistoryTimelineDto>(`/api/history/timeline?${params.toString()}`);
}

/** The book as it was: metadata only, no bodies (§6F.2). */
export function getHistoryAt(hseq: number | 'now'): Promise<BookAtDto> {
  return readJson<BookAtDto>(`/api/history/at/${hseq}`);
}

/** One chapter at a moment; `null` when it did not exist yet, which is a normal answer. */
export async function getHistoryChapter(n: number, hseq: number): Promise<HistoryChapterDto | null> {
  const response = await requestJson(`/api/history/chapters/${n}?at=${hseq}`);
  if (response.status === 404) return null;
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as HistoryChapterDto;
}

/** The lineage chain of one paragraph: where it came from, what rewrote it (§6F.3). */
export async function getHistoryParagraph(blockId: string): Promise<ParagraphChainDto | null> {
  const response = await requestJson(`/api/history/paragraphs/${encodeURIComponent(blockId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as ParagraphChainDto;
}

export function getHistoryDiff(from: number, to: number, chapter?: number): Promise<HistoryDiffDto> {
  const params = new URLSearchParams({ before: String(from), at: String(to) });
  if (chapter !== undefined) params.set('chapter', String(chapter));
  return readJson<HistoryDiffDto>(`/api/history/diff?${params.toString()}`);
}

export function getHistoryImpact(changeId: string): Promise<ChangeImpactDto> {
  return readJson<ChangeImpactDto>(`/api/history/impact/${encodeURIComponent(changeId)}`);
}

export function getHistoryContributors(): Promise<ContributorsDto> {
  return readJson<ContributorsDto>('/api/history/contributors');
}

/**
 * The end matter's list (§6C.5): the author as the remainder plus the measured shares.
 * `fresh` is for the post-mutation path: the route answers `no-store` (BOOK-109), but a copy a
 * browser still holds from before it must not show the list as it was before the reader hid
 * or reappeared.
 */
export function getAuthors(options: { fresh?: boolean } = {}): Promise<AuthorsDto> {
  return readJson<AuthorsDto>('/api/authors', options.fresh === true ? { cache: 'no-store' } : undefined);
}

/** The reader's own trace (BOOK-DOC-4): own only, and 401 for an anonymous visitor. */
export function getMyTrace(): Promise<MyTraceDto> {
  return readJson<MyTraceDto>('/api/authors/me');
}

/**
 * The reader's own decisions (BOOK-13): what became of their interventions, own only, and
 * 401 for an anonymous visitor. It is the durable record the page reloads into — the frame
 * that announced the decision is a broadcast, this is the reader's copy of it.
 */
export function getMyDecisions(): Promise<MyDecisionsDto> {
  return readJson<MyDecisionsDto>('/api/me/decisions');
}

/**
 * BOOK-207 — the reader's own filings for `#след`: own only, newest first, the newest 50.
 * 401 for an anonymous visitor, which is the page's signed-out state, not an error.
 */
export function getMyFilings(): Promise<MyFilingsDto> {
  return readJson<MyFilingsDto>('/api/me/filings');
}

/**
 * «Скрыть из списка авторов» / «вернуть в список» (§6C.5 rule 5): idempotent, and the
 * answer carries the fresh byline count so page 1 moves before the socket frame arrives.
 */
export async function postAuthorsHide(hidden: boolean): Promise<{ hidden: boolean; authors: AuthorsCountDto }> {
  const response = await requestJson('/api/authors/hide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hidden }),
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as { hidden: boolean; authors: AuthorsCountDto };
}

/** Logout is a POST (§17: no state-changing GET). */
export async function logoutSession(): Promise<void> {
  const response = await requestJson('/auth/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw await toApiError(response);
}
