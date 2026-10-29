/**
 * The mode decision (BOOK-173 §4): one table, no inference.
 *
 * The dangerous direction is a **rewrite silently downgraded to a patch**: a filed change of
 * outcome becomes cosmetics and closes done (§7). So the default is the wider mode, and only a
 * filing that says it is about a phrase — or whose anchor names a sentence the book still holds —
 * may patch, and only on a chapter that exists (BOOK-DOC-65 §4).
 */

import { describe, expect, it } from 'vitest';

import { MODEL_REWRITE, REVISION_MODE, chooseMode } from '../../src/writer/mode.ts';
import { modeLine } from '../../src/writer/stages.ts';

describe('chooseMode — the design’s table, row by row', () => {
  it('rewrites a draft, a slot with no text, and a basis-only slot', () => {
    expect(chooseMode({ pass: 'draft', scopeHint: 'phrase' }, false)).toEqual({ mode: 'rewrite', reason: 'slot-empty' });
    expect(chooseMode({ pass: 'change', scopeHint: 'phrase' }, false)).toEqual({ mode: 'rewrite', reason: 'slot-empty' });
    expect(chooseMode({ pass: 'change', scopeHint: null }, false)).toEqual({ mode: 'rewrite', reason: 'slot-empty' });
  });

  it('rewrites a chapter-scope filing', () => {
    expect(chooseMode({ pass: 'change', scopeHint: 'chapter' }, true)).toEqual({ mode: 'rewrite', reason: 'chapter-scope' });
  });

  it('patches a phrase-scope filing on a written chapter', () => {
    expect(chooseMode({ pass: 'change', scopeHint: 'phrase' }, true)).toEqual({ mode: 'patch', reason: 'phrase-scope' });
  });

  it('rewrites when the step has no change behind it: cascade, ending, front, sweep', () => {
    for (const pass of ['cascade', 'ending', 'front', 'sweep']) {
      expect(chooseMode({ pass, scopeHint: null }, true), pass).toEqual({ mode: 'rewrite', reason: 'no-scope' });
    }
  });

  it('patches a filing anchored on a live sentence, with no phrase scope in the row', () => {
    // BOOK-173 §3: v25 gave the filing a sentence id; a change aimed at one may patch it even when
    // the row stored before it said nothing about a phrase.
    expect(chooseMode({ pass: 'change', scopeHint: null, sentenceAnchor: true }, true)).toEqual({
      mode: 'patch',
      reason: 'sentence-anchor',
    });
    // A dead anchor is not a licence to patch: the pass rewrites.
    expect(chooseMode({ pass: 'change', scopeHint: null, sentenceAnchor: false }, true)).toEqual({
      mode: 'rewrite',
      reason: 'no-scope',
    });
    // Chapter scope beats the anchor: the filing asked for the whole chapter.
    expect(chooseMode({ pass: 'change', scopeHint: 'chapter', sentenceAnchor: true }, true)).toEqual({
      mode: 'rewrite',
      reason: 'chapter-scope',
    });
    // And an empty slot is still an empty slot, anchor or not.
    expect(chooseMode({ pass: 'change', scopeHint: null, sentenceAnchor: true }, false)).toEqual({
      mode: 'rewrite',
      reason: 'slot-empty',
    });
  });

  it('honours the owner’s kill switch: WRITER_MODE_DEFAULT=rewrite rewrites every pass', () => {
    // BOOK-173 §4: the switch is read before any other rule — a phrase filing on a written
    // chapter with a live anchor still rewrites while it stands.
    expect(chooseMode({ pass: 'change', scopeHint: 'phrase' }, true, 'rewrite')).toEqual({
      mode: 'rewrite',
      reason: 'default-rewrite',
    });
    expect(chooseMode({ pass: 'change', scopeHint: null, sentenceAnchor: true }, true, 'rewrite')).toEqual({
      mode: 'rewrite',
      reason: 'default-rewrite',
    });
    // The signed-off default is unchanged: `patch` is the same table as no argument at all.
    expect(chooseMode({ pass: 'change', scopeHint: 'phrase' }, true, 'patch')).toEqual(
      chooseMode({ pass: 'change', scopeHint: 'phrase' }, true),
    );
    expect(modeLine({ mode: 'rewrite', reason: 'default-rewrite' })).toBe(
      'режим: перепись (переключатель WRITER_MODE_DEFAULT)',
    );
  });

  it('never patches a draft pass, even on a written chapter', () => {
    expect(chooseMode({ pass: 'draft', scopeHint: 'phrase' }, true)).toEqual({ mode: 'rewrite', reason: 'slot-empty' });
  });
});

describe('the two modes that are not chosen from the table', () => {
  it('keeps a gate-driven revision a rewrite, whatever the filing said', () => {
    expect(REVISION_MODE).toEqual({ mode: 'rewrite', reason: 'revision' });
  });

  it('honours a model that asks for the whole-chapter path', () => {
    expect(MODEL_REWRITE).toEqual({ mode: 'rewrite', reason: 'model' });
  });
});

describe('the stage line — one fact, no new stage names', () => {
  it('says «правка» for a patch and «перепись» otherwise, with the reason in parentheses', () => {
    expect(modeLine({ mode: 'patch', reason: 'phrase-scope' })).toBe('режим: правка (заявка про фразу)');
    expect(modeLine({ mode: 'rewrite', reason: 'chapter-scope' })).toBe('режим: перепись (заявка про главу)');
    expect(modeLine({ mode: 'rewrite', reason: 'no-scope' })).toBe('режим: перепись (заявка не про фразу)');
    expect(modeLine({ mode: 'rewrite', reason: 'slot-empty' })).toBe('режим: перепись (слот пуст)');
    expect(modeLine({ mode: 'rewrite', reason: 'model' })).toBe('режим: перепись (просит модель)');
    expect(modeLine({ mode: 'rewrite', reason: 'revision' })).toBe('режим: перепись (замечания гейта)');
    expect(modeLine({ mode: 'patch', reason: 'sentence-anchor' })).toBe('режим: правка (заявка привязана к предложению)');
  });
});
