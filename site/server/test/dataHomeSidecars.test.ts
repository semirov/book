/**
 * BOOK-217 — a file's SQLite sidecars are that file's files.
 *
 * The deploy of `a424300` migrated the volume to schema v30 and then failed the home gate on
 * `/data/book-before-ch65-drop-20261028T183821Z.db-shm` and its `-wal`: the write-ahead log and
 * shared-memory index of an allow-listed pre-migration dump. Both are written by SQLite beside the
 * file that owns them and deleted with it, so refusing them turned a correct migration into a
 * failed deploy. The rule lives in the one classifier both guards call (`classifyDataEntry`), so
 * the tests drive the pure `dataHomeProblems` seam — no volume on disk is needed.
 *
 * The refusal side is asserted as hard as the pass: a sidecar whose base is not allow-listed is
 * still a stray, and it is named by its **absolute path**, because `ls` is the operator's next act.
 */

import { describe, expect, it } from 'vitest';

import {
  DATA_ALLOW,
  DATA_ALLOW_CONTENT,
  DATA_ALLOW_DIRS,
  classifyDataEntry,
  dataHomeProblems,
  type HomeEntry,
} from '../src/dataHome.ts';

const DATA = '/data';
const BOOK = '/repo/manuscript';

/** The marker `server/src/db/boot.ts` writes today. */
const NAMED_MARKER = 'book-volume 1\nschema=28\n';

/** The dump whose sidecars the incident refused. */
const DUMP = 'book-before-ch65-drop-20261028T183821Z.db';

/** A listing from paths: anything ending in `/` is a directory. */
function listing(paths: string[]): HomeEntry[] {
  return paths.map((path) =>
    path.endsWith('/') ? { rel: path.slice(0, -1), directory: true } : { rel: path, directory: false },
  );
}

/** Problems over synthetic listings, with the marker content the caller would have read. */
function problems(data: string[], marker: string | null = NAMED_MARKER) {
  return dataHomeProblems({
    dataDir: DATA,
    manuscriptDir: BOOK,
    data: listing(data),
    manuscript: [],
    readMarker: () => marker,
  });
}

/** The verdict for one file name, as the deploy guard and the doctor both ask it. */
function verdict(name: string) {
  return classifyDataEntry({ name, directory: false, markerContent: NAMED_MARKER });
}

describe('a dump’s own sidecars pass (BOOK-217)', () => {
  it('passes the pre-migration dump and both sidecars the incident refused', () => {
    expect(problems([DUMP, `${DUMP}-wal`, `${DUMP}-shm`])).toEqual([]);
  });

  it('passes them while `book.db` is open beside them, as on the live volume', () => {
    expect(
      problems([`${DUMP}-wal`, `${DUMP}-shm`, 'book.db', 'book.db-wal', 'book.db-shm', '.book-volume']),
    ).toEqual([]);
  });

  it('passes the reset’s copies and their sidecars', () => {
    const reset = 'book-reset-20261028T120000Z.db';
    expect(problems([reset, `${reset}-wal`, `${reset}-shm`])).toEqual([]);
    // The numbered copy `server/src/reset/backup.ts` writes when the name is taken.
    const numbered = 'book-reset-20261028T120000Z-1.db';
    expect(problems([numbered, `${numbered}-wal`, `${numbered}-shm`])).toEqual([]);
  });

  it('keeps `book.db-wal`/`book.db-shm` allowed by their own entries, reasons intact', () => {
    for (const name of ['book.db-wal', 'book.db-shm']) {
      expect(verdict(name)).toEqual({ ok: true });
      const entry = DATA_ALLOW.find((rule) => rule.name === name);
      expect(entry).toBeDefined();
      expect(entry?.reason).toContain('SQLite');
      // The two explicit entries keep the reasons they had: the rule is about the other dumps.
      expect(entry?.reason).toContain(name === 'book.db-wal' ? 'write-ahead log' : 'shared-memory');
    }
  });

  it('names the base file in the sidecar’s reason — that is the file it belongs to', () => {
    const wal = verdict(`${DUMP}-wal`);
    expect(wal.ok).toBe(true);
    expect(wal.ok ? wal.reason : '').toContain(DUMP);
    expect(wal.ok ? wal.reason : '').toContain('write-ahead log');

    const shm = verdict(`${DUMP}-shm`);
    expect(shm.ok).toBe(true);
    expect(shm.ok ? shm.reason : '').toContain(DUMP);
    expect(shm.ok ? shm.reason : '').toContain('shared-memory');
  });

  it('passes a dump’s sidecar while no marker is readable — the marker is not their business', () => {
    expect(problems([DUMP, `${DUMP}-wal`, `${DUMP}-shm`], null)).toEqual([]);
  });
});

