import type { CatalogEntry, ChapterDto, StateSnapshot } from '@book/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function requestJson(path: string): Promise<Response> {
  return fetch(path, { headers: { accept: 'application/json' } });
}

/** The server answers `{code, message}`; keep both — the composer will need them (M5). */
async function toApiError(response: Response): Promise<ApiError> {
  let code = `HTTP_${response.status}`;
  let message = response.statusText || 'request failed';
  try {
    const body = (await response.json()) as { code?: string; message?: string };
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.message === 'string') message = body.message;
  } catch {
    /* a non-JSON error is still an error */
  }
  return new ApiError(response.status, code, message);
}

async function readJson<T>(path: string): Promise<T> {
  const response = await requestJson(path);
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

export function getState(): Promise<StateSnapshot> {
  return readJson<StateSnapshot>('/api/state');
}

export function getChapters(): Promise<CatalogEntry[]> {
  return readJson<CatalogEntry[]>('/api/chapters');
}

/** `null` is the normal answer for an unwritten slot, not a failure. */
export async function getChapter(n: number): Promise<ChapterDto | null> {
  const response = await requestJson(`/api/chapters/${n}`);
  if (response.status === 404) return null;
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as ChapterDto;
}
