/**
 * F001–F009 of ARCHITECTURE.md §13.4, over an in-memory snapshot of the repository.
 *
 * F001 naming · F002 stray files / range · F003 forbidden vocabulary · F004 the phrase
 * · F005 finite cast · F006 67 chapters · F007 chapter length · F008 process vocabulary
 * · F009 markdown in prose (warn).
 */

import { ENGINEER_LINE_CHAPTERS, TOTAL_CHAPTERS } from '../chapters.ts';
import { buildCastIndex, findUnknownNames } from './cast.ts';
import {
  FORBIDDEN_PROSE,
  PROCESS_PROSE,
  type ChapterFile,
  type Finding,
  type RuleId,
  type Severity,
  type ValidateOptions,
  type ValidateResult,
  type WordRule,
  countChars,
  excerptAt,
  findPhrase,
  findWords,
  lineAt,
  manuscriptChapterFile,
  normalizeText,
  splitBlocks,
} from './text.ts';

const PHRASE = 'Рука пошла и не дошла';
const ENGINEER_NOTE = ENGINEER_LINE_CHAPTERS.join(', ');
/** `manuscript/PLAN.md` is referenced by ARCHITECTURE.md §9 (the `line` field). */
const ALLOWED_EXTRA_FILES = new Set(['PLAN.md']);

const HARD_MIN = 3000;
const HARD_MAX = 15000;
const SOFT_MIN = 6000;
const SOFT_MAX = 12000;

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

