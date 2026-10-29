/**
 * BOOK-220 B2/M3 — the change's live facts, and the one surface that reads them.
 *
 * A change lives in the record's `правка` section (`components/ChangeSection.tsx`), a leaf of the
 * page's tree: the four change frames (`queued`, `processing`, `adapted`, `stale`) and a pass's
 * close land in `ClientState.lines`/`ClientState.passes`, and this store is how the leaf hears
 * them without a prop drilled through four components. `App` publishes the reducer's own two
 * maps on every commit; identity is the whole diff, so a frame that changed neither costs no
 * render.
 *
 * Two sentences live here and nowhere else: the change's own last line (the queue place, the
 * narrowed intent, the stale basis) and the pass's own close (the writer's sentence, a failure,
 * its price). Both are read straight off the frame payload — a surface that would print a guess
 * prints nothing instead.
 */

import type { PassClosedPayload, PassStage } from '@book/shared';
import { useSyncExternalStore } from 'react';

import { CHANGE_STALE_LINE } from './changeStatus.ts';
import type { ChangeLine, ClientState } from './clientState.ts';

/** The two maps of the page's state the record's change section reads. */
export type LiveChangeFacts = Pick<ClientState, 'lines' | 'passes'>;

const EMPTY: LiveChangeFacts = { lines: {}, passes: {} };

let facts: LiveChangeFacts = EMPTY;
const listeners = new Set<() => void>();

/** The page's own commit: the reducer's maps, in place, never a copy on a duplicate. */
export function publishLiveChange(next: LiveChangeFacts): void {
  if (next.lines === facts.lines && next.passes === facts.passes) return;
  facts = next;
  for (const listener of listeners) listener();
}

export function liveChangeFacts(): LiveChangeFacts {
  return facts;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The live facts, as a component reads them (a server render and a test freeze fall back to it). */
export function useLiveChange(): LiveChangeFacts {
  return useSyncExternalStore(subscribe, liveChangeFacts, liveChangeFacts);
}

/** The change's last line, or `null` when no frame named one. */
export function changeLineOf(facts: LiveChangeFacts, changeId: string | null | undefined): ChangeLine | null {
  if (changeId === null || changeId === undefined) return null;
  return facts.lines[changeId] ?? null;
}

/** The newest closed pass of one change: the record prints that pass's own sentence. */
export function closedPassOf(facts: LiveChangeFacts, changeId: string | null | undefined): PassClosedPayload | null {
  if (changeId === null || changeId === undefined) return null;
  let newest: PassClosedPayload | null = null;
  for (const closed of Object.values(facts.passes)) {
    if (closed.changeId !== changeId) continue;
    if (newest === null || closed.at >= newest.at) newest = closed;
  }
  return newest;
}

/**
 * The change's own line, in the reader's words. `queued` carries the place the frame named,
 * `processing` its attempt, `adapted` the narrowed intent and why, `stale` the basis that moved.
 * A `decided` line has no sentence of its own: the change's verdict rows say the outcome.
 */
export function liveLineOf(line: ChangeLine): string | null {
  switch (line.kind) {
    case 'queued':
      return line.ahead > 0 ? `в очереди · впереди ${String(line.ahead)}` : 'в очереди · следующая';
    case 'processing':
      return `идёт · попытка ${String(line.attempt)}`;
    case 'adapted': {
      const intent = line.intent.trim();
      const reason = line.reason.trim();
      if (intent.length === 0) return reason.length === 0 ? 'сужено' : `сужено · ${reason}`;
      return reason.length === 0 ? `сужено · ${intent}` : `сужено · ${intent} · ${reason}`;
    }
    case 'stale':
      return CHANGE_STALE_LINE;
    default:
      return null;
  }
}

/** The pass's own close: its sentence, a failed close, and the price the engine measured. */
export function passLineOf(closed: PassClosedPayload): string | null {
  const parts: string[] = [];
  const sentence = closed.sentence.trim();
  if (sentence.length > 0) parts.push(sentence);
  // The close failed and the payload carries no «write landed» fact, so the line claims only
  // what an interrupted pass does guarantee: it stopped, and it left the text as it was.
  if (closed.closeFailed) parts.push('правка прервана — текст не менялся');
  if (closed.costUsd !== null) parts.push(`${closed.costUsd.toFixed(2).replace('.', ',')} $`);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** Tests only: the store is per module lifetime, and a fresh case starts with no frames. */
export function resetLiveChange(): void {
  facts = EMPTY;
  for (const listener of listeners) listener();
}

/** The stage's own word, for the stages the record reads back for a pass it was not there for. */
export const STAGE_WORDS: Readonly<Record<PassStage, string>> = {
  queued: 'в очереди',
  read: 'прочитано',
  verdict: 'проверено',
  drafting: 'написано',
  typing: 'набрано',
  landed: 'записано',
  refused: 'отказ',
  // §10.8: the two stages the ladder adds. A revision and a widening are work, not verdicts.
  revising: 'доработка',
  widening: 'шире',
};
