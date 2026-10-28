// @vitest-environment jsdom
import type { PassStageEvent } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { useStages, type Stages } from './useStages.ts';

/**
 * The hook around the log: one mount in `App`, `note` for every frame, `reset` for a `hello`.
 * The rules are `useStages.test.ts`'s; this proves the two states the page reads move together.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const T0 = Date.parse('2026-10-28T08:18:00Z');

function event(stage: PassStageEvent['stage'], seq: number): PassStageEvent {
  return {
    passId: 'stp_01J9Z8K4Q7',
    chapter: 7,
    stageSeq: seq,
    stage,
    at: T0 + seq * 1_000,
    actor: { process: 'writer', model: null },
    changeId: null,
    summary: `сводка ${String(seq)}`,
    span: null,
    tokens: null,
    costUsd: null,
  };
}

let api: Stages | null = null;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Probe() {
  api = useStages();
  return <span data-chapters={Object.keys(api.log).length} />;
}

beforeEach(() => {
  api = null;
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  container = null;
  document.body.innerHTML = '';
});

it('hands the page one log and the flags folded from it, and resets both on hello', async () => {
  await act(async () => root?.render(<Probe />));
  expect(api?.log).toEqual({});
  expect(api?.passes).toEqual({});

  await act(async () => api?.note(event('drafting', 1)));
  expect(api?.log[7]?.map((one) => one.stage)).toEqual(['drafting']);
  expect(api?.passes[7]?.stage).toBe('drafting');
  expect(container?.querySelector('span')?.getAttribute('data-chapters')).toBe('1');

  // A repeated frame is not a second row.
  await act(async () => api?.note(event('drafting', 1)));
  expect(api?.log[7]).toHaveLength(1);

  await act(async () => api?.note(event('landed', 2)));
  expect(api?.passes[7]).toBeUndefined();

  await act(async () => api?.reset());
  expect(api?.log).toEqual({});
  // Resetting a cleared log is not a new state: no re-render, no throw.
  await act(async () => api?.reset());
  expect(api?.log).toEqual({});
});
