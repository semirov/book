import type { Db } from '../db.ts';

export type RevisionKind = 'create' | 'rewrite' | 'edit' | 'polish' | 'restore';
export type CauseKind = 'draft' | 'change' | 'cascade' | 'front' | 'ending' | 'sweep' | 'operator' | 'restore';

export type RevisionInput = {
  chapter: number;
  rev: number;
  at: string;
  kind: RevisionKind;
  causeKind: CauseKind;
  changeId: string | null;
  cascadeId: string | null;
  stepId: string | null;
  added: number;
  changed: number;
  removed: number;
  snapshot: string;
  attributed: boolean;
  /** The log entry this revision produced (§6F.2); null only for a pre-M6b row. */
  hseq?: number | null;
  logNote: string | null;
};

export function insertRevision(db: Db, input: RevisionInput): void {
  db.prepare(
    `INSERT INTO revisions
       (chapter, rev, at, kind, cause_kind, change_id, cascade_id, step_id,
        added, changed, removed, snapshot, attributed, hseq, log_note)
     VALUES
       (@chapter, @rev, @at, @kind, @causeKind, @changeId, @cascadeId, @stepId,
        @added, @changed, @removed, @snapshot, @attributed, @hseq, @logNote)`,
  ).run({ ...input, attributed: input.attributed ? 1 : 0, hseq: input.hseq ?? null });
}

export function listRevisions(db: Db, chapter: number): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM revisions WHERE chapter = ? ORDER BY rev').all(chapter) as Array<
    Record<string, unknown>
  >;
}
