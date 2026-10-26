import { describe, expect, it } from 'vitest';

import type { Imprint, LegalDenylist } from '../../src/book.ts';
import { ABOUT_MAX_CHARS, ABOUT_MIN_CHARS, FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE } from '../../src/book.ts';
import type { ManuscriptFile, ValidateOptions } from '../../src/validate/index.ts';
import { runValidation } from '../../src/validate/index.ts';

const IMPRINT: Imprint = {
  author: 'Филипп Семиров',
  copyright: '© Филипп Семиров',
  publisher: null,
  year: 'auto',
};

const DENYLIST: LegalDenylist = { persons: [], characters: [], organisations: [], patterns: [] };

const ABOUT =
  'Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги. Тестовая аннотация для проверки разбора первой страницы. Она состоит из служебных предложений и не является текстом книги.';

const FRONT: ManuscriptFile = { name: '00-front.md', text: `Без названия\n\n${ABOUT}` };

/** A chapter that is inside the band, so F007 stays quiet unless a test says otherwise. */
function chapter(title = 'Тестовая глава', body = 'а'.repeat(20_001)): ManuscriptFile {
  return { name: 'ch05.md', text: `${title}\n\n${body}` };
}

function run(overrides: Partial<ValidateOptions> = {}) {
  return runValidation({
    files: [FRONT, chapter()],
    imprint: IMPRINT,
    denylist: DENYLIST,
    ...overrides,
  });
}

const rules = (result: ReturnType<typeof run>) => result.findings.map((item) => item.rule);
const withRule = (result: ReturnType<typeof run>, rule: string) =>
  result.findings.filter((item) => item.rule === rule);

describe('the clean sheet', () => {
  it('accepts a front matter and one chapter inside the band', () => {
    const result = run();
    expect(result.findings).toEqual([]);
    expect(result.errors).toBe(0);
    expect(result.front).toMatchObject({ title: 'Без названия' });
    expect(result.chapters[0]).toMatchObject({ n: 5, title: 'Тестовая глава', blocks: 1 });
  });

  it('accepts an empty manuscript with only 00-front.md: 67 empty slots', () => {
    const result = run({ files: [FRONT] });
    expect(result.findings).toEqual([]);
    expect(result.chapters).toEqual([]);
    expect(result.totalChapters).toBe(67);
  });

  it('rejects a manuscript with no front matter: F021 is an error, not a warning', () => {
    const result = run({ files: [chapter()] });
    expect(result.findings).toEqual([expect.objectContaining({ rule: 'F021', severity: 'error' })]);
    expect(result.front).toBeNull();
  });
});

describe('F001 — chapter file naming', () => {
  it('rejects a chapter file that is not chNN.md', () => {
    const result = run({ files: [FRONT, { name: 'ch1.md', text: chapter().text }] });
    expect(result.findings[0]).toMatchObject({ rule: 'F001', severity: 'error', file: 'ch1.md' });
  });
});

describe('F002 — stray files, range, duplicates', () => {
  it('rejects an extra .md file', () => {
    const result = run({ files: [FRONT, chapter(), { name: 'notes.md', text: 'x' }] });
    expect(withRule(result, 'F002')).toHaveLength(1);
    expect(withRule(result, 'F002')[0]).toMatchObject({ severity: 'error', file: 'notes.md' });
  });

  it('no longer allows manuscript/PLAN.md — the plan lives in outline/', () => {
    const result = run({ files: [FRONT, chapter(), { name: 'PLAN.md', text: '# План 67 глав' }] });
    expect(withRule(result, 'F002')[0]).toMatchObject({ file: 'PLAN.md' });
  });

  it('rejects a chapter above 67', () => {
    const result = run({ files: [FRONT, { name: 'ch68.md', text: chapter().text }] });
    expect(rules(result)).toContain('F002');
    expect(result.chapters).toHaveLength(0);
  });

  it('rejects the same chapter twice in different case', () => {
    const result = run({
      files: [FRONT, { name: 'ch01.md', text: chapter().text }, { name: 'Ch01.md', text: chapter().text }],
    });
    expect(result.findings.some((item) => item.rule === 'F002' && item.file === 'Ch01.md')).toBe(true);
  });
});

