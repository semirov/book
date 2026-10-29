/**
 * The words and the matching rules of a reader's own decisions (BOOK-13,
 * BOOK-DOC-4 rule 4).
 *
 * Two jobs, both pure so they can be asserted without a browser:
 *
 * 1. **The summary line** — «правка внесена · главы 7–9 · волна 2 · решением · изменилось 12
 *    абзацев · ваша доля 0,4 %». Every clause is a real field: a refusal has no waves, no
 *    chapters and no share, so the line for one is its public reason and nothing else. A
 *    change makes one wave, so «1 волна» is not printed at all (BOOK-59).
 * 2. **The match** — a `change:decided`/`comment:decision` frame is a broadcast, and it
 *    renders as «ваша правка» only when its comment is one of the viewer's own. The set
 *    comes from the durable record, never from a name: two readers may be called «Аня».
 */

import { formatShare, type MyDecisionDto, type MyDecisionsDto } from '@book/shared';

import { chapterRange } from './changeStatus.ts';
import { plural } from './format.ts';
import { STATE_LINES, STATE_WORDS } from './marginalia.ts';

export type DecisionTone = 'done' | 'live' | 'stopped';
export type DecisionLine = { text: string; tone: DecisionTone };

const STATE: Record<MyDecisionDto['outcome'], { copy: string; tone: DecisionTone }> = {
  applied: { copy: 'правка внесена', tone: 'done' },
  adapted: { copy: 'правка внесена частично', tone: 'done' },
  // BOOK-137 — a filing on the canon sentence was decided as paperwork: «рассмотрено», never
  // «внесена», because no letter of the sentence changed. The reason on the line says the mode.
  registered: { copy: STATE_WORDS.registered, tone: 'done' },
  // BOOK-173 §5 — the rewrite came back unchanged: considered, paid for, nothing written, so the
  // record keeps the register's word for a filing that moved no letter (`registered`), not «внесено».
  'no-op': { copy: STATE_WORDS.registered, tone: 'done' },
  // BOOK-218 — the module's own line under the word, never a second copy of it.
  queued: { copy: `${STATE_WORDS.accepted} · ${STATE_LINES.accepted}`, tone: 'live' },
  dropped: { copy: 'правка снята', tone: 'stopped' },
  superseded: { copy: 'правка перекрыта более поздней правкой', tone: 'stopped' },
  failed: { copy: 'не удалось внести', tone: 'stopped' },
  refused: { copy: 'правка не принята', tone: 'stopped' },
};

/** BOOK-7 — a premise's own words: it is the chapter's starting point, not an edit of text. */
const PREMISE_STATE: Partial<Record<MyDecisionDto['outcome'], { copy: string; tone: DecisionTone }>> = {
  // BOOK-218 — the module's own word for the fact, never a literal of it.
  queued: { copy: `${STATE_WORDS.accepted} в основу`, tone: 'live' },
  applied: { copy: 'замысел учтён', tone: 'done' },
  dropped: { copy: 'замысел не взят', tone: 'stopped' },
  superseded: { copy: 'замысел снят', tone: 'stopped' },
};

/** `7` → «глава 7», `7,8,9` → «главы 7–9»; nothing when no chapter was reached. */
export function chaptersCopy(chapters: readonly number[]): string | null {
  if (chapters.length === 0) return null;
  return `${chapters.length === 1 ? 'глава' : 'главы'} ${chapterRange(chapters)}`;
}

/**
 * BOOK-59 — a change makes one wave, so «1 волна» is a number that is always one and tells a
 * reader nothing. Only a wave above the bound is news, and it got there by a decision.
 */
export function wavesCopy(waves: number | null): string | null {
  if (waves === null || waves <= 1) return null;
  return `волна ${waves} · решением`;
}

export function blocksCopy(blocks: number | null): string | null {
  if (blocks === null || blocks <= 0) return null;
  if (blocks === 1) return 'изменился 1 абзац';
  return `изменилось ${blocks} ${plural(blocks, 'абзац', 'абзаца', 'абзацев')}`;
}

/** `2026-10-20` → «20.10» — the day the number was measured, not the day of the decision. */
export function measuredDayCopy(day: string): string {
  return `${day.slice(8, 10)}.${day.slice(5, 7)}`;
}

/**
 * «ваша доля 0,4 %», and — when the last measurement before the decision differs from the
 * current one — that number with the day it was actually taken: «на 20.10 было 0,3 %».
 * A daily measurement may be older than the fact beside it, so it never borrows its moment.
 */
