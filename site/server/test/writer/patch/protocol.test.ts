/**
 * The patch protocol (BOOK-173 §1, BOOK-176): one JSON object, and every way its shape can be
 * refused — in the ledger's words.
 *
 * The bounds are not restated here: eight edits and the code-point limits are `patchCheck`'s
 * (`MAX_EDITS`, `MAX_OLD_CP`, `MAX_NEW_CP`) and the parser calls `shapeRefusal`, so a patch the
 * ledger would refuse is refused before the writer ever writes a byte — with the same code.
 */

import { describe, expect, it } from 'vitest';

import { MAX_EDITS, MAX_NEW_CP, MAX_OLD_CP } from '../../../src/ledger/patchCheck.ts';
import {
  PATCH_BOUNDS,
  declaredPatchMode,
  parsePatchAnswer,
  stripPatchFence,
  type PatchParse,
} from '../../../src/writer/patch/protocol.ts';

const VALID = {
  mode: 'patch',
  edits: [{ blockId: 'ch03#a1b2c3d4', oldText: 'Гуси шли по льду.', newText: 'Часы шли по кругу.' }],
  facts: ['часы'],
  note: 'one sentence',
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function codeOf(raw: string, opts?: { maxEdits?: number; maxNewChars?: number }): string {
  const parsed: PatchParse = parsePatchAnswer(raw, opts);
  return parsed.ok ? 'OK' : parsed.code;
}

function withEdit(edit: Record<string, unknown>): string {
  return json({ ...VALID, edits: [{ ...VALID.edits[0], ...edit }] });
}

describe('parsePatchAnswer — the one object', () => {
  it('reads the design’s own example, mark and all', () => {
    expect(parsePatchAnswer(json(VALID))).toEqual({ ok: true, patch: VALID });
  });

  it('tolerates exactly one surrounding json fence and strips it', () => {
    const fenced = `\`\`\`json\n${json(VALID)}\n\`\`\``;
    expect(parsePatchAnswer(fenced)).toEqual({ ok: true, patch: VALID });
    expect(stripPatchFence(fenced)).toBe(json(VALID));
    expect(parsePatchAnswer(`\`\`\`\n${json(VALID)}\n\`\`\``)).toEqual({ ok: true, patch: VALID });
  });

  it('refuses prose around the object, a second object, or a half-read one', () => {
    for (const raw of [
      `Вот правка: ${json(VALID)}`,
      `${json(VALID)}\nГотово.`,
      `${json(VALID)}\n${json(VALID)}`,
      `\`\`\`json\n${json(VALID)}\n\`\`\`\nи ещё абзац`,
      json(VALID).slice(0, -1),
      '',
    ]) {
      expect(codeOf(raw), raw.slice(0, 40)).toBe('PATCH_UNPARSED');
    }
  });

  it('refuses an array, a null and a scalar as the whole answer', () => {
    expect(codeOf('[]')).toBe('PATCH_SHAPE');
    expect(codeOf('null')).toBe('PATCH_SHAPE');
    expect(codeOf('42')).toBe('PATCH_SHAPE');
  });
});

describe('parsePatchAnswer — mode and the shape of an edit', () => {
  it('refuses an unknown mode, a missing mode and a bare rewrite answer', () => {
    expect(codeOf(json({ ...VALID, mode: 'edit' }))).toBe('PATCH_SHAPE');
    expect(codeOf(json({ edits: VALID.edits, facts: [] }))).toBe('PATCH_SHAPE');
    expect(codeOf(json({ mode: 'rewrite', edits: [], facts: [] }))).toBe('PATCH_SHAPE');
  });

  it('reads the declared mode before the contract, so a decline is an answer', () => {
    expect(declaredPatchMode(json({ mode: 'rewrite', note: 'a number changes' }))).toBe('rewrite');
    expect(declaredPatchMode(json(VALID))).toBe('patch');
    expect(declaredPatchMode('СОГЛАСЕН')).toBeNull();
    expect(declaredPatchMode(json({ mode: 'edit' }))).toBeNull();
    expect(declaredPatchMode(`\`\`\`json\n${json({ mode: 'rewrite' })}\n\`\`\``)).toBe('rewrite');
  });

  it('refuses wrong types, an empty id, a blank block, a heading and an insert', () => {
    expect(codeOf(withEdit({ blockId: 7 }))).toBe('PATCH_SHAPE');
    expect(codeOf(withEdit({ blockId: '  ' }))).toBe('PATCH_SHAPE');
    expect(codeOf(withEdit({ oldText: 5 }))).toBe('PATCH_SHAPE');
    expect(codeOf(withEdit({ newText: null }))).toBe('PATCH_SHAPE');
    expect(codeOf(withEdit({ newText: 'два\n\nабзаца' }))).toBe('PATCH_SHAPE');
    expect(codeOf(withEdit({ newText: '# заголовок' }))).toBe('PATCH_SHAPE');
    // The ledger's `PatchEdit` names one block and replaces text inside it: no insert, no delete.
    expect(codeOf(withEdit({ blockId: null, afterBlockId: 'ch03#a1b2c3d4', oldText: '' }))).toBe('PATCH_SHAPE');
  });

  it('takes the bounds from patchCheck, not from a second copy of the numbers', () => {
    expect(PATCH_BOUNDS).toEqual({ maxEdits: MAX_EDITS, maxOldCp: MAX_OLD_CP, maxNewCp: MAX_NEW_CP });
    const many = Array.from({ length: MAX_EDITS + 1 }, (_, i) => ({ ...VALID.edits[0], blockId: `ch03#b${String(i)}` }));
    expect(codeOf(json({ ...VALID, edits: many }))).toBe('PATCH_INVALID');
    expect(codeOf(json({ ...VALID, edits: many.slice(0, 2) }), { maxEdits: 1 })).toBe('PATCH_INVALID');
    expect(codeOf(withEdit({ newText: 'x'.repeat(MAX_NEW_CP) }))).toBe('OK');
    expect(codeOf(withEdit({ newText: 'x'.repeat(MAX_NEW_CP + 1) }))).toBe('PATCH_INVALID');
    expect(codeOf(withEdit({ newText: 'x'.repeat(11) }), { maxNewChars: 10 })).toBe('PATCH_INVALID');
    expect(codeOf(withEdit({ oldText: 'x'.repeat(MAX_OLD_CP + 1) }))).toBe('PATCH_INVALID');
  });

  it('counts code points, not UTF-16 units: an emoji is one character for the ledger', () => {
    // The ledger bounds live in code points (`cpLength`); a 2 000-emoji pre-image is legal.
    expect(codeOf(withEdit({ oldText: '🙂'.repeat(MAX_OLD_CP), newText: 'Часы.' }))).toBe('OK');
  });

  it('refuses an answer that changes nothing, and one with no edits at all', () => {
    expect(codeOf(json({ ...VALID, edits: [] }))).toBe('PATCH_INVALID');
    expect(codeOf(withEdit({ newText: 'Гуси шли по льду.' }))).toBe('PATCH_INVALID');
  });
});

describe('parsePatchAnswer — facts and note', () => {
  it('requires facts to be an array of short quoted strings', () => {
    expect(codeOf(json({ ...VALID, facts: 'часы' }))).toBe('PATCH_SHAPE');
    expect(codeOf(json({ ...VALID, facts: Array.from({ length: 13 }, () => 'факт') }))).toBe('PATCH_FACTS_INVALID');
    expect(codeOf(json({ ...VALID, facts: [''] }))).toBe('PATCH_FACTS_INVALID');
    expect(codeOf(json({ ...VALID, facts: [7] }))).toBe('PATCH_FACTS_INVALID');
    expect(codeOf(json({ ...VALID, facts: ['ф'.repeat(201)] }))).toBe('PATCH_FACTS_INVALID');
    expect(codeOf(json({ ...VALID, facts: [] }))).toBe('OK');
  });

  it('keeps the note optional and bounded, and never lets it into the chapter', () => {
    expect(codeOf(json({ ...VALID, note: undefined }))).toBe('OK');
    expect(codeOf(json({ ...VALID, note: null }))).toBe('OK');
    expect(codeOf(json({ ...VALID, note: 'n'.repeat(400) }))).toBe('OK');
    expect(codeOf(json({ ...VALID, note: 'n'.repeat(401) }))).toBe('PATCH_SHAPE');
    expect(codeOf(json({ ...VALID, note: 3 }))).toBe('PATCH_SHAPE');
    const parsed = parsePatchAnswer(json({ ...VALID, note: undefined }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.patch.note).toBeNull();
  });

  it('names the edit it refused', () => {
    const parsed = parsePatchAnswer(json({ ...VALID, edits: [{ ...VALID.edits[0] }, { blockId: 1 }] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe('PATCH_SHAPE');
    expect(parsed.detail).toContain('edit 2');
  });
});
