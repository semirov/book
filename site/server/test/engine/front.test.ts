import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FRONT_ANNOTATION_FROZEN } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { getFrontRow } from '../../src/db/repo/front.ts';
import { acquireLease } from '../../src/engine/leases.ts';
import * as store from '../../src/engine/store.ts';
import type { EngineError } from '../../src/engine/types.ts';
import { applyFrontFile } from '../../src/ingest/applyFront.ts';
import { sha256Hex } from '../../src/util/hash.ts';
import { createEngineFixture, DEFAULT_ABOUT, type Fixture } from './helpers.ts';

/**
 * Page 2 is the owner's basis (BOOK-DOC-6): a `front` step exists for the title line and
 * nothing else. These tests pin the three facts the model rests on — the title rewrites, the
 * annotation never moves, and a pass that would move it is refused by name.
 */

const OTHER_ABOUT = DEFAULT_ABOUT.replace('Тестовая аннотация', 'Переписанная аннотация');

function openFrontLease(fixture: Fixture, id: string): string {
  store.insertStep(fixture.db, {
    stepId: id,
    cascadeId: null,
    seq: 0,
    wave: 0,
    lane: null,
    pass: 'front',
    chapter: null,
    boundary: 'front',
    seamsIn: '[]',
    revBefore: 0,
    at: new Date(fixture.clock.now()).toISOString(),
  });
  const step = store.getStep(fixture.db, id);
  if (!step) throw new Error('step insert failed');
  const lease = acquireLease(fixture.deps, { step, session: 'w1', expectedRev: 0, changeId: null });
  fixture.engine.start(lease.id);
  return lease.id;
}

function annotations(fixture: Fixture): string[] {
  return (fixture.db.prepare('SELECT about FROM front_revisions ORDER BY rev').all() as Array<{ about: string }>).map(
    (row) => row.about,
  );
}