export function shareCopy(decision: MyDecisionDto, shareNow: number): string {
  const now = `ваша доля ${formatShare(shareNow)}`;
  const measured = decision.shareAtDecision;
  if (measured === null || measured.share === shareNow) return now;
  return `${now} · на ${measuredDayCopy(measured.day)} было ${formatShare(measured.share)}`;
}

/**
 * The one sentence the reader sees about their own intervention. A refusal is its public
 * reason; an applied change is where it reached, how far it ran, what it changed, and how
 * much of the text is still the reader's.
 */
export function decisionLine(decision: MyDecisionDto, shareNow: number): DecisionLine {
  // BOOK-7: a premise has no waves and no paragraphs of its own, so its line never borrows
  // the applied-change sentence; it says what really happened — в основу, or снят with why.
  if (decision.premise) {
    const state = PREMISE_STATE[decision.outcome] ?? { copy: 'замысел', tone: 'stopped' as DecisionTone };
    const parts: Array<string | null> = [state.copy];
    if (decision.outcome === 'queued') {
      parts.push(`ждёт первой редакции главы ${decision.chapter}`);
    } else if (decision.outcome === 'applied') {
      parts.push(chaptersCopy(decision.chapters), shareCopy(decision, shareNow));
    } else if (decision.reason !== null) {
      parts.push(decision.reason);
    }
    return {
      text: withReport(parts, decision),
      tone: state.tone,
    };
  }
  const state = STATE[decision.outcome];
  const parts: Array<string | null> = [state.copy];

  if (decision.outcome === 'applied' || decision.outcome === 'adapted') {
    parts.push(
      chaptersCopy(decision.chapters),
      wavesCopy(decision.waves),
      blocksCopy(decision.blocks),
      shareCopy(decision, shareNow),
    );
  } else if (decision.reason !== null) {
    parts.push(decision.reason);
  }

  return { text: withReport(parts, decision), tone: state.tone };
}

/**
 * The row's sentence: the summary's own clauses, then the one reason line when the summary does
 * not already carry it (BOOK-218 — never two verdicts on one row).
 */
function withReport(parts: Array<string | null>, decision: MyDecisionDto): string {
  const collected = parts.filter((part): part is string => part !== null && part.length > 0);
  const reason = decision.reason ?? null;
  if (reason !== null && reason.length > 0 && !collected.some((part) => part.includes(reason))) {
    collected.push(reason);
  }
  return collected.join(' · ');
}

/** The viewer's own comment ids: decided ones plus the ones still waiting. */
export function ownCommentIds(decisions: MyDecisionsDto | null): Set<string> {
  const ids = new Set<string>();
  if (decisions === null) return ids;
  for (const item of decisions.items) ids.add(item.commentId);
  for (const id of decisions.open) ids.add(id);
  return ids;
}

/** The two frames that carry a decision about a comment. */
const DECISION_FRAMES = new Set(['change:decided', 'comment:decision']);

/**
 * Does this frame concern the viewer's own intervention? `change:decided` names the comment
 * in `commentId`; `comment:decision` in `id`. Anything else — including a frame about
 * somebody else — is not the viewer's, and must never render as «ваша правка».
 */
export function isOwnDecision(data: unknown, own: ReadonlySet<string>): boolean {
  if (own.size === 0 || data === null || typeof data !== 'object') return false;
  const value = data as { commentId?: unknown; id?: unknown };
  for (const candidate of [value.commentId, value.id]) {
    if (typeof candidate === 'string' && own.has(candidate)) return true;
  }
  return false;
}

/**
 * One fact the page hands to the reader's own record: a reconnect (`hello`), a fresh post,
 * or a socket frame.
 */
export type ReaderRecordEvent =
  | { kind: 'hello'; signedIn: boolean }
  | { kind: 'posted'; signedIn: boolean }
  | { kind: 'frame'; type: string; data: unknown };

/**
 * What the page does with that fact: `refresh` the durable record, `drop` it (the viewer is
 * signed out), or `ignore` it.
 *
 * The rule that matters is the frame one: a decision frame is a broadcast, so it may only
 * reload the record when it names one of the viewer's own comments. A reconnect always
 * reloads — the record may have changed while the socket was down — and an anonymous
 * reconnect drops what is on screen. A frame of any other type never touches the record.
 */
export function readerRecordAction(
  event: ReaderRecordEvent,
  own: ReadonlySet<string>,
): 'refresh' | 'drop' | 'ignore' {
  if (event.kind === 'hello') return event.signedIn ? 'refresh' : 'drop';
  if (event.kind === 'posted') return event.signedIn ? 'refresh' : 'ignore';
  if (!DECISION_FRAMES.has(event.type)) return 'ignore';
  return isOwnDecision(event.data, own) ? 'refresh' : 'ignore';
}
