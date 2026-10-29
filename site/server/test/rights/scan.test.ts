/**
 * Gate B's deterministic scan (BOOK-61, BOOK-DOC-42 §3).
 *
 * The scan answers one question — may this text lawfully be in the book? — with a rule id and
 * nothing a reader sees. Everything public comes from `rights/rules.ts`: one fixed Russian
 * sentence per id, printed by the engine, never authored by a model.
 *
 * No real slur and no borrowed passage is checked in: the stop-list rule is proven by a
 * `test:`-namespaced entry injected through the scan's dependency, and the quote rule by a
 * passage synthesised for this file. A real person is the one name the closed table already
 * carries, because STOP-PERSON is the rule that has to fire on a real filing.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isListRefusal, rightsRefusalLine, RIGHTS_COPY } from '../../src/rights/rules.ts';
import { QUOTE_MIN_CHARS, scanRights } from '../../src/rights/scan.ts';
import { STOP_LIST, STOP_RULES, type StopEntry } from '../../src/rights/stoplist.ts';

/** A passage long enough to be a paragraph of somebody's prose: 494 characters. */
const PASSAGE = Array.from({ length: 11 }, () => 'Смотритель принёс акт и положил его на стол.').join(' ');

/** The only way a test may name a stop-list hit: a private, `test:`-namespaced entry. */
const INJECTED: StopEntry = {
  id: 'test:slur',
  reason: 'injected for this test only',
  patterns: [/запрещённая-строка/u],
};

const SITE_ROOT = new URL('../../../', import.meta.url).pathname;

describe('Gate B — the stop list refuses, and says which entry', () => {
  it('matches a closed-table category and keeps the reason in the operator detail', () => {
    const scan = scanRights({ body: 'Он призывает к насилию над соседями и пишет об этом в акте.' });
    // The entry's own id is the rule (owner's ruling, 2026-10-29): the harm lock derives its case
    // from it, and a recipe, a child and an accusation must not all read as one generic id.
    expect(scan).toMatchObject({ verdict: 'refused', rule: 'STOP-EXTREMISM' });
    // The detail is operator-only: the reader is owed the fixed sentence, not the table.
    const detail = scan.verdict === 'refused' ? scan.detail : '';
    expect(detail).toContain('STOP-EXTREMISM');
    expect(detail).toContain('призывы к насилию');
    expect(rightsRefusalLine('RIGHTS-STOP')).toBe(RIGHTS_COPY.other);
    expect(isListRefusal('RIGHTS-STOP')).toBe(true);
  });

  it('accepts a `test:` entry injected through the dependency, and nothing else', () => {
    const scan = scanRights({ body: 'Тут стоит запрещённая-строка, и это не книга.' }, { stopList: [INJECTED] });
    expect(scan).toMatchObject({ verdict: 'refused', rule: 'RIGHTS-STOP', block: 1 });
    expect(scan.verdict === 'refused' ? scan.detail : '').toContain('test:slur');
    // The same text without the entry is not a finding: a test proves the rule, not a word.
    expect(scanRights({ body: 'Тут стоит запрещённая-строка, и это не книга.' })).toEqual({ verdict: 'clear' });
  });

  it('refuses an injected entry that is not namespaced `test:` — production cannot grow a list', () => {
    expect(() =>
      scanRights({ body: 'что угодно' }, { stopList: [{ id: 'STOP-PRIVATE', reason: '', patterns: [/угодно/u] }] }),
    ).toThrow(/test:/u);
  });

  it('declares the nine categories of the design, each with a recorded reason', () => {
    expect(STOP_LIST.map((entry) => entry.id)).toEqual([...STOP_RULES]);
    for (const entry of STOP_LIST) expect(entry.reason.length, entry.id).toBeGreaterThan(10);
  });

  it('refuses the recipe, not the noun: a document may mention a weapon', () => {
    // The canon's register is bureaucratic and full of weapons; a list that refuses the noun
    // refuses the book (the BOOK-43 M1 failure mode, one gate over).
    expect(scanRights({ body: 'В акте сказано, что оружие хранится в опечатанном сейфе.' })).toEqual({
      verdict: 'clear',
    });
    // The entry's own id is the rule, so the harm lock can say case 1 rather than «вне закона».
    expect(scanRights({ body: 'Он записал рецепт: метамфетамин и пропорции.' })).toMatchObject({
      verdict: 'refused',
      rule: 'STOP-DRUGS',
    });
  });
});

