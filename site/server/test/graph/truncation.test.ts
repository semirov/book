/**
 * A cut answer and a malformed one are different failures (BOOK-185, BOOK-DOC-77 §2).
 *
 * A real pass ended `SCHEMA_INVALID` after ~65k output tokens per chapter, with the run row naming
 * no reason: `max_tokens` cut the JSON (`finish_reason: length`), the repair was cut the same way,
 * and the operator paid twice for one truncation. These tests pin the three facts that repair the
 * diagnosis: **truncation is its own refusal with no repair**, the raw answer is stored either way,
 * and a truncated chapter stays pending for the next attempt.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { extractChapter, type ExtractOutcome, type Provider } from '../../src/graph/extract.ts';
import { RESPONSE_CAP_CHARS } from '../../src/graph/runs.ts';
import { ledgerFixture, seedChapter, type LedgerFixture } from '../ledger/helpers.ts';
import { ANSWER_CH2, AT, CH1, CH2, PIPELINE, answerText, replyingProvider } from './extractFixture.ts';

/** The JSON a chapter's answer starts with and never closes — what `finish_reason: length` leaves. */
const CUT = '{"facts":[{"ref":"f1","kind":"document","value":"65/1187';

let fixture: LedgerFixture;

afterEach(() => {
  fixture.close();
});

function seed(texts: Record<number, string[]> = { 1: CH1, 2: CH2 }): LedgerFixture {
  const seeded = ledgerFixture();
  for (const [chapter, lines] of Object.entries(texts)) {
    seedChapter(seeded.db, { chapter: Number(chapter), texts: lines });
  }
  return seeded;
}

async function run(
  chapter: number,
  provider: Provider,
  over: { noRecall?: boolean; force?: boolean } = {},
): Promise<ExtractOutcome> {
  return extractChapter({
    db: fixture.db,
    chapter,
    provider,
    pipeline: PIPELINE,
    at: AT,
    ...(over.force === undefined ? {} : { force: over.force }),
    noRecall: over.noRecall ?? true,
  });
}

function rows(sql: string): Array<Record<string, unknown>> {
  return fixture.db.prepare(sql).all() as Array<Record<string, unknown>>;
}

