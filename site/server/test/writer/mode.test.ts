/**
 * The mode decision (BOOK-173 §4): one table, no inference.
 *
 * The dangerous direction is a **rewrite silently downgraded to a patch**: a filed change of
 * outcome becomes cosmetics and closes done (§7). So the default is the wider mode, and only a
 * filing that says it is about a phrase — on a chapter that exists — may patch.
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
  });
});
