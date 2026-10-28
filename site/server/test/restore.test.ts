import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FRAME_FIRST_SENTENCE } from '@book/shared';

import { SITE_ROOT, loadConfig } from '../src/config.ts';
import type { EngineDeps } from '../src/engine/types.ts';
import { reconcileRestore } from '../src/engine/reconcile.ts';
import { reconcile as rescan } from '../src/ingest/reconcile.ts';
import { listReconciles, listUngated, recordReconcile, ungatedOf } from '../src/integrity/ungated.ts';
import { releaseLease, seedChange } from './history/helpers.ts';
import { createFixture, type Fixture } from './helpers.ts';

const FRONT =
  'Без названия\n\n' +
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';

const A =
  `${FRAME_FIRST_SENTENCE} Тестовый абзац номер один. Это служебный текст, он не является текстом книги.`;

/** Both versions are a page (§F007 floor), and differ only in the second paragraph. */
const FILLER =
  'Служебный абзац для проверки объёма страницы. Это предложение повторяется, чтобы набрать нужную длину, и не является текстом книги. '
    .repeat(16)
    .trimEnd();

const V1 = `Тестовая глава\n\n${A}\n\nТестовый абзац номер два. Это служебный текст, он не является текстом книги.\n\n${FILLER}`;

const V2 = `Тестовая глава\n\n${A}\n\nДругой служебный текст, тоже не из книги.\n\n${FILLER}`;

function ingest(fixture: Fixture, text: string, at = '2026-10-25T09:00:00Z') {
  fixture.write('ch01.md', text);
  return rescan(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir, now: new Date(at) });
}

function deps(fixture: Fixture): EngineDeps {
  return {
    db: fixture.db,
    config: loadConfig({ BOOK_ROOT: fixture.root, DATA_DIR: fixture.dataDir, LOG_LEVEL: 'error' }),
    bookRoot: fixture.root,
    clock: { now: () => Date.parse('2026-10-25T10:00:00Z') },
  };
}

function latestRevision(fixture: Fixture) {
  return fixture.db
    .prepare(`SELECT rev, kind, cause_kind, attributed, log_note FROM revisions WHERE chapter = 1 ORDER BY rev DESC LIMIT 1`)
    .get() as { rev: number; kind: string; cause_kind: string; attributed: number; log_note: string | null };
}

describe('a restore is recognised by its content (§13.3)', () => {
  it('publishes an unattributed restore when an old text comes back with no lease', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, V1);
      ingest(fixture, V2, '2026-10-25T09:10:00Z');

      const report = ingest(fixture, V1, '2026-10-25T09:20:00Z');
      expect(report.revised).toEqual([1]);

      const revision = latestRevision(fixture);
      expect(revision).toMatchObject({
        rev: 3,
        kind: 'restore',
        cause_kind: 'restore',
        attributed: 0,
        log_note: 'restore of rev 1',
      });

      // The log says the same thing, and says who did it: an operator, not a writer.
      const event = fixture.db
        .prepare(
          `SELECT kind, author_kind, author_label, payload FROM events
            WHERE chapter = 1 AND kind = 'chapter.restored' ORDER BY hseq DESC LIMIT 1`,
        )
        .get() as { kind: string; author_kind: string; author_label: string; payload: string };
      expect(event.kind).toBe('chapter.restored');
      expect(event.author_kind).toBe('operator');
      expect(event.author_label).toBe('оператор');
      expect(JSON.parse(event.payload)).toMatchObject({ attributed: false, restoredRev: 1 });

      // The block chain names the operator too, not «правка вне процесса».
      const overwrite = fixture.db
        .prepare(`SELECT by_kind, by_label FROM overwrites WHERE chapter = 1 ORDER BY hseq DESC LIMIT 1`)
        .get() as { by_kind: string; by_label: string };
      expect(overwrite).toEqual({ by_kind: 'operator', by_label: 'оператор' });
    } finally {
      fixture.close();
    }
  });

  it('does not call a hand edit a restore: new text is «правка вне процесса»', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, V1);
      ingest(fixture, V2, '2026-10-25T09:10:00Z');
      const revision = latestRevision(fixture);
      expect(revision.kind).toBe('edit');
      expect(revision.cause_kind).toBe('draft');
      expect(revision.attributed).toBe(0);
      expect(listUngated(fixture.db)).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('does not call a leased write a restore, even when it puts an old text back', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, V1);
      ingest(fixture, V2, '2026-10-25T09:10:00Z');
      const seeded = seedChange(fixture.db, { index: 1, chapter: 1, label: 'Аня' });
      ingest(fixture, V1, '2026-10-25T09:20:00Z');

      const revision = latestRevision(fixture);
      expect(revision.kind).not.toBe('restore');
      expect(revision.cause_kind).toBe('change');
      expect(revision.attributed).toBe(1);
      expect(listUngated(fixture.db)).toEqual([]);
      releaseLease(fixture.db, seeded.leaseId);
    } finally {
      fixture.close();
    }
  });
});

