import { describe, expect, it } from 'vitest';

import type { CastAllowlist, ValidateOptions } from '../../src/validate/index.ts';
import { runValidation } from '../../src/validate/index.ts';

const allowlist: CastAllowlist = {
  cast: ['Зоя', 'Прокопьевна', 'Мельникова', 'Инна', 'Аркадьевна', 'Нестерова'],
  places: ['посёлок', 'ФАП'],
  manual: ['ЖКХ', 'МТС'],
};

/** A chapter body long enough to pass F007 without a warning. */
function prose(paragraphs: string[]): string {
  const filler =
    'Он стоял у окна и смотрел, как по стеклу идёт вода: капля доходила до рамы и поворачивала вбок. ' +
    'За окном был пустой двор, доска на двух кирпичах и след от колеса, оставшийся с ночи. ' +
    'В коридоре горела лампа, и её свет лежал на полу полосой, ровной, как по линейке. ';
  const blocks = [...paragraphs];
  while (blocks.join('\n\n').length < 6500) blocks.push(filler.repeat(2));
  return blocks.join('\n\n');
}

function run(overrides: Partial<ValidateOptions> = {}) {
  return runValidation({
    files: [],
    allowlist,
    ...overrides,
  });
}

const rules = (result: ReturnType<typeof run>) => result.findings.map((item) => item.rule);

describe('empty manuscript', () => {
  it('is clean and reports no chapters', () => {
    const result = run();
    expect(result.findings).toEqual([]);
    expect(result.chapters).toEqual([]);
    expect(result.totalChapters).toBe(67);
  });

  it('allows manuscript/PLAN.md', () => {
    const result = run({ files: [{ name: 'PLAN.md', text: '# План 67 глав (строго)' }] });
    expect(rules(result)).not.toContain('F002');
  });
});

describe('F001 — chapter file naming', () => {
  it('rejects a chapter file that is not chNN.md', () => {
    const result = run({ files: [{ name: 'ch1.md', text: prose([]) }] });
    expect(result.findings[0]).toMatchObject({ rule: 'F001', severity: 'error', file: 'ch1.md' });
  });
});

describe('F002 — stray files, range, duplicates', () => {
  it('rejects an extra .md file', () => {
    const result = run({ files: [{ name: 'notes.md', text: 'x' }] });
    expect(result.findings).toEqual([
      expect.objectContaining({ rule: 'F002', severity: 'error', file: 'notes.md' }),
    ]);
  });

  it('rejects a chapter above 67', () => {
    const result = run({ files: [{ name: 'ch68.md', text: prose([]) }] });
    expect(rules(result)).toContain('F002');
    expect(result.chapters).toHaveLength(0);
  });

  it('rejects the same chapter twice in different case', () => {
    const result = run({
      files: [
        { name: 'ch01.md', text: prose([]) },
        { name: 'Ch01.md', text: prose([]) },
      ],
    });
    expect(result.findings.some((item) => item.rule === 'F002' && item.file === 'Ch01.md')).toBe(true);
  });
});

describe('F003 — forbidden vocabulary', () => {
  it('flags VOICE taboos with a line number', () => {
    const result = run({ files: [{ name: 'ch05.md', text: prose(['Начался цикл, потом прогон.']) }] });
    const found = result.findings.filter((item) => item.rule === 'F003');
    expect(found.map((item) => item.message)).toEqual([
      'forbidden word: «цикл»',
      'forbidden word: «прогон»',
    ]);
    expect(found[0]?.line).toBe(1);
  });

  it('does not flag a word that merely starts with a taboo word', () => {
    const result = run({ files: [{ name: 'ch05.md', text: prose(['Двор был богатый, крыша — худая.']) }] });
    expect(rules(result)).not.toContain('F003');
  });
});

describe('F004 — «Рука пошла и не дошла»', () => {
  const phrase = 'Рука пошла и не дошла.';

  it('is silent when absent', () => {
    const result = run({ files: [{ name: 'ch05.md', text: prose([]) }] });
    expect(rules(result)).not.toContain('F004');
  });

  it('allows exactly one occurrence in an engineer-line chapter', () => {
    const result = run({ files: [{ name: 'ch23.md', text: prose([phrase]) }] });
    expect(rules(result)).not.toContain('F004');
  });

  it('rejects one occurrence in a chapter of another line', () => {
    const result = run({ files: [{ name: 'ch05.md', text: prose([phrase]) }] });
    expect(result.findings.filter((item) => item.rule === 'F004')).toHaveLength(1);
  });

  it('rejects two occurrences anywhere', () => {
    const result = run({
      files: [
        { name: 'ch23.md', text: prose([phrase]) },
        { name: 'ch27.md', text: prose([phrase]) },
      ],
    });
    expect(result.findings.filter((item) => item.rule === 'F004')).toHaveLength(2);
  });
});

