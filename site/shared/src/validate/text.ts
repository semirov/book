/**
 * Text primitives for the integrity validator (ARCHITECTURE.md §13.4).
 * Pure functions only: the CLI reads the filesystem, everything here is testable.
 *
 * Book-shape parsing (title line, front matter) lives in `../book.ts` — one
 * implementation shared with ingestion — and is re-exported here so the validator has a
 * single import surface.
 */

export {
  ABOUT_MAX_CHARS,
  ABOUT_MIN_CHARS,
  CHAPTER_CHARS,
  FRONT_FILE,
  TITLE_MAX_CHARS,
  countParagraphChars,
  hasMarkdown,
  normalizeBookText,
  parseFrontMatter,
  parseTitleLine,
  splitParagraphs,
} from '../book.ts';

import { normalizeBookText, splitParagraphs, countParagraphChars } from '../book.ts';
import type { Imprint, LegalDenylist } from '../book.ts';

export type Severity = 'error' | 'warn';

/**
 * Every rule id of §13.4, including the retired tombstones (F004, F013, F016, F018) and
 * the ones whose home is the engine or a build test: a rule that exists only in prose
 * still gets an id here, so a reference can never silently name a rule nobody owns.
 */
export type RuleId =
  | 'F001'
  | 'F002'
  | 'F003'
  | 'F004'
  | 'F005'
  | 'F006'
  | 'F007'
  | 'F008'
  | 'F009'
  | 'F010'
  | 'F011'
  | 'F012'
  | 'F013'
  | 'F014'
  | 'F015'
  | 'F016'
  | 'F017'
  | 'F018'
  | 'F019'
  | 'F020'
  | 'F021'
  | 'F022'
  | 'F023'
  | 'F024'
  | 'F025'
  | 'F026'
  | 'F027'
  | 'F028';

export type Finding = {
  rule: RuleId;
  severity: Severity;
  /** File name relative to the repository root, e.g. `manuscript/ch08.md`. */
  file: string;
  /** 1-based line; 1 when the finding is about the file as a whole. */
  line: number;
  message: string;
  excerpt?: string;
};

export type ManuscriptFile = { name: string; text: string };
export type PlanningFile = { name: string; text: string };

export type ChapterFile = {
  n: number;
  file: string;
  text: string;
  title: string | null;
  titleProblems: string[];
  blocks: string[];
  chars: number;
};

export type ValidateOptions = {
  /** Every `*.md` in the manuscript root, name only (no directories). */
  files: ManuscriptFile[];
  /** Plan and process logs — sources for the "total chapters" assertion (F006). */
  planning?: PlanningFile[];
  /** `config/legal.denylist.json`; absent means the gate cannot run (F005 reports it). */
  denylist?: LegalDenylist | null;
  /** `config/imprint.json`; F020 fails without it (§6C.6). */
  imprint?: Imprint | null;
  /** `bible/dossiers.md` — the record of people already on the page (F019). */
  dossiers?: ManuscriptFile | null;
  totalChapters?: number;
};

export type ValidateResult = {
  findings: Finding[];
  errors: number;
  warnings: number;
  chapters: Array<{ n: number; file: string; title: string | null; chars: number; blocks: number }>;
  front: { file: string; title: string | null; about: string | null; chars: number } | null;
  totalChapters: number;
};

export type { Imprint, LegalDenylist } from '../book.ts';

/** CRLF → LF; trailing whitespace on a line is not text. */
export function normalizeText(raw: string): string {
  return normalizeBookText(raw);
}

/** Split into blocks the way ingestion does: on blank lines, trimmed, empties dropped. */
export function splitBlocks(text: string): string[] {
  return splitParagraphs(text);
}

/** `chars` counts spaces, matching the writing logs' «знаков»; title lines are excluded. */
export function countChars(blocks: readonly string[]): number {
  return countParagraphChars(blocks);
}

/** Case- and ё-insensitive folding for comparisons. */
export function foldRu(value: string): string {
  return value.toLowerCase().replace(/ё/gu, 'е');
}

