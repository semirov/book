// @vitest-environment jsdom
import type { CommentDto } from '@book/shared';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { filingsOf } from './sentenceTheatreHarness.tsx';
import { SentenceTheatre } from './SentenceTheatre.tsx';

import {
  claim,
  cleanup,
  mount,
  step,
  comment,
  draw,
  installFrames,
  LINE,
  surface,
  T0,
  write,
  WORDS,
} from './sentenceTheatreHarness.tsx';

/**
 * BOOK-227 — the renderer's acts, in jsdom: the fill, the seven states, the write and the gates.
 * The surface itself (the injected boxes, the fake clock, the frames) is `sentenceTheatreHarness`.
 */

beforeEach(() => {
  installFrames();
});

afterEach(async () => {
  await cleanup();
});

describe('BOOK-227 — the arrival, frame by frame', () => {
  it('draws one rule per line, walks the nib, and stops at the sweep', async () => {
    claim(T0);
    const host = await draw({ row: comment({ status: 'batched' }) });
    expect(host.dataset.act).toBe('arrival');
    // The overlay's nodes are the sentence's lines and its instruments — never its words.
    expect(host.querySelectorAll('.theatre-line')).toHaveLength(2);
    expect(host.querySelectorAll('.theatre-nib')).toHaveLength(1);
    expect(host.querySelectorAll('.theatre').length).toBe(0);
    // The cite is dotted while the fill runs (a hand-off is not a reading).
    expect(surface()?.querySelector('[data-s]')?.getAttribute('data-theatre')).toBe('arrival');

    // 13 words: sweep = max(13 × 60 000 ÷ 230, 1 200) = 3 391 ms.
    const first = (host.querySelector('.theatre-line') as HTMLElement).style.clipPath;
    expect(first).toMatch(/^inset\(0 /u);
    const nib = host.querySelector<HTMLElement>('.theatre-nib');
    // the baseline is 22 px below the line's top, the rule 4 px under it
    expect(nib?.style.transform).toContain('translate3d(4.00px, 26.00px, 0)');
    expect(Number.parseFloat(nib?.style.width ?? '0')).toBe(40);

    await step(1_500);
    const later = (host.querySelector('.theatre-line') as HTMLElement).style.clipPath;
    expect(later).not.toBe(first);
    expect(Number(/inset\(0 ([\d.]+)px/u.exec(later ?? '')?.[1] ?? '0')).toBeLessThan(Number(/inset\(0 ([\d.]+)px/u.exec(first ?? '')?.[1] ?? '999'));

    // Past the sweep: no lines, the shipped cite, and the pen has left with its fact.
    await step(2_000);
    expect(host.querySelectorAll('.theatre-line')).toHaveLength(0);
    expect(surface()?.querySelector('[data-s]')?.getAttribute('data-theatre')).toBeNull();
    const pen = host.querySelector<HTMLElement>('.theatre-nib');
    expect(pen?.style.opacity).toBe('0');
    expect(Number.parseFloat(pen?.style.width ?? '1')).toBe(0);
  });

  it('a claim that has already run its course paints the rule solid in the first frame', async () => {
    claim(T0);
    const host = await draw({ row: comment({ status: 'batched' }), nowAt: T0 + 60_000 });
    expect(host.querySelectorAll('.theatre-line')).toHaveLength(0);
    expect(surface()?.querySelector('[data-s]')?.getAttribute('data-theatre')).toBeNull();
  });
});

describe('BOOK-227 — the seven acts', () => {
  it('thinking: one spine, and nothing else', async () => {
    const stages = [
      {
        passId: 'stp_1',
        chapter: 1,
        stageSeq: 2,
        stage: 'drafting' as const,
        at: T0,
        actor: { process: 'writer' as const, model: null },
        changeId: 'chg_1',
        summary: 'пишется',
        span: null,
        tokens: null,
        costUsd: null,
      },
    ];
    const host = await draw({
      row: comment({ status: 'accepted', changeStatus: 'processing', decidedAt: new Date(T0 - 100).toISOString() }),
      stages,
    });
    expect(host.dataset.act).toBe('thinking');
    expect(host.querySelector('.theatre-spine')?.getAttribute('data-open')).toBe('true');
    // The stub stands on the rule's end: the pen was put down.
    expect(host.querySelector('.theatre-nib')?.getAttribute('data-shape')).toBe('stub');
    // No line rules and no tallies: the block is held, the text is not touched.
    expect(host.querySelectorAll('.theatre-line')).toHaveLength(0);
    expect(host.querySelectorAll('.theatre-tally')).toHaveLength(0);
  });

  it('thinking past the stage’s deadline: the 4 × 3 foot opens once', async () => {
    const drafting = { passId: 'stp_1', chapter: 1, stageSeq: 2, stage: 'drafting', at: T0,
      actor: { process: 'writer', model: null }, changeId: 'chg_1', summary: 'пишется',
      span: null, tokens: null, costUsd: null, deadlineAt: T0 + 40 } as PassStageEvent;
    const host = await draw({ row: comment({ status: 'accepted', changeStatus: 'processing' }), stages: [drafting] });
    expect(host.querySelector('.theatre-foot')?.getAttribute('data-open')).toBe('false');
    await act(async () => { await new Promise((done) => setTimeout(done, 90)); });
    expect(host.querySelector('.theatre-foot')?.getAttribute('data-open')).toBe('true');
  });

  it('verdict: accepted keeps the stub, refused and held leave no stub', async () => {
    const accepted = await draw({
      row: comment({ status: 'accepted', decidedAt: new Date(T0).toISOString() }),
      nowAt: T0 + 100,
    });
    expect(accepted.dataset.act).toBe('verdict');
    expect(accepted.dataset.outcome).toBe('accepted');
    expect(accepted.querySelector('.theatre-nib')?.getAttribute('data-shape')).toBe('stub');
    expect(surface()?.querySelector('[data-s]')?.getAttribute('data-outcome')).toBe('accepted');

    const refused = await draw({
      row: comment({ status: 'rejected', refusal: 'rights', decidedAt: new Date(T0).toISOString() }),
      nowAt: T0 + 100,
    });
    expect(refused.dataset.outcome).toBe('refused');
    expect(refused.querySelector('.theatre-nib')?.getAttribute('data-shape')).toBe('nib');
    expect(refused.querySelector<HTMLElement>('.theatre-nib')?.style.opacity).toBe('0');
    expect(surface()?.querySelector('[data-s]')?.getAttribute('data-outcome')).toBe('refused');
  });

  it('queue: no motion at all — the stub has lifted and nothing else stands', async () => {
    const host = await draw({
      row: comment({ status: 'accepted', decidedAt: new Date(T0).toISOString() }),
      nowAt: T0 + 600,
    });
    expect(host.dataset.act).toBe('queue');
    expect(host.querySelector<HTMLElement>('.theatre-nib')?.style.opacity).toBe('0');
    expect(host.querySelectorAll('.theatre-line')).toHaveLength(0);
    expect(surface()?.querySelector('[data-s]')?.getAttribute('data-theatre')).toBe('queue');
  });

  it('checking: one 1 px tally per gate, 4 px apart, no more than three', async () => {
    const appliedAt = T0;
    const stage = (stageSeq: number, at: number) => ({
      passId: 'stp_1',
      chapter: 1,
      stageSeq,
      stage: 'verdict' as const,
      at,
      actor: { process: 'writer' as const, model: null },
      changeId: 'chg_1',
      summary: 'редактор',
      span: null,
      tokens: null,
      costUsd: null,
    });
    const host = await draw({
      row: comment({ status: 'accepted', decidedAt: new Date(T0 - 1_000).toISOString() }),
      stages: [stage(5, appliedAt + 1_000), stage(6, appliedAt + 2_000)],
      nowAt: appliedAt + 3_000,
    });
    expect(host.dataset.act).toBe('checking');
    const tallies = [...host.querySelectorAll<HTMLElement>('.theatre-tally')];
    expect(tallies).toHaveLength(2);
    expect(tallies.map((node) => node.dataset.gate)).toEqual(['0', '1']);
    // The duration is the height's: two changed lines are 240 ms (the floor).
    expect(tallies[0]?.style.transitionDuration).toBe('240ms');
    expect(host.querySelector<HTMLElement>('.theatre-nib')?.style.opacity).toBe('0');
  });

  it('writing: the spine stands on PR #121’s print, and no other ink is the theatre’s', async () => {
    const host = await draw({
      row: comment({ status: 'accepted', changeStatus: 'processing', decidedAt: new Date(T0 - 5_000).toISOString() }),
      applied: write(),
      nowAt: T0 + 100,
    });
    // §9.4 — the print owns the caret and the ghost; the page's writing act is the 2 px hold and
    // the margin, and this renderer must add no rule, no nib and no line of its own.
    expect(host.dataset.act).toBe('writing');
    expect(host.querySelector('.theatre-spine')?.getAttribute('data-open')).toBe('true');
    expect(host.querySelectorAll('.theatre-line')).toHaveLength(0);
    expect(host.querySelector<HTMLElement>('.theatre-nib')?.style.opacity).toBe('0');
    expect(surface()?.querySelector('[data-s]')?.getAttribute('data-theatre')).toBe('writing');
  });

  it('writing ends with the print’s window: the text is simply there', async () => {
    const host = await draw({
      row: comment({ status: 'accepted', changeStatus: 'processing', decidedAt: new Date(T0 - 5_000).toISOString() }),
      applied: write(),
      nowAt: T0 + 6_000,
    });
    expect(host.dataset.act).not.toBe('writing');
  });

  it('checking: a tally is as tall as the changed lines, not the sentence’s', async () => {
    const gate = {
      passId: 'stp_1',
      chapter: 1,
      stageSeq: 9,
      stage: 'verdict' as const,
      at: T0 + 1_000,
      actor: { process: 'writer' as const, model: null },
      changeId: 'chg_1',
      summary: 'редактор',
      span: null,
      tokens: null,
      costUsd: null,
    };
    // The write names one word of the sentence: one changed line, from the one measurement.
    const host = await draw({
      row: comment({ status: 'accepted', decidedAt: new Date(T0 - 1_000).toISOString() }),
      stages: [gate],
      applied: write({ span: [{ blockId: 'ch01#0594465f', before: '', after: WORDS[0] ?? '', truncated: false }] }),
      nowAt: T0 + 2_000,
    });
    const tally = host.querySelector<HTMLElement>('.theatre-tally');
    expect(tally?.style.transitionDuration).toBe('240ms');
    const line = Number.parseFloat(tally?.style.height ?? '0');
    // One line box plus the 8 px of the stroke's own room, never the whole sentence's height.
    expect(line).toBeLessThan(LINE * 2);
  });

  it('landing: the rule lifts and nothing is left in the margin', async () => {
    const host = await draw({
      row: comment({
        status: 'applied',
        changeId: 'chg_1',
        applied: { chapter: 1, rev: 16 },
        decidedAt: new Date(T0 + 50).toISOString(),
      }),
      nowAt: T0 + 120,
    });
    expect(host.dataset.act).toBe('landing');
    const drawn = [...host.querySelectorAll<HTMLElement>('.theatre-line')];
    expect(drawn).toHaveLength(2);
    // Painted, not merely measured: the un-clipped state is written out, never the sheet's default.
    expect(drawn.map((node) => node.style.clipPath)).toEqual(['inset(0 0 0 0)', 'inset(0 0 0 0)']);
    // The lift is the sheet's, one attribute after one frame (the births' rAF comes first).
    await step(16);
    await step(16);
    expect([...host.querySelectorAll('.theatre-line')].every((node) => (node as HTMLElement).dataset.lift === '')).toBe(true);
  });

  it('failure, our fault: the rule ends short, a 2 × 4 foot under its end', async () => {
    const host = await draw({
      row: comment({ status: 'accepted', attempt: 'failed', decidedAt: new Date(T0).toISOString() }),
      nowAt: T0 + 100,
    });
    expect(host.dataset.act).toBe('failed');
    expect(host.dataset.cause).toBe('fault');
    expect(host.querySelector('.theatre-rule-end')).not.toBeNull();
    const drawn = [...host.querySelectorAll<HTMLElement>('.theatre-line')];
    expect(drawn).toHaveLength(2);
    // Every line but the last is whole; the last ends short of its own words.
    expect(drawn[0]?.style.clipPath).toBe('inset(0 0 0 0)');
    const cut = Number(/^inset\(0 ([\d.]+)px 0 0\)$/u.exec(drawn[1]?.style.clipPath ?? '')?.[1] ?? 0);
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(400);
    expect(host.querySelector<HTMLElement>('.theatre-nib')?.style.opacity).toBe('0');
  });
  it('failure, a verdict: the strike, and no gap and no foot', async () => {
    const host = await draw({
      row: comment({ status: 'rejected', refusal: 'auditor', decidedAt: new Date(T0).toISOString() }),
      nowAt: T0 + 100,
    });
    expect(host.dataset.act).toBe('verdict');
    expect(host.dataset.outcome).toBe('refused');
    expect(host.querySelector('.theatre-rule-end')).toBeNull();
    expect(host.querySelectorAll('.theatre-line')).toHaveLength(0);
  });

  it('transport down: no per-sentence mark is added', async () => {
    claim(T0);
    const host = await draw({ row: comment({ status: 'batched' }), nowAt: T0 + 1_000, transportDown: true });
    expect(host.dataset.cause).toBe('transport');
    expect(host.querySelectorAll('.theatre-line')).toHaveLength(0);
    expect(host.querySelectorAll('.theatre-tally')).toHaveLength(0);
    expect(host.querySelector('.theatre-spine')?.getAttribute('data-open')).toBe('false');
  });

  it('no frame, no act: nothing is rendered at all', async () => {
    const host = await mount(
      <p className="p">
        <span data-s="0" className="cited rule-solid ink-live">
          <span className="sentence-door">Комната стояла в конце коридора и дверь была открыта</span>
          <SentenceTheatre filings={filingsOf(comment({ status: 'new' }))} now={() => T0} />
        </span>
      </p>,
    );
    expect(host.querySelector('.theatre')).toBeNull();
    expect(host.querySelector('[data-s]')?.getAttribute('data-theatre')).toBeNull();
  });
});

