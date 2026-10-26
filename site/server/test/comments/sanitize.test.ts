import { describe, expect, it } from 'vitest';

import {
  COMMENT_BATCH_ITEM_MAX_BYTES,
  COMMENT_MAX_CHARS,
  COMMENT_RAW_MAX_BYTES,
  REQUEST_BODY_MAX_BYTES,
  EDIT_MAX_CHARS,
  EDIT_RAW_MAX_BYTES,
} from '@book/shared';

import { sanitizeAffix, sanitizeBody, sanitizeProposed, sanitizeQuote } from '../../src/comments/sanitize.ts';

describe('comment sanitizer (§12.4)', () => {
  it('normalizes NFKC, drops controls, zero-width and bidi overrides', () => {
    const raw = 'Он\u0000 сказал\u200B: «с\u202Eлово»\uFEFF дважды.';
    const result = sanitizeBody(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('Он сказал: «слово» дважды.');
    expect(result.text).not.toMatch(/[\u0000\u200B\u202E\uFEFF]/u);
  });

  it('collapses runs of spaces and at most doubles newlines', () => {
    const result = sanitizeBody('первая   строка\n\n\n\nвторая\tстрока');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('первая строка\n\nвторая строка');
  });

  it('refuses a body shorter than 3 characters or longer than 1200', () => {
    expect(sanitizeBody('  а  ')).toMatchObject({ ok: false, code: 'TOO_SHORT' });
    expect(sanitizeBody('а'.repeat(1_201))).toMatchObject({ ok: false, code: 'TOO_LONG' });
    expect(sanitizeBody('а'.repeat(1_200)).ok).toBe(true);
  });

  it('strips HTML tags and code fences and neutralizes angle brackets (XSS fixtures)', () => {
    const result = sanitizeBody('<script>alert(1)</script> Тут <b>жирный</b> текст ```js``` и 2 < 3');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain('<');
    expect(result.text).not.toContain('>');
    expect(result.text).not.toContain('script');
    expect(result.text).not.toContain('```');
    expect(result.text).toContain('‹');
  });

  it('never autolinks: a URL stays plain text', () => {
    const result = sanitizeBody('см. https://example.com/a?b=1 и всё');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('см. https://example.com/a?b=1 и всё');
  });

  it('hashes the normalized form, not the raw bytes', () => {
    const first = sanitizeBody('Он  сказал: «слово»');
    const second = sanitizeBody('Он сказал:  «слово» ');
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.hash).toBe(second.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('sanitizes a proposed wording with the same rules', () => {
    expect(sanitizeProposed(null)).toBeNull();
    expect(sanitizeProposed('   ')).toBeNull();
    const proposed = sanitizeProposed('<i>Оставить одно упоминание</i>');
    expect(proposed?.ok).toBe(true);
    if (proposed === null || !proposed.ok) return;
    expect(proposed.text).toBe('Оставить одно упоминание');
  });

  it('caps a proposed wording at the edit bound, not at the note bound (BOOK-DOC-4 R1)', () => {
    // 10 000 is the promise; 10 001 is refused with a code, never truncated.
    expect(sanitizeProposed('я'.repeat(EDIT_MAX_CHARS))).toMatchObject({ ok: true });
    expect(sanitizeProposed('я'.repeat(EDIT_MAX_CHARS + 1))).toMatchObject({ ok: false, code: 'TOO_LONG' });
    const tooLong = sanitizeProposed('я'.repeat(EDIT_MAX_CHARS + 1));
    expect(tooLong !== null && !tooLong.ok && tooLong.message).toContain(String(EDIT_MAX_CHARS));

    // The note body keeps its own bound: the two caps are not interchangeable.
    expect(sanitizeBody('я'.repeat(COMMENT_MAX_CHARS)).ok).toBe(true);
    expect(sanitizeBody('я'.repeat(COMMENT_MAX_CHARS + 1))).toMatchObject({ ok: false, code: 'TOO_LONG' });
    expect(sanitizeBody('я'.repeat(EDIT_MAX_CHARS))).toMatchObject({ ok: false, code: 'TOO_LONG' });
  });

  it('sizes the byte bounds for a full Cyrillic intervention (2 bytes per character)', () => {
    const cyrillic = 'я'.repeat(EDIT_MAX_CHARS);
    const bytes = Buffer.byteLength(cyrillic, 'utf8');
    expect(bytes).toBe(EDIT_MAX_CHARS * 2);
    // ≥ 24 KB with headroom: the raw request bound admits the full Cyrillic text.
    expect(EDIT_RAW_MAX_BYTES).toBeGreaterThanOrEqual(24 * 1024);
    expect(bytes).toBeLessThan(EDIT_RAW_MAX_BYTES);
    // A worst-case BMP character (3 bytes) still fits under the char cap, so the composer's
    // 10 000-character promise is never refused for bytes alone.
    expect(EDIT_MAX_CHARS * 3).toBeLessThan(EDIT_RAW_MAX_BYTES);
    // And a batch line carrying that intervention plus a full note body still fits.
    expect(bytes + COMMENT_RAW_MAX_BYTES).toBeLessThan(COMMENT_BATCH_ITEM_MAX_BYTES);
    // The transport admits a note body and a full intervention together: no bound below the
    // one the composer shows.
    expect(REQUEST_BODY_MAX_BYTES).toBeGreaterThan(EDIT_RAW_MAX_BYTES + COMMENT_RAW_MAX_BYTES);
  });

  it('caps quotes at 280 and affixes at 40 without touching angle brackets in a quote', () => {
    expect(sanitizeQuote('а'.repeat(400))?.length).toBe(280);
    expect(sanitizeAffix('б'.repeat(100))?.length).toBe(40);
    expect(sanitizeQuote('  <важно>  ')).toBe('<важно>');
  });
});
