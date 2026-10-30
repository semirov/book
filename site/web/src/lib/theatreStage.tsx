import type { PassStageEvent } from '@book/shared';
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';

import type { AppliedWrite, ClientState } from './clientState.ts';
import type { StagesLog } from './stages.ts';

/**
 * BOOK-227 — how a sentence hears the page: its chapter's stage log, the page's socket, and the
 * chapter's applied write.
 *
 * The theatre needs three facts the paragraph itself does not carry. Threading them through
 * `ProseParagraph` → `SentenceRuns` would add three props to surfaces that have no business
 * holding them (and the paragraph sits at the arch gate's line bound); so they travel the way
 * BOOK-220 already moves a leaf's facts (`lib/filingLive.ts`, `lib/liveChange.ts`): `App`
 * publishes the reducer's own fields on every commit, `ChapterProse` hands its chapter's slice
 * to the sentence through one context, and each `SentenceTheatre` reads it.
 *
 * `transport` is the page's own `connection === 'closed'` (`lib/socketStatus.ts` → `App`): a
 * dead socket stops every moving mark and adds none — a dead server cannot frame its own death
 * (§9.8).
 *
 * A page outside the provider (the basis slot, a plate, a test) performs nothing: no chapter —
 * no act.
 */

export type TheatreTransport = 'up' | 'down';

/** What `App` publishes: the reducer's fields, in place, never a copy on a duplicate. */
export type TheatrePage = {
  /** The per-chapter stage log (`ClientState.stages`). */
  stages: StagesLog;
  /** The chapter-level write of the print window (`ClientState.applied`). */
  applied: AppliedWrite | null;
  transport: TheatreTransport;
};

/** The three fields of the page's state the theatre reads. */
export type TheatreState = Pick<ClientState, 'stages' | 'applied'>;

const EMPTY: TheatrePage = { stages: {}, applied: null, transport: 'up' };

let page: TheatrePage = EMPTY;
const listeners = new Set<() => void>();

export function publishTheatrePage(next: TheatrePage): void {
  if (next.stages === page.stages && next.applied === page.applied && next.transport === page.transport) {
    return;
  }
  page = next;
  for (const listener of listeners) listener();
}

export function theatrePage(): TheatrePage {
  return page;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The page's theatre facts, as a component reads them (a server render falls back to empty). */
export function useTheatrePage(): TheatrePage {
  return useSyncExternalStore(subscribe, theatrePage, theatrePage);
}

/** The chapter's own log, or `null` when the page has heard none (a log is never invented). */
export function stagesOf(state: TheatreState, chapter: number): readonly PassStageEvent[] | null {
  return state.stages[chapter] ?? null;
}

/** The write, when it names this chapter: the page holds one chapter's print at a time. */
export function appliedOf(state: TheatreState, chapter: number): AppliedWrite | null {
  return state.applied !== null && state.applied.n === chapter ? state.applied : null;
}

/** Tests only: the store is per module lifetime, and a fresh case starts with no frames. */
export function resetTheatrePage(): void {
  page = EMPTY;
  for (const listener of listeners) listener();
}

/** The chapter's slice, as `ChapterProse` hands it to the sentences it writes. */
export type TheatreStage = {
  /** The chapter the log belongs to. */
  chapter: number;
  stages: readonly PassStageEvent[] | null;
  /** The chapter's write, when the print window names it. */
  applied?: AppliedWrite | null;
  /** The page's socket; absent means "up" — a surface with no socket has no fact to perform. */
  transport?: TheatreTransport;
};

const StageContext = createContext<TheatreStage | null>(null);

export function TheatreStageProvider({ value, children }: { value: TheatreStage; children: ReactNode }) {
  return <StageContext.Provider value={value}>{children}</StageContext.Provider>;
}

export function useTheatreStage(): TheatreStage | null {
  return useContext(StageContext);
}
