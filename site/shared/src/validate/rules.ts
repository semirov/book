/**
 * F001–F002, F005–F007, F009, F020–F022 and F029 of ARCHITECTURE.md §13.4, over an
 * in-memory snapshot of the repository.
 *
 * F001 naming · F002 stray files / range · F004 retired (v3) · F005 the legal denylist
 * · F006 67 chapters · F007 chapter length · F009 markdown in prose (warn) · F020 imprint
 * · F021 front matter · F022 chapter title line · F029 the frozen frame.
 *
 * Vocabulary is not policed here: F003 (forbidden words) and F008 (process words) are
 * retired — the only taboos are copyright and RF law, and that is F005's denylist.
 * Everything about meaning is a gate's job (§6B); this file polices structure and law.
 */

import {
  CHAPTER_CHARS,
  FRONT_FILE,
  TOTAL_CHAPTERS,
  imprintProblems,
  isEmptySlot,
  parseChapterTitle,
  parseFrontMatter,
  splitParagraphs,
  type Imprint,
  type LegalDenylist,
} from '../book.ts';
import {
  buildDenylistIndex,
  buildNameIndex,
  compilePatterns,
  findDenylisted,
  findDenylistedNames,
  findPatternHits,
} from './denylist.ts';
import { checkFrame } from './frame.ts';
import {
  type ChapterFile,
  type Finding,
  type RuleId,
  type Severity,
  type ValidateOptions,
  type ValidateResult,
  countParagraphChars,
  excerptAt,
  hasMarkdown,
  lineAt,
  manuscriptChapterFile,
  normalizeText,
} from './text.ts';

const FRONT_PATH = `manuscript/${FRONT_FILE}`;
const DENYLIST_PATH = 'config/legal.denylist.json';
const IMPRINT_PATH = 'config/imprint.json';
function finding(
  rule: RuleId,
  severity: Severity,
  file: string,
  line: number,
  message: string,
  excerpt?: string,
): Finding {
  return excerpt === undefined
    ? { rule, severity, file, line, message }
    : { rule, severity, file, line, message, excerpt };
}

export type CollectedFront = {
  file: string;
  text: string;
  title: string | null;
  about: string | null;
  blocks: string[];
  chars: number;
  problems: string[];
};

/** Chapter files, the front matter and the stray-file findings, in one pass over the listing. */
export function collectManuscript(options: ValidateOptions): {
  chapters: ChapterFile[];
  front: CollectedFront | null;
  findings: Finding[];
} {
  const findings: Finding[] = [];
  const chapters: ChapterFile[] = [];
  const seen = new Map<number, string>();
  let front: CollectedFront | null = null;

  for (const file of options.files) {
    if (file.name === FRONT_FILE) {
      const parsed = parseFrontMatter(file.text);
      front = {
        file: FRONT_PATH,
        text: normalizeText(file.text),
        title: parsed.title,
        about: parsed.about,
        blocks: parsed.blocks,
        chars: parsed.chars,
        problems: parsed.problems,
      };
      continue;
    }

    const parsed = manuscriptChapterFile(file.name);
    if (parsed === null) {
      findings.push(
        finding('F002', 'error', file.name, 1, `extra .md file in manuscript/ — only chNN.md and ${FRONT_FILE} are allowed`),
      );
      continue;
    }
    if ('malformed' in parsed) {
      // A file that still names a chapter (`Ch01.md`) additionally collides with it (F002).
      const loose = /^ch(\d{2})\.md$/iu.exec(file.name);
      if (loose) {
        const n = Number.parseInt(loose[1] ?? '', 10);
        const existing = seen.get(n);
        if (existing !== undefined) {
          findings.push(finding('F002', 'error', file.name, 1, `chapter ${n} already exists as ${existing}`));
        }
      }
      findings.push(
        finding('F001', 'error', file.name, 1, 'chapter file name is not chNN.md (NN zero-padded, 01..67)'),
      );
      continue;
    }
    if (parsed.n < 1 || parsed.n > TOTAL_CHAPTERS) {
      findings.push(
        finding('F002', 'error', file.name, 1, `chapter number ${parsed.n} is outside 01..${TOTAL_CHAPTERS}`),
      );
      continue;
    }
    const duplicate = seen.get(parsed.n);
    if (duplicate !== undefined) {
      findings.push(finding('F002', 'error', file.name, 1, `chapter ${parsed.n} already exists as ${duplicate}`));
      continue;
    }
    seen.set(parsed.n, file.name);

    const text = normalizeText(file.text);
    if (isEmptySlot(parsed.n, text)) {
      // An empty slot is a valid state (§BOOK-6): no title line, no chars, no length. The
      // file may be zero-byte or hold only its basis sentence (ch01/ch67).
      chapters.push({ n: parsed.n, file: file.name, text, title: null, titleProblems: [], blocks: [], chars: 0, empty: true });
      continue;
    }

    // The shared title decision, so a chapter that opens on its frame is untitled prose here,
    // in the reader and in F029 alike (BOOK-32).
    const line = parseChapterTitle(parsed.n, file.text);
    const blocks = splitParagraphs(line.body);
    chapters.push({
      n: parsed.n,
      file: file.name,
      text,
      title: line.title,
      titleProblems: line.problems,
      blocks,
      chars: countParagraphChars(blocks),
      empty: false,
    });
  }

  chapters.sort((a, b) => a.n - b.n);
  return { chapters, front, findings };
}