describe('retired vocabulary rules — the only taboos are copyright and RF law', () => {
  it('reports no F003 or F008 finding for words the old style list banned', () => {
    const result = run({
      files: [FRONT, chapter('Цикл', `Начался цикл, потом прогон и снова цикл. ${'а'.repeat(20_000)}`)],
    });
    expect(result.findings).toEqual([]);
    expect(rules(result)).not.toContain('F003');
    expect(rules(result)).not.toContain('F008');
  });
});

describe('F004 — retired in v3', () => {
  it('does not report the retired meeting-point phrase at all', () => {
    const result = run({
      files: [FRONT, { name: 'ch23.md', text: 'Рука пошла и не дошла.\n\nРука пошла и не дошла.' }],
    });
    expect(rules(result)).not.toContain('F004');
  });
});

describe('F005 — the legal denylist', () => {
  const denylist: LegalDenylist = {
    persons: ['Лев Толстой'],
    characters: ['Гарри Поттер'],
    organisations: ['Запрещённая организация'],
    patterns: ['экстремизм'],
  };

  it('rejects a denylisted real person and a protected character', () => {
    const result = run({
      files: [FRONT, chapter('Вечер', 'Потом вошёл Лев Толстой и заговорил о Гарри Поттере.')],
      denylist,
    });
    const found = withRule(result, 'F005');
    expect(found.map((item) => item.severity)).toEqual(['error', 'error']);
    expect(found.map((item) => item.message)).toEqual([
      expect.stringContaining('denylisted person: «Лев Толстой»'),
      expect.stringContaining('protected character: «Гарри Поттере»'),
    ]);
  });

  it('does not trip a full name on a first name that only starts another name', () => {
    const result = run({
      files: [
        FRONT,
        chapter('Уборка', 'В двадцать минут пятого пришла Александра и стала мыть пол.'),
      ],
      denylist: { ...DENYLIST, persons: ['Александр Лукашенко'] },
    });
    expect(rules(result)).not.toContain('F005');
  });

  it('does not trip a multi-word person on one token of it', () => {
    const result = run({
      files: [FRONT, chapter('Вечер', 'Потом вошёл Александр и сел у окна.')],
      denylist: { ...DENYLIST, persons: ['Александр Лукашенко'] },
    });
    expect(rules(result)).not.toContain('F005');
  });

  it('rejects the exact denylisted full name', () => {
    const result = run({
      files: [FRONT, chapter('Приезд', 'Вчера Александр Лукашенко приехал в район на две минуты.')],
      denylist: { ...DENYLIST, persons: ['Александр Лукашенко'] },
    });
    expect(withRule(result, 'F005')).toEqual([
      expect.objectContaining({ severity: 'error', message: 'denylisted person: «Александр Лукашенко»' }),
    ]);
  });

  it('warns about a denylisted organisation and errors on an illegal-content pattern', () => {
    const result = run({
      files: [FRONT, chapter('Бумага', 'Пришла бумага из Запрещённой организации: экстремизм.')],
      denylist,
    });
    expect(withRule(result, 'F005')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'warn', message: expect.stringContaining('organisation') }),
        expect.objectContaining({ severity: 'error', message: expect.stringContaining('illegal-content') }),
      ]),
    );
  });

  it('does not touch an invented name — names are the writer’s to invent', () => {
    const result = run({ files: [FRONT, chapter('Вечер', 'Потом вошёл Матвей и сел.')] });
    expect(rules(result)).not.toContain('F005');
  });

  it('reports a missing denylist instead of silently passing', () => {
    const result = run({ denylist: null });
    expect(withRule(result, 'F005')[0]).toMatchObject({ severity: 'error', file: 'config/legal.denylist.json' });
  });

  it('reports an invalid denylist pattern', () => {
    const result = run({ denylist: { ...DENYLIST, patterns: ['[broken'] } });
    expect(withRule(result, 'F005')[0]?.message).toContain('not a valid regular expression');
  });
});

