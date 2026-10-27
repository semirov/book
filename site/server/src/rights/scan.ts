/**
 * Gate B's deterministic scan (BOOK-61, BOOK-DOC-42 §3) — may this text lawfully be in the
 * book? It answers with a rule or with nothing; it never writes prose and never calls a model.
 *
 * Three rules can refuse, one can flag:
 *
 *   • `RIGHTS-STOP`   a match on the closed stop list (`stoplist.ts`), including the curated
 *                     public-figure list — a real living person's full name is `STOP-PERSON`;
 *   • `RIGHTS-QUOTE`  a run of `QUOTE_MIN_CHARS` or more inside «…»/“…” or a `>` blockquote
 *                     with no named source in the same block;
 *   • `RIGHTS-FLAG`   a long `proposed`, a quoted run whose source is only half named, or a
 *                     full name the book has never used. A flag refuses nothing: it makes the
 *                     rights gate mandatory, and a row without a verdict is never accepted.
 *
 * **N = 240.** Two to three typeset lines (~35 words) is the longest run that can still be a
 * title, a term, a formula or one line of the book's own document; past it a run is a paragraph
 * of somebody's prose. 240 sits below `COMMENT_QUOTE_MAX_CHARS = 280`, so a quote a reader may
 * anchor is a quote this rule also sees.
 *
 * The scan is a pre-filter, not the defence. Nothing here compares the book to a corpus, so a
 * paraphrase with no flag is not caught mechanically — the rights gate and the editor's reading
 * remain for that (§3, §8). A block is one paragraph: a run split by a blank line is measured
 * as two runs, and a source is looked for in the paragraph that holds the run.
 *
 * Server-only: `web/src` and `@book/shared` must not import this module (asserted by test).
 */

import { buildNameIndex, findDenylistedNames } from '@book/shared';

import {
  PUBLIC_FIGURES,
  STOP_LIST,
  type StopEntry,
} from './stoplist.ts';

/** §3: the shortest quoted run that is a paragraph of somebody's prose, not a term. */
export const QUOTE_MIN_CHARS = 240;

/** The longest `proposed` that may still be the reader's own wording (§3, RIGHTS-FLAG). */
export const PROPOSED_FLAG_CHARS = QUOTE_MIN_CHARS;

export type RightsScanVerdict = 'clear' | 'flag' | 'refused';

/** The rules the scan itself can refuse with. `RIGHTS-FLAG` is a flag, never a stored refusal. */
export type ScanRule = 'RIGHTS-STOP' | 'RIGHTS-QUOTE' | 'STOP-PERSON';

export type RightsScan =
  | { verdict: 'clear' }
  | { verdict: 'refused'; rule: ScanRule; block: number; detail: string }
  | { verdict: 'flag'; rule: 'RIGHTS-FLAG'; block?: number; detail: string };

/** The filing fields the scan reads, exactly as BOOK-DOC-42 §3 names them: body ‖ proposed ‖ quote. */
export type RightsInput = {
  body: string;
  proposed?: string | null;
  quote?: string | null;
};

export type RightsScanOptions = {
  /**
   * Extra closed-table entries, each id prefixed `test:`. The prefix is enforced so production
   * cannot grow a private list and a test never needs to ship a real slur to prove the rule.
   */
  stopList?: readonly StopEntry[];
  /** The curated public-figure list; tests inject their own instead of adding to the shipped one. */
  publicFigures?: readonly string[];
  /** The book's own vocabulary (its block texts): a name it already uses is not a stranger. */
  knownNames?: readonly string[];
};

type Block = { index: number; text: string };

const PARAGRAPH = /\n[ \t]*\n/u;
const BLOCKQUOTE_LINE = /^\s*>/u;
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['«', '»'],
  ['“', '”'],
];

/**
 * A source that names a work or an author: a `источник:`/`source:` label, an attribution after
 * the closing quote («…» — Иван Бунин), a dash line under a blockquote, or «из книги «…»».
 */
const NAMED_SOURCE: readonly RegExp[] = [
  /(?:^|\n)\s*(?:источник|source)\s*[:\-—]/iu,
  /[»”]\s*[—–-]\s*[А-ЯЁ][а-яё-]+/u,
  /(?:^|\n)\s*[—–-]\s*[А-ЯЁ][а-яё-]+\s+[А-ЯЁ][а-яё-]+/u,
  /(?:из|по)\s+(?:книги|романа|повести|сборника|статьи)\s+«[^»]{2,80}»/iu,
];

/** A source that names nothing: it is a suspicion, and a suspicion escalates, never refuses. */
const PARTIAL_SOURCE: readonly string[] = [
  'из книги',
  'из романа',
  'из повести',
  'по воспоминаниям',
  'у одного автора',
  'в одной книге',
  'автор неизвестен',
];

/** Two capitalised words in a row: the shape of a full name («Анна Петровна»). */
const FULL_NAME = /(?<![А-ЯЁа-яё])([А-ЯЁ][а-яё]{2,})\s+([А-ЯЁ][а-яё]{2,})(?![А-ЯЁа-яё])/gu;

