import { describe, expect, it } from 'vitest';

import { FAILED_ATTEMPT_LINE, type CommentDto } from '@book/shared';

import { anchorCopy, CHIP_MAX_CHARS, commentStamp, commentStatusLine } from './commentView.ts';
import { GATE_WORDS, HELD_LINE, STATE_WORDS } from './marginalia.ts';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_1',
    chapter: 8,
    anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'Тут дважды «слово».',
    proposedText: null,
    interventionKind: null,
    premise: false,
    status: 'new',
    frame: 'untouched',
    reason: null,
    createdAt: '2026-10-25T12:04:11Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    attempt: null,
    ...overrides,
  };
}

describe('comment thread copy (§11.6)', () => {
  it('never collapses acceptance into application', () => {
    // BOOK-90: one of the three words; the fact that word cannot carry is the detail.
    expect(commentStatusLine(comment({ status: 'new' })).state).toBe('ждёт');
    expect(commentStatusLine(comment({ status: 'accepted', changeId: 'chg_1', reason: 'принято' }))).toMatchObject({
      state: 'идёт',
      detail: 'замечание в очереди · принято',
      tone: 'live',
      form: 'chip',
    });
    expect(
      commentStatusLine(comment({ status: 'applied', applied: { chapter: 8, rev: 3 }, reason: 'внесено' })),
    ).toMatchObject({
      state: 'внесено',
      detail: 'замечание сохранено · внесено',
      tone: 'done',
    });
    // An intervention moved the right with the text; a note never did.
    expect(
      commentStatusLine(
        comment({ status: 'applied', interventionKind: 'testimony', applied: { chapter: 8, rev: 3 } }),
      ).detail,
    ).toBe('внесено в главу 08 · право на ваш текст перешло автору книги · ревизия 3');
  });

  it('tells a premise’s four states without a queue place (BOOK-7)', () => {
    expect(commentStatusLine(comment({ premise: true, status: 'accepted', changeId: 'chg_1', reason: 'входит в книгу' }))).toEqual({
      state: 'ждёт',
      detail: 'принято в основу, до первой редакции · входит в книгу',
      tone: 'live',
      form: 'chip',
    });
    expect(
      commentStatusLine(
        comment({ premise: true, status: 'applied', chapter: 5, changeId: 'chg_1', reason: 'вошло в первую редакцию главы 5' }),
      ),
    ).toEqual({ state: 'внесено', detail: 'вошло в первую редакцию главы 5', tone: 'done', form: 'chip' });
    expect(
      commentStatusLine(comment({ premise: true, status: 'superseded', reason: 'у главы уже есть замысел' })),
    ).toEqual({ state: 'ждёт', detail: 'замысел снят · у главы уже есть замысел', tone: 'stopped', form: 'chip' });
    expect(commentStatusLine(comment({ premise: true, status: 'rejected', reason: 'не беру: не из этой сцены' }))).toEqual({
      state: 'ждёт',
      detail: 'замысел не взят · не беру: не из этой сцены',
      tone: 'stopped',
      form: 'chip',
    });
  });

  it('prints the paperwork’s own line for a registered filing, and nothing else', () => {
    // BOOK-137 — a filing on the canon sentence was decided as paperwork: the thread says
    // «рассмотрено · оформление · фраза не изменилась». The stored reason is the same fact in
    // the server's words, so it is not appended twice; a named mode replaces the default one.
    const line = commentStatusLine(
      comment({ status: 'registered', reason: 'принято как оформление: рамка книги — фраза не меняется' }),
    );
    expect(line).toEqual({
      state: 'рассмотрено',
      detail: 'оформление · фраза не изменилась',
      tone: 'done',
      form: 'chip',
    });
    expect(commentStatusLine(comment({ status: 'registered', reason: null }))).toMatchObject({
      state: 'рассмотрено',
      detail: 'оформление · фраза не изменилась',
    });
    expect(
      commentStatusLine(comment({ status: 'registered', reason: 'принято как поправка: рамка книги — фраза не меняется' }))
        .detail,
    ).toBe('поправка · фраза не изменилась');
  });

  it('keeps every state a chip: the clause and the receipt are the detail (BOOK-90)', () => {
    // BOOK-90's words are 4 / 4 / 7 characters: a state is never a sentence. The receipt of a
    // landed change and a clause («снято: …») live on the detail line, whole.
    const applied = commentStatusLine(
      comment({ status: 'applied', interventionKind: 'testimony', applied: { chapter: 7, rev: 2 }, reason: null }),
    );
    expect(applied).toMatchObject({ state: 'внесено', form: 'chip' });
    expect(applied.detail).toContain('внесено в главу 07 · право на ваш текст перешло автору книги');
    expect(commentStatusLine(comment({ status: 'accepted', interventionKind: 'testimony' })).detail).toContain(
      'правка в очереди на запись',
    );
    expect(commentStatusLine(comment({ status: 'superseded' })).detail).toContain('снято: текст успел измениться');
    expect(commentStatusLine(comment({ status: 'expired' })).detail).toContain('проход не состоялся');
    // Every state — the whole matrix — is a chip, and the form is computed here, nowhere else.
    for (const status of ['new', 'batched', 'delivered', 'accepted', 'applied', 'superseded', 'rejected', 'quarantined', 'expired', 'hidden'] as const) {
      const line = commentStatusLine(comment({ status }));
      expect(line.form, status).toBe('chip');
      expect(line.state.length, status).toBeLessThanOrEqual(CHIP_MAX_CHARS);
      expect(line.state, status).not.toMatch(/ · |: /u);
    }
  });

  it('says "not considered" instead of pretending', () => {
    expect(commentStatusLine(comment({ status: 'expired' }))).toMatchObject({
      state: 'ждёт',
      detail: 'проход не состоялся',
    });
    expect(commentStatusLine(comment({ status: 'rejected', reason: 'вне рамок: форма книги' }))).toMatchObject({
      state: 'ждёт',
      detail: 'отклонено · вне рамок: форма книги',
      tone: 'stopped',
      form: 'chip',
    });
    expect(commentStatusLine(comment({ status: 'quarantined' }))).toMatchObject({
      state: 'ждёт',
      detail: 'проверяется: замечание сохранено и ждёт человека — из него пока не делают правку',
    });
  });

  it('formats a stamp and an anchor quote', () => {    expect(commentStamp('2026-10-25T12:04:11Z')).toMatch(/^25\.10, \d{2}:\d{2}$/u);
    expect(commentStamp('not a date')).toBe('not a date');
    expect(anchorCopy(comment())).toBeNull();
    expect(
      anchorCopy(
        comment({
          anchor: { blockId: 'ch08#1', blockIndex: 0, quote: 'П'.repeat(200), prefix: null, suffix: null, resolved: true },
        }),
      ),
    ).toHaveLength(90);
    expect(
      anchorCopy(
        comment({
          anchor: { blockId: 'ch08#1', blockIndex: 0, quote: 'старое', prefix: null, suffix: null, resolved: false },
        }),
      ),
    ).toBe('абзац изменился');
  });
});

