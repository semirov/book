/**
 * The extraction pass (BOOK-185, BOOK-DOC-77 §2, §4, §5): one chapter read by an injected
 * provider, checked by the validator, written in one transaction and recorded as a run.
 *
 * The provider is fake on purpose — no network, no key, no money. What the tests prove is the
 * contract around it: a reuse asks nothing, a refusal leaves no rows, a repair happens once, and
 * a forced re-run updates in place instead of doubling the graph.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { closure } from '../../src/graph/closure.ts';
import { extractChapter, REPAIR_LINE, type ExtractOutcome, type Provider } from '../../src/graph/extract.ts';
import { ModelError } from '../../src/graph/model.ts';
import { runIdOf, usdOf } from '../../src/graph/runs.ts';
import { idOf } from '../../src/graph/text.ts';
import {
  assertFactsEstablished,
  FactNotEstablishedError,
  usesBeforeEstablishment,
} from '../../src/graph/integrity.ts';
import { countUnboundFactShaped } from '../../src/ledger/factShaped.ts';
import { factAsOf } from '../../src/ledger/facts.ts';
import { ledgerFixture, seedChapter, type LedgerFixture } from '../ledger/helpers.ts';
import {
  ANSWER_CH1,
  ANSWER_CH2,
  ANSWER_CH2_NARROWED,
  ANSWER_CH3,
  AT,
  AT_LATER,
  CH1,
  CH2,
  CH3,
  PIPELINE,
  answerText,
  fakeProvider,
} from './extractFixture.ts';

let fixture: LedgerFixture;

afterEach(() => {
  fixture.close();
});

function seed(texts: Record<number, string[]> = { 1: CH1, 2: CH2, 3: CH3 }): LedgerFixture {
  const seeded = ledgerFixture();
  for (const [chapter, lines] of Object.entries(texts)) {
    seedChapter(seeded.db, { chapter: Number(chapter), texts: lines });
  }
  return seeded;
}

/**
 * One chapter through the pass. The recall is **off** unless a test asks for it: the tests of
 * «one answer, one transaction» are about the first pass, and a second call would double every
 * count they pin. The recall's own tests pass `noRecall: false` and a two-answer provider.
 */
async function run(
  chapter: number,
  answer: unknown,
  over: { provider?: Provider; force?: boolean; dryRun?: boolean; at?: string; noRecall?: boolean } = {},
): Promise<ExtractOutcome> {
  return extractChapter({
    db: fixture.db,
    chapter,
    provider: over.provider ?? fakeProvider(answerText(answer)),
    pipeline: PIPELINE,
    at: over.at ?? AT,
    ...(over.force === undefined ? {} : { force: over.force }),
    ...(over.dryRun === undefined ? {} : { dryRun: over.dryRun }),
    noRecall: over.noRecall ?? true,
  });
}

function rows(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return fixture.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
}