/** The scan's one public door. `options` is a dependency, so a test injects its own table. */
export function scanRights(input: RightsInput, options: RightsScanOptions = {}): RightsScan {
  const blocks = blocksOf(input);
  const extra = options.stopList ?? [];
  for (const entry of extra) {
    if (!entry.id.startsWith('test:')) {
      throw new Error(`an injected stop-list entry must be namespaced «test:», got «${entry.id}»`);
    }
  }
  const stopList = [...STOP_LIST, ...extra];
  const figures = buildNameIndex(options.publicFigures ?? PUBLIC_FIGURES);

  // 1. The law's own categories. A hit here is not releasable and is never a judgement call.
  for (const block of blocks) {
    const lower = block.text.normalize('NFKC').toLowerCase();
    for (const entry of stopList) {
      if (entry.patterns.some((pattern) => pattern.test(lower))) {
        return {
          verdict: 'refused',
          rule: 'RIGHTS-STOP',
          block: block.index,
          detail: `${entry.id}: ${entry.reason}`,
        };
      }
    }
  }

  // 2. A real living person, or another author's protected character, by complete name.
  for (const block of blocks) {
    const [hit] = findDenylistedNames(block.text, figures);
    if (hit !== undefined) {
      return {
        verdict: 'refused',
        rule: 'STOP-PERSON',
        block: block.index,
        detail: `«${hit.word}»`,
      };
    }
  }

  // 3. A long run of somebody's prose. Refused without any source, flagged when it is half-named.
  for (const block of blocks) {
    const source = sourceOf(block.text);
    for (const run of quotedRuns(block.text)) {
      const length = measure(run);
      if (length >= QUOTE_MIN_CHARS) {
        if (source === 'none') {
          return {
            verdict: 'refused',
            rule: 'RIGHTS-QUOTE',
            block: block.index,
            detail: `a ${length}-character run with no named source`,
          };
        }
        if (source === 'partial') {
          return {
            verdict: 'flag',
            rule: 'RIGHTS-FLAG',
            block: block.index,
            detail: `a ${length}-character run whose source is only half named`,
          };
        }
      } else if (source === 'partial' && length >= QUOTE_MIN_CHARS / 2) {
        return {
          verdict: 'flag',
          rule: 'RIGHTS-FLAG',
          block: block.index,
          detail: `a ${length}-character run whose source is only half named`,
        };
      }
    }
  }

  // 4. A full name the book has never used: invented or not is a model's question, so it flags.
  const known = (options.knownNames ?? []).join('\n');
  for (const block of blocks) {
    const used = nameIn(block.text, known);
    if (used !== null) {
      return { verdict: 'flag', rule: 'RIGHTS-FLAG', block: block.index, detail: `«${used}» is not in the book` };
    }
  }

  // 5. A `proposed` longer than a paragraph: the shape of a copy, and worth a model's look.
  const proposed = input.proposed ?? '';
  if (measure(proposed) > PROPOSED_FLAG_CHARS) {
    return {
      verdict: 'flag',
      rule: 'RIGHTS-FLAG',
      detail: `a proposed text of ${measure(proposed)} characters`,
    };
  }

  return { verdict: 'clear' };
}

/** One paragraph per block; the fields are joined without a run ever spanning two of them. */
function blocksOf(input: RightsInput): Block[] {
  const blocks: Block[] = [];
  for (const field of [input.body, input.proposed ?? '', input.quote ?? '']) {
    for (const chunk of field.split(PARAGRAPH)) {
      const text = chunk.trim();
      if (text.length === 0) continue;
      blocks.push({ index: blocks.length + 1, text });
    }
  }
  return blocks;
}

/** The quoted runs of one block: «…», “…”, and a `>` blockquote as one run. */
function quotedRuns(text: string): string[] {
  const runs: string[] = [];
  for (const [open, close] of QUOTE_PAIRS) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(open, from);
      if (start < 0) break;
      const end = text.indexOf(close, start + 1);
      if (end < 0) break;
      runs.push(text.slice(start + 1, end));
      from = end + 1;
    }
  }
  if (isBlockquote(text)) runs.push(blockquoteBody(text));
  return runs;
}

function isBlockquote(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  return lines.length > 0 && lines.every((line) => BLOCKQUOTE_LINE.test(line));
}

function blockquoteBody(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*>\s?/u, ''))
    .join('\n')
    .trim();
}

/** Characters, with every whitespace run counted as one — a reflow is not a shorter quote. */
function measure(text: string): number {
  return text.replace(/\s+/gu, ' ').trim().length;
}

type SourceClass = 'named' | 'partial' | 'none';

function sourceOf(block: string): SourceClass {
  if (NAMED_SOURCE.some((pattern) => pattern.test(block))) return 'named';
  const lower = block.normalize('NFKC').toLowerCase();
  if (PARTIAL_SOURCE.some((marker) => lower.includes(marker))) return 'partial';
  return 'none';
}

/**
 * The first full-name shape in the block the book has never used, or `null`. "Used" is asked
 * of the book's vocabulary with the same complete-name matcher the figures list uses, so a case
 * form of a name the chapter already carries is not a stranger.
 */
function nameIn(block: string, known: string): string | null {
  for (const match of block.matchAll(FULL_NAME)) {
    const name = `${match[1] ?? ''} ${match[2] ?? ''}`.trim();
    if (name.length === 0) continue;
    // A name after a dash is a source attribution («…» — Иван Бунин), not a character: the
    // quote rule already asked whether that source was named, and a source is not a hero.
    if (/[—–-]\s*$/u.test(block.slice(Math.max(0, match.index - 8), match.index))) continue;
    if (findDenylistedNames(known, buildNameIndex([name])).length > 0) continue;
    return name;
  }
  return null;
}