function checkLength(chapter: ChapterFile): Finding[] {
  // An empty slot has no length: the band applies to a written chapter only (§BOOK-6). A
  // slot holding nothing but the frozen frame of ch01/ch67 is `empty`, so it never reaches
  // either end of the band.
  if (chapter.empty) return [];
  if (chapter.chars > CHAPTER_CHARS.max) {
    return [
      finding(
        'F007',
        'error',
        chapter.file,
        1,
        `chapter has ${chapter.chars} characters, the maximum is ${CHAPTER_CHARS.max} (F007)`,
      ),
    ];
  }
  // The floor is a limit, not a hint (canon, BOOK-DOC-4): a written chapter below a page is
  // an error for the commit and for the engine's `land` alike.
  if (chapter.chars < CHAPTER_CHARS.floor) {
    return [
      finding(
        'F007',
        'error',
        chapter.file,
        1,
        `chapter has ${chapter.chars} characters, the minimum is ${CHAPTER_CHARS.floor} (F007)`,
      ),
    ];
  }
  if (chapter.chars < CHAPTER_CHARS.min) {
    return [
      finding(
        'F007',
        'warn',
        chapter.file,
        1,
        `thin chapter: ${chapter.chars} characters, the band is ${CHAPTER_CHARS.min}–${CHAPTER_CHARS.max}`,
      ),
    ];
  }
  return [];
}

/** Offsets of each block inside the file text, so findings can carry a line number. */
function blockOffsets(chapter: ChapterFile): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const block of chapter.blocks) {
    const index = chapter.text.indexOf(block, cursor);
    const offset = index >= 0 ? index : cursor;
    offsets.push(offset);
    cursor = offset + block.length;
  }
  return offsets;
}

function checkMarkdown(chapter: ChapterFile, offsets: number[]): Finding[] {
  for (let i = 0; i < chapter.blocks.length; i += 1) {
    const block = chapter.blocks[i] ?? '';
    const offset = offsets[i] ?? 0;
    if (hasMarkdown(block)) {
      return [
        finding(
          'F009',
          'warn',
          chapter.file,
          lineAt(chapter.text, offset),
          'markdown in prose: the format is plain paragraphs',
        ),
      ];
    }
  }
  return [];
}

/** F022 — line 1 is the chapter title; a missing one is an error for the commit only. */
function checkTitleLine(chapter: ChapterFile): Finding[] {
  // An empty slot needs no title line; a written chapter keeps the rule unchanged.
  if (chapter.empty) return [];
  return chapter.titleProblems.map((problem) =>
    finding('F022', 'error', chapter.file, 1, `chapter title line: ${problem}`),
  );
}

/** F021 — the front matter is mandatory: without it there is no cover and no page 2. */
function checkFrontMatter(front: CollectedFront | null): Finding[] {
  if (front === null) {
    return [finding('F021', 'error', FRONT_PATH, 1, `front matter is missing — ${FRONT_PATH} is required`)];
  }
  return front.problems.map((problem) => finding('F021', 'error', FRONT_PATH, 1, `front matter: ${problem}`));
}

/** F020 — the imprint is a legal statement; drift is an error, not a style question. */
function checkImprint(imprint: Imprint | null | undefined): Finding[] {
  return imprintProblems(imprint).map((problem) => finding('F020', 'error', IMPRINT_PATH, 1, `imprint: ${problem}`));
}

/** F005 — the legal denylist itself, reported once. */
function checkDenylistConfig(denylist: LegalDenylist | null | undefined): {
  findings: Finding[];
  persons: ReturnType<typeof buildNameIndex>;
  characters: ReturnType<typeof buildNameIndex>;
  organisations: ReturnType<typeof buildDenylistIndex>;
  patterns: RegExp[];
} {
  const emptyNames = buildNameIndex([]);
  const emptyOrganisations = buildDenylistIndex([]);
  if (denylist === null || denylist === undefined) {
    return {
      findings: [finding('F005', 'error', DENYLIST_PATH, 1, 'legal denylist is missing — the legal gate cannot run')],
      persons: emptyNames,
      characters: emptyNames,
      organisations: emptyOrganisations,
      patterns: [],
    };
  }
  const compiled = compilePatterns(denylist.patterns ?? []);
  return {
    findings: compiled.problems.map((problem) => finding('F005', 'error', DENYLIST_PATH, 1, problem)),
    persons: buildNameIndex(denylist.persons ?? []),
    characters: buildNameIndex(denylist.characters ?? []),
    organisations: buildDenylistIndex(denylist.organisations ?? []),
    patterns: compiled.regexes,
  };
}

