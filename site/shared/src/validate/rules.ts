/**
 * F001–F002, F005–F007 and F009, plus F019–F022 of ARCHITECTURE.md §13.4, over an
 * in-memory snapshot of the repository.
 *
 * F001 naming · F002 stray files / range · F004 retired (v3) · F005 the legal denylist
 * · F006 67 chapters · F007 chapter length · F009 markdown in prose (warn) · F019
 * unrecorded name (warn) · F020 imprint · F021 front matter · F022 chapter title line.
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
  parseFrontMatter,
  parseTitleLine,
  splitParagraphs,
  type Imprint,
  type LegalDenylist,
} from '../book.ts';
import {
  buildDenylistIndex,
  compilePatterns,
  findDenylisted,
  findPatternHits,
  matchesDenylist,
} from './denylist.ts';
import {
  CAPITALIZED_WORD,
  type ChapterFile,
  type Finding,
  type RuleId,
  type Severity,
  type ValidateOptions,
  type ValidateResult,
  countParagraphChars,
  excerptAt,
  foldRu,
  hasMarkdown,
  isSentenceStart,
  lineAt,
  manuscriptChapterFile,
  normalizeText,
} from './text.ts';

const FRONT_PATH = `manuscript/${FRONT_FILE}`;
const DENYLIST_PATH = 'config/legal.denylist.json';
const IMPRINT_PATH = 'config/imprint.json';
const DOSSIERS_PATH = 'bible/dossiers.md';

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

    const line = parseTitleLine(file.text);
    const blocks = splitParagraphs(line.body);
    chapters.push({
      n: parsed.n,
      file: file.name,
      text: normalizeText(file.text),
      title: line.title,
      titleProblems: line.problems,
      blocks,
      chars: countParagraphChars(blocks),
    });
  }

  chapters.sort((a, b) => a.n - b.n);
  return { chapters, front, findings };
}

function checkLength(chapter: ChapterFile): Finding[] {
  if (chapter.chars > CHAPTER_CHARS.max) {
    return [
      finding(
        'F007',
        'error',
        chapter.file,
        1,
        `chapter has ${chapter.chars} characters, maximum is ${CHAPTER_CHARS.max}`,
      ),
    ];
  }
  if (chapter.chars < CHAPTER_CHARS.floor) {
    return [
      finding(
        'F007',
        'warn',
        chapter.file,
        1,
        `thin chapter: ${chapter.chars} characters, a page is ${CHAPTER_CHARS.floor}`,
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
  persons: ReturnType<typeof buildDenylistIndex>;
  characters: ReturnType<typeof buildDenylistIndex>;
  organisations: ReturnType<typeof buildDenylistIndex>;
  patterns: RegExp[];
} {
  const empty = buildDenylistIndex([]);
  if (denylist === null || denylist === undefined) {
    return {
      findings: [finding('F005', 'error', DENYLIST_PATH, 1, 'legal denylist is missing — the legal gate cannot run')],
      persons: empty,
      characters: empty,
      organisations: empty,
      patterns: [],
    };
  }
  const compiled = compilePatterns(denylist.patterns ?? []);
  return {
    findings: compiled.problems.map((problem) => finding('F005', 'error', DENYLIST_PATH, 1, problem)),
    persons: buildDenylistIndex(denylist.persons ?? []),
    characters: buildDenylistIndex(denylist.characters ?? []),
    organisations: buildDenylistIndex(denylist.organisations ?? []),
    patterns: compiled.regexes,
  };
}

/** F005 — denylisted persons and characters are errors, organisations a warning, patterns errors. */
function checkLegal(
  chapter: ChapterFile,
  indexes: {
    persons: ReturnType<typeof buildDenylistIndex>;
    characters: ReturnType<typeof buildDenylistIndex>;
    organisations: ReturnType<typeof buildDenylistIndex>;
    patterns: RegExp[];
  },
): { findings: Finding[]; flagged: Set<string> } {
  const findings: Finding[] = [];
  const flagged = new Set<string>();
  const groups: Array<[RuleId, Severity, ReturnType<typeof buildDenylistIndex>, string]> = [
    ['F005', 'error', indexes.persons, 'denylisted person'],
    ['F005', 'error', indexes.characters, 'protected character'],
    ['F005', 'warn', indexes.organisations, 'denylisted organisation'],
  ];
  for (const [rule, severity, index, label] of groups) {
    for (const hit of findDenylisted(chapter.text, index)) {
      flagged.add(foldRu(hit.word));
      findings.push(
        finding(
          rule,
          severity,
          chapter.file,
          lineAt(chapter.text, hit.offset),
          `${label}: «${hit.word}»`,
          excerptAt(chapter.text, hit.offset, hit.word.length),
        ),
      );
    }
  }
  if (indexes.patterns.length > 0) {
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
  }
  return { findings, flagged };
}

/** The record of people already on the page: every capitalised word in the dossiers file. */
export function recordedNames(dossiers: { text: string } | null | undefined): Set<string> {
  if (dossiers === null || dossiers === undefined) return new Set();
  const names = new Set<string>();
  for (const match of dossiers.text.matchAll(CAPITALIZED_WORD)) names.add(foldRu(match[0]));
  return names;
}

/**
 * F019 — a capitalised proper name that is not recorded in `bible/dossiers.md`.
 * A warning, never a block: a name is the writer's to invent (§6E.5).
 */
function checkNameRecord(
  chapter: ChapterFile,
  recorded: ReturnType<typeof buildDenylistIndex>,
  knownWords: Set<string>,
  flagged: Set<string>,
  offsets: number[],
): Finding[] {
  const findings: Finding[] = [];
  const reported = new Set<string>();
  for (let i = 0; i < chapter.blocks.length; i += 1) {
    const block = chapter.blocks[i] ?? '';
    const offset = offsets[i] ?? 0;
    for (const match of block.matchAll(CAPITALIZED_WORD)) {
      const word = match[0];
      const key = foldRu(word);
      if (knownWords.has(key) || flagged.has(key) || reported.has(key)) continue;
      if (matchesDenylist(word, recorded)) continue;
      if (isSentenceStart(block, match.index)) {
        const rest = block.slice(match.index + word.length);
        const next = /^\s+([А-ЯЁ][а-яё]+)/u.exec(rest);
        if (!next || knownWords.has(foldRu(next[1] ?? '')) || matchesDenylist(next[1] ?? '', recorded)) continue;
      }
      reported.add(key);
      findings.push(
        finding(
          'F019',
          'warn',
          chapter.file,
          lineAt(chapter.text, offset + match.index),
          `name «${word}» is not recorded in ${DOSSIERS_PATH}`,
          excerptAt(chapter.text, offset + match.index, word.length),
        ),
      );
    }
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
  const knownNames = recordedNames(options.dossiers);
  const recordedIndex = buildDenylistIndex([...knownNames]);

  for (const chapter of chapters) {
    findings.push(...checkTitleLine(chapter));
    findings.push(...checkLength(chapter));

    const legalHits = checkLegal(chapter, legal);
    findings.push(...legalHits.findings);

    const offsets = blockOffsets(chapter);
    findings.push(...checkMarkdown(chapter, offsets));
    findings.push(...checkNameRecord(chapter, recordedIndex, knownNames, legalHits.flagged, offsets));
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
