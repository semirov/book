import { describe, expect, it } from 'vitest';

import {
  ABOUT_PARAGRAPHS,
  BLOCK_MS,
  GATE_ATTRIBUTE,
  GATE_DONE,
  GATE_RUN,
  SEQ_BLOCKS,
  SEQ_IDS,
  STAGGER_MS,
  TITLE_CAP_MS,
  TITLE_REST_MS,
  TOTAL_MS,
  seqAt,
  shouldRun,
} from './frontSequence.ts';

/**
 * BOOK-DOC-49 §2, §7 — the first-load sequence, pinned as the contract it is.
 *
 * The table is the owner's order and the spec's offsets; the sheet's delay rules are the same
 * numbers in CSS, so the last case here is the guard that keeps the two from drifting (a block
 * that animates a beat late is otherwise found by eye, weeks later).
 */

/** Every stylesheet as text: the stagger lives in CSS and is proved against the table. */
const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const sheet = sheets['../styles/first-load.css'] ?? '';

/** The owner's order, written out — not derived from the table under test. */
const OWNER_ORDER = [
  'title',
  'byline',
  'genre',
  'promise',
  'how-1',
  'how-2',
  'how-3',
  'rule',
  'about-1',
  'about-2',
  'about-3',
  'about-4',
  'about-5',
  'about-6',
  'about-7',
  'about-8',
  'about-9',
];

const OWNER_OFFSETS = [0, 500, 580, 660, 740, 820, 900, 980, 1_060, 1_140, 1_220, 1_300, 1_380, 1_460, 1_540, 1_620, 1_700];

describe('the sequence table (BOOK-DOC-49 §2)', () => {
  it('names its 17 blocks in the owner’s order', () => {
    expect(SEQ_IDS).toEqual(OWNER_ORDER);
    expect(SEQ_BLOCKS).toHaveLength(17);
  });

  it('starts every block on the offset the spec printed', () => {
    expect(SEQ_BLOCKS.map((block) => block.at)).toEqual(OWNER_OFFSETS);
    for (const [index, id] of OWNER_ORDER.entries()) expect(seqAt(id), id).toBe(OWNER_OFFSETS[index]);
    expect(seqAt('about-10')).toBeNull();
    expect(seqAt('kicker')).toBeNull();
  });

  it('keeps the numbers the rest of the sheet reads', () => {
    expect(BLOCK_MS).toBe(220);
    expect(STAGGER_MS).toBe(80);
    expect(TITLE_REST_MS).toBe(220);
    expect(TITLE_CAP_MS).toBe(400);
    expect(TOTAL_MS).toBe(1_920);
    // The budget is wall-clock and it ends where the table says: the last paragraph's turn.
    const last = SEQ_BLOCKS.at(-1);
    expect(last?.id).toBe('about-9');
    expect((last?.at ?? 0) + BLOCK_MS).toBe(TOTAL_MS);
    // 80 ms, uniform, in document order — from the byline on (the title is typed, not staggered).
    const staggered = SEQ_BLOCKS.slice(1);
    for (let index = 1; index < staggered.length; index += 1) {
      const previous = staggered[index - 1]?.at ?? 0;
      const current = staggered[index]?.at ?? 0;
      expect(current - previous).toBe(STAGGER_MS);
    }
  });

  it('types one block, fades the rule, and rises everything else', () => {
    const byMotion = (motion: string) => SEQ_BLOCKS.filter((block) => block.motion === motion).map((block) => block.id);
    expect(byMotion('typed')).toEqual(['title']);
    expect(byMotion('fade')).toEqual(['rule']);
    expect(byMotion('rise')).toHaveLength(15);
    // Page 2 is the nine paragraphs the front matter carries and no more.
    expect(ABOUT_PARAGRAPHS).toBe(9);
  });

  it('names the gate the sheet hangs every rule on', () => {
    expect(GATE_ATTRIBUTE).toBe('data-front-seq');
    expect(GATE_RUN).toBe('run');
    expect(GATE_DONE).toBe('done');
    expect(sheet).toContain('html[data-front-seq="run"]');
    // No rule reads the end state: `done` is the absence of the sequence, not a second style.
    expect(sheet).not.toContain('data-front-seq="done"');
  });
});

describe('when the sequence runs (BOOK-DOC-49 §2b, §2c, §5)', () => {
  const base = { hash: '', scrollY: 0, reduced: false, ran: false };

  it('runs on a page load that opened on the cover, once', () => {
    expect(shouldRun(base)).toBe(true);
  });

  it('does not run behind an anchor: the reader did not open on the cover', () => {
    for (const hash of ['#ch-12', '#правка-7', '#about']) {
      expect(shouldRun({ ...base, hash }), hash).toBe(false);
    }
  });

  it('does not run for still paper', () => {
    expect(shouldRun({ ...base, reduced: true })).toBe(false);
  });

  it('does not run over a restored scroll', () => {
    expect(shouldRun({ ...base, scrollY: 12 })).toBe(false);
    expect(shouldRun({ ...base, scrollY: 0 })).toBe(true);
  });

  it('never runs twice in one document', () => {
    expect(shouldRun({ ...base, ran: true })).toBe(false);
  });
});

describe('the sheet and the table agree (BOOK-DOC-49 §7)', () => {
  it('gives every tagged block the delay of its turn', () => {
    for (const block of SEQ_BLOCKS) {
      if (block.motion === 'typed') continue;
      const delay = new RegExp(
        `html\\[data-front-seq="run"\\] \\[data-seq="${block.id}"\\] \\{\\s*animation-delay: ${block.at}ms;`,
        'u',
      );
      expect(sheet, block.id).toMatch(delay);
    }
    // The typed title carries no animation: the engine prints it, the sheet must not fade it.
    expect(sheet).toMatch(/html\[data-front-seq="run"\] \[data-seq="title"\] \{\s*animation: none;/u);
  });

  it('hands the rule the opacity-only fade, and every other block the 4 px rise', () => {
    expect(sheet).toMatch(
      /html\[data-front-seq="run"\] \[data-seq="rule"\] \{\s*animation-name: seq-fade;/u,
    );
    expect(sheet).toMatch(
      /html\[data-front-seq="run"\] \[data-seq\] \{\s*animation: seq-in var\(--dur-ui\) var\(--ease-out\) both;/u,
    );
    expect(sheet).toContain('transform: translateY(4px)');
    expect(sheet).not.toContain('translateY(8px)');
  });

  it('keeps the title caret at the one overridden height and no other', () => {
    expect(sheet).toMatch(/\.titul \.caret-inline \{\s*height: 0\.72em;\s*vertical-align: -0\.02em;/u);
    // The paragraph's caret is the chapter's (live.css): the cover may not restate its width.
    expect(sheet).not.toContain('width: 2px');
  });
});
