/**
 * The ripple's small, provable pieces (BOOK-173, BOOK-DOC-75 §3–§5): the reaction to a plan, the
 * judge's prompt and its strict parse, and the five verification checks. No engine, no model, no
 * manuscript — these are the rules a larger test would otherwise only exercise by luck.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from '../../../src/db/db.ts';
import { assertDependency } from '../../../src/ledger/graph/edges.ts';
import type { RipplePlan } from '../../../src/ledger/graph/plan.ts';
import {
  JUDGE_MAX_EDGES,
  JUDGE_MAX_NODES,
  buildJudgePrompt,
  parseJudgeAnswer,
} from '../../../src/writer/ripple/judge.ts';
import {
  RIPPLE_CHAPTER_USD,
  affectedChapters,
  planLine,
  priceOf,
  reactToLanding,
  wideSentence,
} from '../../../src/writer/ripple/planAfterPatch.ts';
import { afterPatch } from '../../../src/writer/ripple/afterPatch.ts';
import { readLedgerFacts, verifyRipple } from '../../../src/writer/ripple/verify.ts';
import type { Lane } from '../../../src/writer/passLane.ts';
import type { WriterAssignment } from '@book/shared';
import { AT, ledgerFixture, seedChange, seedChapter, type LedgerFixture } from '../../ledger/helpers.ts';

const BOOK_ROOT = new URL('../../../../..', import.meta.url).pathname;

/** A plan with the shape the engine freezes, narrowed to what these rules read. */
function plan(overrides: Partial<RipplePlan> = {}): RipplePlan {
  const node = (factId: string, chapter: number, mandatory: boolean, reason: string) => ({
    factId,
    chapter,
    blockId: `ch${String(chapter)}#a1`,
    mandatory,
    reason: reason as never,
    direction: 'forward' as never,
    hops: 1,
    via: [],
    quote: `утверждение ${factId}`,
  });
  return {
    changeId: 'chg_1',
    chapter: 5,
    outcome: 'ripple',
    proven: true,
    seeds: [{ factId: 'f:seed', chapter: 5, blockId: 'ch05#a1', changed: ['status'] }],
    nodes: [node('f:a', 12, true, 'CAUSE_CHANGED:edg_1'), node('f:b', 19, false, 'TONE')],
    edges: ['edg_1'],
    edgeDetail: [{ id: 'edg_1', from: 'f:seed', to: 'f:a', kind: 'references', on: 'status', statement: '' }],
    patches: [],
    closureSize: { nodes: 3, edges: 1, chapters: 3, parts: 1 },
    chaptersTouched: [5, 12, 19],
    bounds: { chars: 4_000, usd: 0.6, iterations: 4, nodes: 1_500, edges: 3_000 },
    unresolved: [],
    truncated: false,
    ...overrides,
  };
}

describe('reactToLanding — three outcomes, one sentence each', () => {
  it('continues when the engine planned nothing or the change is local', () => {
    expect(reactToLanding(null)).toEqual({ kind: 'continue' });
    expect(reactToLanding(plan({ outcome: 'local' }))).toEqual({ kind: 'continue' });
  });

  it('prints the plan line for a ripple: chapters, mandatory, optional, price', () => {
    const reaction = reactToLanding(plan());
    expect(reaction.kind).toBe('ripple');
    expect(planLine(plan())).toBe('правка задела 2 глав · 1 обязательных · 1 отсрочиваемых · $0.14');
    expect(priceOf(plan())).toBe(RIPPLE_CHAPTER_USD);
  });

  it('names the nearest consequence in the wide sentence, and says the point patch stays', () => {
    const sentence = wideSentence(plan({ outcome: 'wide' }));
    expect(sentence).toContain('это меняет причину в главе 12');
    expect(sentence).toContain('нужен широкий проход, его решает автор');
    expect(sentence).toContain('правка на месте уже в книге (глава 5)');
    expect(affectedChapters(plan())).toEqual([12, 19]);
    expect(reactToLanding(plan({ outcome: 'wide' })).kind).toBe('wide');
  });
});

