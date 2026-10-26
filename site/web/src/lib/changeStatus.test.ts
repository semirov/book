import type { ChangeStepDto, ChangeSummaryDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  boundaryLabel,
  changeLines,
  changeNumber,
  chapterRange,
  outcomeCopy,
  progressLine,
  relevanceCopy,
  stampCopy,
  stepLabel,
  wingGlyph,
} from './changeStatus.ts';

function summary(overrides: Partial<ChangeSummaryDto> = {}): ChangeSummaryDto {
  return {
    id: 'chg_1',
    seq: 4,
    chapter: 8,
    intent: 'в абзаце дважды «слово» — оставить одно',
    status: 'done',
    outcome: 'applied',
    reason: null,
    position: null,
    enqueuedAt: '2026-10-25T12:00:00Z',
    decidedAt: '2026-10-25T12:05:00Z',
    chapters: [8, 7, 9],
    cascade: { id: 'csc_1', status: 'closed', outcome: 'consistent' },
    ...overrides,
  };
}

describe('the thread’s two lines', () => {
  it('separates the queue promise from the application', () => {
    const lines = changeLines(summary({ status: 'pending', position: 4, outcome: null, chapters: [8] }));
    expect(lines).toMatchObject({ first: 'принято · 4-я в очереди', tone: 'waiting' });
    expect(lines.second).toBe('правки идут по одной, в порядке записи');
  });

  it('says the chapter being written while processing', () => {
    expect(changeLines(summary({ status: 'processing', outcome: null }))).toMatchObject({
      first: 'принято · правится',
      second: 'глава 8',
    });
  });

  it('says the basis moved when stale', () => {
    expect(changeLines(summary({ status: 'stale' }))).toMatchObject({
      first: 'принято · основа изменилась',
      second: 'решается, применять ли правку',
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
      first: 'внесено частично',
      second: 'основа изменилась · дошло до глав 7 и 9',
    });
  });

  it('always states why a change was dropped', () => {
    const dropped = summary({ status: 'void', outcome: 'dropped', reason: 'в главе уже одно упоминание' });
    expect(changeLines(dropped)).toMatchObject({ first: 'снято', second: 'в главе уже одно упоминание', tone: 'quiet' });
    expect(progressLine(dropped)).toBe('принято → снято');
  });

  it('distinguishes a superseded change from a dropped one', () => {
    const superseded = summary({ status: 'void', outcome: 'superseded', reason: 'правка 9 переписала абзац' });
    expect(changeLines(superseded).first).toBe('перекрыто более поздней правкой');
    expect(changeLines(superseded).second).toBe('правка 9 переписала абзац');
  });

  it('does not hide an escalation or a failure', () => {
    expect(changeLines(summary({ status: 'escalated', outcome: 'budget', reason: 'остановлено бюджетом' }))).toMatchObject({
      first: 'принято · ждёт решения автора',
      second: 'остановлено бюджетом',
      tone: 'escalated',
    });
    expect(progressLine(summary({ status: 'escalated', outcome: 'budget' }))).toBe('принято → ждёт решения автора');
    expect(changeLines(summary({ status: 'failed', outcome: null }))).toMatchObject({
      first: 'не удалось внести',
      second: 'замечание сохранено',
    });
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
    expect(outcomeCopy('dropped')).toBe('снято');
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

  it('stamps the state, not the promise', () => {
    expect(stampCopy(summary({ status: 'pending', position: 2 }))).toBe('ждёт очереди');
    expect(stampCopy(summary({ status: 'processing' }))).toBe('идёт');
    expect(stampCopy(summary())).toBe('внесено');
    expect(stampCopy(summary({ outcome: 'adapted' }))).toBe('внесено частично');
    expect(stampCopy(summary({ status: 'void', outcome: 'dropped' }))).toBe('снято');
    expect(stampCopy(summary({ status: 'escalated', outcome: 'budget' }))).toBe('ждёт решения');
  });
});