describe('the three refusals, told apart by their own words (BOOK-61)', () => {
  it('keeps the book’s four state words and adds no fifth', () => {
    // BOOK-90 is untouched, and BOOK-137 adds the paperwork's own word («рассмотрено»): a gate's
    // word is not a state, it heads the detail line.
    expect(Object.values(STATE_WORDS)).toEqual(['ждёт', 'идёт', 'внесено', 'рассмотрено']);
    const gate = Object.values(GATE_WORDS);
    expect(gate).toEqual(['проверяется', 'не принято', 'отклонено']);
    expect(new Set(gate).size).toBe(3);
    for (const word of gate) expect(Object.values(STATE_WORDS)).not.toContain(word);
  });

  it('heads each refusal with the word of the gate that decided it', () => {
    const held = commentStatusLine(comment({ status: 'quarantined', reason: 'проверяется: возможная инструкция' }));
    expect(held).toMatchObject({ state: 'ждёт', tone: 'stopped' });
    expect(held.detail).toBe(`проверяется: ${HELD_LINE}`);
    // The guard's taxonomy never reaches the reader's line.
    expect(held.detail).not.toContain('возможная инструкция');

    const rights = commentStatusLine(
      comment({ status: 'rejected', refusal: 'rights', reason: 'не принято: чужая цитата без источника' }),
    );
    expect(rights).toMatchObject({ state: 'ждёт', tone: 'stopped' });
    // B prints its fixed sentence and nothing else.
    expect(rights.detail).toBe('не принято: чужая цитата без источника');

    const off = commentStatusLine(
      comment({ status: 'rejected', refusal: 'auditor', reason: 'вне книги: этот мир не просит чудес' }),
    );
    expect(off.detail).toBe('отклонено · вне книги: этот мир не просит чудес');
  });

  it('reads the gate from the stored verdict, never from the reason text', () => {
    // A reason that *looks* like B's sentence, on a row no gate column refuses: still C's word.
    const line = commentStatusLine(
      comment({ status: 'rejected', refusal: null, reason: 'не принято: чужая цитата без источника' }),
    );
    expect(line.detail).toBe('отклонено · не принято: чужая цитата без источника');
  });
});