describe('Gate B — a real living person is a complete name', () => {
  it('refuses a public figure named in full, in the nominative and in a case form', () => {
    for (const body of [
      'Добавь в главу сцену, где Владимир Путин подписывает акт.',
      'Добавь в главу сцену с Владимиром Путиным у сейфа.',
      'Пусть Гарри Поттер зайдёт в тамбур и оставит расписку.',
    ]) {
      const scan = scanRights({ body });
      expect(scan, body).toMatchObject({ verdict: 'refused', rule: 'STOP-PERSON' });
      expect(scan.verdict === 'refused' ? scan.detail : '', body).toMatch(/«.+»/u);
    }
    expect(rightsRefusalLine('STOP-PERSON')).toBe(RIGHTS_COPY.person);
    expect(rightsRefusalLine('RIGHTS-PERSON')).toBe(RIGHTS_COPY.person);
    expect(isListRefusal('RIGHTS-PERSON')).toBe(true);
  });

  it('does not refuse a surname alone: a part of a name is not the name', () => {
    expect(scanRights({ body: 'Путин упомянут в акте как фамилия без имени.' })).toEqual({ verdict: 'clear' });
  });
});

describe('Gate B — the quote rule, N = 240', () => {
  it('refuses a long run in «ёлочки» with no source, and that refusal is releasable', () => {
    const scan = scanRights({ body: `«${PASSAGE}»` });
    expect(scan).toMatchObject({ verdict: 'refused', rule: 'RIGHTS-QUOTE', block: 1 });
    expect(scan.verdict === 'refused' ? scan.detail : '').toContain('with no named source');
    expect(rightsRefusalLine('RIGHTS-QUOTE')).toBe(RIGHTS_COPY.quote);
    // The one releasable refusal: a judgement about provenance, not a category of the law.
    expect(isListRefusal('RIGHTS-QUOTE')).toBe(false);
  });

  it('clears the same passage when the block names its source', () => {
    expect(scanRights({ body: `«${PASSAGE}» — Иван Бунин` })).toEqual({ verdict: 'clear' });
    expect(scanRights({ body: `источник: «${PASSAGE}»` })).toEqual({ verdict: 'clear' });
  });

  it('reads a `>` blockquote as one run', () => {
    expect(scanRights({ body: `> ${PASSAGE}` })).toMatchObject({ verdict: 'refused', rule: 'RIGHTS-QUOTE' });
  });

  it('leaves a short quotation alone — a term or a title is not a paragraph', () => {
    expect(scanRights({ body: 'В уставе написано: «инструкция по эксплуатации».' })).toEqual({ verdict: 'clear' });
  });
});

describe('Gate B — a flag asks for the gate and refuses nothing', () => {
  it('flags a `proposed` longer than the quote threshold', () => {
    const scan = scanRights({ body: 'Правка к абзацу.', proposed: PASSAGE });
    expect(scan).toMatchObject({ verdict: 'flag', rule: 'RIGHTS-FLAG' });
    expect(scan.verdict === 'flag' ? scan.detail : '').toContain('proposed');
  });

  it('flags a long run whose source is only half named', () => {
    const scan = scanRights({ body: `«${PASSAGE}» — из книги` });
    expect(scan).toMatchObject({ verdict: 'flag', rule: 'RIGHTS-FLAG' });
    expect(scan.verdict === 'flag' ? scan.detail : '').toContain('half named');
  });

  it('flags a shorter run too when its source is half named', () => {
    // Half of N is still longer than a term; a half-named source makes a model look, not a refusal.
    const run = PASSAGE.slice(0, 140);
    expect(run.length).toBeGreaterThan(QUOTE_MIN_CHARS / 2);
    expect(run.length).toBeLessThan(QUOTE_MIN_CHARS);
    expect(scanRights({ body: `«${run}» — из книги` })).toMatchObject({ verdict: 'flag', rule: 'RIGHTS-FLAG' });
    // The same short run with no source at all is below the threshold and stays clear.
    expect(scanRights({ body: `«${run}»` })).toEqual({ verdict: 'clear' });
  });

  it('flags a full name the book has never used, and clears one it has', () => {
    const body = 'В абзаце Анна Петровна ставит подпись и уходит.';
    expect(scanRights({ body })).toMatchObject({ verdict: 'flag', rule: 'RIGHTS-FLAG' });
    expect(scanRights({ body }, { knownNames: ['Анна Петровна вошла в комнату.'] })).toEqual({ verdict: 'clear' });
  });

  it('writes no rule that a verdict column could store', () => {
    // `RIGHTS-FLAG` is not a refusal id: `recordRights` would reject it, and the row stays null.
    expect(rightsRefusalLine('RIGHTS-FLAG')).toBeNull();
    expect(isListRefusal('RIGHTS-FLAG')).toBe(false);
  });
});

describe('Gate B — the scan is server-only', () => {
  it('is imported by neither the SPA nor `@book/shared`', () => {
    const offenders: string[] = [];
    for (const dir of [join(SITE_ROOT, 'web/src'), join(SITE_ROOT, 'shared/src')]) {
      for (const file of walk(dir)) {
        if (!/\.tsx?$/u.test(file)) continue;
        const source = readFileSync(file, 'utf8');
        if (/rights\/(scan|stoplist|rules|record|apply)/u.test(source)) {
          offenders.push(relative(SITE_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}