describe('ungated until reconcile (§13.3, §20 M7)', () => {
  it('marks the chapter ungated, then clears it and records the gates', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, V1);
      ingest(fixture, V2, '2026-10-25T09:10:00Z');
      ingest(fixture, V1, '2026-10-25T09:20:00Z');

      expect(ungatedOf(fixture.db, 1)).toEqual({
        chapter: 1,
        rev: 3,
        at: '2026-10-25T09:20:00Z',
        restoredRev: 1,
      });

      const result = reconcileRestore(deps(fixture), { chapter: 1, because: 'restore rev 1' });
      expect(result).toMatchObject({
        chapter: 1,
        rev: 3,
        restoredRev: 1,
        actor: 'operator',
        because: 'restore rev 1',
      });
      // The gates were re-run, not assumed: the validator answered about the text on disk.
      expect(result.validation.errors).toBe(0);
      expect(result.validation.passed).toBe(true);
      expect(result.validation.warnings).toBeGreaterThan(0); // a page under the band's floor (10 000) is thin

      // The panel stops asking, and the mark is a row, not a flag.
      expect(listUngated(fixture.db)).toEqual([]);
      const marks = listReconciles(fixture.db);
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({ chapter: 1, rev: 3, actor: 'operator', because: 'restore rev 1' });
      // The operator's act is in the log too, and the mark points at it.
      expect(marks[0]?.hseq).toBeGreaterThan(0);
      const act = fixture.db
        .prepare(`SELECT kind, payload FROM events WHERE hseq = ?`)
        .get(marks[0]?.hseq) as { kind: string; payload: string };
      expect(act.kind).toBe('operator.restore');
      expect(JSON.parse(act.payload)).toMatchObject({ sourceRev: 1, because: 'restore rev 1' });
    } finally {
      fixture.close();
    }
  });

  it('refuses to reconcile a chapter that is not ungated', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, V1);
      expect(() => reconcileRestore(deps(fixture), { chapter: 1, because: 'nothing to reconcile' })).toThrowError(
        /не ждёт сверки/u,
      );
      expect(listReconciles(fixture.db)).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('refuses a chapter outside the book before touching anything', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      // The bound itself belongs to the engine (`engine/reconcile.ts`, its own pass); this checks
      // that the wrapper refuses a number no book could hold, whatever the bound reads.
      for (const chapter of [0, 1000, 1.5]) {
        expect(() => reconcileRestore(deps(fixture), { chapter, because: 'x' })).toThrowError(/between 1 and \d+/u);
      }
      expect(listReconciles(fixture.db)).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('reconciles even when the imprint has drifted: F020 reports it, it does not crash', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, V1);
      ingest(fixture, V2, '2026-10-25T09:10:00Z');
      ingest(fixture, V1, '2026-10-25T09:20:00Z');

      const drifted = join(fixture.root, 'drifted-imprint.json');
      writeFileSync(
        drifted,
        JSON.stringify({ author: 'Кто-то', copyright: '© Кто-то', publisher: 'Издательство' }),
        'utf8',
      );
      const base = deps(fixture);
      const result = reconcileRestore(
        { ...base, config: { ...base.config, imprintPath: drifted } },
        { chapter: 1, because: 'restore rev 1' },
      );
      expect(result.validation.passed).toBe(false);
      expect(result.validation.rules).toContain('F020');
      // The mark is still written: an observation of a drifting imprint is what the panel wants.
      expect(listReconciles(fixture.db)).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it('survives a corrupt mark row instead of failing the panel', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      fixture.db
        .prepare(
          `INSERT INTO reconciles (chapter, rev, at, actor, because, validation)
           VALUES (1, 2, '2026-10-25T09:00:00Z', 'operator', 'restore', 'not json')`,
        )
        .run();
      const marks = listReconciles(fixture.db);
      expect(marks[0]?.validation).toEqual({ errors: 0, warnings: 0, passed: false, rules: [] });
    } finally {
      fixture.close();
    }
  });

  it('refuses a reconcile without a reason: the operator’s words are the record', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, V1);
      ingest(fixture, V2, '2026-10-25T09:10:00Z');
      ingest(fixture, V1, '2026-10-25T09:20:00Z');
      expect(() => reconcileRestore(deps(fixture), { chapter: 1, because: '   ' })).toThrowError(/because/u);
    } finally {
      fixture.close();
    }
  });

  it('clears ungated by itself when the next write touches the chapter', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, V1);
      ingest(fixture, V2, '2026-10-25T09:10:00Z');
      ingest(fixture, V1, '2026-10-25T09:20:00Z');
      expect(listUngated(fixture.db)).toHaveLength(1);

      // The next step rewrites the chapter for real: the restore is no longer the last word.
      ingest(fixture, `Тестовая глава\n\n${A}\n\nДобавленный абзац номер два.`, '2026-10-25T09:30:00Z');
      expect(listUngated(fixture.db)).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('records a reconcile twice as one mark, never as a second fact', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, V1);
      ingest(fixture, V2, '2026-10-25T09:10:00Z');
      ingest(fixture, V1, '2026-10-25T09:20:00Z');
      reconcileRestore(deps(fixture), { chapter: 1, because: 'restore rev 1' });
      // A second run is refused because the chapter is no longer ungated, and it cannot
      // duplicate the row either: the mark is unique per (chapter, rev).
      expect(() => reconcileRestore(deps(fixture), { chapter: 1, because: 'again' })).toThrowError();
      expect(listReconciles(fixture.db)).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });
});

