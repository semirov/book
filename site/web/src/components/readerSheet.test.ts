import { describe, expect, it } from 'vitest';

import { firstDeclarations, mediaBlockList, mediaBlocks, rules } from './cssRules.ts';

/**
 * BOOK-128 comment #3815 — the reader sheet's one geometry, read as text.
 *
 * `reader.css` dresses two marginalia layers: the word's record and the phrase's block. jsdom
 * has no layout, so the claims a browser would make with pixels are made here against the
 * declaration that makes them true — and against the **query** it lives in, because a rule in
 * the wrong block is a rule that stops applying on the page it was written for.
 *
 * Three rules matter, and each was a defect once:
 *   - `.sentence-flow` is the phrase's block where there is no margin channel (a past chapter
 *     on the chronicle). It must undo the margin's geometry **outside every query**: a
 *     chronicle reads a past chapter at any width, and an `absolute; opacity: 0` block past the
 *     right edge is a transparent hole nobody opens.
 *   - `.prov-door` is one 12 px trace line in the margin; the 44 px target is the phone's body
 *     alone, where a thumb meets it.
 */

const sheets = import.meta.glob<string>('../styles/*.css', { query: '?raw', import: 'default', eager: true });
const reader = sheets['../styles/reader.css'] ?? '';

/** Whether any `@media` block of the sheet names the selector. */
function inQuery(selector: string): boolean {
  return mediaBlockList(reader).some(({ body }) => new RegExp(`${selector}\\s*\\{`, 'u').test(body));
}

describe('the phrase’s block, in the margin and in the flow', () => {
  it('is a block in the flow: the margin geometry and its invisible wait are deleted', () => {
    // BOOK-128 comment #3852 — the reader blocks are no longer placed past the prose; the
    // accordion (`record.css`) carries them, and the same nodes stand in the document's flow
    // wherever they are still mounted on their own.
    const base = rules(reader).find(([selector]) => selector.split(',').some((token) => token.trim() === '.sentence-block'))?.[1] ?? '';
    expect(base).toContain('position: static');
    expect(base).toContain('width: auto');
    expect(base).toContain('opacity: 1');
    expect(base).not.toContain('position: absolute');
    expect(base).not.toContain('var(--note-fit)');
    expect(base).not.toContain('opacity: 0');
  });

  it('is the document’s own flow in the flow variant, outside every query', () => {
    // `firstDeclarations` is the sheet's own block for the selector; the query check below is
    // what proves the rule is not scoped to a width a chronicle may not have.
    const flow = firstDeclarations(reader, '.sentence-flow');
    expect(flow, 'the flow variant has a rule').not.toBe('');
    expect(flow).toContain('position: static');
    expect(flow).toContain('width: auto');
    expect(flow).toContain('border-top: 1px solid var(--rule)');
    expect(flow).toContain('opacity: 1');
    expect(flow).toContain('transition: none');
    expect(inQuery('\\.sentence-flow'), 'the flow rule must not hide in a query').toBe(false);
  });
});

describe('the filing’s door on the word', () => {
  it('is one 12 px trace line in the margin: no 44 px box inside the note', () => {
    const base = firstDeclarations(reader, '.prov-door');
    expect(base, 'the door is styled').not.toBe('');
    expect(base).not.toContain('min-height');
    // The line it stands in is unchanged: 12 px mono at 1.4.
    const trace = rules(reader).find(([selector]) => selector.split(',').some((token) => token.trim() === '.prov-trace'))?.[1] ?? '';
    expect(trace).toContain('font-size: var(--fs-micro)');
    expect(trace).toContain('line-height: 1.4');
  });

  it('is a thumb’s target on the phone, where the note is the strip’s body', () => {
    const phone = mediaBlocks(reader, 'max-width: 1023px').join('\n');
    expect(phone).toMatch(/\.prov-door \{[^}]*min-height: 44px/u);
  });
});