describe('a sidecar of something else is still a stray', () => {
  it('refuses `notes.db-wal`, naming its absolute path', () => {
    const found = problems(['book.db', 'notes.db-wal']);
    expect(found.map((problem) => problem.code)).toEqual(['NOT_ALLOWED']);
    expect(found[0]?.path).toBe(`${DATA}/notes.db-wal`);
    expect(found[0]?.message).toContain(`${DATA}/notes.db-wal`);
    // The existing sentence still travels: the operator reads what would have passed.
    expect(found[0]?.message).toContain("is not in the volume's allow-list");
    expect(found[0]?.message).toContain('remove it by hand');
  });

  it('refuses a stray `-shm`, and both sidecars of one stray base as two lines', () => {
    expect(problems(['tmp.db-shm']).map((problem) => problem.path)).toEqual([`${DATA}/tmp.db-shm`]);
    expect(problems(['notes.db-wal', 'notes.db-shm']).map((problem) => problem.path)).toEqual([
      `${DATA}/notes.db-shm`,
      `${DATA}/notes.db-wal`,
    ]);
  });

  it('refuses a name that only looks like a sidecar: `book-before-x.db-wal.bak`', () => {
    const found = problems(['book-before-x.db-wal.bak']);
    expect(found.map((problem) => problem.code)).toEqual(['NOT_ALLOWED']);
    expect(found[0]?.path).toBe(`${DATA}/book-before-x.db-wal.bak`);
    expect(found[0]?.message).toContain(`${DATA}/book-before-x.db-wal.bak`);
    // A dump's name with another suffix is not a sidecar either: only `-wal` and `-shm` are.
    expect(verdict('book-before-x.db-something').ok).toBe(false);
  });

  it('refuses a sidecar of a sidecar: `book.db-wal-wal` is not a database’s file', () => {
    // `book.db-wal` passes the file rules, but it is a file SQLite writes, never one it opens —
    // the base of a sidecar must be a database, not another sidecar.
    expect(problems(['book.db', 'book.db-wal']).map((problem) => problem.path)).toEqual([]);
    expect(problems(['book.db-wal-wal']).map((problem) => problem.path)).toEqual([`${DATA}/book.db-wal-wal`]);
    expect(problems(['book.db-shm-shm']).map((problem) => problem.code)).toEqual(['NOT_ALLOWED']);
    expect(verdict('book.db-wal-wal').ok).toBe(false);
    // The real pair is untouched: a dump's own sidecars still pass (they are on the allow-list).
    expect(problems([DUMP, `${DUMP}-wal`, `${DUMP}-shm`])).toEqual([]);
  });

  it('refuses a directory named like a sidecar: a directory is judged by the directory rules', () => {
    const found = problems(['book.db-wal/']);
    expect(found[0]?.code).toBe('NOT_ALLOWED');
    expect(found[0]?.path).toBe(`${DATA}/book.db-wal`);
    expect(classifyDataEntry({ name: 'book.db-wal', directory: true, markerContent: null }).ok).toBe(false);
  });

  it('refuses a sidecar inside a stray directory by naming the directory, as the doctor does', () => {
    expect(problems([`tmp/${DUMP}-wal`]).map((problem) => problem.path)).toEqual([`${DATA}/tmp`]);
  });
});

describe('the refusal sentence still lists every allowed name', () => {
  it('names the whole allow-list on a stray sidecar', () => {
    const message = problems(['notes.db-wal'])[0]?.message ?? '';
    for (const entry of DATA_ALLOW) expect(message).toContain(entry.name);
    for (const entry of DATA_ALLOW_CONTENT) expect(message).toContain(entry.name);
    for (const entry of DATA_ALLOW_DIRS) expect(message).toContain(`${entry.name}/`);
    // The sidecar rule adds no name to the list: it is about the files already named.
    expect(DATA_ALLOW.map((entry) => entry.name)).toEqual([
      'book.db',
      'book.db-wal',
      'book.db-shm',
      '*.token',
      'book-before-*.db',
      'book-reset-*.db',
      'cover.*',
    ]);
  });
});
