import type { Db } from '../db.ts';

export type RevisionKind = 'create' | 'rewrite' | 'edit' | 'reweiter' | 'restore';
export type CauseKind = 'draft' | 'cascade' | 'local' | 'canon' | 'operator' | 'restore';

export type RevisionInput = {
  chapter: number;
  rev: number;
  at: string;
  kind: RevisionKind;
  causeKind: CauseKind;
  changeId: string | null;
  cascadeId: string | null;
  stageSeq: number | null;
  added: number;
  changed: number;
  removed: number;
  snapshot: string;
  attributed: boolean;
  logNote: string | null;
};

export function insertRevision(db: Db, input: RevisionInput): void {
  db.prepare(
    `INSERT INTO revisions
       (chapter, rev, at, kind, cause_kind, change_id, cascade_id, stage_seq,
        added, changed, removed, snapshot, attributed, log_note)
     VALUES
       (@chapter, @rev, @at, @kind, @causeKind, @changeId, @cascadeId, @stageSeq,
        @added, @changed, @removed, @snapshot, @attributed, @logNote)`,
  ).run({ ...input, attributed: input.attributed ? 1 : 0 });
}

export function listRevisions(db: Db, chapter: number): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM revisions WHERE chapter = ? ORDER BY rev').all(chapter) as Array<
    Record<string, unknown>
  >;
}
