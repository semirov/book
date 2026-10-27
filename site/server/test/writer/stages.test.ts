/**
 * The stage emitter (`docs/writer-lane.md` §2): `stageSeq` is always omitted, the actor is the
 * writer, the span is passed through, and a summary is one factual line inside the bound.
 */

import { STAGE_SUMMARY_MAX_CHARS } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { emitStage, grouped, stageLogLine, stageSummary } from '../../src/writer/stages.ts';

type Sent = Record<string, unknown>;

function sinkOf(): { sent: Sent[]; sink: { stage(event: Record<string, unknown>): Promise<unknown> } } {
  const sent: Sent[] = [];
  return {
    sent,
    sink: {
      stage: async (event) => {
        sent.push(event);
        return { ok: true };
      },
    },
  };
}

describe('emitStage', () => {
  it('omits stageSeq and names the writer as the actor', async () => {
    const { sent, sink } = sinkOf();
    const result = await emitStage(sink, {
      stage: 'queued',
      chapter: 65,
      passId: 'stp_1',
      changeId: null,
      summary: 'проход открыт: глава 65, задание draft',
      model: 'deepseek-v4-pro',
      at: 1_790_000_000_000,
    });
    expect(result).toEqual({ ok: true });
    expect(sent[0]).toEqual({
      passId: 'stp_1',
      stage: 'queued',
      at: 1_790_000_000_000,
      actor: { process: 'writer', model: 'deepseek-v4-pro' },
      changeId: null,
      summary: 'проход открыт: глава 65, задание draft',
      span: null,
      tokens: null,
      costUsd: null,
    });
    expect(Object.keys(sent[0] ?? {})).not.toContain('stageSeq');
  });

  it('passes the span, the tokens and the money of a landing through', async () => {
    const { sent, sink } = sinkOf();
    const span = [{ blockId: null, before: '', after: 'текст', truncated: false }];
    await emitStage(sink, {
      stage: 'landed',
      chapter: 65,
      passId: 'stp_1',
      summary: 'глава 65: 2 431 знак',
      span,
      tokens: { in: 3_000, out: 600 },
      costUsd: 0.0021,
      at: 2,
    });
    expect(sent[0]).toMatchObject({ stage: 'landed', span, tokens: { in: 3_000, out: 600 }, costUsd: 0.0021 });
    expect(sent[0]?.actor).toEqual({ process: 'writer', model: null });
  });

  it('reports a refused stage instead of throwing: a stage is not the pass', async () => {
    const result = await emitStage(
      {
        stage: async () => {
          throw Object.assign(new Error('refused'), { code: 'UNKNOWN_PASS' });
        },
      },
      { stage: 'refused', chapter: 65, passId: 'stp_1', summary: 'проход остановлен', at: 1 },
    );
    expect(result).toEqual({ ok: false, code: 'UNKNOWN_PASS' });
  });
});

describe('stageSummary', () => {
  it('builds one factual line from the values the pass holds', () => {
    expect(stageSummary.queued({ chapter: 65, pass: 'draft', premise: 'документ о допуске', intent: null })).toBe(
      'проход открыт: глава 65, задание draft · замысел: документ о допуске',
    );
    expect(stageSummary.queued({ chapter: 9, pass: 'change', premise: null, intent: 'поправить сцену' })).toBe(
      'проход открыт: глава 9, задание change · правка: поправить сцену',
    );
    expect(stageSummary.read({ sections: 8, chars: 84_120, neighbours: [64, 66] })).toBe(
      'промпт собран: 8 разделов, 84 120 знаков · соседи: 64, 66',
    );
    expect(stageSummary.read({ sections: 8, chars: 900, neighbours: [] })).toContain('написанных соседей нет');
    expect(stageSummary.draftingStarted({ call: 1, chars: 84_120, purpose: 'draft' })).toBe(
      'запрос к модели №1 · 84 120 знаков промпта',
    );
    expect(stageSummary.draftingStarted({ call: 2, chars: 10, purpose: 'repair' })).toContain('с причиной отказа');
    expect(stageSummary.draftingStarted({ call: 3, chars: 10, purpose: 'continue' })).toContain('продолжение №3');
    expect(stageSummary.draftingReturned({ chars: 22_140, tokensIn: 84_120, tokensOut: 22_100 })).toBe(
      'ответ: 22 140 знаков · 84 120 → 22 100 токенов',
    );
    expect(stageSummary.verdict({ role: 'editor', verdict: 'GAP', findings: 3, blockers: 1 })).toBe(
      'редактор: GAP · замечаний 3 · блокеров 1',
    );
    expect(stageSummary.verdict({ role: 'consultant', verdict: 'HOLDS', findings: 0, blockers: 0 })).toBe(
      'консультант: HOLDS · замечаний нет',
    );
    expect(stageSummary.landed({ chapter: 65, chars: 22_140, blocks: 12, tokensIn: 126_900, tokensOut: 22_400, costUsd: 0.42 })).toBe(
      'глава 65: 22 140 знаков, 12 абзацев · 126 900 → 22 400 токенов · $0.4200',
    );
    expect(stageSummary.refused({ reason: 'ответ модели не прошёл проверку' })).toBe(
      'проход остановлен: ответ модели не прошёл проверку',
    );
  });

  it('stays inside the bound even when the reason is a whole sentence', () => {
    const long = stageSummary.refused({ reason: 'причина '.repeat(200) });
    expect(long.length).toBe(STAGE_SUMMARY_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(grouped(1_500_000)).toBe('1 500 000');
  });

  it('logs the stage and its own summary, never a prompt', () => {
    const line = stageLogLine(Date.UTC(2026, 9, 27, 9, 0, 0), 'queued', 'проход открыт: глава 65');
    expect(line).toBe('[writer] 2026-10-27T09:00:00.000Z queued проход открыт: глава 65');
  });
});