/**
 * F005 — denylisted persons and characters are errors, organisations a warning, patterns
 * errors. A person or a character is caught only as a complete name (§13.4); an
 * organisation is caught by any of its written parts.
 */
function checkLegal(
  chapter: ChapterFile,
  indexes: {
    persons: ReturnType<typeof buildNameIndex>;
    characters: ReturnType<typeof buildNameIndex>;
    organisations: ReturnType<typeof buildDenylistIndex>;
    patterns: RegExp[];
  },
): Finding[] {
  const findings: Finding[] = [];
  const names: Array<[ReturnType<typeof buildNameIndex>, string]> = [
    [indexes.persons, 'denylisted person'],
    [indexes.characters, 'protected character'],
  ];
  for (const [index, label] of names) {
    for (const hit of findDenylistedNames(chapter.text, index)) {
      findings.push(
        finding(
          'F005',
          'error',
          chapter.file,
          lineAt(chapter.text, hit.offset),
          `${label}: «${hit.word}»`,
          excerptAt(chapter.text, hit.offset, hit.length),
        ),
      );
    }
  }
  for (const hit of findDenylisted(chapter.text, indexes.organisations)) {
    findings.push(
      finding(
        'F005',
        'warn',
        chapter.file,
        lineAt(chapter.text, hit.offset),
        `denylisted organisation: «${hit.word}»`,
        excerptAt(chapter.text, hit.offset, hit.length),
      ),
    );
  }
  for (const hit of findPatternHits(chapter.text, indexes.patterns)) {
    findings.push(
      finding(
        'F005',
        'error',
        chapter.file,
        lineAt(chapter.text, hit.offset),
        `illegal-content pattern: «${hit.text}»`,
        excerptAt(chapter.text, hit.offset, hit.text.length),
      ),
    );
  }
  return findings;
}

const TOTAL_PATTERNS: RegExp[] = [
  /(?:всего|итого|в книге|роман[а-яё]*|план[а-яё]*|книга)[^\d\n]{0,24}(\d{1,3})\s*(?:глав|главы|главах|главами)/giu,
  /(\d{2,3})\s*(?:глав|главы|главах|главами)\s*(?:строго|всего|итого|ровно)/giu,
  /(?:^|\n)[^\d\n]{0,3}(\d{2,3})\s+глав(?![а-яё])/gimu,
];

function checkTotals(total: number, planning: ValidateOptions['planning']): Finding[] {
  const findings: Finding[] = [];
  for (const file of planning ?? []) {
    const text = normalizeText(file.text);
    for (const pattern of TOTAL_PATTERNS) {
      const matcher = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(text)) !== null) {
        const value = Number.parseInt(match[1] ?? '', 10);
        if (!Number.isFinite(value)) continue;
        if (value === total) continue;
        if (value < 30) continue;
        findings.push(
          finding(
            'F006',
            'error',
            file.name,
            lineAt(text, match.index),
            `file asserts ${value} chapters; the book has ${total}`,
            excerptAt(text, match.index, match[0].length),
          ),
        );
      }
    }
  }
  return findings;
}

export function runValidation(options: ValidateOptions): ValidateResult {
  const total = options.totalChapters ?? TOTAL_CHAPTERS;
  const { chapters, front, findings } = collectManuscript(options);

  findings.push(...checkFrontMatter(front));
  findings.push(...checkImprint(options.imprint));

  const legal = checkDenylistConfig(options.denylist);
  findings.push(...legal.findings);

  for (const chapter of chapters) {
    findings.push(...checkTitleLine(chapter));
    findings.push(...checkLength(chapter));
    findings.push(...checkFrame(chapter));
    findings.push(...checkLegal(chapter, legal));

    const offsets = blockOffsets(chapter);
    findings.push(...checkMarkdown(chapter, offsets));
  }

  findings.push(...checkTotals(total, options.planning));

  findings.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    return a.rule.localeCompare(b.rule);
  });

  return {
    findings,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warn').length,
    chapters: chapters.map((c) => ({ n: c.n, file: c.file, title: c.title, chars: c.chars, blocks: c.blocks.length })),
    front:
      front === null
        ? null
        : { file: front.file, title: front.title, about: front.about, chars: front.chars },
    totalChapters: total,
  };
}
