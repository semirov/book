/**
 * Mode **B**: the surgical patch, through the modules the other lane builds (BOOK-DOC-65 §1–§2).
 *
 * The signatures are frozen by the design note, so this file is written against them and not
 * around them:
 *
 *   buildPatchPrompt({bookRoot, chapter, assignment}) → {system, user, prefixSha256, promptSha256, sections, blocks}
 *   parsePatchAnswer(raw, opts?) → {ok:true, patch} | {ok:false, code, detail}
 *   applyPatch({chapter, text, patch, maxFraction?}) → {ok:true, text, changedChars, fraction, edits} | {ok:false, code, detail}
 *
 * The import is dynamic and guarded. The modules are being written in a parallel lane; if they
 * are absent when a run happens, the honest result is a **BLOCKED** row naming what is missing —
 * never a local second implementation of the protocol or the applier. A patch accepted by a
 * forked applier would prove nothing about the one that ships.
 */

import { sha256Hex } from '../../server/src/util/hash.ts';
import type { AssignmentData } from './promptA.ts';

export type PatchSection = { id: string; chars: number; sha256: string };

export type PatchPrompt = {
  system: string;
  user: string;
  prefixSha256: string;
  promptSha256: string;
  sections: PatchSection[];
  blocks: string[];
};

export type PatchParse = { ok: true; patch: unknown } | { ok: false; code: string; detail: string };

export type PatchApply =
  | { ok: true; text: string; changedChars: number; fraction: number; edits: number }
  | { ok: false; code: string; detail: string };

type PatchModule = {
  buildPatchPrompt?: (input: { bookRoot: string; chapter: number; assignment: unknown }) => Partial<PatchPrompt>;
  parsePatchAnswer?: (raw: string, opts?: unknown) => PatchParse;
  applyPatch?: (input: { chapter: number; text: string; patch: unknown; maxFraction?: number }) => PatchApply;
};

export type PatchModules = {
  buildPatchPrompt: NonNullable<PatchModule['buildPatchPrompt']>;
  parsePatchAnswer: NonNullable<PatchModule['parsePatchAnswer']>;
  applyPatch: NonNullable<PatchModule['applyPatch']>;
};

export type PatchLoad = { ok: true; modules: PatchModules } | { ok: false; blocked: string };

const PATCH_DIR = '../../server/src/writer/patch';

/**
 * The three modules, or the exact reason they cannot be used. A module that exists but has a
 * different shape is the same refusal as a missing one: `BLOCKED: patch/protocol.ts exports no
 * parsePatchAnswer`.
 */
export async function loadPatchModules(): Promise<PatchLoad> {
  const missing: string[] = [];
  const loaded: PatchModule = {};
  try {
    const prompt = (await import(`${PATCH_DIR}/prompt.ts`)) as PatchModule;
    if (typeof prompt.buildPatchPrompt === 'function') loaded.buildPatchPrompt = prompt.buildPatchPrompt;
    else missing.push('patch/prompt.ts exports no buildPatchPrompt');
  } catch {
    missing.push('patch/prompt.ts is absent');
  }
  try {
    const protocol = (await import(`${PATCH_DIR}/protocol.ts`)) as PatchModule;
    if (typeof protocol.parsePatchAnswer === 'function') loaded.parsePatchAnswer = protocol.parsePatchAnswer;
    else missing.push('patch/protocol.ts exports no parsePatchAnswer');
  } catch {
    missing.push('patch/protocol.ts is absent');
  }
  try {
    const apply = (await import(`${PATCH_DIR}/apply.ts`)) as PatchModule;
    if (typeof apply.applyPatch === 'function') loaded.applyPatch = apply.applyPatch;
    else missing.push('patch/apply.ts exports no applyPatch');
  } catch {
    missing.push('patch/apply.ts is absent');
  }
  if (missing.length > 0) return { ok: false, blocked: missing.join('; ') };
  return {
    ok: true,
    modules: {
      buildPatchPrompt: loaded.buildPatchPrompt as PatchModules['buildPatchPrompt'],
      parsePatchAnswer: loaded.parsePatchAnswer as PatchModules['parsePatchAnswer'],
      applyPatch: loaded.applyPatch as PatchModules['applyPatch'],
    },
  };
}

/**
 * The builder's own sections, with the two hashes the design note requires. A builder that does
 * not compute them is not refused — `sha256(system)` is the same fact — but a builder that has
 * no `system`/`user` at all is.
 */
export function patchPromptOf(
  modules: PatchModules,
  input: { bookRoot: string; chapter: number; assignment: AssignmentData & { scopeHint: string } },
): PatchPrompt {
  const built = modules.buildPatchPrompt({
    bookRoot: input.bookRoot,
    chapter: input.chapter,
    assignment: input.assignment,
  });
  if (typeof built.system !== 'string' || typeof built.user !== 'string') {
    throw new Error('BLOCKED: buildPatchPrompt returned no system/user');
  }
  const prefixSha256 = typeof built.prefixSha256 === 'string' ? built.prefixSha256 : sha256Hex(built.system);
  const promptSha256 =
    typeof built.promptSha256 === 'string' ? built.promptSha256 : sha256Hex(`${built.system}\n\n${built.user}`);
  return {
    system: built.system,
    user: built.user,
    prefixSha256,
    promptSha256,
    sections: Array.isArray(built.sections) ? built.sections : [],
    blocks: Array.isArray(built.blocks) ? built.blocks : [],
  };
}

/** The applier's own numbers, read once: `edits` may be the list or its length. */
export function normalizeApply(result: PatchApply): PatchApply {
  if (!result.ok) return result;
  const raw = result as unknown as { edits?: unknown };
  const edits = Array.isArray(raw.edits) ? raw.edits.length : Number(raw.edits ?? 0);
  return {
    ok: true,
    text: result.text,
    changedChars: Number(result.changedChars ?? 0),
    fraction: Number(result.fraction ?? 0),
    edits: Number.isFinite(edits) ? edits : 0,
  };
}
