import { FAILED_ATTEMPT_LINE, type ChangeStepDto, type ChangeSummaryDto, type HistoryRecordDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { PREMISE_PENDING, STATE_WORDS, turnLine } from './marginalia.ts';
import {
  boundaryLabel,
  CAUSE_WORDS,
  changeHeading,
  changeLines,
  changeNumber,
  chapterRange,
  outcomeCopy,
  outcomeLine,
  premiseOutcomeCopy,
  progressLine,
  RECORD_NOT_LANDED,
  recordReason,
  recordStateWord,
  relevanceCopy,
  stampCopy,
  stepLabel,
  wingGlyph,
} from './changeStatus.ts';

function summary(overrides: Partial<ChangeSummaryDto> = {}): ChangeSummaryDto {
  return {
    premiseLanded: false,
    sourceCommentId: null,
    id: 'chg_1',
    seq: 4,
    chapter: 8,
    intent: 'в абзаце дважды «слово» — оставить одно',
    premise: false,
    status: 'done',
    frame: 'untouched',
    frameMode: null,
    outcome: 'applied',
    reason: null,
    position: null,
    enqueuedAt: '2026-10-25T12:00:00Z',
    decidedAt: '2026-10-25T12:05:00Z',
    chapters: [8, 7, 9],
    rewritten: [8, 7],
    steps: 3,
    modes: [],
    cascade: { id: 'csc_1', status: 'closed', outcome: 'consistent' },
    ...overrides,
  };
}

describe('the thread’s two lines', () => {
  it('separates the writer’s lane from the application', () => {
    const lines = changeLines(summary({ status: 'pending', position: 4, outcome: null, chapters: [8] }));
    // BOOK-218 — a change's turn, in the chapter's words: never a place in a queue.
    expect(lines).toMatchObject({ first: STATE_WORDS.reading, tone: 'waiting' });
    expect(lines.second).toBe(turnLine(4));
    // BOOK-218 line 6 — the sentence is the owner's, the count is a tail in words.
    expect(lines.second).toBe('правка ждёт своей минуты: впереди три');
    // The next one has nothing ahead: the tail is dropped, the reason stays.
    expect(changeLines(summary({ status: 'pending', position: 1 })).second).toBe('правка ждёт своей минуты');
    expect(changeLines(summary({ status: 'pending', position: null })).second).toBe('правка ждёт своей минуты');
  });

  it('says the chapter being written while processing', () => {
    // BOOK-218 line 7 — the summary carries no start moment, so the word stands alone here; the
    // full `ChangeDto` prints `главу пишут — начали в 12:10` (`changeVerdict`).
    expect(changeLines(summary({ status: 'processing', outcome: null }))).toMatchObject({
      first: 'идёт',
      second: 'главу пишут',
    });
  });

  it('says the basis moved when stale', () => {
    expect(changeLines(summary({ status: 'stale' }))).toMatchObject({
      first: 'ждёт',
      second: 'основа изменилась, решается заново',
    });
  });

  it('states the reach after application, never a percentage', () => {
    const lines = changeLines(summary());
    expect(lines).toMatchObject({ first: 'внесено', second: 'дошло до глав 7 и 9', tone: 'done' });
    expect(progressLine(summary())).toBe('принято → внесено → дошло до глав 7 и 9');
  });

  it('names a local edit as local', () => {
    const local = summary({ chapters: [8] });
    expect(changeLines(local).second).toBe('осталось в главе 8');
    expect(progressLine(local)).toBe('принято → внесено → осталось в главе 8');
  });

  it('says an adaptation was partial', () => {
    expect(changeLines(summary({ outcome: 'adapted' }))).toMatchObject({
      first: 'внесено',
      second: 'частично · дошло до глав 7 и 9',
    });
  });

  it('files a paperwork change as «рассмотрено», with the mode and no reach (BOOK-137)', () => {
    // `done` with `outcome: 'registered'`: the record exists, the sentence did not change. The
    // word is the state's own, never «внесено», and the line names the mode, not a ripple.
    const paperwork = summary({ outcome: 'registered', frame: 'touched', frameMode: 'оформление', steps: 0, chapters: [8], rewritten: [], cascade: null });
    expect(changeLines(paperwork)).toMatchObject({
      first: 'рассмотрено',
      second: 'оформление · фраза не изменилась',
      tone: 'done',
    });
    expect(progressLine(paperwork)).toBe('принято → рассмотрено');
    expect(stampCopy(paperwork)).toBe('рассмотрено');
    expect(outcomeCopy('registered')).toBe('рассмотрено');
    // BOOK-173 (merge note): the vocabulary register (BOOK-218) has no line for `ripple`/`no-op`
    // yet, so `outcomeCopy` falls through to the running word. The cards' own wording for the two
    // new outcomes is the register owner's to add — this file does not spell one of its own.
    expect(outcomeCopy('ripple')).toBe(STATE_WORDS.reading);
    expect(outcomeCopy('no-op')).toBe(STATE_WORDS.reading);
  });

  it('always states why a change was dropped', () => {
    const dropped = summary({ status: 'void', outcome: 'dropped', reason: 'в главе уже одно упоминание' });
    expect(changeLines(dropped)).toMatchObject({ first: 'ждёт', second: 'в главе уже одно упоминание', tone: 'quiet' });
    expect(progressLine(dropped)).toBe('принято → ждёт');
  });

  it('distinguishes a superseded change from a dropped one', () => {
    const superseded = summary({ status: 'void', outcome: 'superseded', reason: 'правка 9 переписала абзац' });
    expect(changeLines(superseded).first).toBe('ждёт');
    expect(changeLines(superseded).second).toBe('правка 9 переписала абзац');
    // Without a public reason the deck says what happened, never just the word.
    expect(changeLines({ ...superseded, reason: null }).second).toBe('перекрыто более поздней правкой');
    expect(changeLines(summary({ status: 'void', outcome: 'dropped', reason: null })).second).toBe('снято');
  });

  it('does not hide an escalation or a failure', () => {
    expect(changeLines(summary({ status: 'escalated', outcome: 'budget', reason: 'остановлено бюджетом' }))).toMatchObject({
      first: 'ждёт',
      second: 'остановлено бюджетом',
      tone: 'escalated',
    });
    expect(progressLine(summary({ status: 'escalated', outcome: 'budget' }))).toBe('принято → ждёт');
    expect(changeLines(summary({ status: 'failed', outcome: null }))).toMatchObject({
      first: 'ждёт',
      second: 'не удалось внести',
    });
  });
});

describe('BOOK-7 — a premise is not an edit', () => {
  it('says «ждёт» / «внесено» on the stamp, with the premise’s story on the second line', () => {
    const waiting = summary({ premise: true, status: 'pending', position: 4, outcome: null, chapters: [] });
    expect(stampCopy(waiting)).toBe('ждёт');
    expect(changeLines(waiting)).toEqual({
      first: 'ждёт',
      second: PREMISE_PENDING,
      tone: 'waiting',
    });
    expect(progressLine(waiting)).toBe('принято в основу → ждёт');

    const applied = summary({ premise: true, reason: 'вошло в первую редакцию главы 8', chapters: [8] });
    expect(stampCopy(applied)).toBe('внесено');
    expect(changeLines(applied)).toEqual({
      first: 'внесено',
      second: 'вошло в первую редакцию главы 8',
      tone: 'done',
    });
    expect(progressLine(applied)).toBe('принято в основу → внесено → вошло в первую редакцию');
  });

  it('names a superseded premise as the chapter already having one, with its reason', () => {
    const superseded = summary({ premise: true, status: 'void', outcome: 'superseded', reason: 'у главы уже есть замысел' });
    expect(stampCopy(superseded)).toBe('ждёт');
    expect(changeLines(superseded)).toEqual({
      first: 'ждёт',
      second: 'у главы уже есть замысел',
      tone: 'quiet',
    });
    expect(progressLine(superseded)).toBe('принято в основу → ждёт');
  });

  it('says «замысел не взят» on the line for a writer refusal, «ждёт» on the stamp', () => {
    const refused = summary({ premise: true, status: 'void', outcome: 'dropped', reason: 'не беру: не из этой сцены' });
    expect(stampCopy(refused)).toBe('ждёт');
    expect(changeLines(refused).first).toBe('ждёт');
    expect(premiseOutcomeCopy(refused)).toBe('замысел не взят');
  });

  it('heads the card as «замысел · глава N», never as an edit number', () => {
    expect(changeHeading({ seq: 14, chapter: 5, premise: true })).toBe('замысел · глава 5');
    expect(changeHeading({ seq: 14, chapter: 5 })).toBe('правка 014 · глава 5');
  });
});

describe('ranges and labels', () => {
  it('makes a reach readable without arithmetic', () => {
    expect(chapterRange([])).toBe('');
    expect(chapterRange([8])).toBe('8');
    expect(chapterRange([7, 8, 9])).toBe('7–9');
    expect(chapterRange([6, 9])).toBe('6 и 9');
    expect(chapterRange([9, 7, 9])).toBe('7 и 9');
  });

  it('numbers a change like the riband does', () => {
    expect(changeNumber(4)).toBe('004');
    expect(changeNumber(14)).toBe('014');
  });

  it('names a seam by the boundary it is', () => {
    expect(boundaryLabel(8)).toBe('7 | 8');
    expect(boundaryLabel('front')).toBe('обложка | 1');
    expect(boundaryLabel('ending')).toBe('42 | финал');
  });

  it('maps relevance and outcomes to honest copy', () => {
    expect(relevanceCopy('fresh')).toBe('основа та же');
    expect(relevanceCopy('partial')).toBe('основа изменилась частично');
    expect(relevanceCopy('unknown')).toBe('основа не проверена');
    expect(outcomeCopy('finding')).toBe('внесено · замечание сохранено');
    // BOOK-76/BOOK-218: a physics stop never says «внесено» — the claim did not enter the book,
    // and the line is our failure, never «нужно решение».
    expect(outcomeCopy('science')).toMatch(/^не дошло: /u);
    expect(outcomeCopy('science')).not.toContain('внесено');
    expect(outcomeCopy('dropped')).toBe('снято');
    // BOOK-218 line 13 — the day's printing money is gone, and it is not about this edit.
    expect(outcomeCopy('budget')).toBe(
      'на сегодня всё: деньги на печать кончились. это не про вашу правку — приходите завтра',
    );
    expect(outcomeCopy('budget')).not.toContain('бюджет');
    // BOOK-61: a Gate B stop is our failure too — the edit was not judged by the idea.
    expect(outcomeCopy('rights')).toMatch(/^не дошло: /u);
    expect(outcomeCopy('rights')).not.toContain('внесено');
  });

  it('prints the gate’s sentence once: a reason that opens with the outcome word is the line', () => {
    // Gate B: the fixed sentence already begins with «не принято», so the footer is one line.
    expect(
      outcomeLine({ premise: false, status: 'escalated', outcome: 'rights', reason: 'не принято: чужая цитата без источника' }),
    ).toEqual({ word: null, reason: 'не принято: чужая цитата без источника' });
    // Every other stop keeps both parts, exactly as before this pass.
    expect(
      outcomeLine({ premise: false, status: 'escalated', outcome: 'budget', reason: 'правка остановлена бюджетом — нужно решение' }),
    ).toEqual({
      word: 'на сегодня всё: деньги на печать кончились. это не про вашу правку — приходите завтра',
      reason: 'правка остановлена бюджетом — нужно решение',
    });
    // A stop with no reason says our failure's line — not a verdict about the idea.
    expect(outcomeLine({ premise: false, status: 'escalated', outcome: 'rights', reason: null }).word).toMatch(
      /^не дошло: /u,
    );
  });

  it('labels a step and its wing without naming a gate', () => {
    const step = (overrides: Partial<ChangeStepDto>): ChangeStepDto => ({
      seq: 2,
      wave: 1,
      wing: 'upward',
      chapter: 9,
      pass: 'cascade',
      boundary: 9,
      outcome: 'rewritten',
      revBefore: 1,
      revAfter: 2,
      seamsIn: [],
      seamsOut: [],
      charsDelta: 41,
      note: null,
      at: '2026-10-25T12:00:00Z',
      cycles: 2,
      findingSurvived: false,
      ...overrides,
    });
    expect(stepLabel(step({}))).toBe('глава 9 переписана');
    expect(stepLabel(step({ outcome: 'holds' }))).toBe('глава 9 проверена, правок нет');
    expect(stepLabel(step({ outcome: 'published_with_finding' }))).toBe('глава 9 переписана · замечание сохранено');
    expect(stepLabel(step({ pass: 'front', chapter: 'front', wing: null }))).toBe('обложка и страница 2');
    expect(wingGlyph(step({ wing: 'downward' }))).toBe('←');
    expect(wingGlyph(step({ wing: 'upward' }))).toBe('→');
    expect(wingGlyph(step({ wing: null }))).toBe('·');
    const raw = JSON.stringify([stepLabel(step({})), stepLabel(step({ outcome: 'holds' }))]);
    for (const forbidden of ['вердикт', 'редактор', 'консультант', 'findings']) expect(raw).not.toContain(forbidden);
  });

  it('stamps one of the three state words, not a phrase', () => {
    expect(stampCopy(summary({ status: 'pending', position: 2 }))).toBe('идёт');
    expect(stampCopy(summary({ status: 'processing' }))).toBe('идёт');
    expect(stampCopy(summary())).toBe('внесено');
    expect(stampCopy(summary({ outcome: 'adapted' }))).toBe('внесено');
    expect(stampCopy(summary({ status: 'void', outcome: 'dropped' }))).toBe('ждёт');
    expect(stampCopy(summary({ status: 'escalated', outcome: 'budget' }))).toBe('ждёт');
    expect(stampCopy(summary({ status: 'stale' }))).toBe('ждёт');
    expect(stampCopy(summary({ status: 'failed', outcome: null }))).toBe('ждёт');
  });
});

describe('BOOK-65 — one state word for one public record entry', () => {
  function record(
    overrides: Partial<Pick<HistoryRecordDto, 'status' | 'premise' | 'premiseLanded' | 'reason'>> = {},
  ) {
    return {
      status: 'done' as const,
      premise: false,
      premiseLanded: false,
      reason: null,
      ...overrides,
    } as Pick<HistoryRecordDto, 'status' | 'premise' | 'premiseLanded' | 'reason'>;
  }

  it('says «не внесено» for every change the book refused or stopped', () => {
    // One word, one fact: the book did not take this change. The queue's own vocabulary
    // («снято», «остановлено», «перекрыто») stays on the card and the thread.
    for (const status of ['void', 'escalated', 'failed'] as const) {
      expect(recordStateWord(record({ status })), status).toBe(RECORD_NOT_LANDED);
    }
    expect(RECORD_NOT_LANDED).toBe('не внесено');
  });

  it('says nothing about a landed change: the span is the fact', () => {
    expect(recordStateWord(record({ status: 'done' }))).toBeNull();
  });

  it('says nothing about a change still on its way, or a pass with no change row', () => {
    // A queue place belongs to the door; the chronicle prints the book, not the queue.
    for (const status of ['pending', 'processing', 'stale', null] as const) {
      expect(recordStateWord(record({ status })), String(status)).toBeNull();
    }
  });

  it('reads a premise by the chapter’s own text, never by its attempt', () => {
    // The prod shape: chapter 65 was written while the premise’s change ended `void`/`dropped`
    // with the sanitized failure line. The chapter is the landing, so the row says nothing
    // about the failed attempt.
    const prod = record({
      premise: true,
      premiseLanded: true,
      status: 'void',
      reason: FAILED_ATTEMPT_LINE,
    });
    expect(recordStateWord(prod)).toBeNull();
    expect(JSON.stringify(recordStateWord(prod))).not.toMatch(/не по форме|не внесено/u);
    // A premise whose slot is still empty has not landed, whatever it is doing.
    expect(recordStateWord(record({ premise: true, status: 'pending' }))).toBe('не внесено');
  });

  it('prints the reason only after a refusal or a stop', () => {
    expect(recordReason(record({ status: 'void', reason: 'текст успел измениться' }))).toBe(
      'текст успел измениться',
    );
    expect(recordReason(record({ status: 'escalated', reason: 'нужно решение автора' }))).toBe(
      'нужно решение автора',
    );
    expect(recordReason(record({ status: 'failed', reason: 'повторные обрывы' }))).toBe('повторные обрывы');
    // A reason is never appended to a change that is still on its way or already landed…
    expect(recordReason(record({ status: 'done', reason: 'не печатается' }))).toBeNull();
    expect(recordReason(record({ status: 'pending', reason: 'не печатается' }))).toBeNull();
    // …and an absent or empty reason prints nothing at all.
    expect(recordReason(record({ status: 'void', reason: null }))).toBeNull();
    expect(recordReason(record({ status: 'void', reason: '' }))).toBeNull();
  });
});

/**
 * The chapter's text is the landing. A premise whose chapter 65 exists reads
 * «внесено» with the edition it entered, and a failed attempt left behind on its change row
 * (a `void` with the sanitized failure line) is not the premise's story.
 */
describe('a landed premise on the change surfaces', () => {
  const failedAttemptLine = FAILED_ATTEMPT_LINE;
  const landed = summary({
    premise: true,
    premiseLanded: true,
    chapter: 65,
    status: 'void',
    outcome: 'dropped',
    reason: failedAttemptLine,
    chapters: [65],
  });

  it('reads as entered with the edition, not as a stale failure', () => {
    expect(stampCopy(landed)).toBe('внесено');
    expect(changeLines(landed)).toEqual({
      first: 'внесено',
      second: 'вошло в первую редакцию главы 65',
      tone: 'done',
    });
    expect(progressLine(landed)).toBe('принято в основу → внесено → вошло в первую редакцию');
    expect(premiseOutcomeCopy(landed)).toBe('замысел учтён');
    // The failure line of the old attempt is nowhere in the copy the reader sees.
    expect(JSON.stringify(changeLines(landed))).not.toMatch(/PROVIDER_SHAPE|ENGINE_TIMEOUT|не по форме/u);
    expect(changeLines(landed).second).not.toBe(failedAttemptLine);
  });

  it('never invents a landing for a premise whose chapter has no text', () => {
    const waiting = summary({ premise: true, premiseLanded: false, chapter: 65, status: 'pending', outcome: null });
    expect(changeLines(waiting)).toMatchObject({ first: 'ждёт', second: PREMISE_PENDING });
    expect(progressLine(waiting)).toBe('принято в основу → ждёт');
    expect(premiseOutcomeCopy(waiting)).toBe('в основе главы');
  });
});

describe('the record’s two cause words (owner, 2026-10-28)', () => {
  it('names a reader’s filing and a pass, and never prints the internal noun', () => {
    expect(CAUSE_WORDS.reader).toBe('правка читателя');
    expect(CAUSE_WORDS.pass).toBe('писалась');
    expect(JSON.stringify(CAUSE_WORDS)).not.toMatch(/проход/u);
  });
});
