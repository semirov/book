import { describe, expect, it } from 'vitest';

import {
  createDraftStore,
  derivedBody,
  draftFilled,
  draftSummary,
  emptyDraft,
  anchoredPayload,
  firstSentenceOf,
  rekeyDraft,
  submissionBody,
  submitLabel,
} from './draft.ts';

describe('the derived body', () => {
  it('keeps what the reader wrote in «что это меняет»', () => {
    expect(derivedBody({ body: '  свет должен быть  ', proposed: 'Свет был включён до меня. Дальше тишина.', noteOnly: false })).toBe(
      'свет должен быть',
    );
  });

  it('falls back to the first sentence of the wording, as the form says it will', () => {
    expect(
      derivedBody({ body: '', proposed: 'Свет был включён до меня. Дальше тишина.', noteOnly: false }),
    ).toBe('Свет был включён до меня.');
  });

  it('never invents a body for a note', () => {
    expect(derivedBody({ body: '', proposed: 'Свет был включён до меня.', noteOnly: true })).toBe('');
    expect(firstSentenceOf('Пришли А. С. Пушкин и т. д. Потом все ушли.')).toBe('Пришли А. С. Пушкин и т. д.');
  });
});

describe('what is submitted (BOOK-33)', () => {
  const premise = { chapter: 9, blockId: null, sentence: '', baseRev: null, kind: null, noteOnly: false };

  it('sends a premise whole, never cut at its first full stop', () => {
    const two = 'В главе должен быть документ о переводе смены. Подпись — начальник смены.';
    expect(submissionBody({ ...premise, body: '', proposed: two })).toBe(two);
    // A premise has one field: the wording is the filing, and an empty wording falls back.
    expect(submissionBody({ ...premise, body: '', proposed: '  перевод смены  ' })).toBe('перевод смены');
    expect(submissionBody({ ...premise, body: 'перевод смены', proposed: '' })).toBe('перевод смены');
  });

  it('sends a note whole, and never resurrects the hidden intervention line', () => {
    const note = 'Тут повтор. И ещё один повтор.';
    expect(submissionBody({ blockId: 'ch08#aa11bb22', noteOnly: true, body: '', proposed: note })).toBe(note);
    // BOOK-57: «что это меняет» is not rendered on the note path, so a stale line in it is
    // not a fallback — a note with an empty field has nothing to send.
    expect(submissionBody({ blockId: 'ch08#aa11bb22', noteOnly: true, body: 'свет не от лампы', proposed: '' })).toBe('');
    expect(submissionBody({ blockId: 'ch08#aa11bb22', noteOnly: true, body: 'свет', proposed: '  повтор  ' })).toBe('повтор');
  });

  it('derives only an intervention’s body', () => {
    expect(
      submissionBody({ blockId: 'ch08#aa11bb22', noteOnly: false, body: '', proposed: 'Свет был включён. Дальше тишина.' }),
    ).toBe('Свет был включён.');
  });

  it('captures the revision the paragraph was rendered from', () => {
    expect(emptyDraft({ chapter: 8, blockId: 'ch08#aa11bb22', sentence: 'Я вошёл.', baseRev: 4 }).baseRev).toBe(4);
    expect(emptyDraft({ chapter: 9, blockId: null, sentence: '', baseRev: null }).baseRev).toBeNull();
  });
});

describe('a re-anchored draft (major 1)', () => {
  const draft = {
    chapter: 8,
    blockId: 'ch08#aa11bb22',
    baseRev: 3,
    blockIndex: 0,
    sentence: 'Её освещал яркий свет.',
    kind: 'testimony' as const,
    noteOnly: false,
    body: 'свет не от лампы',
    proposed: 'Свет был включён до меня.',
  };

  it('keeps what the reader wrote and takes the fresh block, sentence and revision', () => {
    const moved = rekeyDraft(draft, { blockId: 'ch08#cc33dd44', sentence: 'Её освещал ровный свет.', baseRev: 4 });
    expect(moved).toEqual({
      ...draft,
      blockId: 'ch08#cc33dd44',
      sentence: 'Её освещал ровный свет.',
      baseRev: 4,
    });
  });

  it('moves to the paragraph’s new position when the block was rewritten', () => {
    const moved = rekeyDraft(draft, { blockId: 'ch08#ee55ff66', sentence: 'Новый абзац.', baseRev: 5, blockIndex: 1 });
    expect(moved).toMatchObject({ blockId: 'ch08#ee55ff66', blockIndex: 1, baseRev: 5 });
    expect(anchoredPayload(moved, { body: 'x' })).toMatchObject({
      blockId: 'ch08#ee55ff66',
      baseRev: 5,
      quote: 'Новый абзац.',
    });
  });

  it('sends the fresh block and revision on the next attempt', () => {
    const moved = rekeyDraft(draft, { blockId: 'ch08#cc33dd44', sentence: 'Её освещал ровный свет.', baseRev: 4 });
    const payload = anchoredPayload(moved, { body: 'свет не от лампы' });
    expect(payload).toMatchObject({ blockId: 'ch08#cc33dd44', baseRev: 4, quote: 'Её освещал ровный свет.', chapter: 8 });
  });

  it('never invents an anchor for a premise', () => {
    const premise = { ...draft, blockId: null, baseRev: null, sentence: '' };
    expect(anchoredPayload(premise, { body: 'замысел' })).toMatchObject({
      blockId: null,
      baseRev: null,
      quote: null,
    });
  });
});

describe('the draft store', () => {
  it('keeps a draft by seam and reopens it', () => {
    const store = createDraftStore();
    const draft = { ...emptyDraft({ chapter: 8, blockId: 'ch08#aa11bb22', sentence: 'Её освещал яркий свет.', baseRev: 3 }), body: 'не от лампы' };
    expect(store.read('ch8:ch08#aa11bb22:1-25')).toBeNull();
    expect(store.read('never-kept')).toBeNull();
    store.keep('ch8:ch08#aa11bb22:1-25', draft);
    expect(store.read('ch8:ch08#aa11bb22:1-25')).toEqual(draft);
    expect(store.size()).toBe(1);
    store.drop('ch8:ch08#aa11bb22:1-25');
    expect(store.size()).toBe(0);
  });

  it('summarises only a draft that has something in it', () => {
    expect(draftSummary(emptyDraft({ chapter: 8, blockId: 'ch08#aa11bb22', sentence: 'Я вошёл.', baseRev: 3 }))).toBeNull();
    expect(draftSummary({ ...emptyDraft({ chapter: 8, blockId: 'ch08#aa11bb22', sentence: 'Я вошёл.', baseRev: 3 }), body: 'а'.repeat(43) })).toBe(
      'черновик · 43\u00a0знака',
    );
    expect(draftFilled({ body: '', proposed: '', noteOnly: false })).toBe(false);
    expect(draftFilled({ body: '', proposed: 'свет', noteOnly: false })).toBe(true);
  });
});

describe('the submit word', () => {
  it('names the action by what it is, not by a mode', () => {
    expect(submitLabel({ noteOnly: true, blockId: 'ch08#aa11bb22' })).toBe('оставить замечание');
    expect(submitLabel({ noteOnly: false, blockId: null })).toBe('заложить замысел');
    expect(submitLabel({ noteOnly: false, blockId: 'ch08#aa11bb22' })).toBe('передать');
  });
});
