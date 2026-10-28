/**
 * The writing phase of a pass (BOOK-173 §0, §2, §5): one session, one mode, one answer path.
 *
 * It was inside `pass.ts` and had to move out — the pass was at the 500-line wall — and it now
 * owns a decision the old code did not have: **patch first** for a phrase-scope filing on a
 * written chapter, rewrite otherwise (`mode.ts` chose before we got here).
 *
 * Patch path, in order: build the prompt from blocks with ids, ask, parse (`protocol.ts`),
 * apply (`apply.ts`), check integrity (`integrity.ts`), then the existing `validateAnswer` on
 * the post-apply text — the gates' authority is not re-implemented, only reused. One refusal
 * buys one repair turn in the same session (the prefix cannot move); a second refusal parks.
 * A model that answers `mode:"rewrite"` is obeyed in the same pass, with no patch retry.
 *
 * Rewrite path: today's — one draft, one repair with the reason, then continuations until the
 * chapter passes the thin line. Continuations now append a turn to the same session instead of
 * rebuilding a prompt: the model already wrote that prose in this conversation, so the prefix
 * it was charged for stays the same.
 */

import { readChapter } from '../engine/text.ts';
import type { Answer, Lane } from './passLane.ts';
import type { BuiltPrompt } from './prompt.ts';
import type { ModeChoice, ModeReason, WriteMode } from './mode.ts';
import { MODEL_REWRITE } from './mode.ts';
import type { PatchPrompt } from './patch/prompt.ts';
import { declaredPatchMode, parsePatchAnswer } from './patch/protocol.ts';
import { applyPatch } from './patch/apply.ts';
import { danglingReference, factsIntact, neighbourDigests, neighbourMoved } from './patch/integrity.ts';
import { mergeContinuation, finalize, isThin } from './prose.ts';
import { continuationInstruction, headOf, openSession, repairInstruction } from './session.ts';
import type { PatchReceipt } from './transcript.ts';

/** How much already-written prose a repair is shown: context, never a second chapter. */
const REPAIR_TAIL_CHARS = 1_500;

export type PatchSummary = PatchReceipt;

export type WriteOutcome =
  | { ok: true; text: string; mode: WriteMode; modeReason: ModeReason; patch: PatchSummary | null }
  | { ok: false; code: string; detail: string; cause: 'failed' | 'refused'; mode: WriteMode; patch: PatchSummary | null };

export type WritePhaseInput = {
  lane: Lane;
  bookRoot: string;
  chapter: number;
  mode: ModeChoice;
  rewrite: BuiltPrompt;
  /** Built only for patch mode; `null` otherwise. */
  patch: PatchPrompt | null;
  continueMax: number;
  patchMaxFraction: number;
  patchMaxEdits: number;
};

/** The last characters of a chapter, told apart from an instruction by their own fence. */
function tailContext(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= REPAIR_TAIL_CHARS ? trimmed : trimmed.slice(-REPAIR_TAIL_CHARS).trimStart();
}

/** What an attempt that ran to an answer produced; `rewrite` is not an answer, it is a request. */
type OutcomeAttempt =
  | { kind: 'applied'; text: string; patch: PatchSummary }
  | { kind: 'refused'; code: string; detail: string; cause: 'failed' | 'refused' };

type Attempt = OutcomeAttempt | { kind: 'rewrite' };

/**
 * The patch attempt: one answer, one repair, and every refusal in the transcript's own words.
 * A validator refusal is final (`PATCH_REJECTED:<CODE>`): it means the patched chapter is not a
 * chapter, and a second guess at the same base is not worth a call.
 */
