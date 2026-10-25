import { describe, expect, it } from 'vitest';

import type { Imprint, LegalDenylist } from '../../src/book.ts';
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
  'Книга о том, как вещи научились обходиться без тех, кто их завёл. В ней нет героев — есть смены, ' +
  'заявки, очереди и бумаги, которые пережили своих составителей. Земля в ней больше не кормит: её ' +
  'обслуживают. Поля стали участками, участки — строками в реестре, реестр — тем, что закрывают само, ' +
  'без человека. Конец у этой книги один, и он не спрятан: шестьдесят семь глав пишутся в открытую.';

const FRONT: ManuscriptFile = { name: '00-front.md', text: `Земля, которая больше не кормит\n\n${ABOUT}` };

/** A chapter that is inside the band, so F007 stays quiet unless a test says otherwise. */
function chapter(title = 'Половик в тамбуре', body = 'а'.repeat(20_001)): ManuscriptFile {
  return { name: 'ch05.md', text: `${title}\n\n${body}` };
}

function run(overrides: Partial<ValidateOptions> = {}) {
  return runValidation({
    files: [FRONT, chapter()],
    imprint: IMPRINT,
    denylist: DENYLIST,
    dossiers: { name: 'bible/dossiers.md', text: '(пока пусто)' },
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
    expect(result.front).toMatchObject({ title: 'Земля, которая больше не кормит' });
    expect(result.chapters[0]).toMatchObject({ n: 5, title: 'Половик в тамбуре', blocks: 1 });
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

describe('F003 — forbidden vocabulary', () => {
  it('flags VOICE taboos with a line number', () => {
    const result = run({ files: [FRONT, chapter('Половик', 'Начался цикл, потом прогон.')] });
    const found = withRule(result, 'F003');
    expect(found.map((item) => item.message)).toEqual([
      'forbidden word: «цикл»',
      'forbidden word: «прогон»',
    ]);
    expect(found[0]?.line).toBe(3);
  });

  it('does not flag a word that merely starts with a taboo word', () => {
    const result = run({ files: [FRONT, chapter('Двор', 'Двор был богатый, крыша — худая.')] });
    expect(rules(result)).not.toContain('F003');
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
      files: [FRONT, chapter('Вечер', 'Потом вошёл Толстой и заговорил о Поттере.')],
      denylist,
    });
    const found = withRule(result, 'F005');
    expect(found.map((item) => item.severity)).toEqual(['error', 'error']);
    expect(found.map((item) => item.message)).toEqual([
      expect.stringContaining('denylisted person'),
      expect.stringContaining('protected character'),
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

describe('F008 — process vocabulary', () => {
  it('reports PASS and reweiter without repeating F003 words', () => {
    const result = run({ files: [FRONT, chapter('Смена', 'Пошёл PASS, потом reweiter и цикл.')] });
    const found = withRule(result, 'F008');
    expect(found.map((item) => item.message)).toEqual([
      'process vocabulary in prose: «PASS»',
      'process vocabulary in prose: «reweiter»',
    ]);
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

describe('F019 — the dossiers record is a warning, never a gate', () => {
  it('warns about an invented name that is not recorded', () => {
    const result = run({ files: [FRONT, chapter('Вечер', 'Потом вошёл Матвей и сел у окна.')] });
    expect(rules(result)).not.toContain('F005');
    expect(withRule(result, 'F019')).toEqual([
      expect.objectContaining({ severity: 'warn', message: expect.stringContaining('Матвей') }),
    ]);
  });

  it('accepts a name recorded in bible/dossiers.md', () => {
    const result = run({
      files: [FRONT, chapter('Вечер', 'Потом вошёл Матвей и сел у окна.')],
      dossiers: { name: 'bible/dossiers.md', text: 'Имя: Матвей Кораблёв. Глава 5.' },
    });
    expect(rules(result)).not.toContain('F019');
  });

  it('stays quiet on an ordinary sentence-initial capital', () => {
    const result = run({ files: [FRONT, chapter('Снег', 'Снег лежал до утра. Потом стало тихо.')] });
    expect(rules(result)).not.toContain('F019');
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
    const result = run({ files: [{ name: '00-front.md', text: `Земля\n\n${'я'.repeat(200)}` }] });
    expect(withRule(result, 'F021')[0]?.message).toContain('expected 300–900');
  });

  it('rejects an annotation of 1 000 characters', () => {
    const result = run({ files: [{ name: '00-front.md', text: `Земля\n\n${'я'.repeat(1_000)}` }] });
    expect(withRule(result, 'F021')[0]?.message).toContain('1000 characters');
  });

  it('rejects a fifth annotation block', () => {
    const block = 'а'.repeat(100);
    const result = run({
      files: [{ name: '00-front.md', text: `Земля\n\n${[block, block, block, block, block].join('\n\n')}` }],
    });
    expect(withRule(result, 'F021')[0]?.message).toContain('5 blocks');
  });

  it('rejects markdown in the annotation', () => {
    const result = run({ files: [{ name: '00-front.md', text: `Земля\n\n${ABOUT}\n\n[ссылка](https://example.org)` }] });
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
    expect(withRule(run({ files: [FRONT, chapter('Половик:', 'Текст.')] }), 'F022')[0]?.message).toContain('colon');
    expect(withRule(run({ files: [FRONT, chapter('## Половик', 'Текст.')] }), 'F022')[0]?.message).toContain(
      'markdown',
    );
  });

  it('rejects a non-blank line 2', () => {
    const result = run({ files: [FRONT, { name: 'ch01.md', text: 'Половик\nПервый абзац без пустой строки.' }] });
    expect(withRule(result, 'F022')[0]?.message).toContain('line 2 must be blank');
  });

  it('accepts a title line and keeps the title out of chars', () => {
    const result = run({ files: [FRONT, chapter('Половик в тамбуре', 'а'.repeat(20_001))] });
    expect(result.chapters[0]).toMatchObject({ title: 'Половик в тамбуре', chars: 20_001 });
  });
});

describe('report shape', () => {
  it('sorts findings by file and line, counts severities and keeps titles', () => {
    const result = run({
      files: [
        FRONT,
        { name: 'ch05.md', text: 'Глава пять\n\nЦикл.' },
        { name: 'ch01.md', text: '' },
      ],
    });
    expect(result.errors).toBeGreaterThanOrEqual(2);
    const keys = result.findings.map((item) => `${item.file}:${item.line}`);
    expect([...keys].sort()).toEqual(keys);
    expect(result.chapters.map((item) => item.n)).toEqual([1, 5]);
    expect(result.chapters[1]?.title).toBe('Глава пять');
  });
});
