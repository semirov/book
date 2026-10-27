/**
 * The five public states of a change, as делопроизводство (BOOK-DOC-4; `style/VOICE.md`
 * §Ретроспектива; `concept/CONCEPT.md` «Канал»).
 *
 * A change is not «готово»: it is a file. The intervention is registered, a case is opened,
 * the text is amended, a cause is established, a divergence may be recorded. Each word is
 * earned by data — no step, no «заведено дело»; no rewritten chapter, no «внесены
 * изменения» — and a refused intervention shows none of them. The same words are rendered
 * by the change card, the focus view and the chronicle, so this module is their one source.
 *
 * The retroactive cause is filed in one of three modes (`shared/src/change.ts`): **оформление**
 * (the cause existed, now registered), **поправка** (the past reformulated, not denied —
 * «пункт изложен в новой редакции»), **расхождение** (document and scene deliberately do not
 * match; the seam is тоска, not a bug). Never «исправлено», never a role, never exclamation.
 */

import type { ChangeDto, ChangeSummaryDto, RetroMode } from '@book/shared';

export type DeedState = 'registered' | 'filed' | 'changed' | 'cause' | 'divergence';

export const DEED_ORDER: readonly DeedState[] = ['registered', 'filed', 'changed', 'cause', 'divergence'];

/** Lowercase, no exclamation, no neon — the words the card, the focus view and the chronicle share. */
export const DEED_WORDS: Record<DeedState, string> = {
  registered: 'зарегистрировано',
  filed: 'заведено дело',
  changed: 'внесены изменения',
  cause: 'причина установлена',
  divergence: 'расхождение зафиксировано',
};

/** The copy of one mode: an amendment says so in the document's own words. */
export const MODE_WORDS: Record<RetroMode, string> = {
  оформление: 'оформление',
  поправка: 'поправка: пункт изложен в новой редакции',
  расхождение: 'расхождение зафиксировано',
};

/** Everything the states are derived from — all of it public, none of it a gate's words. */
export type DeedInput = {
  /** The intervention became a change (a refusal becomes none). */
  accepted: boolean;
  /** Steps recorded for the change: the case file. */
  steps: number;
  /** Chapters actually rewritten. */
  rewritten: readonly number[];
  /** The modes the cause was filed under, as the public list on the change DTO. */
  modes: readonly RetroMode[];
};

/**
 * The one pure mapping: an ordered list of the states that really happened. A state is never
 * asserted ahead of its data, and nothing is derived from a timer, a status word or a wish.
 */
export function deedStates(input: DeedInput): DeedState[] {
  if (!input.accepted) return [];
  const states: DeedState[] = ['registered'];
  if (input.steps <= 0) return states;
  states.push('filed');
  if (input.rewritten.length > 0) states.push('changed');
  if (input.modes.some((mode) => mode === 'оформление' || mode === 'поправка')) states.push('cause');
  if (input.modes.includes('расхождение')) states.push('divergence');
  return states;
}

/** One state in words; the cause carries its mode, because the mode is the whole point. */
export function deedWord(state: DeedState, modes: readonly RetroMode[] = []): string {
  if (state !== 'cause') return DEED_WORDS[state];
  const mode = modes.includes('поправка') ? 'поправка' : 'оформление';
  return `${DEED_WORDS.cause} · ${MODE_WORDS[mode]}`;
}

/** «зарегистрировано · заведено дело · внесены изменения · причина установлена · оформление» */
export function deedLine(input: DeedInput): string {
  return deedStates(input)
    .map((state) => deedWord(state, input.modes))
    .join(' · ');
}

/** The card's and the focus view's input: the public change DTO, nothing else. */
function changeDeed(change: ChangeDto): DeedInput {
  // A local change raises no cascade, so its rewritten chapters are the steps that landed —
  // the state still has to be earned by a chapter that was actually rewritten.
  const landed = change.steps
    .filter(
      (step) =>
        typeof step.chapter === 'number' &&
        (step.outcome === 'rewritten' || step.outcome === 'published_with_finding'),
    )
    .map((step) => step.chapter as number);
  return {
    accepted: true,
    steps: change.steps.length,
    rewritten: change.cascade === null ? [...new Set(landed)] : change.cascade.chaptersRewritten,
    modes: change.modes,
  };
}

/** The chronicle's input: the list row, whose `steps`/`rewritten`/`modes` are public. */
export function summaryDeed(change: ChangeSummaryDto | null): DeedInput {
  if (change === null) return { accepted: false, steps: 0, rewritten: [], modes: [] };
  return {
    accepted: true,
    steps: change.steps,
    rewritten: change.rewritten,
    modes: change.modes,
  };
}

/** The deed line of a change DTO, or nothing at all when there is no change to file. */
export function changeDeedLine(change: ChangeDto | null): string | null {
  return change === null ? null : deedLine(changeDeed(change));
}
