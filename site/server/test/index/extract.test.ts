import { describe, expect, it } from 'vitest';

import { indexChapterText } from '../../src/index/build.ts';
import { extractChapter, splitSentences } from '../../src/index/extract.ts';

const PARAGRAPHS = [
  'Инженер Ковалёв вошёл в комнату.',
  'Приказ № 4 выдан утром. Ковалёв обещал вернуться через два дня.',
  'В 1987 году приказ № 4 отозван. Мастер молчал.',
  'мастер не вернулся.',
];

const chapter = extractChapter({ n: 12, written: true, sha256: 'text-hash', paragraphs: PARAGRAPHS });

describe('the derived index reads one chapter (BOOK-18 §1)', () => {
  it('records entities as found, with a person named by a title and an ambiguous common noun', () => {
    const kovalev = chapter.entities.find((entity) => entity.key === 'ковалев');
    expect(kovalev).toMatchObject({ kind: 'person', surfaces: ['Ковалёв'], ambiguous: false });
    expect(kovalev?.mentions).toEqual([
      { paragraph: 0, surface: 'Ковалёв' },
      { paragraph: 1, surface: 'Ковалёв' },
    ]);
    // «Мастер» capitalised in one paragraph, lowercase in the next: doubt is recorded…
    expect(chapter.entities.find((entity) => entity.key === 'мастер')).toMatchObject({ ambiguous: true });
    // …and an ambiguous entity is not an error: extraction returns a plain value.
    expect(chapter.entities.map((entity) => entity.key)).toEqual(['ковалев', 'мастер', 'приказ']);
    expect(chapter.entities.map((entity) => entity.key)).toEqual(
      [...chapter.entities.map((entity) => entity.key)].sort(),
    );
  });

  it('records a stated promise with its marker and a bounded sentence', () => {
    expect(chapter.promises).toEqual([
      { paragraph: 1, marker: 'обещал', text: 'Ковалёв обещал вернуться через два дня.' },
    ]);
  });

  it('records time markers by kind, in reading order', () => {
    expect(chapter.timeMarkers).toEqual([
      { paragraph: 1, kind: 'daypart', text: 'утром' },
      { paragraph: 1, kind: 'relative', text: 'через два дня' },
      { paragraph: 2, kind: 'year', text: '1987' },
    ]);
  });

  it('records a document with its status, where it acted, and the status that stands', () => {
    expect(chapter.documents).toEqual([
      { document: 'приказ № 4', surface: 'Приказ № 4', status: 'annulled', paragraphs: [1, 2] },
    ]);
  });

  it('is deterministic: the same paragraphs give the same value', () => {
    const again = extractChapter({ n: 12, written: true, sha256: 'text-hash', paragraphs: PARAGRAPHS });
    expect(again).toEqual(chapter);
    expect(JSON.stringify(again)).toBe(JSON.stringify(chapter));
  });

  it('splits sentences without losing the text', () => {
    expect(splitSentences('Первое. Второе! Третье?')).toEqual(['Первое.', 'Второе!', 'Третье?']);
  });

  it('does not index a slot that holds only its basis sentence (BOOK-6)', () => {
    const basis = indexChapterText(1, 'Я вошёл в пустую комнату. Её освещал яркий свет.');
    expect(basis).toMatchObject({ n: 1, written: false, entities: [], promises: [], documents: [] });
    expect(indexChapterText(2, '')).toMatchObject({ n: 2, written: false, timeMarkers: [] });
  });

  it('reads the four document statuses by their own verbs', () => {
    const statuses = extractChapter({
      n: 9,
      written: true,
      sha256: 'hash',
      paragraphs: [
        'Справка выдана в кассе.',
        'Приказ отозван.',
        'Протокол изменён.',
        'Удостоверение зачитано вслух.',
      ],
    }).documents;
    expect(statuses.map((entry) => [entry.document, entry.status])).toEqual([
      ['приказ', 'annulled'],
      ['протокол', 'amended'],
      ['справка', 'issued'],
      ['удостоверение', 'quoted'],
    ]);
  });

  it('keeps a document that is quoted under its name', () => {
    const quoted = extractChapter({
      n: 9,
      written: true,
      sha256: 'hash',
      paragraphs: ['Постановление «О порядке» зачитано в зале.'],
    }).documents;
    expect(quoted).toEqual([
      { document: 'постановление о порядке', surface: 'Постановление «О порядке»', status: 'quoted', paragraphs: [0] },
    ]);
  });
});
