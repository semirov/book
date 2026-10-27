import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from '../src/db/db.ts';
import { appendEvent } from '../src/history/log.ts';
import { StateService } from '../src/ingest/stateService.ts';
import { createFixture, type Fixture } from './helpers.ts';
import { seedChange } from './history/helpers.ts';

/**
 * BOOK-56 — history is off until the first reader change.
 *
 * The fixture is the live-shaped log: five `front.revised` events, no revisions, no
 * changes, no comments. The state DTO must say so, a machine change must not turn it on,
 * and one reader-caused change must. The log itself is only ever read.
 */

const NOW = new Date('2026-10-25T12:00:00Z');
const LOG_TABLES = ['events', 'changes', 'comments', 'revisions', 'front_revisions', 'block_versions'] as const;

let fixture: Fixture | null = null;

afterEach(() => {
  fixture?.close();
  fixture = null;
});

/** The five events the live log holds: all `front.revised`, none of them a reader's. */
function liveLog(db: Db): void {
  for (let rev = 1; rev <= 5; rev += 1) {
    appendEvent(db, { kind: 'front.revised', isFront: true, rev, authorKind: 'author' }, NOW.getTime());
  }
}

function counts(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of LOG_TABLES) {
    out[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return out;
}

/** A change the machine made on its own: no filing behind it. */
function insertMachineChange(db: Db): void {
  db.prepare(
    `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks,
                          scope_hint, status, enqueued_at)
     VALUES ('chg_machine', 'continuity', 5, 'машинная правка', 1, 'sha', '[]',
             'phrase', 'pending', '2026-10-25T11:00:00Z')`,
  ).run();
}

describe('the state DTO decides history once (BOOK-56)', () => {
  it('carries `history` and keeps it off on the live-shaped log', () => {
    fixture = createFixture();
    liveLog(fixture.db);
    const state = new StateService(fixture.db, () => NOW).snapshot();

    expect(state.history).toEqual({ live: false, readerChanges: 0 });
  });

  it('reads the log without touching it: counts are equal before and after', () => {
    fixture = createFixture();
    liveLog(fixture.db);
    const service = new StateService(fixture.db, () => NOW);
    const before = counts(fixture.db);

    service.snapshot();
    service.snapshot();

    expect(counts(fixture.db)).toEqual(before);
    expect(before.events).toBe(5);
    expect(before.revisions).toBe(0);
    expect(before.changes).toBe(0);
    expect(before.comments).toBe(0);
  });

  it('a machine revision alone does not turn history on (AC4)', () => {
    fixture = createFixture();
    liveLog(fixture.db);
    insertMachineChange(fixture.db);

    const state = new StateService(fixture.db, () => NOW).snapshot();

    expect(state.history).toEqual({ live: false, readerChanges: 0 });
  });

  it('the first reader-sourced change turns it on and bumps the snapshot version (AC3)', () => {
    fixture = createFixture();
    liveLog(fixture.db);
    const service = new StateService(fixture.db, () => NOW);
    const before = service.snapshot();
    expect(before.history.live).toBe(false);

    seedChange(fixture.db, { index: 1, chapter: 8 });

    const after = service.snapshot();
    expect(after.history).toEqual({ live: true, readerChanges: 1 });
    expect(after.version).toBe(before.version + 1);
    // The rows the reader's change needed are the only ones added; the snapshot wrote none.
    expect(counts(fixture.db).events).toBe(5);
  });
});
