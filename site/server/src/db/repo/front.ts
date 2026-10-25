import type { Db } from '../db.ts';

export type FrontRow = {
  id: number;
  title: string;
  about: string;
  rev: number;
  sha256: string;
  updated_at: string;
};

/** The single front-matter row (§8), or undefined while `00-front.md` is absent. */
export function getFrontRow(db: Db): FrontRow | undefined {
  return db.prepare('SELECT * FROM front_matter WHERE id = 1').get() as FrontRow | undefined;
}

export function upsertFrontRow(
  db: Db,
  row: { title: string; about: string; rev: number; sha256: string; updatedAt: string },
): void {
  db.prepare(
    `INSERT INTO front_matter (id, title, about, rev, sha256, updated_at)
     VALUES (1, @title, @about, @rev, @sha256, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       about = excluded.about,
       rev = excluded.rev,
       sha256 = excluded.sha256,
       updated_at = excluded.updated_at`,
  ).run(row);
}

export function deleteFrontRow(db: Db): void {
  db.prepare('DELETE FROM front_matter WHERE id = 1').run();
}