async function patchAttempt(input: WritePhaseInput, prompt: PatchPrompt): Promise<Attempt> {
  const { lane, chapter, bookRoot } = input;
  const own = readChapter(bookRoot, chapter);
  const beforeBlocks = own.blocks.map((block) => ({ id: block.id, text: block.text }));
  const neighbours = neighbourDigests(bookRoot, chapter);
  const session = openSession({ system: prompt.system, user: prompt.user });

  let answer = await lane.ask('draft', session.messages(), 'draft');
  let previous = '';
  let failure: { code: string; detail: string } | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0 && failure !== null) {
      const turn = session.append({
        kind: 'repair',
        assistant: headOf(previous),
        user: repairInstruction(failure.code, failure.detail, tailContext(own.raw)),
      });
      if (!turn.ok) return { kind: 'refused', code: turn.code, detail: turn.detail, cause: 'failed' };
      answer = await lane.ask('repair', turn.messages, 'repair');
    }
    previous = answer.text;
    if (declaredPatchMode(answer.text) === 'rewrite') return { kind: 'rewrite' };

    const parsed = parsePatchAnswer(answer.text, { maxEdits: input.patchMaxEdits });
    if (!parsed.ok) {
      failure = { code: parsed.code, detail: parsed.detail };
      continue;
    }
    const applied = applyPatch({ chapter, text: own.raw, patch: parsed.patch, maxFraction: input.patchMaxFraction });
    if (!applied.ok) {
      failure = { code: applied.code, detail: applied.detail };
      continue;
    }
    const dangling = danglingReference({ blocks: beforeBlocks, edits: parsed.patch.edits });
    if (!dangling.ok) {
      failure = { code: dangling.code, detail: dangling.detail };
      continue;
    }
    const facts = factsIntact({ text: applied.text, patch: parsed.patch });
    if (!facts.ok) {
      failure = { code: facts.code, detail: facts.detail };
      continue;
    }
    // The one prose judge stays the pass's: the same five checks, reused, never re-implemented.
    const checked = lane.check(applied.text, null);
    if (!checked.ok) {
      return { kind: 'refused', code: `PATCH_REJECTED:${checked.code}`, detail: checked.reason, cause: 'failed' };
    }
    // The prompt was built from neighbours as they were; a moved one means another book.
    if (neighbourMoved(bookRoot, chapter, neighbours)) {
      return {
        kind: 'refused',
        code: 'PATCH_NEIGHBOUR_MOVED',
        detail: `a neighbour of chapter ${String(chapter)} changed while the patch was being written`,
        cause: 'failed',
      };
    }
    return {
      kind: 'applied',
      text: finalize(checked.text),
      patch: {
        edits: parsed.patch.edits.length,
        changedChars: applied.changedChars,
        fraction: applied.fraction,
        facts: parsed.patch.facts.length,
        note: parsed.patch.note,
        dangling: dangling.skipped,
      },
    };
  }
  const last = failure ?? { code: 'PATCH_UNPARSED', detail: 'the patch attempt produced no answer' };
  return { kind: 'refused', ...last, cause: 'failed' };
}

/** The rewrite: one draft, one repair with the reason, then continuations in the same session. */
async function rewrite(input: WritePhaseInput): Promise<OutcomeAttempt> {
  const { lane, chapter } = input;
  const session = openSession({ system: input.rewrite.system, user: input.rewrite.user });
  const first = await lane.ask('draft', session.messages(), 'draft');
  let checked: Answer = lane.check(first.text, first.finishReason);
  if (!checked.ok) {
    const reason = checked.reason;
    const turn = session.append({
      kind: 'repair',
      assistant: headOf(first.text),
      user: repairInstruction(checked.code, reason, tailContext(readChapter(input.bookRoot, chapter).raw)),
    });
    if (!turn.ok) return { kind: 'refused', code: turn.code, detail: turn.detail, cause: 'failed' };
    const second = await lane.ask('repair', turn.messages, 'repair');
    checked = lane.check(second.text, second.finishReason);
    if (!checked.ok) {
      return {
        kind: 'refused',
        code: checked.code,
        detail: `ответ модели не прошёл проверку: ${checked.code}: ${checked.reason}`.slice(0, 300),
        cause: checked.code === 'ANSWER_REFUSAL' ? 'refused' : 'failed',
      };
    }
  }

  let text = finalize(checked.text);
  let continuations = 0;
  while (continuations < input.continueMax && isThin(chapter, text)) {
    const turn = session.append({ kind: 'continue', assistant: text, user: continuationInstruction() });
    if (!turn.ok) return { kind: 'refused', code: turn.code, detail: turn.detail, cause: 'failed' };
    const more = await lane.ask('continue', turn.messages, 'continue');
    const next = lane.check(mergeContinuation(chapter, text, more.text), more.finishReason);
    // A continuation that breaks a rule is dropped: the chapter that validates already stands.
    if (!next.ok || next.text.length <= text.length) break;
    text = finalize(next.text);
    continuations += 1;
  }
  return { kind: 'applied', text, patch: { edits: 0, changedChars: 0, fraction: 0, facts: 0, note: null, dangling: null } };
}

/**
 * Run the writing phase for one pass. A refusal is a typed outcome; a transport failure still
 * throws, as `lane.ask` does, and the pass parks it with its own code.
 */
export async function writeChapter(input: WritePhaseInput): Promise<WriteOutcome> {
  let mode = input.mode;
  const first: Attempt =
    mode.mode === 'patch' && input.patch !== null ? await patchAttempt(input, input.patch) : { kind: 'rewrite' };
  let attempt: OutcomeAttempt;
  if (first.kind === 'rewrite') {
    // The model asks for the whole-chapter path: honour it in this pass, one step, no retry.
    if (mode.mode === 'patch') mode = MODEL_REWRITE;
    attempt = await rewrite(input);
  } else {
    attempt = first;
  }

  if (attempt.kind === 'refused') {
    return { ok: false, code: attempt.code, detail: attempt.detail, cause: attempt.cause, mode: mode.mode, patch: null };
  }
  return {
    ok: true,
    text: attempt.text,
    mode: mode.mode,
    modeReason: mode.reason,
    patch: mode.mode === 'patch' ? attempt.patch : null,
  };
}