describe('F006 — 67 chapters', () => {
  it('rejects a plan that asserts another total', () => {
    const result = run({ planning: [{ name: 'outline/PLAN.md', text: '# План 66 глав (строго)' }] });
    expect(result.findings[0]).toMatchObject({ rule: 'F006', severity: 'error' });
  });

  it('accepts the real plan shape', () => {
    const plan = ['# План 67 глав (строго)', '', '| 44 главы = 4 линии × 11 |'].join('\n');
    expect(rules(run({ planning: [{ name: 'outline/PLAN.md', text: plan }] }))).not.toContain('F006');
  });
});

describe('F007 — chapter length at both moments', () => {
  it('rejects 30 001 characters', () => {
    const result = run({ files: [FRONT, chapter('Длинная', 'а'.repeat(30_001))] });
    expect(withRule(result, 'F007')[0]).toMatchObject({ severity: 'error' });
  });

  it('accepts 30 000 characters', () => {
    const result = run({ files: [FRONT, chapter('Длинная', 'а'.repeat(30_000))] });
    expect(rules(result)).not.toContain('F007');
  });

  it('warns at 19 999 characters (thin chapter)', () => {
    const result = run({ files: [FRONT, chapter('Тонкая', 'а'.repeat(19_999))] });
    expect(withRule(result, 'F007')[0]).toMatchObject({ severity: 'warn' });
    expect(withRule(result, 'F007')[0]?.message).toContain('thin chapter');
  });

  it('warns at 1 599 characters', () => {
    const result = run({ files: [FRONT, chapter('Страница', 'а'.repeat(1_599))] });
    expect(withRule(result, 'F007')[0]).toMatchObject({ severity: 'warn' });
  });

  it('passes at 20 001 characters', () => {
    const result = run({ files: [FRONT, chapter('Полная', 'а'.repeat(20_001))] });
    expect(rules(result)).not.toContain('F007');
  });

  it('does not count the title line in chars', () => {
    const result = run({ files: [FRONT, chapter('я'.repeat(80), 'а'.repeat(20_000))] });
    expect(result.chapters[0]?.chars).toBe(20_000);
    expect(rules(result)).not.toContain('F007');
  });
});

describe('F009 — markdown in prose', () => {
  it('warns about a heading and a link', () => {
    const result = run({
      files: [FRONT, chapter('Вторник', '## Вторник\n\nТекст с [ссылкой](https://example.org) внутри.')],
    });
    const found = withRule(result, 'F009');
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('warn');
  });
});

describe('F020 — the imprint is exact', () => {
  it('accepts the exact imprint', () => {
    expect(rules(run())).not.toContain('F020');
  });

  it('rejects a drifting copyright, author or publisher', () => {
    const result = run({
      imprint: { author: 'Другой автор', copyright: '© Другой автор', publisher: 'Издательство', year: 'auto' },
    });
    expect(withRule(result, 'F020')).toHaveLength(3);
  });

  it('rejects a missing imprint', () => {
    expect(withRule(run({ imprint: null }), 'F020')[0]?.message).toContain('imprint is missing');
  });
});

describe('F021 — the front matter', () => {
  it('rejects a title above 80 characters', () => {
    const result = run({ files: [{ name: '00-front.md', text: `${'я'.repeat(81)}\n\n${ABOUT}` }] });
    expect(withRule(result, 'F021')[0]?.message).toContain('81 characters');
  });

  it('rejects an annotation of 200 characters', () => {
    const result = run({ files: [{ name: '00-front.md', text: `Название\n\n${'я'.repeat(200)}` }] });
    expect(withRule(result, 'F021')[0]?.message).toContain(`expected ${ABOUT_MIN_CHARS}–${ABOUT_MAX_CHARS}`);
  });

  it('rejects an annotation above the character limit', () => {
    const result = run({
      files: [{ name: '00-front.md', text: `Название\n\n${'я'.repeat(ABOUT_MAX_CHARS + 1)}` }],
    });
    expect(withRule(result, 'F021')[0]?.message).toContain(`${ABOUT_MAX_CHARS + 1} characters`);
  });

  it('rejects an annotation of thirteen blocks', () => {
    const block = 'а'.repeat(100);
    const blocks = Array.from({ length: 13 }, () => block);
    const result = run({
      files: [{ name: '00-front.md', text: `Название\n\n${blocks.join('\n\n')}` }],
    });
    expect(withRule(result, 'F021')[0]?.message).toContain('13 blocks');
  });

  it('rejects markdown in the annotation', () => {
    const result = run({ files: [{ name: '00-front.md', text: `Название\n\n${ABOUT}\n\n[ссылка](https://example.org)` }] });
    expect(withRule(result, 'F021')[0]?.message).toContain('markdown');
  });
});

