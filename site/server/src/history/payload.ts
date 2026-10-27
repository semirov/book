/** JSON columns of the history tables: a malformed value is absence, never a crash. */
export function safeJson<T>(raw: string | null | undefined): T | null {
  if (raw === null || raw === undefined || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