describe('a front step rewrites the title, never page 2 (BOOK-DOC-6)', () => {
  it('lands a new title and leaves the annotation byte-identical', () => {
    const fixture = createEngineFixture({ front: { title: 'Без названия', about: DEFAULT_ABOUT } });
    try {
      const leaseId = openFrontLease(fixture, 'stp_front_title');
      fixture.writeFront('Другое название', DEFAULT_ABOUT);

      const landed = fixture.engine.land(leaseId);
      expect(landed.changed).toBe(true);
      expect(landed.revAfter).toBe(2);

      const front = getFrontRow(fixture.db);
      expect(front?.title).toBe('Другое название');
      expect(front?.about).toBe(DEFAULT_ABOUT);
      // Every front revision carries the same annotation; only the title moved.
      expect(annotations(fixture)).toEqual([DEFAULT_ABOUT, DEFAULT_ABOUT]);
      const hash = sha256Hex(DEFAULT_ABOUT);
      expect(annotations(fixture).every((about) => sha256Hex(about) === hash)).toBe(true);
      // A title revision is a title revision: nothing in the log claims page 2 changed.
      const logged = fixture.db
        .prepare(`SELECT payload FROM events WHERE kind = 'front.revised' ORDER BY hseq DESC LIMIT 1`)
        .get() as { payload: string };
      expect(JSON.parse(logged.payload)).not.toHaveProperty('annotationRejected');
      expect(JSON.parse(logged.payload)).not.toHaveProperty('changed');
    } finally {
      fixture.close();
    }
  });

  it('refuses a pass that would alter the annotation, by name', () => {
    const fixture = createEngineFixture({ front: { title: 'Без названия', about: DEFAULT_ABOUT } });
    try {
      const leaseId = openFrontLease(fixture, 'stp_front_refused');
      fixture.writeFront('Другое название', OTHER_ABOUT);

      let refusal: EngineError | null = null;
      try {
        fixture.engine.land(leaseId);
      } catch (error) {
        refusal = error as EngineError;
      }
      expect(refusal?.code).toBe(FRONT_ANNOTATION_FROZEN);
      expect(refusal?.status).toBe(409);
      expect(refusal?.message).toContain('только название');
      // Nothing landed: the projection still holds the basis and no revision was published.
      const front = getFrontRow(fixture.db);
      expect(front?.title).toBe('Без названия');
      expect(front?.about).toBe(DEFAULT_ABOUT);
      expect(front?.rev).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('records an annotation-only attempt as a refused rewrite while a lease owns the front', () => {
    const fixture = createEngineFixture({ front: { title: 'Без названия', about: DEFAULT_ABOUT } });
    try {
      // A live front lease is a pass writing: page 2 is basis against it (BOOK-7).
      openFrontLease(fixture, 'stp_front_direct');
      const result = applyFrontFile({
        db: fixture.db,
        dataDir: fixture.dataDir,
        raw: `Без названия\n\n${OTHER_ABOUT}\n`,
        mtimeMs: fixture.clock.now(),
        nowMs: fixture.clock.now(),
      });
      if (result.status === 'unchanged') throw new Error('expected a revision');
      expect(result.title).toBe('Без названия');
      expect(result.about).toBe(DEFAULT_ABOUT);
      expect(result.annotationRejected).toBe(FRONT_ANNOTATION_FROZEN);
      const logged = fixture.db
        .prepare(`SELECT payload FROM events WHERE kind = 'front.revised' ORDER BY hseq DESC LIMIT 1`)
        .get() as { payload: string };
      expect(JSON.parse(logged.payload)).toMatchObject({
        titleChanged: false,
        annotationRejected: FRONT_ANNOTATION_FROZEN,
      });
    } finally {
      fixture.close();
    }
  });

  it('accepts an owner hand edit of page 2 with no lease: the annotation becomes the new basis', () => {
    const fixture = createEngineFixture({ front: { title: 'Без названия', about: DEFAULT_ABOUT } });
    try {
      // No step, no lease: the owner edited `00-front.md` by hand (BOOK-7).
      const edited = applyFrontFile({
        db: fixture.db,
        dataDir: fixture.dataDir,
        raw: `Новое название\n\n${OTHER_ABOUT}\n`,
        mtimeMs: fixture.clock.now(),
        nowMs: fixture.clock.now(),
      });
      if (edited.status === 'unchanged') throw new Error('expected a revision');
      expect(edited.annotationChanged).toBe(true);
      expect(edited.annotationRejected).toBeNull();
      expect(edited.about).toBe(OTHER_ABOUT);
      expect(edited.aboutSha256).toBe(sha256Hex(OTHER_ABOUT));
      expect(edited.actor).toMatchObject({ kind: 'unattributed', label: 'правка вне процесса' });
      expect(getFrontRow(fixture.db)).toMatchObject({
        title: 'Новое название',
        about: OTHER_ABOUT,
        about_sha256: sha256Hex(OTHER_ABOUT),
        rev: 2,
      });
      // The history line names the hand edit, not a pass it cannot prove.
      const logged = fixture.db
        .prepare(`SELECT payload, author_kind, author_label FROM events WHERE kind = 'front.revised' ORDER BY hseq DESC LIMIT 1`)
        .get() as { payload: string; author_kind: string; author_label: string };
      expect(logged.author_kind).toBe('unattributed');
      expect(logged.author_label).toBe('правка вне процесса');
      expect(JSON.parse(logged.payload)).toMatchObject({
        annotationChanged: true,
        aboutSha256: sha256Hex(OTHER_ABOUT),
      });

      // The new text is the basis now: a pass that tries to move it is refused by name.
      const leaseId = openFrontLease(fixture, 'stp_front_after_owner');
      fixture.writeFront('Новое название', `${OTHER_ABOUT} Волна.`);
      let refusal: EngineError | null = null;
      try {
        fixture.engine.land(leaseId);
      } catch (error) {
        refusal = error as EngineError;
      }
      expect(refusal?.code).toBe(FRONT_ANNOTATION_FROZEN);
      expect(getFrontRow(fixture.db)?.about).toBe(OTHER_ABOUT);
    } finally {
      fixture.close();
    }
  });

  it('keeps the annotation as it was when an old snapshot is restored', () => {
    const fixture = createEngineFixture({ front: { title: 'Старое название', about: DEFAULT_ABOUT } });
    try {
      // An owner edit moves page 2, so the restore has a different annotation to put back.
      const edited = applyFrontFile({
        db: fixture.db,
        dataDir: fixture.dataDir,
        raw: `Новое название\n\n${OTHER_ABOUT}\n`,
        mtimeMs: fixture.clock.now(),
        nowMs: fixture.clock.now(),
      });
      if (edited.status === 'unchanged') throw new Error('expected a revision');
      expect(edited.about).toBe(OTHER_ABOUT);

      const first = fixture.db
        .prepare('SELECT snapshot FROM front_revisions ORDER BY rev ASC LIMIT 1')
        .get() as { snapshot: string };
      const restored = applyFrontFile({
        db: fixture.db,
        dataDir: fixture.dataDir,
        raw: readFileSync(join(fixture.dataDir, first.snapshot), 'utf8'),
        mtimeMs: fixture.clock.now(),
        nowMs: fixture.clock.now(),
      });
      if (restored.status === 'unchanged') throw new Error('expected a restored revision');
      expect(restored.title).toBe('Старое название');
      expect(restored.about).toBe(DEFAULT_ABOUT);
      expect(restored.aboutSha256).toBe(sha256Hex(DEFAULT_ABOUT));
      expect(getFrontRow(fixture.db)?.about).toBe(DEFAULT_ABOUT);
    } finally {
      fixture.close();
    }
  });

  it('keeps the annotation when an old title is restored', () => {
    const fixture = createEngineFixture({ front: { title: 'Старое название', about: DEFAULT_ABOUT } });
    try {
      const first = fixture.db
        .prepare('SELECT snapshot FROM front_revisions ORDER BY rev DESC LIMIT 1')
        .get() as { snapshot: string };

      const retitled = applyFrontFile({
        db: fixture.db,
        dataDir: fixture.dataDir,
        raw: `Новое название\n\n${DEFAULT_ABOUT}\n`,
        mtimeMs: fixture.clock.now(),
        nowMs: fixture.clock.now(),
      });
      expect(retitled.status).toBe('revised');

      // The operator puts the first snapshot back: the title returns, page 2 never moved.
      const restored = applyFrontFile({
        db: fixture.db,
        dataDir: fixture.dataDir,
        raw: readFileSync(join(fixture.dataDir, first.snapshot), 'utf8'),
        mtimeMs: fixture.clock.now(),
        nowMs: fixture.clock.now(),
      });
      if (restored.status === 'unchanged') throw new Error('expected a restored revision');
      expect(restored.title).toBe('Старое название');
      expect(restored.about).toBe(DEFAULT_ABOUT);
      expect(annotations(fixture)).toEqual([DEFAULT_ABOUT, DEFAULT_ABOUT, DEFAULT_ABOUT]);

      // And the restored sheet still lands through the gate: the title is a slot again.
      const leaseId = openFrontLease(fixture, 'stp_front_restored');
      fixture.writeFront('Старое название', DEFAULT_ABOUT);
      expect(fixture.engine.land(leaseId).landed).toBe(true);
    } finally {
      fixture.close();
    }
  });
});