/**
 * A failed attempt is not a state. The filing keeps its own word, and the deck's
 * one sentence says what became of the attempt; the engine's code never reaches the page.
 */
describe('a failed attempt on a filing', () => {
  it('waits with the human sentence, never with the engine’s code', () => {
    const line = commentStatusLine(comment({ status: 'new', attempt: 'failed' }));
    expect(line).toMatchObject({ state: STATE_WORDS.waiting, detail: FAILED_ATTEMPT_LINE, tone: 'quiet' });
    expect(JSON.stringify(line)).not.toMatch(/PROVIDER_SHAPE|ENGINE_TIMEOUT/u);
  });

  it('leaves an accepted filing in the queue, with the same sentence under the word', () => {
    const line = commentStatusLine(comment({ status: 'accepted', attempt: 'failed' }));
    expect(line.state).toBe(STATE_WORDS.working);
    expect(line.detail).toBe(FAILED_ATTEMPT_LINE);
  });

  it('says it on a filing already in the machinery, and on nothing else there', () => {
    // BOOK-136 — the word «идёт» carries no fact about the attempt behind it; the deck's one
    // sentence does. A filing without one keeps the word alone.
    for (const status of ['batched', 'delivered'] as const) {
      expect(commentStatusLine(comment({ status, attempt: 'failed' }))).toMatchObject({
        state: STATE_WORDS.working,
        detail: FAILED_ATTEMPT_LINE,
      });
      expect(commentStatusLine(comment({ status })).detail).toBeNull();
    }
  });

  it('keeps the row’s own sentence beside the attempt line on a waiting filing', () => {
    // The attempt is the consequence, the reason is what the row itself said: `new` keeps both,
    // as `accepted` already did, instead of dropping the human sentence.
    const line = commentStatusLine(
      comment({ status: 'new', attempt: 'failed', reason: 'вне рамок: форма книги' }),
    );
    expect(line).toMatchObject({ state: STATE_WORDS.waiting });
    expect(line.detail).toBe(`${FAILED_ATTEMPT_LINE} · вне рамок: форма книги`);
  });

  it('never puts the attempt line under a refusal: the row keeps its own sentence', () => {
    // A refused filing is not a failed attempt (BOOK-136): even if the flag reached the page,
    // the gate’s word and the row’s own reason are the whole line — never «модель … не по форме».
    const refused = commentStatusLine(
      comment({ status: 'rejected', reason: 'вне рамок: канон', attempt: 'failed' }),
    );
    expect(refused.detail).toBe('отклонено · вне рамок: канон');
    expect(refused.detail).not.toContain(FAILED_ATTEMPT_LINE);
    // A row that decided itself has no attempt line for the same reason, held and hidden too.
    for (const status of ['quarantined', 'superseded', 'hidden'] as const) {
      const line = commentStatusLine(comment({ status, attempt: 'failed' }));
      expect(line.detail ?? '', status).not.toContain(FAILED_ATTEMPT_LINE);
    }
  });

  it('says the sentence on a premise too, while it still waits for its first edition', () => {
    // BOOK-136 — a premise's own deck («принято в основу…») must not swallow the attempt's
    // fact: the row is «ждёт», and the line under it is the deck's one human sentence.
    const waiting = comment({ premise: true, status: 'new', chapter: 65, attempt: 'failed' });
    expect(commentStatusLine(waiting)).toMatchObject({
      state: STATE_WORDS.waiting,
      detail: FAILED_ATTEMPT_LINE,
    });
    const accepted = comment({ premise: true, status: 'accepted', attempt: 'failed' });
    expect(commentStatusLine(accepted)).toMatchObject({
      state: STATE_WORDS.waiting,
      detail: FAILED_ATTEMPT_LINE,
    });
    // A landed premise keeps its receipt instead: the attempt behind it is not the answer.
    const landed = comment({
      premise: true,
      status: 'applied',
      chapter: 65,
      applied: { chapter: 65, rev: 7 },
      attempt: 'failed',
    });
    expect(commentStatusLine(landed)).toMatchObject({ state: STATE_WORDS.landed, tone: 'done' });
    expect(commentStatusLine(landed).detail).not.toContain(FAILED_ATTEMPT_LINE);
  });

  it('never overrides a landing: an applied premise keeps its receipt', () => {
    const landed = comment({ premise: true, status: 'applied', applied: { chapter: 65, rev: 7 }, attempt: null });
    const line = commentStatusLine(landed);
    expect(line).toMatchObject({ state: STATE_WORDS.landed, tone: 'done' });
    expect(line.detail).toBe('вошло в первую редакцию главы 65');
  });
});