const exec = promisify(execFile);

/**
 * A child `node` must not inherit the coverage collector: vitest's v8 provider hands
 * `NODE_V8_COVERAGE` to the workers, and a subprocess writing into the same temp directory
 * races the reporter that cleans it. The tool is unaffected; only the instrumentation goes.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  return env;
}

/** The operator tool, run as the operator runs it: `node site/bin/restore.mjs`. */
async function cli(args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec('node', ['bin/restore.mjs', ...args], {
      cwd: SITE_ROOT,
      env: childEnv(),
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

describe('bin/restore.mjs — the operator rolls back a snapshot (§13.3)', () => {
  it('lists the revisions, restores a chosen one, and names the next command', async () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, V1);
      ingest(fixture, V2, '2026-10-25T09:10:00Z');
      const root = `--root=${fixture.root}`;
      const data = `--data-dir=${fixture.dataDir}`;

      const list = await cli(['--chapter', '1', '--list', root, data]);
      expect(list.code).toBe(0);
      expect(list.out).toContain('глава 1');
      expect(list.out).toContain('rev   2');
      expect(list.out).toContain('← сейчас');

      const dry = await cli(['--chapter', '1', '--rev', '1', '--dry-run', root, data]);
      expect(dry.code).toBe(0);
      expect(dry.out).toContain('без записи');
      // A dry run writes nothing.
      expect(readFileSync(`${fixture.manuscript}/ch01.md`, 'utf8')).toBe(V2);

      const restore = await cli(['--chapter', '1', '--rev', '1', root, data]);
      expect(restore.code).toBe(0);
      expect(restore.out).toContain('восстановлена из rev 1');
      expect(restore.out).toContain(`engine.mjs reconcile 1 --because "restore rev 1"`);
      expect(readFileSync(`${fixture.manuscript}/ch01.md`, 'utf8')).toBe(V1);

      // The site then labels it: attributed:false, kind restore, ungated until reconcile.
      rescan(fixture.db, { bookRoot: fixture.root, dataDir: fixture.dataDir, now: new Date('2026-10-25T09:30:00Z') });
      expect(latestRevision(fixture)).toMatchObject({ rev: 3, kind: 'restore', cause_kind: 'restore', attributed: 0 });
      expect(listUngated(fixture.db)).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it('refuses a revision that does not exist and a chapter without arguments', async () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      ingest(fixture, V1);
      const root = `--root=${fixture.root}`;
      const data = `--data-dir=${fixture.dataDir}`;

      const missing = await cli(['--chapter', '1', '--rev', '9', root, data]);
      expect(missing.code).toBe(1);
      expect(missing.out).toContain('не имеет ревизии 9');

      const noChapter = await cli([root, data]);
      expect(noChapter.code).toBe(1);
      expect(noChapter.out).toContain('--chapter N is required');

      // BOOK-155: the CLI's own bound is the book's last chapter.
      const tooFar = await cli(['--chapter', '43', '--list', root, data]);
      expect(tooFar.code).toBe(1);
      expect(tooFar.out).toContain('between 1 and 42');

      const same = await cli(['--chapter', '1', '--rev', '1', root, data]);
      expect(same.code).toBe(0);
      expect(same.out).toContain('уже на rev 1');
    } finally {
      fixture.close();
    }
  });
});

describe('the mark row itself (§13.3)', () => {
  it('normalises what it writes: a blank reason and actor become the operator’s defaults', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      const row = recordReconcile(fixture.db, {
        chapter: 4,
        rev: 2,
        actor: '   ',
        because: '   ',
        validation: { errors: 0, warnings: 1, passed: true, rules: ['F007'] },
        nowMs: Date.parse('2026-10-25T12:00:00Z'),
      });
      expect(row).toMatchObject({ chapter: 4, rev: 2, actor: 'operator', because: 'restore', hseq: null });
      expect(row.validation).toEqual({ errors: 0, warnings: 1, passed: true, rules: ['F007'] });
    } finally {
      fixture.close();
    }
  });

  it('reads a half-written or corrupt validation payload without throwing', () => {
    const fixture = createFixture({ '00-front.md': FRONT });
    try {
      fixture.db
        .prepare(
          `INSERT INTO reconciles (chapter, rev, at, actor, because, validation)
           VALUES (2, 1, '2026-10-25T09:00:00Z', 'operator', 'partial', '{"errors": 3}')`,
        )
        .run();
      const row = listReconciles(fixture.db)[0];
      expect(row?.validation).toEqual({ errors: 3, warnings: 0, passed: false, rules: [] });
    } finally {
      fixture.close();
    }
  });
});