function count(table: string): number {
  return (fixture.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Everything the graph holds, without the run ledger: a refusal must leave this untouched. */
function graphSnapshot(): string {
  return JSON.stringify({
    facts: rows('SELECT * FROM facts ORDER BY id'),
    mentions: rows('SELECT * FROM mentions ORDER BY id'),
    literals: rows('SELECT * FROM literals ORDER BY id'),
    edges: rows('SELECT * FROM fact_dependency ORDER BY id'),
    threads: rows('SELECT * FROM threads ORDER BY id'),
    events: rows('SELECT * FROM thread_events ORDER BY id'),
    chapters: rows('SELECT n, ledger_gap FROM chapters ORDER BY n'),
  });
}

describe('one answer, written in one transaction', () => {
  it('writes the facts, the roles, the witnesses, the literals, the gap and the run', async () => {
    fixture = seed();
    const first = await run(1, ANSWER_CH1);
    expect(first).toMatchObject({ ok: true, reused: false, chapter: 1 });
    if (!first.ok || first.reused || first.dryRun) throw new Error('expected a written run');

    const second = await run(2, ANSWER_CH2);
    expect(second).toMatchObject({ ok: true, reused: false, chapter: 2 });
    if (!second.ok || second.reused || second.dryRun) throw new Error('expected a written run');
    expect(second.counts).toMatchObject({ facts: 2, uses: 1, mentions: 3, edges: 1, threads: 1 });
    expect(second.rejects).toEqual([]);

    const facts = rows('SELECT id, key, chapter, kind, statement, sentence, term, extracted_by FROM facts ORDER BY key');
    expect(facts.map((row) => row.key)).toEqual(['date:2065-09-14', 'document:65-11877-арх', 'document:77-1-арх']);
    const date = facts.find((row) => row.key === 'date:2065-09-14');
    expect(date).toMatchObject({
      id: idOf('fct', 'date:2065-09-14'),
      chapter: 2,
      kind: 'date',
      term: '14.09.2065',
      statement: 'Акт датирован 14.09.2065.',
      sentence: 'Акт датирован 14.09.2065.',
      extracted_by: JSON.stringify({
        run: second.run,
        model: 'deepseek-flash',
        prompt: (rows('SELECT prompt_sha FROM extraction_runs WHERE id = ?', second.run)[0] ?? {}).prompt_sha,
        at: AT,
        pass: 'extract',
      }),
    });

    // Roles: the two facts this chapter asserts, and one use of the earlier chapter's paper.
    const mentions = rows(
      `SELECT m.role, m.witness, m.start, m.end, m.block_id, m.span_id, m.resolved_by_change, m.chapter
         FROM mentions m ORDER BY m.chapter, m.block_id, m.start`,
    );
    expect(mentions.map((row) => ({ role: row.role, witness: row.witness }))).toEqual([
      { role: 'assert', witness: 'Номер 65/11877/арх' },
      { role: 'assert', witness: '14.09.2065' },
      { role: 'use', witness: 'делу № 65/11877/арх' },
      { role: 'assert', witness: 'акт 77/1/арх' },
    ]);
    // Offsets are code points in the block's own text, and the witness is that text.
    const blocks = rows('SELECT id, text FROM blocks WHERE chapter = 2 ORDER BY idx') as Array<{ id: string; text: string }>;
    const dateMention = mentions[1] as { block_id: string; start: number; end: number };
    const dateBlock = blocks.find((block) => block.id === dateMention.block_id);
    expect(dateBlock?.text).toBe(CH2[0]);
    expect(Array.from(String(dateBlock?.text)).slice(dateMention.start, dateMention.end).join('')).toBe('14.09.2065');
    expect(dateMention.start).toBe(14);
    // No span was written by an edit, so the fallback names the run and the block index.
    expect(mentions.map((row) => row.span_id)).toEqual([
      `ext:${first.run}:0`,
      `ext:${second.run}:0`,
      `ext:${second.run}:1`,
      `ext:${second.run}:1`,
    ]);
    expect(mentions.every((row) => row.resolved_by_change === null)).toBe(true);

    // Literals are the chapter's own index: every date and document number, bound or not.
    const literals = rows(
      'SELECT l.literal, l.raw, l.start, l.end FROM literals l JOIN blocks b ON b.id = l.block_id ' +
        'WHERE l.chapter = 2 ORDER BY b.idx, l.start',
    );
    expect(literals.map((row) => row.literal)).toEqual(['2065-09-14', '77-1-арх', '65-11877-арх']);

    const edge = rows('SELECT * FROM fact_dependency')[0] ?? {};
    expect(edge).toMatchObject({
      from: idOf('fct', 'document:77-1-арх'),
      to: idOf('fct', 'document:65-11877-арх'),
      kind: 'document',
      chapter: 2,
      stance: 'plain',
      origin: 'inferred',
      step_id: second.run,
      retired_by_run: null,
      statement: 'акт 77/1/арх составлен по делу 65/11877/арх',
    });
    expect(String(edge.extracted_by)).toContain(second.run);

    const thread = rows('SELECT * FROM threads')[0] ?? {};
    expect(thread).toMatchObject({ state: 'advanced', opened_at_chapter: 2, closed_at_chapter: null });
    expect(String(thread.extracted_by)).toContain(second.run);
    expect(rows('SELECT kind FROM thread_events ORDER BY id').map((row) => row.kind)).toEqual(['opened', 'advanced']);

    expect(rows('SELECT n, ledger_gap FROM chapters WHERE n = 2')[0]).toEqual({
      n: 2,
      ledger_gap: countUnboundFactShaped(fixture.db, 2),
    });

    const runRow = rows('SELECT * FROM extraction_runs WHERE id = ?', second.run)[0] ?? {};
    expect(runRow).toMatchObject({
      chapter: 2,
      rev: 1,
      status: 'ok',
      pass: 'extract',
      model: 'deepseek-flash',
      facts: 2,
      uses: 1,
      edges: 1,
      threads: 1,
      tokens_in: 1000,
      tokens_out: 200,
      tokens_cached: 0,
      rejects: '[]',
      error: null,
      response: answerText(ANSWER_CH2),
      at: AT,
    });
    expect(runRow.usd).toBeCloseTo(usdOf(PIPELINE.pricing, { in: 1000, out: 200, cached: 0 }), 9);
    expect(runRow.usd).toBeCloseTo(0.000364, 9);
  });

  it('names the first run of a question after the question, and the next one after its ordinal', async () => {
    fixture = seed();
    const first = await run(1, ANSWER_CH1);
    if (!first.ok || first.reused) throw new Error('expected a written run');
    const row = rows('SELECT * FROM extraction_runs WHERE id = ?', first.run)[0] ?? {};
    const question = {
      chapter: 1,
      rev: 1,
      textSha: String(row.text_sha),
      promptSha: String(row.prompt_sha),
      model: 'deepseek-flash',
      pass: 'extract' as const,
    };
    expect(first.run).toBe(runIdOf(question, 1));
    expect(String(row.request_sha)).toHaveLength(64);

    // A re-ask is the same question, a different row: the ordinal is what keeps the id unique.
    const again = await run(1, ANSWER_CH1, { force: true, at: AT_LATER });
    expect(again.ok && again.run).toBe(runIdOf(question, 2));
  });
});

describe('reuse: a completed run answers a question nobody asks twice', () => {
  it('returns the stored counts and calls no model', async () => {
    fixture = seed();
    await run(1, ANSWER_CH1);
    const calls = fakeProvider(answerText(ANSWER_CH2));
    const first = await run(2, ANSWER_CH2, { provider: calls });
    const before = graphSnapshot();

    const second = await run(2, ANSWER_CH2, { provider: calls });
    expect(calls.calls).toHaveLength(1);
    expect(second).toMatchObject({ ok: true, reused: true, chapter: 2 });
    expect(graphSnapshot()).toBe(before);
    if (first.ok && !first.reused) {
      expect(second.ok && second.reused && second.counts).toEqual({ facts: 2, uses: 1, edges: 1, threads: 1 });
    }
  });
});

describe('a forced re-extraction supersedes, never overwrites', () => {
  it('updates a key in place, retires a vanished key and its edge, and the graph stops seeing them', async () => {
    fixture = seed();
    await run(1, ANSWER_CH1);
    const first = await run(2, ANSWER_CH2);
    if (!first.ok || first.reused) throw new Error('expected a written run');
    const dateId = idOf('fct', 'date:2065-09-14');
    const documentId = idOf('fct', 'document:77-1-арх');
    expect(factAsOf(fixture.db, 3).map((fact) => fact.id)).toContain(documentId);

    const forced = await run(2, ANSWER_CH2_NARROWED, { force: true, at: AT_LATER });
    expect(forced).toMatchObject({ ok: true, reused: false });
    if (!forced.ok || forced.reused || forced.dryRun) throw new Error('expected a written run');
    expect(forced.counts).toMatchObject({ facts: 1, uses: 1, edges: 0, threads: 0 });
    expect(forced.counts.supersededFacts).toEqual([documentId]);
    expect(forced.counts.retiredEdges).toHaveLength(1);

    // The same key keeps its id and takes the new answer's fields.
    const date = rows('SELECT id, term, extracted_by FROM facts WHERE id = ?', dateId)[0] ?? {};
    expect(date.term).toBe('акт от 14.09.2065');
    expect(String(date.extracted_by)).toContain(forced.run);

    // The vanished fact is retired, not deleted, and no longer the graph.
    const retired = rows('SELECT invalidated_at, superseded_by_extraction, chapter FROM facts WHERE id = ?', documentId)[0] ?? {};
    expect(retired).toEqual({ invalidated_at: AT_LATER, superseded_by_extraction: forced.run, chapter: 2 });
    expect(factAsOf(fixture.db, 3).map((fact) => fact.id)).not.toContain(documentId);

    // Its edge too, and the closure of the date no longer walks it.
    const edge = rows('SELECT retired_by_run FROM fact_dependency')[0] ?? {};
    expect(edge.retired_by_run).toBe(forced.run);
    expect(closure(fixture.db, [dateId]).edges).toEqual([]);

    // The thread had only this chapter's events: with them gone, it is gone.
    expect(count('threads')).toBe(0);
    expect(count('thread_events')).toBe(0);
  });
});

describe('an append-only run ledger', () => {
  it('keeps both raw answers when one chapter is forced twice', async () => {
    fixture = seed();
    await run(1, ANSWER_CH1);
    const first = await run(2, ANSWER_CH2);
    if (!first.ok || first.reused) throw new Error('expected a written run');
    const forced = await run(2, ANSWER_CH2_NARROWED, { force: true, at: AT_LATER });
    if (!forced.ok || forced.reused || forced.dryRun) throw new Error('expected a written run');

    // «Supersede, never overwrite» is about the audit too: two rows, two requests, two answers,
    // and the older answer is still readable in full.
    const written = rows(
      `SELECT id, at, status, response, facts FROM extraction_runs
        WHERE chapter = 2 AND pass = 'extract' ORDER BY at, rowid`,
    );
    expect(written).toEqual([
      expect.objectContaining({ id: first.run, at: AT, status: 'ok', response: answerText(ANSWER_CH2), facts: 2 }),
      expect.objectContaining({ id: forced.run, at: AT_LATER, status: 'ok', response: answerText(ANSWER_CH2_NARROWED), facts: 1 }),
    ]);
    expect(first.run).not.toBe(forced.run);
    // The rows keep naming the run that wrote them, not the newest one.
    expect(String(rows('SELECT extracted_by FROM facts WHERE key = ?', 'date:2065-09-14')[0]?.extracted_by)).toContain(
      forced.run,
    );
  });
});

describe('FACT_NOT_ESTABLISHED', () => {
  it('counts a use of a key the book does not hold and keeps the one it does', async () => {
    fixture = seed();
    await run(1, ANSWER_CH1);
    const outcome = await run(2, {
      facts: [{ kind: 'document', value: '77/1/арх', term: '77/1/арх', quote: 'акт 77/1/арх' }],
      uses: [
        { kind: 'document', value: '65/11877/арх', quote: 'делу № 65/11877/арх' },
        { kind: 'document', value: '88/8/арх', quote: 'акт 77/1/арх' },
      ],
      edges: [],
      threads: [],
    });
    if (!outcome.ok || outcome.reused || outcome.dryRun) throw new Error('expected a written run');
    expect(outcome.counts).toMatchObject({ facts: 1, uses: 1, mentions: 2 });
    expect(outcome.rejects).toHaveLength(1);
    expect(outcome.rejects[0]).toMatchObject({ code: 'FACT_NOT_ESTABLISHED', path: 'uses[1]' });
    const runRow = rows('SELECT rejects FROM extraction_runs WHERE id = ?', outcome.run)[0] ?? {};
    expect(JSON.parse(String(runRow.rejects))).toHaveLength(1);
  });

  it('refuses the whole run when a later chapter uses a fact this answer retires', async () => {
    fixture = seed();
    await run(1, ANSWER_CH1);
    await run(2, ANSWER_CH2);
    const later = await run(3, ANSWER_CH3);
    expect(later).toMatchObject({ ok: true, reused: false });

    const before = graphSnapshot();
    const refused = await run(2, ANSWER_CH2_NARROWED, { force: true, at: AT_LATER });
    expect(refused).toMatchObject({ ok: false, code: 'FACT_NOT_ESTABLISHED' });
    expect(graphSnapshot()).toBe(before);

    const runRow = rows('SELECT status, error FROM extraction_runs WHERE chapter = 2 ORDER BY at DESC, rowid DESC')[0] ?? {};
    expect(runRow).toEqual({ status: 'refused', error: 'FACT_NOT_ESTABLISHED' });
    // The fact chapter 3 consumes is still live: nothing was written.
    expect(factAsOf(fixture.db, 4).map((fact) => fact.key)).toContain('document:77-1-арх');
  });
});

describe('the form check itself', () => {
  it('names the chapter that establishes a fact a use reads too early', async () => {
    fixture = seed();
    await run(2, ANSWER_CH2);
    const documentId = idOf('fct', 'document:77-1-арх');
    const block = rows('SELECT id, text FROM blocks WHERE chapter = 1 ORDER BY idx')[0] as { id: string; text: string };
    // A second writer's use, in a chapter that cannot have read a fact of chapter 2.
    fixture.db
      .prepare(
        `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, resolved_by_change, role, witness, edge_path)
         VALUES ('patch:1', ?, 1, 0, 4, 'fact', ?, NULL, 'use', ?, '[]')`,
      )
      .run(block.id, documentId, Array.from(block.text).slice(0, 4).join(''));

    expect(usesBeforeEstablishment(fixture.db)).toHaveLength(1);
    try {
      assertFactsEstablished(fixture.db);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(FactNotEstablishedError);
      const refusal = error as FactNotEstablishedError;
      expect(refusal.rows[0]).toMatchObject({ chapter: 1, factChapter: 2, retired: 0 });
      expect(refusal.message).toContain('fact of chapter 2');
    }
  });
});

describe('CAUSE_AFTER_EFFECT', () => {
  it('drops an edge that puts its cause after its effect, and writes the rest', async () => {
    fixture = seed();
    await run(1, ANSWER_CH1);
    const outcome = await run(2, {
      facts: [
        { ref: 'f1', kind: 'date', value: '14.09.2065', term: '14.09.2065', quote: '14.09.2065' },
        { ref: 'f2', kind: 'document', value: '77/1/арх', term: '77/1/арх', quote: 'акт 77/1/арх' },
      ],
      uses: [],
      edges: [
        { from: 'f2', to: { key: 'document:65-11877-арх' }, kind: 'document', quote: 'акт 77/1/арх' },
        { from: 'f2', to: { key: 'document:65-11877-арх' }, kind: 'cause', quote: 'акт 77/1/арх' },
      ],
      threads: [],
    });
    if (!outcome.ok || outcome.reused || outcome.dryRun) throw new Error('expected a written run');
    expect(outcome.rejects.map((reject) => reject.code)).toEqual(['CAUSE_AFTER_EFFECT']);
    expect(outcome.counts.edges).toBe(1);
    expect(rows('SELECT kind FROM fact_dependency')).toEqual([{ kind: 'document' }]);
  });
});

describe('FRAME_CHANGED', () => {
  it('rolls the answer back when the chapter changed under it', async () => {
    fixture = seed();
    await run(1, ANSWER_CH1);
    const base = fakeProvider(answerText(ANSWER_CH2));
    const provider: Provider = async (request) => {
      // The edit lands between the read and the write: the block ids and offsets the answer
      // quoted describe text that is no longer the chapter.
      fixture.db.prepare('UPDATE chapters SET sha256 = ? WHERE n = 2').run('sha-after-the-read');
      return base(request);
    };

    const outcome = await run(2, ANSWER_CH2, { provider });
    expect(outcome).toMatchObject({ ok: false, code: 'FRAME_CHANGED' });
    expect(count('facts')).toBe(1); // chapter 1's paper only
    expect(count('mentions')).toBe(1);
    expect(count('literals')).toBe(1); // chapter 1's paper only
    const runRow = rows('SELECT status, error FROM extraction_runs WHERE chapter = 2 ORDER BY at DESC, rowid DESC')[0] ?? {};
    expect(runRow).toEqual({ status: 'refused', error: 'FRAME_CHANGED' });
  });
});

describe('an unexpected write failure', () => {
  it('records EXTRACT_ERROR, rolls the rows back and keeps no half-written chapter', async () => {
    fixture = seed();
    // A failure the pass has no name for: the literals index is gone, so the write throws after
    // the facts and mentions were written — and the transaction must take them back.
    fixture.db.exec('DROP TABLE literals');
    const outcome = await run(2, ANSWER_CH2, { noRecall: true });
    expect(outcome).toMatchObject({ ok: false, code: 'EXTRACT_ERROR' });
    expect(count('facts')).toBe(0);
    expect(count('mentions')).toBe(0);
    const runRow = rows('SELECT status, error FROM extraction_runs ORDER BY at DESC, rowid DESC')[0] ?? {};
    expect(runRow).toEqual({ status: 'error', error: 'EXTRACT_ERROR' });
  });
});

describe('a dry run', () => {
  it('answers with the accepted items and writes nothing at all', async () => {
    fixture = seed();
    await run(1, ANSWER_CH1);
    const before = graphSnapshot();
    const outcome = await run(2, ANSWER_CH2, { dryRun: true });
    if (!outcome.ok || outcome.reused || !outcome.dryRun) throw new Error('expected a dry run');
    expect(outcome.accepted.facts).toHaveLength(2);
    expect(outcome.accepted.uses).toHaveLength(1);
    expect(outcome.accepted.edges).toHaveLength(1);
    expect(outcome.accepted.threads).toHaveLength(1);
    expect(outcome.rejects).toEqual([]);
    expect(graphSnapshot()).toBe(before);
    expect(count('extraction_runs')).toBe(1); // chapter 1's run only
  });
});

describe('the schema', () => {
  it('asks once more, with one line added, and takes the second answer', async () => {
    fixture = seed();
    await run(1, ANSWER_CH1);
    const calls = fakeProvider('не JSON', answerText(ANSWER_CH2));
    const outcome = await run(2, ANSWER_CH2, { provider: calls });
    expect(outcome.ok).toBe(true);
    expect(calls.calls).toHaveLength(2);
    expect(calls.calls[1]?.user.endsWith(REPAIR_LINE)).toBe(true);
    expect(calls.calls[1]?.system).toBe(calls.calls[0]?.system);
  });

  it('records a refused run and writes no rows when the repair fails too', async () => {
    fixture = seed();
    await run(1, ANSWER_CH1);
    const before = graphSnapshot();
    const calls = fakeProvider('не JSON', 'тоже не JSON');
    const outcome = await run(2, ANSWER_CH2, { provider: calls });
    expect(outcome).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
    expect(calls.calls).toHaveLength(2);
    expect(graphSnapshot()).toBe(before);
    const runRow = rows("SELECT status, error, response FROM extraction_runs WHERE pass = 'extract' AND chapter = 2")[0] ?? {};
    expect(runRow).toMatchObject({ status: 'refused', error: 'SCHEMA_INVALID', response: 'тоже не JSON' });
  });
});

describe('a transport failure', () => {
  it('is a run with an error code and no rows, never a stored body', async () => {
    fixture = seed();
    const provider: Provider = async () => {
      throw new ModelError('MODEL_TIMEOUT', 2);
    };
    const outcome = await run(2, ANSWER_CH2, { provider });
    expect(outcome).toMatchObject({ ok: false, code: 'MODEL_TIMEOUT' });
    expect(count('facts')).toBe(0);
    const runRow = rows('SELECT status, error, tokens_in FROM extraction_runs WHERE chapter = 2')[0] ?? {};
    expect(runRow).toEqual({ status: 'error', error: 'MODEL_TIMEOUT', tokens_in: 0 });
  });
});
