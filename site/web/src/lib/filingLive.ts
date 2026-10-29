/**
 * BOOK-220 §11.3 — the filing's live facts, and the two surfaces that read them.
 *
 * The record is a leaf of the page's tree, and the frames that decide whether a filing may be
 * repeated arrive at the page root: `filing:reading` (the attempt, its class and the cap),
 * `filing:update` (the state and the tries left) and `comment:decision` (the answer a filing
 * got). `ChangeLiveFacts` already carries the change's line and its closed pass; the filing's
 * own three are published here, on the same commit, so no surface fetches what a frame holds.
 *
 * Identity is the whole diff: a frame that moved none of the three costs no render.
 */

import type { CommentDecisionPayload, FilingUpdatePayload, LiveReading } from '@book/shared';
import { useSyncExternalStore } from 'react';

import type { ClientState } from './clientState.ts';

/** The three maps of the page's state the record and the trail read for a filing. */
export type FilingLiveFacts = Pick<ClientState, 'reading' | 'filingUpdates' | 'decisions'>;

const EMPTY: FilingLiveFacts = { reading: null, filingUpdates: {}, decisions: {} };

let facts: FilingLiveFacts = EMPTY;
const listeners = new Set<() => void>();

/** The page's own commit: the reducer's three fields, in place, never a copy on a duplicate. */
export function publishFilingLive(next: FilingLiveFacts): void {
  if (
    next.reading === facts.reading &&
    next.filingUpdates === facts.filingUpdates &&
    next.decisions === facts.decisions
  ) {
    return;
  }
  facts = next;
  for (const listener of listeners) listener();
}

export function filingLiveFacts(): FilingLiveFacts {
  return facts;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The live facts, as a component reads them (a server render and a test freeze fall back). */
export function useFilingLive(): FilingLiveFacts {
  return useSyncExternalStore(subscribe, filingLiveFacts, filingLiveFacts);
}

/** The reading of **this** filing, or `null` when the frame named another row. */
export function readingOf(facts: FilingLiveFacts, commentId: string | null | undefined): LiveReading | null {
  if (commentId === null || commentId === undefined) return null;
  return facts.reading !== null && facts.reading.commentId === commentId ? facts.reading : null;
}

export function updateOf(
  facts: FilingLiveFacts,
  commentId: string | null | undefined,
): FilingUpdatePayload | null {
  if (commentId === null || commentId === undefined) return null;
  return facts.filingUpdates[commentId] ?? null;
}

export function decisionOf(
  facts: FilingLiveFacts,
  commentId: string | null | undefined,
): CommentDecisionPayload | null {
  if (commentId === null || commentId === undefined) return null;
  return facts.decisions[commentId] ?? null;
}

/** Tests only: the store is per module lifetime, and a fresh case starts with no frames. */
export function resetFilingLive(): void {
  facts = EMPTY;
  for (const listener of listeners) listener();
}
