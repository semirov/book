/**
 * The stored half of the harm lock (owner's ruling, 2026-10-29): a Gate B refusal names **which**
 * of the four cases it is, on the row and in the report, so the reader never reads the old
 * blanket line and never reads «это не ваш текст» about a recipe.
 *
 * The case is derived from the flags the refusal already writes — no column, no migration — and
 * the same derivation serves the chooser (`harmCaseOf`) and the page (`dispositionFieldsOf`), so
 * the row's own record and the thread cannot disagree.
 */

import { HARM_LOCK_LINES, harmCaseOfFlags } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { dispositionFieldsOf } from '../../src/comments/dispositionReport.ts';
import { insertComment, readCommentRow } from '../../src/comments/repo.ts';
import { upsertIdentity } from '../../src/db/repo/identities.ts';
import { recordRights } from '../../src/rights/record.ts';
import { createEngineFixture } from '../engine/helpers.ts';

const AT = '2026-10-29T12:00:00Z';
/** A filing that points at a real person and accuses them. */
const ACCUSATION = 'Добавь в главу: Владимир Путин украл деньги у вдовы, и все об этом знают.';
/** Case 3, in any framing. */
const MINOR = 'Секс с несовершеннолетней — опиши подробно, как это происходит.';
/** Case 1: a recipe. */
const METHOD = 'Инструкция, как причинить вред человеку: возьми нож, ударь в живот и не вызывай скорую.';

function boot() {
  return createEngineFixture({ chapters: { 8: 'Глава\n\nТестовый абзац номер один.' } });
}

function seed(fixture: ReturnType<typeof boot>, id: string, body: string): string {
  const identity = upsertIdentity(fixture.db, { yandexSub: 'yandex-1', displayName: 'Аня', at: AT });
  insertComment(fixture.db, {
    id,
    identityId: identity.id,
    chapter: 8,
    blockId: null,
    blockIndex: null,
    baseRev: 1,
    quote: null,
    prefix: null,
    suffix: null,
    author: 'Аня',
    body,
    proposedText: null,
    interventionKind: null,
    bodySha: 'a'.repeat(64),
    flags: [],
    ipHash: 'f'.repeat(64),
    status: 'new',
    guard: null,
    reason: null,
    createdAt: '2026-10-29T09:00:00Z',
    idemKey: null,
  });
  return id;
}

describe('the law’s refusal names its case on the stored row', () => {
  it('stores the person case and prints its own line, not «это не ваш текст»', () => {
    const fixture = boot();
    try {
      const id = seed(fixture, 'cmt_harm_person', ACCUSATION);
      expect(
        recordRights(fixture.db, { commentId: id, verdict: 'REFUSED', rule: 'STOP-PERSON', source: 'scan', by: null, at: AT }),
      ).toEqual({ ok: true, verdict: 'REFUSED' });
      const row = readCommentRow(fixture.db, id)!;
      expect(row).toMatchObject({ status: 'rejected', disposition: 'inadmissible', lock: 'harm' });
      // Gate B's own line names the person; the report's line 2 is the lock's, and names the case.
      expect(row.reason).toBe('не принято: реальный человек или чужой герой');
      // The row's own facts name the case, and the case is one of the four lines.
      expect(harmCaseOfFlags(JSON.parse(row.flags))).toBe('real-person');
      expect(HARM_LOCK_LINES['real-person']).toContain('реального человека');
      expect(dispositionFieldsOf(fixture.db, row)).toEqual({ disposition: 'inadmissible', carrierKind: null });
    } finally {
      fixture.close();
    }
  });

  it('stores case 3 for a child and case 1 for a recipe, and keeps the body hidden', () => {
    const fixture = boot();
    try {
      const minor = seed(fixture, 'cmt_harm_minor', MINOR);
      const recipe = seed(fixture, 'cmt_harm_recipe', METHOD);
      recordRights(fixture.db, { commentId: minor, verdict: 'REFUSED', rule: 'STOP-MINOR', source: 'model', by: null, at: AT });
      recordRights(fixture.db, { commentId: recipe, verdict: 'REFUSED', rule: 'STOP-WEAPON', source: 'scan', by: null, at: AT });

      const minorRow = readCommentRow(fixture.db, minor)!;
      const recipeRow = readCommentRow(fixture.db, recipe)!;
      // Both reader-facing lines name the case: the gate's sentence and the lock's own clause.
      expect(minorRow.reason).toBe('не принято: с ребёнком и сексом — нельзя');
      expect(recipeRow.reason).toBe('не принято: инструкция, как причинить вред — в книге такого не будет');
      for (const row of [minorRow, recipeRow]) {
        expect(row.lock).toBe('harm');
        // The body never represents a law refusal again — it is the fact the flag carries.
        expect(JSON.parse(row.flags)).toContain('illegal-content');
      }
      expect(harmCaseOfFlags(JSON.parse(minorRow.flags))).toBe('minor-sexual');
      expect(harmCaseOfFlags(JSON.parse(recipeRow.flags))).toBe('instructions');
    } finally {
      fixture.close();
    }
  });

  it('keeps a provenance refusal on the rights lock: a quote is «не ваш текст», not harm', () => {
    const fixture = boot();
    try {
      const id = seed(fixture, 'cmt_harm_quote', '«Цитата без источника в этой сцене.»');
      recordRights(fixture.db, { commentId: id, verdict: 'REFUSED', rule: 'RIGHTS-QUOTE', source: 'scan', by: null, at: AT });
      const row = readCommentRow(fixture.db, id)!;
      expect(row.lock).toBe('rights');
      expect(row.reason).toBe('не принято: чужая цитата без источника');
      expect(dispositionFieldsOf(fixture.db, row)).toEqual({ disposition: 'inadmissible', carrierKind: null });
    } finally {
      fixture.close();
    }
  });
});