describe('F022 — the chapter title line', () => {
  it('rejects a chapter without a title line', () => {
    const result = run({
      files: [FRONT, { name: 'ch01.md', text: 'Первый абзац без заголовка.\nВторой абзац без пустой строки.' }],
    });
    expect(withRule(result, 'F022')).toEqual([
      expect.objectContaining({ severity: 'error', file: 'ch01.md', line: 1 }),
    ]);
  });

  it('rejects a title above 80 characters', () => {
    const result = run({ files: [FRONT, chapter('я'.repeat(81), 'Текст.')] });
    expect(withRule(result, 'F022')[0]?.message).toContain('81 characters');
  });

  it('rejects a trailing colon and markdown in the title', () => {
    expect(withRule(run({ files: [FRONT, chapter('Тестовая глава:', 'Текст.')] }), 'F022')[0]?.message).toContain('colon');
    expect(withRule(run({ files: [FRONT, chapter('## Тестовая запись', 'Текст.')] }), 'F022')[0]?.message).toContain(
      'markdown',
    );
  });

  it('rejects a non-blank line 2', () => {
    const result = run({ files: [FRONT, { name: 'ch01.md', text: 'Тестовая глава\nПервый абзац без пустой строки.' }] });
    expect(withRule(result, 'F022')[0]?.message).toContain('line 2 must be blank');
  });

  it('accepts a title line and keeps the title out of chars', () => {
    const result = run({ files: [FRONT, chapter('Тестовая глава', 'а'.repeat(20_001))] });
    expect(result.chapters[0]).toMatchObject({ title: 'Тестовая глава', chars: 20_001 });
  });
});

describe('F029 — the frozen frame', () => {
  /** A chapter file with a valid title line and the given prose. */
  const framed = (n: number, body: string): ManuscriptFile => ({
    name: `ch${String(n).padStart(2, '0')}.md`,
    text: `Глава\n\n${body}`,
  });
  const found = (result: ReturnType<typeof run>) => withRule(result, 'F029');

  it('accepts the frame at both ends', () => {
    const result = run({
      files: [
        FRONT,
        framed(1, `${FRAME_FIRST_SENTENCE} Потом он сел и стал ждать.`),
        framed(67, `Всё стихло к утру. ${FRAME_LAST_SENTENCE}`),
      ],
    });
    expect(found(result)).toEqual([]);
  });

  it('accepts a frame rewrapped across lines', () => {
    const opening = run({
      files: [FRONT, framed(1, 'Рано утром я проснулся по будильнику,\nбыл обычный будний день. Потом он сел.')],
    });
    expect(found(opening)).toEqual([]);

    const closing = run({ files: [FRONT, framed(67, 'Всё стихло.\nИ никого\nне стало.')] });
    expect(found(closing)).toEqual([]);
  });

  it('rejects a changed word in the opening sentence', () => {
    const result = run({
      files: [FRONT, framed(1, 'Рано утром я проснулся по будильнику, был обычный рабочий день. Потом он сел.')],
    });
    expect(found(result)).toEqual([
      expect.objectContaining({
        severity: 'error',
        file: 'ch01.md',
        message: expect.stringContaining('must begin with'),
      }),
    ]);
    expect(found(result)[0]?.message).toContain('found «Рано утром я проснулся по будильнику, был обычный рабочий день.»');
  });

  it('rejects ch01 without the frozen sentence', () => {
    const result = run({ files: [FRONT, framed(1, 'Тестовый абзац пришёл на работу раньше всех.')] });
    expect(found(result)).toHaveLength(1);
    expect(found(result)[0]?.message).toContain('found «Тестовый абзац пришёл на работу раньше всех.»');
  });

  it('rejects ch67 without the last sentence', () => {
    const result = run({ files: [FRONT, framed(67, 'Всё стихло, но кто-то остался.')] });
    expect(found(result)).toEqual([
      expect.objectContaining({ severity: 'error', file: 'ch67.md', message: expect.stringContaining('must end with') }),
    ]);
    expect(found(result)[0]?.message).toContain('found «Всё стихло, но кто-то остался.»');
  });

  it('reports the tail of a long closing paragraph', () => {
    const result = run({ files: [FRONT, framed(67, `${'Слово '.repeat(40)}и всё стихло.`)] });
    const message = found(result)[0]?.message ?? '';
    expect(message).toContain('…');
    expect(message).toContain('и всё стихло.»');
  });

  it('accepts the sentence as the whole file — a basis-only slot', () => {
    const result = run({
      files: [
        FRONT,
        { name: 'ch01.md', text: FRAME_FIRST_SENTENCE },
        { name: 'ch67.md', text: FRAME_LAST_SENTENCE },
      ],
    });
    expect(found(result)).toEqual([]);
  });

  it('accepts the sentence as a title-less first line', () => {
    const result = run({ files: [FRONT, { name: 'ch01.md', text: `${FRAME_FIRST_SENTENCE}\nПотом он сел.` }] });
    expect(found(result)).toEqual([]);
  });

  it('accepts a manuscript without ch67', () => {
    const result = run({ files: [FRONT, framed(1, `${FRAME_FIRST_SENTENCE} Потом он сел.`)] });
    expect(found(result)).toEqual([]);
  });

  it('keeps the reported sentence to 80 characters', () => {
    const result = run({ files: [FRONT, framed(1, `${'Слово '.repeat(40)}и всё.`)] });
    const message = found(result)[0]?.message ?? '';
    expect(message).toContain('…');
    expect(message.length).toBeLessThan(300);
  });
});

