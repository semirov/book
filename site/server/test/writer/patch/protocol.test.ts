/**
 * The patch protocol (BOOK-173 §1): one JSON object, and every way its shape can be refused.
 *
 * The parser is the first of three doors (protocol → applier → validator). It is deliberately
 * unforgiving: prose around the object, a second object, a guessed "first { to last }" — all
 * `PATCH_UNPARSED`, because a guessed patch is worse than a parked pass.
 */

import { describe, expect, it } from 'vitest';

import {
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
    const parsed = parsePatchAnswer(json(VALID));
    expect(parsed).toEqual({ ok: true, patch: VALID });
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

  it('refuses wrong types, an empty id, a blank block and a heading', () => {
    expect(codeOf(withEdit({ blockId: 7 }))).toBe('PATCH_SHAPE');
    expect(codeOf(withEdit({ blockId: '  ' }))).toBe('PATCH_SHAPE');
    expect(codeOf(withEdit({ oldText: 5 }))).toBe('PATCH_SHAPE');
    expect(codeOf(withEdit({ newText: null }))).toBe('PATCH_SHAPE');
    expect(codeOf(withEdit({ newText: 'два\n\nабзаца' }))).toBe('PATCH_SHAPE');
    expect(codeOf(withEdit({ newText: '# заголовок' }))).toBe('PATCH_SHAPE');
    expect(codeOf(withEdit({ afterBlockId: 3 }))).toBe('PATCH_SHAPE');
  });

  it('requires afterBlockId on an insert, and no pre-image with it', () => {
    expect(codeOf(withEdit({ blockId: null, oldText: '', newText: 'Новый абзац.' }))).toBe('PATCH_SHAPE');
    expect(codeOf(withEdit({ blockId: null, afterBlockId: 'ch03#a1b2c3d4', oldText: 'Гуси', newText: 'Новый.' }))).toBe(
      'PATCH_SHAPE',
    );
    const insert = parsePatchAnswer(
      withEdit({ blockId: null, afterBlockId: 'ch03#a1b2c3d4', oldText: '', newText: 'Новый абзац.' }),
    );
    expect(insert.ok).toBe(true);
    if (!insert.ok) return;
    expect(insert.patch.edits[0]).toEqual({
      blockId: null,
      afterBlockId: 'ch03#a1b2c3d4',
      oldText: '',
      newText: 'Новый абзац.',
    });
  });

  it('bounds the answer: no empty patch, at most eight edits, text inside its own limits', () => {
    expect(codeOf(json({ ...VALID, edits: [] }))).toBe('PATCH_EMPTY');
    const many = Array.from({ length: 9 }, (_, i) => ({ ...VALID.edits[0], blockId: `ch03#b${String(i)}` }));
    expect(codeOf(json({ ...VALID, edits: many }))).toBe('PATCH_TOO_MANY_EDITS');
    expect(codeOf(json({ ...VALID, edits: many })), 'a caller may allow fewer').toBe('PATCH_TOO_MANY_EDITS');
    expect(codeOf(json({ ...VALID, edits: many.slice(0, 2) }), { maxEdits: 1 })).toBe('PATCH_TOO_MANY_EDITS');
    expect(codeOf(withEdit({ newText: 'x'.repeat(4_000) }))).toBe('OK');
    expect(codeOf(withEdit({ newText: 'x'.repeat(4_001) }))).toBe('PATCH_EDIT_TOO_LARGE');
    expect(codeOf(withEdit({ newText: 'x'.repeat(11) }), { maxNewChars: 10 })).toBe('PATCH_EDIT_TOO_LARGE');
    expect(codeOf(withEdit({ oldText: 'x'.repeat(2_001) }))).toBe('PATCH_EDIT_TOO_LARGE');
  });

  it('refuses an answer that changes nothing, even when it is well formed', () => {
    expect(codeOf(withEdit({ newText: 'Гуси шли по льду.' }))).toBe('PATCH_EMPTY');
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

  it('names what is wrong with the edit it refused', () => {
    const parsed = parsePatchAnswer(json({ ...VALID, edits: [{ ...VALID.edits[0] }, { blockId: 1 }] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe('PATCH_SHAPE');
    expect(parsed.detail).toContain('edit 2');
  });
});
