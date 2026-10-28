/**
 * The two gates on a landed result (BOOK-DOC-65 §3): the same prompts production sends, aimed at
 * a chapter that was **not** written to disk.
 *
 * `buildGatePrompt` takes the landed text as an argument and reads neighbours from the book
 * itself, so a result that only exists in an artifact is judged exactly as a result on disk would
 * be. The index slice is `null`: it is engine-derived and there is no engine here, which the
 * summary states rather than hides.
 *
 * The assignment is the pass's shape as `passLane.ts` builds it for a gate: `pass: 'change'`, the
 * filing's intent, no premise, cycle 0, no note.
 */

import type { Untrusted } from '@book/shared';

import { buildGatePrompt, parseGateAnswer, type BuiltGatePrompt, type GateRoleName } from '../../server/src/writer/gates.ts';
import { SpendCapError } from './metrics.ts';
import type { CallModel } from './modes.ts';
import { record, text } from './shape.ts';
import { saveArtifact } from './store.ts';
import { CYCLE, GATE_MAX_TOKENS, PASS, estimateTokens, type Filing } from './spec.ts';

export type GateRole = GateRoleName;

export const GATE_ROLES: readonly GateRole[] = ['editor', 'consultant'];

export function gateAssignment(chapter: number, intent: Untrusted<string> | null, role: GateRole): Record<string, unknown> {
  return { chapter, pass: PASS, intent, premise: null, cycle: CYCLE, role, note: null };
}

export function gatePromptFor(input: {
  bookRoot: string;
  role: GateRole;
  chapter: number;
  intent: Untrusted<string> | null;
  landedText: string;
}): BuiltGatePrompt {
  return buildGatePrompt({
    bookRoot: input.bookRoot,
    role: input.role,
    chapter: input.chapter,
    assignment: gateAssignment(input.chapter, input.intent, input.role),
    landedText: input.landedText,
    indexSlice: null,
  });
}

export type GateCtx = {
  bookRoot: string;
  pin: { model: string; apiModel: string };
  force: boolean;
  call: CallModel;
  reusable: (name: string, promptSha256: string) => boolean;
};

/**
 * One gate per role per chapter, one attempt each. A gate that cannot read its answer is
 * `GATE_UNPARSED` in the table — the same refusal the lane would make, not a missing cell.
 *
 * The chapter is part of the artifact's name because a ripple lands in more than one: the filing's
 * own chapter and every mandatory chapter the plan named are judged separately, as production
 * dispatches them.
 */
export async function runGatesFor(
  ctx: GateCtx,
  mode: 'A' | 'B',
  filing: Filing,
  target: { chapter: number; text: string },
): Promise<void> {
  for (const role of GATE_ROLES) {
    const name = `gates-${mode}-${filing.label}-ch${String(target.chapter).padStart(2, '0')}-${role}.json`;
    const built = gatePromptFor({
      bookRoot: ctx.bookRoot,
      role,
      chapter: target.chapter,
      intent: { value: filing.intent, untrusted: true } as Untrusted<string>,
      landedText: target.text,
    });
    if (!ctx.force && ctx.reusable(name, built.promptSha256)) {
      process.stdout.write(`[gates ${mode} ${filing.label} ch${String(target.chapter)} ${role}] resumed\n`);
      continue;
    }

    let result: Awaited<ReturnType<CallModel>> | null = null;
    let failure: string | null = null;
    try {
      result = await ctx.call(
        [
          { role: 'system', content: built.system },
          { role: 'user', content: built.user },
        ],
        GATE_MAX_TOKENS,
        `gate ${mode} ${filing.label} ch${String(target.chapter)} ${role}`,
      );
    } catch (error) {
      if (error instanceof SpendCapError) throw error;
      failure = (error as { code?: string }).code ?? 'CALL_FAILED';
    }

    const parsed = result === null ? null : parseGateAnswer(result.text, role);
    // A gate that was cut at the token cap did not answer: its code is the evidence, not a verdict.
    const truncated = result !== null && result.finishReason === 'length' && parsed !== null && !parsed.ok;
    saveArtifact(name, {
      command: 'gates',
      id: `${mode}-${filing.label}-ch${String(target.chapter)}-${role}`,
      run: { mode, chapter: target.chapter, filing: filing.label, role, filingId: filing.id },
      request: {
        model: ctx.pin.model,
        apiModel: ctx.pin.apiModel,
        maxTokens: GATE_MAX_TOKENS,
        promptChars: built.system.length + built.user.length,
        estTokensIn: estimateTokens(built.system.length + built.user.length),
        promptSha256: built.promptSha256,
        prefixSha256: built.prefixSha256 ?? null,
        sections: built.sections.map((section) => ({ id: section.id, chars: section.chars, sha256: section.sha256 })),
        // Stated, not silently skipped: the engine's derived pointer does not exist here.
        indexSlice: null,
      },
      response:
        result === null
          ? null
          : {
              text: result.text,
              finishReason: result.finishReason,
              latencyMs: result.latencyMs,
              usage: { in: result.usage.promptTokens, out: result.usage.completionTokens, cachedIn: result.usage.cacheHit },
            },
      parsed:
        parsed === null
          ? { ok: false, code: failure ?? 'CALL_FAILED', findings: [] }
          : parsed.ok
            ? { ok: true, verdict: parsed.verdict, findings: parsed.findings }
            : truncated
              ? {
                  ok: false,
                  code: 'GATE_TRUNCATED',
                  reason: parsed.reason,
                  finishReason: result?.finishReason ?? null,
                  tokens: { in: result?.usage.promptTokens ?? 0, out: result?.usage.completionTokens ?? 0 },
                  findings: [],
                }
              : { ok: false, code: parsed.code, reason: parsed.reason, findings: [] },
      metrics: {
        usdBook: result?.cost.usdBook ?? null,
        usdPeak: result?.cost.usdPeak ?? null,
        wallMs: result?.latencyMs ?? null,
        refusal: failure,
      },
    });
  }
}

/** The gate artifact's own verdict, for a caller that wants it without re-reading the file. */
export function gateVerdict(artifact: Record<string, unknown> | null): string | null {
  const parsed = record(artifact?.parsed);
  if (parsed?.ok !== true) return text(parsed?.code);
  return text(parsed.verdict);
}