describe('an empty slot is a valid state (§BOOK-6)', () => {
  it('accepts an absent chapter', () => {
    expect(rules(run({ files: [FRONT] }))).toEqual([]);
  });

  it('accepts a zero-byte chapter file without thin or title findings', () => {
    const result = run({ files: [FRONT, { name: 'ch05.md', text: '' }] });
    expect(result.findings).toEqual([]);
    expect(result.chapters[0]).toMatchObject({ n: 5, title: null, chars: 0, blocks: 0 });
  });

  it('accepts a basis-only ch01 and ch67 without thin or title findings', () => {
    const result = run({
      files: [
        FRONT,
        { name: 'ch01.md', text: FRAME_FIRST_SENTENCE },
        { name: 'ch67.md', text: FRAME_LAST_SENTENCE },
      ],
    });
    expect(result.findings).toEqual([]);
    expect(result.chapters.map((item) => item.chars)).toEqual([0, 0]);
  });

  it('keeps F007 and F022 for a written chapter', () => {
    const thin = run({ files: [FRONT, chapter('Короткая', 'Один абзац.')] });
    expect(withRule(thin, 'F007')[0]).toMatchObject({ severity: 'warn', message: expect.stringContaining('thin chapter') });

    const untitled = run({ files: [FRONT, { name: 'ch06.md', text: 'Первый абзац без заголовка.\nВторой.' }] });
    expect(withRule(untitled, 'F022')).toHaveLength(1);
  });
});

describe('names are the writer’s to invent — no rule polices them', () => {
  it('accepts an unrecorded invented name without a finding', () => {
    const result = run({
      files: [FRONT, chapter('Вечер', `Потом вошёл Матвей и сел у окна. ${'а'.repeat(20_000)}`)],
    });
    expect(result.findings).toEqual([]);
  });
});

describe('report shape', () => {
  it('sorts findings by file and line, counts severities and keeps titles', () => {
    const result = run({
      files: [
        FRONT,
        { name: 'ch05.md', text: `Глава пять\n\n${'а'.repeat(30_001)}` },
        // A written chapter without a title line: F022 is an error for the commit (§6C.3).
        { name: 'ch01.md', text: 'Первый абзац без заголовка.\nВторой абзац без пустой строки.' },
      ],
    });
    expect(result.errors).toBeGreaterThanOrEqual(2);
    const keys = result.findings.map((item) => `${item.file}:${item.line}`);
    expect([...keys].sort()).toEqual(keys);
    expect(result.chapters.map((item) => item.n)).toEqual([1, 5]);
    expect(result.chapters[1]?.title).toBe('Глава пять');
  });
});
