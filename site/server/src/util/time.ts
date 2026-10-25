/** ISO-8601 UTC, second precision — the format stored in SQLite. */
export function toIso(date: Date | number): string {
  const value = typeof date === 'number' ? new Date(date) : date;
  return value.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}