/** Chapter files and the stray-file findings, in one pass over the root listing. */
export function collectChapters(options: ValidateOptions): {
  chapters: ChapterFile[];
  findings: Finding[];
} {
  const findings: Finding[] = [];
  const chapters: ChapterFile[] = [];
  const seen = new Map<number, string>();

  for (const file of options.files) {
    const parsed = manuscriptChapterFile(file.name);
    if (parsed === null) {
      if (ALLOWED_EXTRA_FILES.has(file.name)) continue;
      findings.push(
        finding('F002', 'error', file.name, 1, 'extra .md file in manuscript/ — only chNN.md and PLAN.md are allowed'),
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
    const blocks = splitBlocks(text);
    chapters.push({ n: parsed.n, file: file.name, text, blocks, chars: countChars(blocks) });
  }

  chapters.sort((a, b) => a.n - b.n);
  return { chapters, findings };
}

function scanVocabulary(
  chapter: ChapterFile,
  rules: WordRule[],
  rule: RuleId,
  label: string,
  skip?: Set<string>,
): { findings: Finding[]; seen: Set<string> } {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const wordRule of rules) {
    for (const match of findWords(chapter.text, wordRule)) {
      const key = `${match.offset}:${match.word.toLowerCase()}`;
      if (skip?.has(key) || seen.has(key)) continue;
      seen.add(key);
      findings.push(
        finding(
          rule,
          'error',
          chapter.file,
          lineAt(chapter.text, match.offset),
          `${label}: «${match.word}»`,
          excerptAt(chapter.text, match.offset, match.length),
        ),
      );
    }
  }
  return { findings, seen };
}

function checkLength(chapter: ChapterFile): Finding[] {
  if (chapter.chars < HARD_MIN) {
    return [
      finding(
        'F007',
        'error',
        chapter.file,
        1,
        `chapter has ${chapter.chars} characters, hard minimum is ${HARD_MIN}`,
      ),
    ];
  }
  if (chapter.chars > HARD_MAX) {
    return [
      finding(
        'F007',
        'error',
        chapter.file,
        1,
        `chapter has ${chapter.chars} characters, hard maximum is ${HARD_MAX}`,
      ),
    ];
  }
  if (chapter.chars < SOFT_MIN || chapter.chars > SOFT_MAX) {
    return [
      finding(
        'F007',
        'warn',
        chapter.file,
        1,
        `chapter has ${chapter.chars} characters, outside the ${SOFT_MIN}..${SOFT_MAX} band`,
      ),
    ];
  }
  return [];
}

function checkMarkdown(chapter: ChapterFile, offsets: number[]): Finding[] {
  for (let i = 0; i < chapter.blocks.length; i += 1) {
    const block = chapter.blocks[i] ?? '';
    const offset = offsets[i] ?? 0;
    const problems: string[] = [];
    if (/^\s{0,3}#{1,6}\s/u.test(block)) problems.push('heading');
    if (/\[[^\]\n]+\]\([^)\n]+\)/u.test(block)) problems.push('link');
    if (/\[\^[^\]\n]+\]/u.test(block)) problems.push('footnote');
    if (problems.length > 0) {
      return [
        finding(
          'F009',
          'warn',
          chapter.file,
          lineAt(chapter.text, offset),
          `markdown in prose: ${problems.join(', ')} — the format is plain paragraphs`,
        ),
      ];
    }
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

function checkPhrase(chapters: ChapterFile[]): Finding[] {
  const occurrences: Array<{ chapter: ChapterFile; offset: number }> = [];
  for (const chapter of chapters) {
    for (const offset of findPhrase(chapter.text, PHRASE)) occurrences.push({ chapter, offset });
  }
  const findings: Finding[] = [];
  for (const { chapter, offset } of occurrences) {
    const line = lineAt(chapter.text, offset);
    if (occurrences.length > 1) {
      findings.push(
        finding(
          'F004',
          'error',
          chapter.file,
          line,
          `«${PHRASE}» occurs ${occurrences.length} times in the book (maximum 1)`,
          excerptAt(chapter.text, offset, PHRASE.length),
        ),
      );
      continue;
    }
    if (!ENGINEER_LINE_CHAPTERS.includes(chapter.n)) {
      findings.push(
        finding(
          'F004',
          'error',
          chapter.file,
          line,
          `«${PHRASE}» is allowed only in an engineer-line chapter (${ENGINEER_NOTE}), not in chapter ${chapter.n}`,
          excerptAt(chapter.text, offset, PHRASE.length),
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
  const { chapters, findings } = collectChapters(options);
  const castIndex = buildCastIndex([
    ...options.allowlist.cast,
    ...options.allowlist.places,
    ...options.allowlist.manual,
    ...(options.allowNewNames ?? []),
  ]);

  for (const chapter of chapters) {
    findings.push(...checkLength(chapter));
    const forbidden = scanVocabulary(chapter, FORBIDDEN_PROSE, 'F003', 'forbidden word');
    findings.push(...forbidden.findings);
    // F008 covers «цикл / прогон / перезапуск» too; they are already errors above, so a
    // duplicate line is suppressed instead of reporting the same word twice.
    findings.push(
      ...scanVocabulary(chapter, PROCESS_PROSE, 'F008', 'process vocabulary in prose', forbidden.seen).findings,
    );

    const offsets = blockOffsets(chapter);
    for (let i = 0; i < chapter.blocks.length; i += 1) {
      const block = chapter.blocks[i] ?? '';
      const offset = offsets[i] ?? 0;
      // A markdown heading is F009's business; its first word is not a character name.
      if (/^\s{0,3}#{1,6}\s/u.test(block)) continue;
      for (const hit of findUnknownNames(block, castIndex)) {
        findings.push(
          finding(
            'F005',
            'error',
            chapter.file,
            lineAt(chapter.text, offset + hit.offset),
            `name «${hit.word}» is not in config/cast.allowlist.json (or --allow-new-name=)`,
            excerptAt(chapter.text, offset + hit.offset, hit.word.length),
          ),
        );
      }
    }
    findings.push(...checkMarkdown(chapter, offsets));
  }

  findings.push(...checkPhrase(chapters));
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
    chapters: chapters.map((c) => ({ n: c.n, file: c.file, chars: c.chars, blocks: c.blocks.length })),
    totalChapters: total,
  };
}
