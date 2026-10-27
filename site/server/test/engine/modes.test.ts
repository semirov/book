import type { Finding } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { readChange, listChanges } from '../../src/engineState/changes.ts';
import { modesOfSteps } from '../../src/engineState/modes.ts';
import { createEngineFixture, runStubStep } from './helpers.ts';

/**
 * A retroactive cause is data (BOOK-DOC-4; `style/VOICE.md` §Ретроспектива).
 *
 * The editor files one of the three modes with its finding; the engine normalises it (an
 * unknown word is dropped like any untrusted field), persists it with the verdict, and the
 * public change DTO carries a plain ordered list of modes — never the finding's text, never
 * a role. That list is what the card, the focus view and the chronicle render as
 * «причина установлена · оформление» or «расхождение зафиксировано».
 */

const FINDING: Finding = {
  severity: 'minor',
  location: 'глава 2, абзац 1',
  defect: 'причина названа после события и не оформлена документом',
  fix: 'оформить причину актом и сослаться на него в абзаце',
  mode: 'оформление',
};

function fixtureWithBook() {
  const fixture = createEngineFixture();
  // Three written chapters give the ripple somewhere to go in both directions.
  fixture.writeChapterBlocks(1, 'Начало', ['Тестовый абзац номер один. Это служебный текст.']);
  fixture.writeChapterBlocks(2, 'Середина', ['Тестовый абзац номер два. Это служебный текст.']);
  fixture.writeChapterBlocks(3, 'Конец', ['Тестовый абзац номер три. Это служебный текст.']);
  return fixture;
}

describe('the retroactive mode travels from a verdict to the public card', () => {
  it('is normalised, persisted with the verdict and aggregated as a plain list', () => {
    const fixture = fixtureWithBook();
    try {
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 2,
        intent: 'сослаться на акт, которым заведена причина',
      });
      const origin = runStubStep(fixture, {
        title: 'Середина',
        blocks: ['Тестовый абзац номер два с ссылкой на акт. Это служебный текст.'],
        seams: [{ boundary: 3, reason: 'в главе 3 сказано иначе' }],
        editor: { verdict: 'GAP', findings: [FINDING] },
        consultant: { verdict: 'HOLDS', findings: [] },
      });
      expect(origin?.assignment.pass).toBe('change');

      const dto = readChange(fixture.db, change.id, fixture.clock.now());
      expect(dto?.modes).toEqual(['оформление']);
      expect(dto?.cascade?.modes).toEqual(['оформление']);
      // The verdict is persisted with the mode, in the findings JSON the engine already keeps.
      // A blockerless `GAP` is downgraded to `HOLDS`; the finding and its mode are kept.
      const stored = fixture.db.prepare('SELECT findings FROM gate_verdicts').all() as Array<{ findings: string }>;
      expect(stored.some((row) => row.findings.includes('оформление'))).toBe(true);
      // Nothing of the finding's own text may reach the public projection.
      expect(JSON.stringify(dto)).not.toContain(FINDING.defect);
      expect(JSON.stringify(dto)).not.toContain(FINDING.location);
      expect(JSON.stringify(dto)).not.toContain('editor');
    } finally {
      fixture.close();
    }
  });

  it('drops an unknown mode instead of inventing a fourth one, and shows none for a refusal', () => {
    const fixture = fixtureWithBook();
    try {
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 2,
        intent: 'назвать причину документально',
      });
      runStubStep(fixture, {
        title: 'Середина',
        blocks: ['Тестовый абзац номер два. Это служебный текст, правленый.'],
        editor: {
          verdict: 'GAP',
          findings: [{ ...FINDING, mode: 'исправление' as unknown as Finding['mode'] }],
        },
      });
      const dto = readChange(fixture.db, change.id, fixture.clock.now());
      expect(dto?.modes).toEqual([]);
      // The origin reported no seam, so the change stayed local: no cascade aggregate to read.
      expect(dto?.cascade).toBeNull();

      // A refused intervention never becomes a change at all: no change, no states.
      expect(readChange(fixture.db, 'chg_missing', fixture.clock.now())).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('reads a cause from the editor only, never from a consultant finding', () => {
    const fixture = fixtureWithBook();
    try {
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 2,
        intent: 'назвать причину документально',
      });
      runStubStep(fixture, {
        title: 'Середина',
        blocks: ['Тестовый абзац номер два. Это служебный текст, правленый.'],
        editor: { verdict: 'HOLDS', findings: [] },
        consultant: { verdict: 'GAP', findings: [{ ...FINDING, mode: 'поправка' }] },
      });
      // The consultant's finding is kept as provenance, but it may not file a cause.
      const stored = fixture.db
        .prepare(`SELECT findings FROM gate_verdicts WHERE role = 'consultant'`)
        .get() as { findings: string };
      expect(stored.findings).toContain('поправка');
      const dto = readChange(fixture.db, change.id, fixture.clock.now());
      expect(dto?.modes).toEqual([]);
      expect(listChanges(fixture.db).find((row) => row.id === change.id)?.modes).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('ignores a findings blob that is not a list of findings at all', () => {
    const fixture = fixtureWithBook();
    try {
      fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 2, intent: 'назвать причину' });
      runStubStep(fixture, {
        title: 'Середина',
        blocks: ['Тестовый абзац номер два. Это служебный текст, правленый.'],
      });
      const step = fixture.db.prepare('SELECT step_id FROM steps LIMIT 1').get() as { step_id: string };
      const overwrite = fixture.db.prepare(
        `UPDATE gate_verdicts SET findings = ? WHERE step_id = ? AND role = 'editor'`,
      );
      overwrite.run(JSON.stringify({ mode: 'оформление' }), step.step_id);
      expect(modesOfSteps(fixture.db, [step.step_id])).toEqual([]);
      overwrite.run(JSON.stringify([null, 42, { defect: 'x' }, { mode: 'поправка' }]), step.step_id);
      expect(modesOfSteps(fixture.db, [step.step_id])).toEqual(['поправка']);
      expect(modesOfSteps(fixture.db, [])).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('carries the modes and the rewritten chapters on the list row the chronicle reads', () => {
    const fixture = fixtureWithBook();
    try {
      const change = fixture.engine.enqueue({
        kind: 'accepted_comment',
        chapter: 2,
        intent: 'зафиксировать расхождение документа и сцены',
      });
      runStubStep(fixture, {
        title: 'Середина',
        blocks: ['Тестовый абзац номер два. Это служебный текст с расхождением.'],
        editor: {
          verdict: 'GAP',
          findings: [{ ...FINDING, defect: 'сцена не подчиняется документу', mode: 'расхождение' }],
        },
      });

      const [row] = listChanges(fixture.db).filter((entry) => entry.id === change.id);
      expect(row?.modes).toEqual(['расхождение']);
      expect(row?.rewritten).toContain(2);
      expect(JSON.stringify(row)).not.toContain('сцена не подчиняется документу');
    } finally {
      fixture.close();
    }
  });
});