const ENDINGS = [
  'иями', 'ями', 'ами', 'ыми', 'ими', 'ого', 'его', 'ому', 'ему',
  'ов', 'ев', 'ых', 'их', 'ая', 'яя', 'ое', 'ее', 'ый', 'ий', 'ой', 'ей',
  'ом', 'ем', 'ах', 'ях', 'ам', 'ям', 'ия', 'ии', 'ью', 'ию',
  'а', 'я', 'ы', 'и', 'у', 'ю', 'е', 'о', 'ь', 'й',
];

/**
 * Crude Russian stemmer: strips one inflectional ending.
 * Enough to match «Зоя / Зои / Зою» and «Мельникова / Мельниковых» against one name.
 */
export function stemRu(value: string): string {
  const folded = foldRu(value);
  for (const ending of ENDINGS) {
    if (folded.length > ending.length + 1 && folded.endsWith(ending)) {
      return folded.slice(0, -ending.length);
    }
  }
  return folded;
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** One line of context around a match, for the report. */
export function excerptAt(text: string, offset: number, length: number): string {
  const start = Math.max(0, offset - 24);
  const end = Math.min(text.length, offset + length + 24);
  return text.slice(start, end).replace(/\n/gu, ' ').trim();
}

export type WordRule = {
  /** Lowercase stem; matched at a word start with a non-letter boundary. */
  stem?: string;
  /** Exact inflected forms (used where a stem would over-match, e.g. «бог» → «богатый»). */
  forms?: string[];
  /** Latin token, matched case-insensitively as a whole word. */
  latin?: string;
};

/** VOICE §Табу, plus the process vocabulary of F008. */
export const FORBIDDEN_PROSE: WordRule[] = [
  { stem: 'цикл' },
  { stem: 'прогон' },
  { stem: 'перезапуск' },
  { stem: 'симуляц' },
  { stem: 'матриц' },
  { forms: ['бог', 'бога', 'богу', 'богом', 'боге', 'боги', 'богов', 'богам', 'богами', 'богах'] },
  { stem: 'избранн' },
  { stem: 'надежд' },
  { forms: ['чудо', 'чуда', 'чуду', 'чудом', 'чуде', 'чудеса', 'чудес', 'чудесам', 'чудесами'] },
  { stem: 'вселенн' },
  { stem: 'пилюл' },
  { stem: 'имплант' },
  { stem: 'препарат' },
];

export const PROCESS_PROSE: WordRule[] = [
  { stem: 'цикл' },
  { stem: 'прогон' },
  { stem: 'перезапуск' },
  { latin: 'pass' },
  { latin: 'reweiter' },
];

const LETTER = '\\p{L}';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Build a matcher for one rule. Cyrillic is not `\w`, so the boundary is spelled out. */
function rulePattern(rule: WordRule): RegExp {
  if (rule.latin) {
    return new RegExp(`(^|[^${LETTER}])(${escapeRegExp(rule.latin)})(?![${LETTER}])`, 'giu');
  }
  if (rule.forms) {
    const alternatives = [...rule.forms].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
    return new RegExp(`(^|[^${LETTER}])(${alternatives})(?![${LETTER}])`, 'giu');
  }
  return new RegExp(`(^|[^${LETTER}])(${escapeRegExp(rule.stem ?? '')})`, 'giu');
}

export type WordMatch = { offset: number; length: number; word: string };

/** Every match of a rule, with the offset of the word itself (not of the boundary). */
export function findWords(text: string, rule: WordRule): WordMatch[] {
  const pattern = rulePattern(rule);
  const matches: WordMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const boundary = match[1] ?? '';
    const word = match[2] ?? '';
    matches.push({ offset: match.index + boundary.length, length: word.length, word });
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return matches;
}

/** Does the character before this offset end a sentence (or start the block)? */
export function isSentenceStart(text: string, offset: number): boolean {
  let i = offset - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i -= 1;
  if (i < 0 || text[i] === '\n') return true;
  return '.!?…:;"«»()\[\]—–'.includes(text[i] ?? '');
}

export const CAPITALIZED_WORD = /[А-ЯЁ][а-яё]+|[А-ЯЁ]{2,}/gu;

export function manuscriptChapterFile(name: string): { n: number } | { malformed: string } | null {
  if (!/\.md$/iu.test(name)) return null;
  if (!/^ch/iu.test(name)) return null;
  const match = /^ch(\d{2})\.md$/u.exec(name);
  if (!match) return { malformed: name };
  const n = Number.parseInt(match[1] ?? '', 10);
  return { n };
}
