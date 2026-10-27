import type { CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  filingInk,
  filingNumber,
  filingQuote,
  filingsForBlock,
  isPending,
  isStale,
  sortFilings,
  staleLine,
  stripFilings,
} from './filings.ts';

function comment(overrides: Partial<CommentDto> & { id: string; createdAt: string }): CommentDto {
  return {
    chapter: 8,
    anchor: { blockId: 'ch08#aa11bb22', blockIndex: 2, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: 'Свет был включён до меня.',
    interventionKind: 'testimony',
    status: 'new',
    premise: false,
    reason: null,
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

const NEW = comment({ id: 'cmt_01J9Z8K4Q7', createdAt: '2026-10-21T12:03:00Z' });
const ACCEPTED = comment({
  id: 'cmt_01J9Z8K5AA',
  createdAt: '2026-10-20T09:00:00Z',
  status: 'accepted',
  anchor: { ...NEW.anchor, quote: 'Я вошёл в пустую комнату.' },
});
const APPLIED = comment({ id: 'cmt_01J9Z8K6BB', createdAt: '2026-10-19T09:00:00Z', status: 'applied' });
const STALE = comment({
  id: 'cmt_01J9Z8K7CC',
  createdAt: '2026-10-22T09:00:00Z',
  anchor: { ...NEW.anchor, resolved: false, quote: null },
});

describe('filingInk', () => {
  it('gives every state a word and a rule shape, never colour alone', () => {
    expect(filingInk(NEW)).toEqual({ word: 'ждёт рассмотрения', rule: 'dotted', tone: 'quiet' });
    expect(filingInk({ status: 'accepted' })).toEqual({ word: 'в очереди', rule: 'solid', tone: 'live' });
    expect(filingInk({ status: 'applied' })).toEqual({ word: 'внесено', rule: 'none', tone: 'done' });
    expect(filingInk({ status: 'rejected' })).toEqual({ word: 'отклонено', rule: 'solid', tone: 'stopped' });
    expect(filingInk({ status: 'superseded' }).rule).toBe('solid');
  });

  it('falls back to the quiet wait for a state a build does not know', () => {
    expect(filingInk({ status: 'something' as CommentDto['status'] }).word).toBe('ждёт рассмотрения');
  });
});

describe('filingsForBlock', () => {
  it('groups by sentence and keeps the pending filing first', () => {
    const groups = filingsForBlock([ACCEPTED, NEW, STALE], 'ch08#aa11bb22');
    const sameSentence = groups.find((group) => group.quote === 'Её освещал яркий свет.');
    expect(sameSentence?.all.map((item) => item.id)).toEqual([NEW.id]);
  });

  it('shows the newest numeral and the overflow on one sentence', () => {
    const older = comment({ id: 'cmt_01J9Z8K8DD', createdAt: '2026-10-18T09:00:00Z' });
    const latest = comment({ id: 'cmt_01J9Z8K9EE', createdAt: '2026-10-23T09:00:00Z' });
    const [group] = filingsForBlock([older, NEW, latest], 'ch08#aa11bb22');
    expect(group?.number).toBe(filingNumber(latest));
    expect(group?.extra).toBe(2);
    expect(stripFilings(group!).shown).toHaveLength(2);
    expect(stripFilings(group!).more).toBe(1);
  });

  it('marks a stale group and leaves live ones alone', () => {
    const [group] = filingsForBlock([STALE], 'ch08#aa11bb22');
    expect(group?.stale).toBe(true);
    expect(isStale(STALE)).toBe(true);
    expect(isStale(NEW)).toBe(false);
  });

  it('ignores another paragraph’s filings', () => {
    expect(filingsForBlock([NEW], 'ch08#ffffffff')).toEqual([]);
  });
});

describe('sortFilings and the overflow line', () => {
  it('puts pending before decided and newest first inside a group', () => {
    expect(sortFilings([APPLIED, NEW, ACCEPTED]).map((item) => item.id)).toEqual([NEW.id, ACCEPTED.id, APPLIED.id]);
    expect(isPending(NEW)).toBe(true);
    expect(isPending(APPLIED)).toBe(false);
  });

  it('prints the stale line for the paragraph', () => {
    expect(staleLine([STALE])).toBe('1 замечание · абзац изменился');
    expect(staleLine([STALE, { ...STALE, id: 'cmt_01J9Z8KAFF' }])).toBe('2 замечания · абзац изменился');
    expect(staleLine([NEW])).toBeNull();
  });
});

describe('the mark and its quote', () => {
  it('prints a three-character record suffix, never an invented ordinal', () => {
    expect(filingNumber({ id: 'cmt_01J9Z8K4Q7' })).toBe('№4Q7');
    expect(filingNumber({ id: 'ab' })).toBe('№0AB');
  });

  it('shortens a long quote and says so when the paragraph moved', () => {
    expect(filingQuote(NEW)).toBe('Её освещал яркий свет.');
    expect(filingQuote(STALE)).toBe('абзац изменился');
    expect(filingQuote({ ...NEW, anchor: { ...NEW.anchor, quote: 'а'.repeat(200) } })).toHaveLength(120);
  });
});
