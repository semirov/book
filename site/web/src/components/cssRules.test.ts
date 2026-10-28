import { describe, expect, it } from 'vitest';

import { firstDeclarations, hasRule, mediaBlockList, mediaBlocks, rules, unionDeclarations } from './cssRules.ts';

/**
 * The sheet reader the colophon's CSS claims stand on (BOOK-99). Two failure modes are pinned
 * here, on text with the shape of the sheets rather than on the sheets themselves: a reader
 * that answers with the first block of a query makes a scan of the second one vacuous, and a
 * missing block must throw rather than answer `''`. A missing *selector* answers `''` by
 * design — that absence is what a negative claim over a block is made of — and is pinned too.
 */
describe('the sheet reader (BOOK-99)', () => {
  // Two blocks of one query, the shape `book.css` has: the second must be read, not skipped.
  const twice = [
    '@media (max-width: 599px) {',
    '  .a { color: red }',
    '}',
    '@media (max-width: 599px) {',
    '  .b { color: blue }',
    '}',
  ].join('\n');

  it('reads every block of a query, not the first one', () => {
    const blocks = mediaBlocks(twice, 'max-width: 599px');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('color: red');
    expect(blocks[1]).toContain('color: blue');
    // The flat enumeration sees both blocks too, in the order the sheet writes them.
    expect(mediaBlockList(twice).map((block) => block.query)).toEqual(['max-width: 599px', 'max-width: 599px']);
  });

  it('fails loudly when the query is absent, instead of answering an empty string', () => {
    expect(() => mediaBlocks(twice, 'max-width: 1023px')).toThrow(/no @media \(max-width: 1023px\) block/u);
  });

  it('fails loudly when the block is opened and never closed', () => {
    expect(() => mediaBlockList('@media (max-width: 599px) {\n  .a { color: red }')).toThrow(/unclosed @media block/u);
  });

  it('answers a selector from every rule of it, and from the first one on request', () => {
    const css = ['.a { color: red }', '.a { min-height: 24px }', '.b { color: blue }'].join('\n');
    expect(unionDeclarations(css, '.a').replace(/\s+/gu, ' ').trim()).toBe('color: red ; min-height: 24px');
    expect(firstDeclarations(css, '.a').replace(/\s+/gu, ' ').trim()).toBe('color: red');
    // `?` and `.` in a selector are literals, not the pattern they read as.
    expect(unionDeclarations('.a?b { color: red }', '.a?b')).toContain('color: red');
  });

  it('reads a selector named in a list beside others, which is one rule of two selectors', () => {
    const css = ['.a, .b { color: red }', '.b:hover { color: blue }', '.ab { color: pink }'].join('\n');
    expect(unionDeclarations(css, '.b')).toContain('color: red');
    // A token is a whole selector: `.b` is not `.b:hover`, and not `.ab`.
    expect(unionDeclarations(css, '.b')).not.toContain('color: blue');
    expect(unionDeclarations(css, '.b')).not.toContain('color: pink');
    expect(unionDeclarations(css, '.ab')).toContain('color: pink');
  });

  it('answers an empty string for a selector the sheet does not name — the absence itself', () => {
    const css = ['.a { color: red }', '.a, .b { color: blue }'].join('\n');
    expect(unionDeclarations(css, '.c')).toBe('');
    expect(firstDeclarations(css, '.c')).toBe('');
    // An absent selector is not a substring of a present one, and the call is not a prefix match.
    expect(unionDeclarations(css, 'a')).toBe('');
    expect(unionDeclarations(css, '.a')).toContain('color: blue');
  });

  it('reads a rule nested in a width step, and strips a commented-out one', () => {
    const css = ['@media (max-width: 599px) {', '  .a { color: red }', '}', '/* .a { color: pink } */'].join('\n');
    expect(rules(css)).toEqual([['.a', ' color: red ']]);
    expect(hasRule(css, '.a')).toBe(true);
    expect(hasRule(css, '.b')).toBe(false);
  });

  it('names a selector stated only inside a list, and never a prefix of one', () => {
    const css = ['.a, .b { color: red }', '.ab { color: pink }'].join('\n');
    // `.b` is stated by the list, so a loud presence check must not answer «the sheet has none».
    expect(hasRule(css, '.b')).toBe(true);
    expect(hasRule(css, '.a')).toBe(true);
    // A token is a whole selector, not a prefix: `.b:hover` and a bare `b` are not `.b`.
    expect(hasRule(css, '.b:hover')).toBe(false);
    expect(hasRule(css, 'b')).toBe(false);
    // A commented-out rule is not a rule, in `hasRule` either.
    expect(hasRule('/* .c { color: red } */', '.c')).toBe(false);
  });
});
