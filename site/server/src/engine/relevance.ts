/**
 * Relevance: what happens to a change whose base moved (ARCHITECTURE.md §6A.7, ADR-016).
 *
 * Deterministic and model-free. Strict FIFO guarantees that by the time change #7 is
 * processed, changes #1–#6 have rewritten the text it was written about — so "the base
 * moved" is the normal case, not an error path. This module answers *how* it moved; only
 * the writer may answer whether the intent still describes a defect.
 */

import type { Relevance, RelevanceGrade } from '@book/shared';

export type RelevanceInput = {
  baseRev: number;
  baseBlocks: string[];
  anchor: { blockIds: string[]; quote: string } | null;
  current: {
    rev: number;
    blocks: Array<{ id: string; hash: string; text: string }>;
    text: string;
  };
};

function share(present: number, total: number): number {
  if (total === 0) return 1;
  return Math.round((present / total) * 1000) / 1000;
}

function anchorState(input: RelevanceInput): 'intact' | 'moved' | 'edited' | 'gone' {
  const anchor = input.anchor;
  if (anchor === null) {
    // A chapter-level change has no paragraph to lose; its anchor is the chapter itself.
    return input.current.rev === input.baseRev ? 'intact' : 'moved';
  }
  const ids = new Set(input.current.blocks.map((block) => block.id));
  if (anchor.blockIds.some((id) => ids.has(id))) return 'intact';
  const quote = anchor.quote.trim();
  if (quote.length > 0 && input.current.text.includes(quote)) {
    return input.current.rev === input.baseRev ? 'intact' : 'moved';
  }
  return 'gone';
}

/**
 * The four grades the engine may decide alone. `void` is *not* here: "the goal is already
 * true" is a writer judgement with a citation (§6A.7), so the engine can only record
 * evidence and hand the change to the step.
 */
export function gradeRelevance(input: RelevanceInput): Relevance {
  const currentHashes = new Set(input.current.blocks.map((block) => block.hash));
  const present = input.baseBlocks.filter((hash) => currentHashes.has(hash)).length;
  const overlap = share(present, input.baseBlocks.length);
  const anchor = anchorState(input);

  const moved = input.current.rev !== input.baseRev;
  let grade: RelevanceGrade;
  if (!moved) {
    grade = 'fresh';
  } else if (overlap >= 0.8 && anchor !== 'gone') {
    grade = 'rebased';
  } else if (overlap >= 0.4) {
    grade = 'partial';
  } else {
    grade = anchor === 'gone' ? 'unknown' : 'partial';
  }

  const evidence: string[] = [];
  evidence.push(
    moved
      ? `глава переписана: ревизия ${input.baseRev} → ${input.current.rev}`
      : `ревизия не менялась (${input.baseRev})`,
  );
  evidence.push(`сохранилось ${Math.round(overlap * 100)} % абзацев, на которые опиралась правка`);
  if (anchor === 'gone') evidence.push('абзац, к которому относится замечание, в тексте не найден');
  else if (anchor === 'moved') evidence.push('абзац сместился, но его текст в главе остался');
  else if (anchor === 'edited') evidence.push('абзац изменён');

  return {
    grade,
    revAtRecord: input.baseRev,
    revNow: input.current.rev,
    anchor,
    // Only a fresh base needs no judgement: the change was recorded against this exact text.
    applies: grade === 'fresh' ? 'yes' : 'untestable',
    overlap,
    chapterRewritten: moved && overlap < 0.5,
    evidence,
    decidedBy: grade === 'fresh' || grade === 'rebased' ? 'engine' : null,
    reason: null,
  };
}

export type WriterDecision = 'adapt' | 'drop' | 'void';

/**
 * The writer's answer, recorded before any text is touched. `void` is the "already true"
 * judgement; `adapt` narrows the intent to the residual; `drop` says the change is no
 * longer needed and must cite what made it unnecessary.
 */
export function withWriterDecision(relevance: Relevance, decision: WriterDecision, reason: string): Relevance {
  const cited = reason.trim();
  if (cited.length === 0) {
    throw new Error('a relevance decision needs a reason');
  }
  if (decision === 'void') {
    return { ...relevance, grade: 'void', applies: 'no', decidedBy: 'writer', reason: cited };
  }
  if (decision === 'drop') {
    return { ...relevance, applies: 'no', decidedBy: 'writer', reason: cited };
  }
  return { ...relevance, applies: 'partial', decidedBy: 'writer', reason: cited };
}

/** Grade → outcome, in one place so the vocabulary never drifts (§6A.7). */
export function relevanceOutcome(
  relevance: Relevance,
  decision: WriterDecision | null,
): 'applied' | 'adapted' | 'dropped' | 'superseded' {
  if (relevance.grade === 'void') return 'superseded';
  if (relevance.grade === 'fresh' || relevance.grade === 'rebased') return 'applied';
  return decision === 'drop' ? 'dropped' : 'adapted';
}

/** Does the writer have to decide before the text may be touched? */
export function needsWriterDecision(relevance: Relevance): boolean {
  return relevance.grade === 'partial' || relevance.grade === 'unknown' || relevance.grade === 'void';
}