function count(table: string): number {
  return (fixture.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('a truncated answer', () => {
  it('is MODEL_TRUNCATED, asked once, and keeps the text it was cut at', async () => {
    fixture = seed();
    const provider = replyingProvider({ text: CUT, finishReason: 'length' });
    const outcome = await run(2, provider);

    expect(outcome).toMatchObject({ ok: false, code: 'MODEL_TRUNCATED' });
    // One call, not two: the repair would be cut at the same cap for the same reason.
    expect(provider.calls).toHaveLength(1);
    expect(count('facts')).toBe(0);
    const [row] = rows(
      "SELECT status, error, response, facts, tokens_out FROM extraction_runs WHERE pass = 'extract' AND chapter = 2",
    );
    expect(row).toEqual({ status: 'refused', error: 'MODEL_TRUNCATED', response: CUT, facts: 0, tokens_out: 200 });
  });

  it('is MODEL_TRUNCATED even when the cut left no text at all', async () => {
    // The real run's symptom: a reasoning model spent the whole cap thinking, so nothing readable
    // arrived and the row stored an empty response that named no cause.
    fixture = seed();
    const provider = replyingProvider({ text: '', finishReason: 'length' });
    const outcome = await run(2, provider);

    expect(outcome).toMatchObject({ ok: false, code: 'MODEL_TRUNCATED' });
    expect(provider.calls).toHaveLength(1);
    const [row] = rows("SELECT status, error, response FROM extraction_runs WHERE pass = 'extract' AND chapter = 2");
    expect(row).toEqual({ status: 'refused', error: 'MODEL_TRUNCATED', response: '' });
  });

  it('is not read as complete just because the cut happened to parse', async () => {
    // The reason is checked before the text: an answer stopped at the cap is not an answer whose
    // last item was known to be finished.
    fixture = seed();
    const provider = replyingProvider({ text: answerText(ANSWER_CH2), finishReason: 'length' });
    const outcome = await run(2, provider);

    expect(outcome).toMatchObject({ ok: false, code: 'MODEL_TRUNCATED' });
    expect(provider.calls).toHaveLength(1);
    expect(count('facts')).toBe(0);
  });

  it('is not reused: the next attempt asks the model again', async () => {
    fixture = seed();
    const provider = replyingProvider({ text: CUT, finishReason: 'length' }, { text: answerText(ANSWER_CH2) });

    const cut = await run(2, provider);
    expect(cut).toMatchObject({ ok: false, code: 'MODEL_TRUNCATED' });

    const second = await run(2, provider);
    expect(second).toMatchObject({ ok: true, reused: false });
    expect(provider.calls).toHaveLength(2);
    expect(count('facts')).toBe(2);
  });

  it('is MODEL_TRUNCATED in the repair too, after the one call it earned', async () => {
    // The repair is asked because the first answer was *malformed*, not cut; if the second is cut,
    // the refuser is the cap, not the schema.
    fixture = seed();
    const provider = replyingProvider({ text: 'не JSON' }, { text: CUT, finishReason: 'length' });
    const outcome = await run(2, provider);

    expect(outcome).toMatchObject({ ok: false, code: 'MODEL_TRUNCATED' });
    expect(provider.calls).toHaveLength(2);
    const [row] = rows("SELECT status, error, response FROM extraction_runs WHERE pass = 'extract' AND chapter = 2");
    expect(row).toEqual({ status: 'refused', error: 'MODEL_TRUNCATED', response: CUT });
  });

  it('in the recall pass leaves the first answer standing and records its own refusal', async () => {
    fixture = seed();
    const provider = replyingProvider({ text: answerText(ANSWER_CH2) }, { text: CUT, finishReason: 'length' });
    const outcome = await run(2, provider, { noRecall: false });

    expect(outcome.ok).toBe(true);
    expect(outcome.passes.recall).toMatchObject({ skipped: false, ok: false, code: 'MODEL_TRUNCATED' });
    // The recall is additive: what the first pass found is in the graph, and the recall bought nothing.
    expect(count('facts')).toBe(2);
    const [recall] = rows(
      "SELECT status, error, response, facts FROM extraction_runs WHERE pass = 'recall' AND chapter = 2",
    );
    expect(recall).toEqual({ status: 'refused', error: 'MODEL_TRUNCATED', response: CUT, facts: 0 });
  });
});

describe('a malformed answer that was not cut', () => {
  it('still earns its one repair, then SCHEMA_INVALID with the last text kept', async () => {
    fixture = seed();
    const provider = replyingProvider({ text: 'не JSON' }, { text: 'тоже не JSON' });
    const outcome = await run(2, provider);

    expect(outcome).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.user).not.toBe(provider.calls[0]?.user);
    expect(count('facts')).toBe(0);
    const [row] = rows("SELECT status, error, response FROM extraction_runs WHERE pass = 'extract' AND chapter = 2");
    expect(row).toEqual({ status: 'refused', error: 'SCHEMA_INVALID', response: 'тоже не JSON' });
  });

  it('is read as SCHEMA_INVALID, never as truncation, when the provider named no reason', async () => {
    fixture = seed();
    const provider = replyingProvider({ text: CUT, finishReason: null }, { text: CUT, finishReason: null });
    const outcome = await run(2, provider);

    expect(outcome).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
    expect(provider.calls).toHaveLength(2);
  });
});

describe('what a refusal stores', () => {
  it('caps a runaway answer at 200 KB — a diagnosis, not a generation', async () => {
    fixture = seed();
    const runaway = 'x'.repeat(RESPONSE_CAP_CHARS + 50_000);
    const provider = replyingProvider({ text: runaway }, { text: runaway });
    const outcome = await run(2, provider);

    expect(outcome).toMatchObject({ ok: false, code: 'SCHEMA_INVALID' });
    const [row] = rows("SELECT status, response FROM extraction_runs WHERE pass = 'extract' AND chapter = 2");
    expect(row?.status).toBe('refused');
    expect(String(row?.response)).toHaveLength(RESPONSE_CAP_CHARS);
  });

  it('never ends the stored text on half a surrogate pair', async () => {
    fixture = seed();
    // The cap falls exactly on the high half of an emoji: slicing there would store a lone
    // surrogate, which is not text and cannot be re-encoded as JSON.
    const text = `${'x'.repeat(RESPONSE_CAP_CHARS - 1)}😀yy`;
    const provider = replyingProvider({ text }, { text });
    await run(2, provider);

    const [row] = rows("SELECT response FROM extraction_runs WHERE pass = 'extract' AND chapter = 2");
    const stored = String(row?.response);
    expect(stored).toHaveLength(RESPONSE_CAP_CHARS - 1);
    expect(stored.endsWith('\uD83D')).toBe(false);
  });

  it('keeps an accepted answer whole, so a reuse still replays it', async () => {
    fixture = seed();
    const text = answerText(ANSWER_CH2);
    await run(2, replyingProvider({ text }));

    const [row] = rows("SELECT status, response FROM extraction_runs WHERE pass = 'extract' AND chapter = 2");
    expect(row).toEqual({ status: 'ok', response: text });
  });
});
