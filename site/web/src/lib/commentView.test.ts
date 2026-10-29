import { describe, expect, it } from 'vitest';

import { FAILED_ATTEMPT_LINE, type CommentDto } from '@book/shared';

import { anchorCopy, CHIP_MAX_CHARS, commentStamp, commentStatusLine } from './commentView.ts';
import { DROPPED_LINES, GATE_WORDS, STATE_LINES, STATE_WORDS } from './marginalia.ts';

/** A filing; `changeStatus` is the DTO's own (`pending`/`processing`), never a terminal word. */
type LineOverrides = Partial<CommentDto>;

function comment(overrides: LineOverrides = {}): CommentDto {
  return {
    id: 'cmt_1',
    number: 1,
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
  } as CommentDto;
}

describe('comment thread copy (§11.6)', () => {
  it('never collapses acceptance into application', () => {
    // BOOK-90: one of the deck's words; the fact that word cannot carry is the detail.
    expect(commentStatusLine(comment({ status: 'new' })).state).toBe('ждёт');
    // BOOK-189, BOOK-218 — `accepted` is «принято» until the linked change says the machine is
    // writing; only `processing` makes it «пишется» with the chapter on the line.
    expect(commentStatusLine(comment({ status: 'accepted', changeId: 'chg_1', reason: 'принято' }))).toMatchObject({
      state: STATE_WORDS.accepted,
      detail: STATE_LINES.accepted,
      tone: 'live',
      // `правка ждёт своей минуты` is 24 characters and carries no clause: still a chip.
      form: 'chip',
    });
    expect(
      commentStatusLine(comment({ status: 'accepted', changeId: 'chg_1', changeStatus: 'pending' })),
    ).toMatchObject({ state: STATE_WORDS.accepted, detail: STATE_LINES.accepted });
    expect(
      commentStatusLine(comment({ status: 'accepted', changeId: 'chg_1', changeStatus: 'processing' })),
    ).toMatchObject({ state: STATE_WORDS.writing, detail: null, tone: 'live' });
    // BOOK-219 — the change the writer closed reaches the row through the server's `applied`
    // status and its receipt, never through a terminal `changeStatus` (the DTO cannot carry one).
    expect(
      commentStatusLine(comment({ status: 'applied', changeId: 'chg_1', applied: { chapter: 8, rev: 4 } })),
    ).toMatchObject({ state: 'внесено', detail: 'в главу 8. это четвёртая редакция', tone: 'done' });
    // BOOK-219 — a receipt on the row is the landing fact even ahead of the durable read.
    expect(
      commentStatusLine(comment({ status: 'accepted', changeId: 'chg_1', applied: { chapter: 8, rev: 4 } })),
    ).toMatchObject({ state: 'внесено', detail: 'в главу 8. это четвёртая редакция', tone: 'done' });
    // A landing whose receipt storage lost its row leaves the word alone, not an empty clause.
    expect(
      commentStatusLine(comment({ status: 'applied', interventionKind: 'testimony', changeId: 'chg_1' })),
    ).toMatchObject({ state: 'внесено', detail: null, tone: 'done' });
    // The owner's landed row: the sink word and its own fact — `внесено` · `в главу 8. это
    // третья редакция`. A stored reason on an applied row is not printed: the receipt is the fact.
    expect(
      commentStatusLine(comment({ status: 'applied', applied: { chapter: 8, rev: 3 }, reason: 'внесено' })),
    ).toMatchObject({
      state: 'внесено',
      detail: 'в главу 8. это третья редакция',
      tone: 'done',
    });
    // An intervention and a note are told apart by the state block, not by a second receipt.
    expect(
      commentStatusLine(
        comment({ status: 'applied', interventionKind: 'testimony', applied: { chapter: 8, rev: 3 } }),
      ).detail,
    ).toBe('в главу 8. это третья редакция');
  });

  it('tells a premise’s four states without a queue place (BOOK-7)', () => {
    expect(commentStatusLine(comment({ premise: true, status: 'accepted', changeId: 'chg_1', reason: 'входит в книгу' }))).toEqual({
      state: STATE_WORDS.accepted,
      detail: 'в основу · до первой редакции · входит в книгу',
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
    ).toEqual({ state: STATE_WORDS.dropped, detail: 'у главы уже есть замысел', tone: 'stopped', form: 'chip' });
    expect(commentStatusLine(comment({ premise: true, status: 'rejected', reason: 'не беру: не из этой сцены' }))).toEqual({
      state: STATE_WORDS.refused,
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
    // BOOK-90's words are short: a state is a chip. BOOK-218 line 10 puts the landing's own fact
    // — `в главу 7. это вторая редакция` — on the detail line, whole.
    const applied = commentStatusLine(
      comment({ status: 'applied', interventionKind: 'testimony', applied: { chapter: 7, rev: 2 }, reason: null }),
    );
    expect(applied).toMatchObject({ state: 'внесено', form: 'chip' });
    expect(applied.detail).toBe('в главу 7. это вторая редакция');
    expect(commentStatusLine(comment({ status: 'accepted', interventionKind: 'testimony' })).detail).toBe(
      STATE_LINES.accepted,
    );
    expect(commentStatusLine(comment({ status: 'superseded' })).detail).toContain(DROPPED_LINES.superseded);
    expect(commentStatusLine(comment({ status: 'expired' })).detail).toContain(DROPPED_LINES.expired);
    // Every state — the whole matrix — is a chip, computed here and nowhere else.
    for (const status of ['new', 'batched', 'delivered', 'accepted', 'applied', 'superseded', 'rejected', 'quarantined', 'expired', 'hidden'] as const) {
      const line = commentStatusLine(comment({ status }));
      expect(line.form, status).toBe('chip');
      expect(line.state.length, status).toBeLessThanOrEqual(CHIP_MAX_CHARS);
      expect(line.state, status).not.toMatch(/ · |: /u);
    }
  });

  it('says "not considered" instead of pretending', () => {
    expect(commentStatusLine(comment({ status: 'expired' }))).toMatchObject({
      state: STATE_WORDS.dropped,
      detail: DROPPED_LINES.expired,
    });
    // BOOK-189 — a refusal is a state of its own: the sink word `не принято` heads it, the
    // reason is the line, and nothing in it waits.
    expect(commentStatusLine(comment({ status: 'rejected', reason: 'вне рамок: форма книги' }))).toMatchObject({
      state: 'не принято',
      detail: 'вне рамок: форма книги',
      tone: 'stopped',
      form: 'chip',
    });
    // A refusal with no stored sentence still says «отклонено», and invents no second line.
    expect(commentStatusLine(comment({ status: 'rejected', reason: null }))).toMatchObject({
      state: 'не принято',
      detail: null,
      tone: 'stopped',
    });
    // BOOK-189 — a rights reason that is the gate's word alone is not printed again: the state
    // already says «не принято», and the row owes no second line.
    expect(
      commentStatusLine(comment({ status: 'rejected', refusal: 'rights', reason: 'не принято' })),
    ).toMatchObject({ state: 'не принято', detail: null, tone: 'stopped' });
    expect(commentStatusLine(comment({ status: 'quarantined' }))).toMatchObject({
      state: STATE_WORDS.held,
      detail: STATE_LINES.held,
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

describe('one applied, one pending, one refused filing (BOOK-189)', () => {
  // The owner's prod page: the writer said «пока нечего писать: заявок нет» while two filings
  // read «идёт · правка в очереди на запись · входит в книгу». One fixture, three rows, the
  // words the page owes: «внесено», «принято», «отклонено».
  const applied = comment({
    id: 'cmt_applied',
    number: 2,
    status: 'applied',
    interventionKind: 'testimony',
    changeId: 'chg_done',
    applied: { chapter: 8, rev: 4 },
    reason: null,
  });
  const pending = comment({
    id: 'cmt_pending',
    number: 3,
    status: 'accepted',
    interventionKind: 'testimony',
    changeId: 'chg_pending',
    changeStatus: 'pending',
    reason: 'входит в книгу',
    applied: null,
  });
  const refused = comment({
    id: 'cmt_refused',
    number: 4,
    status: 'rejected',
    refusal: 'auditor',
    reason: 'вне книги: этот мир не просит чудес',
  });

  it('prints the receipt, the queue place and the refusal, each once', () => {
    const landed = commentStatusLine(applied);
    expect(landed.state).toBe('внесено');
    expect(landed.detail).toBe('в главу 8. это четвёртая редакция');
    expect(landed.tone).toBe('done');
    // One «внесено» in the row: the sink word, never the receipt repeating it.
    expect(JSON.stringify(landed).split('внесено').length - 1).toBe(1);
    expect(JSON.stringify(landed)).not.toContain('право на ваш текст');

    const waiting = commentStatusLine(pending);
    expect(waiting.state).toBe(STATE_WORDS.accepted);
    expect(waiting.detail).toBe(STATE_LINES.accepted);

    const rejected = commentStatusLine(refused);
    // A refused filing is «отклонено»: the gate's word is the state, the reason is the line.
    expect(rejected.state).toBe('не принято');
    expect(rejected.detail).toBe('вне книги: этот мир не просит чудес');

    // A legacy landing with no receipt of its own: the word alone. Its stored acceptance
    // sentence («входит в книгу») is not a fact about a landing, and no empty clause is joined.
    const legacy = commentStatusLine(
      comment({ status: 'applied', applied: null, reason: 'входит в книгу', interventionKind: 'testimony' }),
    );
    expect(legacy.state).toBe('внесено');
    expect(legacy.detail).toBeNull();
    expect(JSON.stringify(legacy)).not.toContain('входит в книгу');
    expect(JSON.stringify(legacy)).not.toContain('  ');
  });

  it('never says «идёт» of a landed filing, nor «входит в книгу» of any of them', () => {
    for (const row of [applied, pending, refused]) {
      const line = commentStatusLine(row);
      expect(JSON.stringify(line)).not.toContain('входит в книгу');
    }
    expect(JSON.stringify(commentStatusLine(applied))).not.toContain('идёт');
    expect(JSON.stringify(commentStatusLine(applied))).not.toContain('правка в очереди');
    expect(JSON.stringify(commentStatusLine(pending))).not.toContain('идёт');
    // BOOK-189 — a filing with several changes is sent as `applied` (the landing wins over the
    // escalated attempt `change_id` pointed at), so the row owes the receipt, not a queue place.
    const many = comment({
      status: 'applied',
      interventionKind: 'testimony',
      changeId: 'chg_applied',
      applied: { chapter: 3, rev: 2 },
      reason: null,
      changeStatus: null,
      attempt: null,
    });
    const line = commentStatusLine(many);
    expect(line.state).toBe('внесено');
    expect(line.detail).toBe('в главу 3. это вторая редакция');
    expect(JSON.stringify(line)).not.toMatch(/идёт|правка в очереди|входит в книгу/u);
    // One «внесено» in the row: the state word, never a second one in the detail.
    expect(line.state.split('внесено').length - 1).toBe(1);
    expect(line.detail ?? '').not.toContain('внесено');
  });
});

describe('the three refusals, told apart by their own words (BOOK-61)', () => {
  it('keeps the book’s state words and adds no gate word to them', () => {
    // BOOK-90 is untouched, BOOK-137 added the paperwork's word («рассмотрено»), BOOK-189 the
    // refusal («отклонено»), BOOK-218 the states a row can end in («проверяется», «снято»,
    // «скрыто»); BOOK-206 removed the author's word — a legacy `escalated` row reads «ждёт».
    // The refusal word is also C's gate word — a refusal is one word the book already printed;
    // B's «не принято» and A's «проверяется» are not states, they qualify a wait.
    expect(Object.values(STATE_WORDS)).toEqual([
      'ждёт',
      'идёт',
      'принято',
      'главу пишут',
      'внесено',
      'рассмотрено',
      'проверяется',
      'не принято',
      'не дошло',
      'снято',
      'скрыто',
    ]);
    const gate = Object.values(GATE_WORDS);
    // BOOK-218 — two sinks, one word each: a refusal says `не принято` whichever door it came
    // through, and the sentence on the line is what separates the doors.
    expect(gate).toEqual(['проверяется', 'не принято', 'не принято']);
    expect(new Set(gate).size).toBe(2);
    expect(gate.filter((word) => !Object.values(STATE_WORDS).includes(word))).toEqual([]);
  });

  it('heads each refusal with the word of the gate that decided it', () => {
    const held = commentStatusLine(comment({ status: 'quarantined', reason: 'проверяется: возможная инструкция' }));
    expect(held).toMatchObject({ state: STATE_WORDS.held, tone: 'stopped' });
    expect(held.detail).toBe(STATE_LINES.held);
    // The guard's taxonomy never reaches the reader's line.
    expect(held.detail).not.toContain('возможная инструкция');

    const rights = commentStatusLine(
      comment({ status: 'rejected', refusal: 'rights', reason: 'не принято: чужая цитата без источника' }),
    );
    expect(rights).toMatchObject({ state: 'не принято', tone: 'stopped' });
    // B's word heads the row once; its sentence keeps standing after it, whole and unprefixed.
    expect(rights.detail).toBe('чужая цитата без источника');
    expect(JSON.stringify(rights).split('не принято')).toHaveLength(2);

    const off = commentStatusLine(
      comment({ status: 'rejected', refusal: 'auditor', reason: 'вне книги: этот мир не просит чудес' }),
    );
    expect(off).toMatchObject({ state: 'не принято', tone: 'stopped' });
    expect(off.detail).toBe('вне книги: этот мир не просит чудес');
  });

  it('prints a legacy escalated row as waiting, and never as the author’s turn (BOOK-206)', () => {
    const line = commentStatusLine(comment({ status: 'escalated', reason: 'можно ли оформить это бумагой?' }));
    expect(line).toMatchObject({ state: 'ждёт', tone: 'live', form: 'chip' });
    // The old question is not a line the reader is owed any more: the row claims nothing.
    expect(line.detail).toBeNull();
    expect(JSON.stringify(line)).not.toContain('автор');
  });

  it('reads the gate from the stored verdict, never from the reason text', () => {
    // A reason that *looks* like B's sentence, on a row no gate column refuses: still C's word.
    const line = commentStatusLine(
      comment({ status: 'rejected', refusal: null, reason: 'не принято: чужая цитата без источника' }),
    );
    expect(line.state).toBe('не принято');
    expect(line.detail).toBe('не принято: чужая цитата без источника');
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

  it('leaves an accepted filing waiting, with the same sentence under the word', () => {
    // BOOK-189, BOOK-218 — a failed attempt has no `changeStatus`, so the row is «принято» with
    // the chapter's turn, and the deck's one sentence says why nothing landed.
    const line = commentStatusLine(comment({ status: 'accepted', attempt: 'failed' }));
    expect(line.state).toBe(STATE_WORDS.accepted);
    expect(line.detail).toBe(FAILED_ATTEMPT_LINE);
  });

  it('says it on a filing already in the machinery, and on nothing else there', () => {
    // BOOK-136 — the word «идёт» carries no fact about the attempt behind it; the deck's one
    // sentence does. A filing without one keeps the word alone.
    for (const status of ['batched', 'delivered'] as const) {
      expect(commentStatusLine(comment({ status, attempt: 'failed' }))).toMatchObject({
        state: STATE_WORDS.reading,
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
    // the gate's word and the row's own reason are the whole line — never «модель … не по форме».
    const refused = commentStatusLine(
      comment({ status: 'rejected', reason: 'вне рамок: канон', attempt: 'failed' }),
    );
    expect(refused.state).toBe('не принято');
    expect(refused.detail).toBe('вне рамок: канон');
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
      state: STATE_WORDS.accepted,
      detail: FAILED_ATTEMPT_LINE,
    });
    const accepted = comment({ premise: true, status: 'accepted', attempt: 'failed' });
    expect(commentStatusLine(accepted)).toMatchObject({
      state: STATE_WORDS.accepted,
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
