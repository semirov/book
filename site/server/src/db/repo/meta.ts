import type { Db } from '../db.ts';

type Row = { v: string };

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(key) as Row | undefined;
  return row?.v ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(key, value);
}

export function getNumber(db: Db, key: string, fallback: number): number {
  const raw = getMeta(db, key);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}