describe('afterPatch — the pass’s three reactions', () => {
  type Asked = Array<{ kind: string; system: string; user: string }>;

  function lane(answer: string, asked: Asked): Lane {
    return {
      emit: async () => undefined,
      ask: async (kind: string, messages: Array<{ role: string; content: string }>) => {
        asked.push({
          kind,
          system: messages.find((message) => message.role === 'system')?.content ?? '',
          user: messages.find((message) => message.role === 'user')?.content ?? '',
        });
        return { text: answer } as never;
      },
    } as unknown as Lane;
  }

  const job = { stepId: 'stp_1', changeId: 'chg_1' } as WriterAssignment;
  const base = { chapter: 5, job, bookRoot: BOOK_ROOT, now: () => Date.parse('2026-10-28T00:00:00Z'), log: () => undefined };

  it('parks a wide before any call, and says the point patch stays', async () => {
    const asked: Asked = [];
    const result = await afterPatch({ ...base, lane: lane('HOLDS', asked), plan: plan({ outcome: 'wide' }) });
    expect(result.kind).toBe('park');
    if (result.kind === 'park') {
      expect(result.sentence).toContain('нужен широкий проход');
      expect(result.sentence).toContain('план: 2 глав');
      expect(result.cause).toBeUndefined();
    }
    expect(asked).toEqual([]);
  });

  it('continues on HOLDS, having asked exactly one judge call over the closure', async () => {
    const asked: Asked = [];
    const result = await afterPatch({ ...base, lane: lane('HOLDS', asked), plan: plan() });
    expect(result).toEqual({ kind: 'continue' });
    expect(asked.map((call) => call.kind)).toEqual(['judge']);
    expect(asked[0]?.user).toContain('утверждение f:a');
  });

  it('parks a judge that could not be understood — a refusal is never HOLDS', async () => {
    const asked: Asked = [];
    const result = await afterPatch({ ...base, lane: lane('мне кажется, всё держится', asked), plan: plan() });
    expect(result.kind).toBe('park');
    if (result.kind === 'park') {
      expect(result.cause).toBe('refused');
      expect(result.sentence).toContain('судья причинности не смог ответить');
    }
  });

  it('carries a GAP sentence into the escalation', async () => {
    const result = await afterPatch({
      ...base,
      lane: lane('GAP: «допуск выдан» в главе 12 стало ложным', []),
      plan: plan(),
    });
    expect(result).toMatchObject({ kind: 'park', cause: 'refused' });
    if (result.kind === 'park') expect(result.sentence).toBe('замыкание не держится: «допуск выдан» в главе 12 стало ложным');
  });
});

describe('the causality judge', () => {
  it('shows the closure, never a chapter, and keeps the caps', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      factId: `f:${String(index)}`,
      chapter: 12,
      blockId: null,
      mandatory: index % 2 === 0,
      reason: 'CAUSE_CHANGED:edg' as never,
      direction: 'forward' as never,
      hops: 1,
      via: [],
      quote: 'ц'.repeat(200),
    }));
    const edges = Array.from({ length: 40 }, (_, index) => ({
      id: `edg_${String(index)}`,
      from: 'f:seed',
      to: `f:${String(index)}`,
      kind: 'references',
      on: 'status',
      statement: 'свидетельство',
    }));
    const prompt = buildJudgePrompt({ bookRoot: BOOK_ROOT, plan: plan({ nodes: many, edgeDetail: edges }) });
    expect(prompt.nodes).toBe(JUDGE_MAX_NODES);
    expect(prompt.edges).toBe(JUDGE_MAX_EDGES);
    expect(prompt.user.split('\n').filter((line) => line.includes('· глава'))).toHaveLength(JUDGE_MAX_NODES);
    // Quotes are clipped, and the three questions travel verbatim.
    expect(prompt.user).toContain('ц'.repeat(119) + '…');
    expect(prompt.user).toContain('назови предложение, которое стало ложным');
    expect(prompt.user).toContain('назови, кто решает в цепочке');
    expect(prompt.user).toContain('назови необратимое изменение каждой затронутой главы');
    // The prefix is the pass's own cache prefix: canon, then the writer's role, then the protocol.
    expect(prompt.prefixSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(prompt.system).toContain('## Что вернуть');
  });

  it('parses strictly: HOLDS, GAP with a sentence, and a refusal for anything else', () => {
    expect(parseJudgeAnswer('HOLDS')).toEqual({ ok: true, verdict: 'HOLDS', sentence: null });
    expect(parseJudgeAnswer('  HOLDS.\n')).toEqual({ ok: true, verdict: 'HOLDS', sentence: null });
    expect(parseJudgeAnswer('GAP: «допуск выдан» в главе 12 стало ложным')).toEqual({
      ok: true,
      verdict: 'GAP',
      sentence: '«допуск выдан» в главе 12 стало ложным',
    });
    for (const broken of ['', 'holds: maybe', '{"verdict":"HOLDS"}', 'GAP', 'GAP:', 'Я думаю, что всё держится']) {
      const verdict = parseJudgeAnswer(broken);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/^JUDGE_(EMPTY|UNPARSED):/u);
    }
  });
});