describe('F005 — the finite cast', () => {
  it('accepts allowlisted names in any case form', () => {
    const text = prose(['Инна Аркадьевна пришла к Зое Прокопьевне. У Мельниковых закрыта калитка.']);
    const result = run({ files: [{ name: 'ch05.md', text }] });
    expect(rules(result)).not.toContain('F005');
  });

  it('rejects an unknown name in the middle of a sentence', () => {
    const text = prose(['Инна пришла. Потом вошёл Матвей и сел у окна.']);
    const found = run({ files: [{ name: 'ch05.md', text }] }).findings.filter((item) => item.rule === 'F005');
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('Матвей');
  });

  it('rejects an unknown name at the start of a sentence', () => {
    const text = prose(['Матвей Кораблёв вошёл и сел у окна.']);
    const found = run({ files: [{ name: 'ch05.md', text }] }).findings.filter((item) => item.rule === 'F005');
    expect(found.map((item) => item.message)).toEqual([
      expect.stringContaining('Матвей'),
      expect.stringContaining('Кораблёв'),
    ]);
  });

  it('accepts an abbreviation from the manual list', () => {
    const result = run({ files: [{ name: 'ch05.md', text: prose(['Пришла бумага из ЖКХ.']) }] });
    expect(rules(result)).not.toContain('F005');
  });

  it('accepts a name passed with --allow-new-name for this run', () => {
    const text = prose(['Потом вошёл Матвей и сел у окна.']);
    const result = run({ files: [{ name: 'ch05.md', text }], allowNewNames: ['Матвей'] });
    expect(rules(result)).not.toContain('F005');
  });
});

describe('F006 — 67 chapters', () => {
  it('rejects a plan that asserts another total', () => {
    const result = run({
      planning: [{ name: 'manuscript/PLAN.md', text: '# План 66 глав (строго)' }],
    });
    expect(result.findings[0]).toMatchObject({ rule: 'F006', severity: 'error' });
  });

  it('accepts the real plan shape', () => {
    const plan = [
      '# План 67 глав (строго)',
      '',
      '| 44 главы = 4 линии × 11 |',
      '',
      'Чередование строгое: 4 → 5 → 6 → 7.',
    ].join('\n');
    expect(rules(run({ planning: [{ name: 'manuscript/PLAN.md', text: plan }] }))).not.toContain('F006');
  });
});

describe('F007 — chapter length', () => {
  it('rejects a chapter below the hard minimum', () => {
    const result = run({ files: [{ name: 'ch05.md', text: 'Короткая глава.' }] });
    expect(result.findings[0]).toMatchObject({ rule: 'F007', severity: 'error' });
  });

  it('warns outside the soft band', () => {
    const text = 'а'.repeat(5000);
    const result = run({ files: [{ name: 'ch05.md', text }] });
    expect(result.findings[0]).toMatchObject({ rule: 'F007', severity: 'warn' });
  });

  it('rejects a chapter above the hard maximum', () => {
    const result = run({ files: [{ name: 'ch05.md', text: 'а'.repeat(16000) }] });
    expect(result.findings[0]).toMatchObject({ rule: 'F007', severity: 'error' });
  });
});

describe('F008 — process vocabulary', () => {
  it('reports PASS and reweiter without repeating F003 words', () => {
    const text = prose(['Пошёл PASS, потом reweiter и цикл.']);
    const found = run({ files: [{ name: 'ch05.md', text }] }).findings.filter((item) => item.rule === 'F008');
    expect(found.map((item) => item.message)).toEqual([
      'process vocabulary in prose: «PASS»',
      'process vocabulary in prose: «reweiter»',
    ]);
  });
});

describe('F009 — markdown in prose', () => {
  it('warns about a heading and a link', () => {
    const result = run({
      files: [
        {
          name: 'ch05.md',
          text: prose(['## Вторник', 'Текст с [ссылкой](https://example.org) внутри.']),
        },
      ],
    });
    const found = result.findings.filter((item) => item.rule === 'F009');
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe('warn');
  });
});

describe('report shape', () => {
  it('sorts findings by file and line and counts severities', () => {
    const result = run({
      files: [
        { name: 'ch05.md', text: prose(['Цикл.']) },
        { name: 'ch01.md', text: 'коротко' },
      ],
    });
    expect(result.errors).toBeGreaterThanOrEqual(2);
    const keys = result.findings.map((item) => `${item.file}:${item.line}`);
    expect([...keys].sort()).toEqual(keys);
    expect(result.chapters.map((chapter) => chapter.n)).toEqual([1, 5]);
  });
});
