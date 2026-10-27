import type { ChangeStepDto, ChangeSummaryDto, HistoryRecordDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  boundaryLabel,
  changeHeading,
  changeLines,
  changeNumber,
  chapterRange,
  outcomeCopy,
  outcomeLine,
  premiseOutcomeCopy,
  progressLine,
  recordReason,
  recordWord,
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
  it('separates the queue promise from the application', () => {
    const lines = changeLines(summary({ status: 'pending', position: 4, outcome: null, chapters: [8] }));
    expect(lines).toMatchObject({ first: 'идёт', tone: 'waiting' });
    expect(lines.second).toBe('4-я в очереди');
  });

  it('says the chapter being written while processing', () => {
    expect(changeLines(summary({ status: 'processing', outcome: null }))).toMatchObject({
      first: 'идёт',
      second: 'пишется глава 8',
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
      second: 'принято в основу, до первой редакции',
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
    expect(boundaryLabel('ending')).toBe('67 | финал');
  });

  it('maps relevance and outcomes to honest copy', () => {
    expect(relevanceCopy('fresh')).toBe('основа та же');
    expect(relevanceCopy('partial')).toBe('основа изменилась частично');
    expect(relevanceCopy('unknown')).toBe('основа не проверена');
    expect(outcomeCopy('finding')).toBe('внесено · замечание сохранено');
    // BOOK-76: a physics stop never says «внесено» — the claim did not enter the book.
    expect(outcomeCopy('science')).toBe('остановлено: физика не подтверждена');
    expect(outcomeCopy('science')).not.toContain('внесено');
    expect(outcomeCopy('dropped')).toBe('снято');
    // BOOK-59: stopping at the wave bound asks for a decision; the word names no money.
    expect(outcomeCopy('budget')).toBe('остановлено: дальше — решением владельца');
    expect(outcomeCopy('budget')).not.toContain('бюджет');
    // BOOK-61: Gate B's one word — never «внесено», never the auditor's word.
    expect(outcomeCopy('rights')).toBe('не принято');
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
    ).toEqual({ word: 'остановлено: дальше — решением владельца', reason: 'правка остановлена бюджетом — нужно решение' });
    // A stop with no reason still says its word.
    expect(outcomeLine({ premise: false, status: 'escalated', outcome: 'rights', reason: null })).toEqual({
      word: 'не принято',
      reason: null,
    });
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

describe('BOOK-65 — one outcome word for one public record entry', () => {
  function record(
    overrides: Partial<Pick<HistoryRecordDto, 'status' | 'outcome' | 'premise' | 'premiseLanded' | 'reason'>> = {},
  ) {
    return {
      status: 'done',
      outcome: 'applied',
      premise: false,
      premiseLanded: false,
      reason: null,
      ...overrides,
    } as Pick<HistoryRecordDto, 'status' | 'outcome' | 'premise' | 'premiseLanded' | 'reason'>;
  }

  it('uses exactly the three public state words, agreeing with the card', () => {
    // A queue place is «идёт» on the card's stamp (`changeState`), so it is «идёт» here too;
    // `stale` is a re-decision, which waits. The two surfaces share one mapping (BOOK-65 M1).
    expect(recordWord(record({ status: 'pending', outcome: null }))).toBe('идёт');
    expect(recordWord(record({ status: 'processing', outcome: null }))).toBe('идёт');
    expect(recordWord(record({ status: 'stale', outcome: null }))).toBe('ждёт');
    expect(recordWord(record({ status: 'done' }))).toBe('внесено');
    expect(recordWord(record({ status: 'done', outcome: 'adapted' }))).toBe('внесено');
  });

  it('gives a refused or stopped change one word from the existing vocabulary', () => {
    expect(recordWord(record({ status: 'void', outcome: 'dropped' }))).toBe('снято');
    expect(recordWord(record({ status: 'void', outcome: 'superseded' }))).toBe('перекрыто');
    for (const status of ['escalated', 'failed'] as const) {
      expect(recordWord(record({ status, outcome: 'budget' }))).toBe('остановлено');
    }
  });

  it('speaks of a premise in its own gender and never as «внесено»', () => {
    expect(recordWord(record({ premise: true, status: 'done' }))).toBe('учтён');
    expect(recordWord(record({ premise: true, status: 'void', outcome: 'superseded' }))).toBe('снят');
    expect(recordWord(record({ premise: true, status: 'pending', outcome: null }))).toBe('ждёт');
    expect(recordWord(record({ premise: true, status: 'processing', outcome: null }))).toBe('ждёт');
  });

  it('prints the reason only after a refused or stopped word', () => {
    expect(recordReason(record({ status: 'void', outcome: 'dropped', reason: 'текст успел измениться' }))).toBe(
      'текст успел измениться',
    );
    expect(recordReason(record({ status: 'escalated', outcome: 'origin', reason: 'нужно решение автора' }))).toBe(
      'нужно решение автора',
    );
    expect(recordReason(record({ status: 'failed', outcome: null, reason: 'повторные обрывы' }))).toBe('повторные обрывы');
    // A reason is never appended to a change that is still on its way or already landed…
    expect(recordReason(record({ status: 'done', reason: 'не печатается' }))).toBeNull();
    expect(recordReason(record({ status: 'pending', reason: 'не печатается' }))).toBeNull();
    // …and an absent or empty reason prints nothing at all.
    expect(recordReason(record({ status: 'void', outcome: 'dropped', reason: null }))).toBeNull();
    expect(recordReason(record({ status: 'void', outcome: 'dropped', reason: '' }))).toBeNull();
  });

  it('reads the prod shape as «учтён»: a landed premise is not its failed attempt', () => {
    // The prod shape: chapter 65 was written, the premise’s change ended `void`/`dropped` with
    // the sanitized failure line, and the row said «замысел … снят». The chapter’s text is the
    // landing (`premiseLanded`), so the word is the premise’s own and the attempt is stale news.
    const prod = record({
      premise: true,
      premiseLanded: true,
      status: 'void',
      outcome: 'dropped',
      reason: 'модель ответила не по форме — заявка остаётся в очереди',
    });
    expect(recordWord(prod)).toBe('учтён');
    expect(recordReason(prod)).toBeNull();
    expect(JSON.stringify([recordWord(prod), recordReason(prod)])).not.toMatch(/не по форме|снят/u);
  });
});

/**
 * The chapter's text is the landing. A premise whose chapter 65 exists reads
 * «внесено» with the edition it entered, and a failed attempt left behind on its change row
 * (a `void` with the sanitized failure line) is not the premise's story.
 */
describe('a landed premise on the change surfaces', () => {
  const failedAttemptLine = 'модель ответила не по форме — заявка остаётся в очереди';
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
    expect(changeLines(waiting)).toMatchObject({ first: 'ждёт', second: 'принято в основу, до первой редакции' });
    expect(progressLine(waiting)).toBe('принято в основу → ждёт');
    expect(premiseOutcomeCopy(waiting)).toBe('в основе главы');
  });
});