describe('the verification after a chapter lands', () => {
  let fixture: LedgerFixture;
  let db: Db;

  afterEach(() => {
    db.close();
    fixture.close();
  });

  function open(): void {
    fixture = ledgerFixture();
    db = fixture.db;
    seedChapter(db, { chapter: 5, texts: ['Допуск выдан.'], at: AT });
    seedChapter(db, { chapter: 12, texts: ['Допуск всё ещё выдан.'], at: AT });
    seedChapter(db, { chapter: 19, texts: ['По допуску платят.'], at: AT });
  }

  function fact(id: string, chapter: number, kind = 'state', validFrom = chapter): void {
    db.prepare(
      `INSERT INTO facts (id, chapter, kind, statement, valid_from_chapter, created_at)
       VALUES (?, ?, ?, 'утверждение', ?, ?)`,
    ).run(id, chapter, kind, validFrom, AT);
  }

  function use(factId: string, chapter: number): void {
    const block = db.prepare('SELECT id FROM blocks WHERE chapter = ?').get(chapter) as { id: string };
    db.prepare(
      `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, role, witness, edge_path)
       VALUES (?, ?, ?, 0, 2, 'fact', ?, 'use', 'ут', '[]')`,
    ).run(`span_${factId}_${String(chapter)}`, block.id, chapter, factId);
  }

  const ok = (): boolean => true;

  it('passes a closed ledger whose every changed chapter is irreversible', () => {
    open();
    fact('f:seed', 5, 'document');
    fact('f:a', 12, 'document');
    fact('f:b', 19, 'decision');
    assertDependency(db, { from: 'f:seed', to: 'f:a', chapter: 12, kind: 'references', onComponent: 'status' });
    const result = verifyRipple({
      plan: plan(),
      recomputed: plan(),
      changedChapters: [5, 12, 19],
      facts: readLedgerFacts(db),
      frameOk: ok,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('names a dangling endpoint, an early use, a lost irreversible row, a changed frame and drift', () => {
    open();
    fact('f:seed', 5, 'state');
    fact('f:a', 12, 'state');
    fact('f:b', 19, 'state');
    // A fact that left the book while an edge still names it: `FACT_DANGLING`, not a crash — facts
    // are retired, never deleted, and an edge whose endpoint was invalidated is the same dangling.
    const retired = seedChange(db, { id: 'chg_retire', chapter: 5 });
    fact('f:gone', 12, 'state');
    db.prepare('UPDATE facts SET invalidated_at = ?, invalidated_by_change = ? WHERE id = ?').run(AT, retired, 'f:gone');
    assertDependency(db, { from: 'f:seed', to: 'f:gone', chapter: 12, kind: 'references' });
    fact('f:late', 19, 'state');
    use('f:late', 12);
    const result = verifyRipple({
      plan: plan(),
      recomputed: plan({ nodes: [...plan().nodes, { ...plan().nodes[0]!, factId: 'f:new', chapter: 19, mandatory: false }] }),
      changedChapters: [5, 12, 19],
      facts: readLedgerFacts(db),
      frameOk: (chapter) => chapter !== 12,
    });
    const codes = result.failures.map((failure) => failure.code);
    expect(codes).toContain('FACT_DANGLING');
    expect(codes).toContain('CAUSE_UNSUPPORTED');
    expect(codes).toContain('IRREVERSIBLE_LOST');
    expect(codes).toContain('FRAME_CHANGED');
    expect(codes).toContain('CLOSURE_DRIFT');
    expect(result.ok).toBe(false);
  });

  it('accepts a node that became mandatory while we worked, and rejects an unplanned optional one', () => {
    open();
    fact('f:seed', 5, 'document');
    fact('f:a', 12, 'document');
    const grown = plan({
      nodes: [...plan().nodes, { ...plan().nodes[0]!, factId: 'f:new', chapter: 19, mandatory: true }],
    });
    expect(
      verifyRipple({ plan: plan(), recomputed: grown, changedChapters: [5, 12], facts: readLedgerFacts(db), frameOk: ok })
        .failures.filter((failure) => failure.code === 'CLOSURE_DRIFT'),
    ).toEqual([]);
  });
});
