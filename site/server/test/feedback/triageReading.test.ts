/**
 * BOOK-206 (ADR-045 §4) — the closed shape of a gate C answer's `reading`.
 *
 * The table is the ADR's, row for row: which rung each verdict may name, what each rung owes
 * (a carrier, five refusal fields and a bounded stamp, or the finale lock), and the one field
 * every rung carries — the intent. A broken answer is a failed call, so every case here is
 * "parsed" or "refused", never "guessed".
 */

import { describe, expect, it } from 'vitest';

import { STAMP_MAX_CHARS } from '@book/shared';

import { buildEnvelope, withWorld } from '../../src/feedback/envelope.ts';
import { parseReadingBlock, parseTriageAnswer } from '../../src/feedback/triageReading.ts';

const ID = 'cmt_01M635KZP466CGBC0CKS1NWS4Z';
const WORLD = 'Он вошёл в регистратуру. Там сидела женщина с бланком. Срок — тридцать дней.';
const INTENT = 'в абзаце сказано, что это служебный текст';

const ENVELOPE = withWorld(
  buildEnvelope({
    id: ID,
    chapter: 8,
    block: 'ch08#a',
    rev: 1,
    kind: 'decision',
    values: { author: 'Аня', quote: 'Там сидела женщина с бланком.', text: 'он чихнул', proposed: null },
  }),
  WORLD,
);

function answer(verdict: 'FITS' | 'OFF', reading: unknown, evidence = [{ field: 'world', quote: 'женщина с бланком' }]): unknown {
  return {
    envelope: 'book.verdict/v1',
    itemId: ID,
    gate: 'C',
    verdict,
    rule: null,
    evidence,
    reason: verdict === 'OFF' ? 'вне книги: просьба не про текст' : null,
    ...(reading === undefined ? {} : { reading }),
  };
}

const CARRIER = { kind: 'document', quoteKept: 'срок тридцать дней и подпись', factsChanged: 1 };
const REFUSAL = {
  establishedFact: 'срок уже стоит в бланке',
  namedPerson: 'смотритель',
  namedInstance: 'регистратура',
  cost: 'очередь',
  stamp: 'не соответствует форме',
};

describe('the reading block (ADR-045 §4)', () => {
  it('reads an absent rung on FITS as as_said, and keeps the intent', () => {
    const parsed = parseTriageAnswer(answer('FITS', { intent: INTENT }), ENVELOPE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.answer.reading).toMatchObject({ rung: 'as_said', lock: null, carrier: null, refusal: null, intent: INTENT });
    expect(parsed.answer.verdict).toBe('FITS');
  });

  it('licenses a complete carrier, and a complete in-world refusal', () => {
    const paper = parseTriageAnswer(answer('FITS', { rung: 'through_paper', intent: INTENT, carrier: CARRIER }), ENVELOPE);
    expect(paper.ok && paper.answer.reading.carrier).toEqual(CARRIER);
    const world = parseTriageAnswer(answer('OFF', { rung: 'refused_in_world', intent: INTENT, refusal: REFUSAL }), ENVELOPE);
    expect(world.ok && world.answer.reading.refusal).toEqual(REFUSAL);
    const finale = parseTriageAnswer(answer('OFF', { rung: 'inadmissible', lock: 'finale', intent: INTENT }), ENVELOPE);
    expect(finale.ok && finale.answer.reading.lock).toBe('finale');
  });

  it('refuses every answer that breaks a rule — a failed call, never a defaulted rung', () => {
    const cases: Array<[string, unknown]> = [
      ['OFF with no reading at all', answer('OFF', undefined)],
      ['OFF read as said', answer('OFF', { rung: 'as_said', intent: INTENT })],
      ['FITS read as a refusal', answer('FITS', { rung: 'refused_in_world', intent: INTENT, refusal: REFUSAL })],
      ['FITS read as inadmissible', answer('FITS', { rung: 'inadmissible', lock: 'finale', intent: INTENT })],
      ['paper without a carrier', answer('FITS', { rung: 'through_paper', intent: INTENT })],
      ['paper with a kind outside the six', answer('FITS', { rung: 'through_paper', intent: INTENT, carrier: { ...CARRIER, kind: 'letter' } })],
      ['paper changing no fact', answer('FITS', { rung: 'through_paper', intent: INTENT, carrier: { ...CARRIER, factsChanged: 0 } })],
      ['a refusal missing a field', answer('OFF', { rung: 'refused_in_world', intent: INTENT, refusal: { ...REFUSAL, cost: '' } })],
      [
        'a stamp past the bound',
        answer('OFF', {
          rung: 'refused_in_world',
          intent: INTENT,
          refusal: { ...REFUSAL, stamp: 'ф'.repeat(STAMP_MAX_CHARS + 1) },
        }),
      ],
      ['inadmissible without the finale lock', answer('OFF', { rung: 'inadmissible', intent: INTENT })],
      ['a lock on a landing rung', answer('FITS', { rung: 'as_said', lock: 'finale', intent: INTENT })],
      ['an intent that is empty', answer('FITS', { intent: '   ' })],
      ['an intent past the bound', answer('FITS', { intent: 'ф'.repeat(201) })],
      ['an unknown key', answer('FITS', { intent: INTENT, alternate: true })],
    ];
    for (const [label, raw] of cases) {
      const parsed = parseTriageAnswer(raw, ENVELOPE);
      expect(parsed.ok, label).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.code).toBe('READING_MALFORMED');
    }
  });

  it('drops a carrier the rung does not use, so the licence cannot run on a dead field', () => {
    const parsed = parseReadingBlock({ rung: 'as_said', intent: INTENT, carrier: { ...CARRIER, kind: 'letter' } }, 'FITS');
    expect(parsed.ok && parsed.reading.carrier).toBeNull();
  });

  it('post-checks a quote from the world, and refuses one that is not there', () => {
    const bad = parseTriageAnswer(answer('FITS', { intent: INTENT }, [{ field: 'world', quote: 'этой строки в книге нет' }]), ENVELOPE);
    expect(bad).toMatchObject({ ok: false, code: 'POSTCHECK_FAILED' });
  });

  it('refuses a verdict for another filing', () => {
    const raw = answer('FITS', { intent: INTENT }) as Record<string, unknown>;
    const parsed = parseTriageAnswer({ ...raw, itemId: 'cmt_other' }, ENVELOPE);
    expect(parsed).toMatchObject({ ok: false, code: 'VERDICT_MALFORMED' });
  });
});
