/**
 * The corpus as a test (BOOK-61 AC7, BOOK-DOC-42 §6).
 *
 * Every row of BOOK-DOC-37 §2 runs here through the same pieces production uses: the batch
 * boundary's Gate A question (`classifyPayload`), Gate B's scan (`scanRights`), the intent
 * validator, and — for the rows that carry a recorded answer — the envelope, the verdict
 * parser, the post-check and the copy. A `makeFakeDispatcher` implements the one port a gate
 * answer crosses (`GateDispatcher`), so the pipeline below a model is proven with no model,
 * no network and no database.
 *
 * The count is asserted, not implied: 45 rows of the audit's table plus the cases this pass adds
 * (B15b–B15e: a fence is no disguise), the three synthesised Gate B rows (the in-world order,
 * the injected stop entry, the canned person refusal) and the five hostile replies. The audit's
 * header says 42; its own table has 45 rows.
 */

import { describe, expect, it } from 'vitest';

import { classifyPayload, validateIntent } from '@book/shared';

import { buildEnvelope, type FilingEnvelope } from '../src/feedback/envelope.ts';
import { VERDICT_ENVELOPE, parseVerdict, type GateDispatcher } from '../src/feedback/gate.ts';
import { RIGHTS_COPY, isListRefusal, rightsRefusalLine } from '../src/rights/rules.ts';
import { scanRights } from '../src/rights/scan.ts';
import {
  CASES,
  CORPUS_FENCE,
  INTENT_CONTEXT,
  IN_WORLD_ORDER,
  TEST_STOP_ENTRY,
  itemIdOf,
  type Case,
} from './corpus/gates.ts';

/** The five BOOK-43 samples and the document that only mentions the word (design §6). */
const BUREAUCRACY = new Set(['A13', 'A14', 'A15', 'B9', 'B10', 'A19']);

function envelopeOf(c: Case): FilingEnvelope {
  return buildEnvelope({
    id: itemIdOf(c.id),
    chapter: 8,
    block: null,
    rev: 2,
    kind: 'document',
    values: {
      // D1 is the display name: the same value, in the field the posting guard never looked at.
      author: c.id === 'D1' ? c.payload : 'читатель',
      quote: null,
      text: c.id === 'D1' ? 'Замечание к абзацу.' : c.payload,
      proposed: null,
    },
  });
}

/**
 * The one port a gate answer crosses. Production has no implementation (the triage session is
 * the dispatcher); the fake answers from the case's recorded reply and records what it was
 * handed, so a test can prove the envelope got there.
 */
function makeFakeDispatcher(replies: ReadonlyMap<string, unknown>): {
  dispatchGate: GateDispatcher;
  seen: FilingEnvelope[];
} {
  const seen: FilingEnvelope[] = [];
  const dispatchGate: GateDispatcher = async (envelope) => {
    seen.push(envelope);
    return (
      replies.get(envelope.itemId) ?? {
        envelope: VERDICT_ENVELOPE,
        itemId: envelope.itemId,
        gate: 'C',
        verdict: 'FITS',
        rule: null,
        evidence: [],
      }
    );
  };
  return { dispatchGate, seen };
}

function scanOf(c: Case): ReturnType<typeof scanRights> {
  // The stop-list row takes its entry as a dependency, exactly as the scan's options allow:
  // production's table is closed, and a test must not ship a real slur to prove the rule.
  return scanRights({ body: c.payload }, c.id === 'B-STOPLIST' ? { stopList: [TEST_STOP_ENTRY] } : {});
}

describe('the corpus — Gate A on a filing', () => {
  const cases = CASES.filter((c) => c.gate === 'A' && c.surface === 'comment');

  for (const c of cases) {
    it(`${c.id}: ${'passthrough' in c.expect ? 'passes' : `is held ${c.expect.rule ?? ''}`.trim()}`, async () => {
      const hit = classifyPayload(c.payload, { fence: CORPUS_FENCE });
      if ('passthrough' in c.expect) {
        expect(hit).toBeNull();
        // A pass is a claim about all three gates, not only about A: B scans it clear and a
        // C `FITS` for the same text is accepted (never produced from the text).
        expect(scanOf(c).verdict).toBe('clear');
        const envelope = envelopeOf(c);
        const { dispatchGate } = makeFakeDispatcher(new Map());
        const raw = await dispatchGate(envelope);
        expect(parseVerdict(raw, { gate: 'C', items: new Map([[envelope.itemId, envelope]]) })).toMatchObject({
          ok: true,
          verdict: { verdict: 'FITS' },
        });
        return;
      }
      expect(hit, c.payload).not.toBeNull();
      expect(hit?.rule).toBe(c.expect.rule);
    });
  }

  it('keeps every false positive out of quarantine', () => {
    for (const c of CASES.filter((row) => row.fp === true && row.gate === 'A')) {
      expect(classifyPayload(c.payload), c.id).toBeNull();
      expect(BUREAUCRACY.has(c.id) || c.id === 'B-ORDER', `${c.id} belongs to the false-positive set`).toBe(true);
    }
  });
});

describe('the corpus — Gate B on the text surface', () => {
  for (const c of CASES.filter((row) => row.gate === 'B' && row.surface === 'text')) {
    it(`${c.id}: ${'passthrough' in c.expect ? 'cleared' : c.expect.verdict}`, () => {
      const scan = scanOf(c);
      if ('passthrough' in c.expect) {
        expect(scan.verdict).toBe('clear');
        return;
      }
      expect(scan).toMatchObject({ verdict: 'refused', rule: c.expect.rule });
    });
  }

  it('separates the releasable refusal from the ones the list decides', () => {
    // The in-world order is somebody's prose without a source: refused, and an operator may
    // clear it — a judgement about provenance, not a crime.
    const order = scanOf(CASES.find((c) => c.id === 'B-ORDER') as Case);
    expect(order).toMatchObject({ verdict: 'refused', rule: 'RIGHTS-QUOTE' });
    expect(isListRefusal('RIGHTS-QUOTE')).toBe(false);
    expect(rightsRefusalLine('RIGHTS-QUOTE')).toBe(RIGHTS_COPY.quote);

    // The stop-list hit is the law's own category: not releasable, and not a judgement call.
    const stopped = scanOf(CASES.find((c) => c.id === 'B-STOPLIST') as Case);
    expect(stopped).toMatchObject({ verdict: 'refused', rule: 'RIGHTS-STOP' });
    expect(isListRefusal('RIGHTS-STOP')).toBe(true);
    expect(rightsRefusalLine('RIGHTS-STOP')).toBe(RIGHTS_COPY.other);

    // The synthetic order is long enough to be a paragraph and carries no named source.
    expect(IN_WORLD_ORDER.length).toBeGreaterThan(480);
    expect(IN_WORLD_ORDER.length).toBeLessThan(700);
  });
});

describe('the corpus — the intent surface', () => {
  for (const c of CASES.filter((row) => row.surface === 'intent')) {
    it(`${c.id}: ${'passthrough' in c.expect ? 'accepted' : c.expect.verdict}`, () => {
      const verdict = validateIntent(c.payload, 8, INTENT_CONTEXT[c.id] ?? {});
      if ('passthrough' in c.expect) {
        expect(verdict.ok).toBe(true);
        return;
      }
      if (c.expect.verdict === 'ACCEPTED') {
        expect(verdict).toMatchObject({ ok: true });
        return;
      }
      expect(verdict).toMatchObject({ ok: false, code: c.expect.verdict });
    });
  }
});

describe('the corpus — the hostile side of a recorded answer', () => {
  const replyCases = CASES.filter((c) => c.reply !== undefined);

  it('has one case per shape the parser must refuse', () => {
    expect(replyCases.map((c) => c.id)).toEqual(['B-PERSON', 'X1', 'X2', 'X3', 'X4', 'X5']);
  });

  for (const c of replyCases) {
    it(`${c.id}: ${'passthrough' in c.expect ? '' : c.expect.verdict}`, async () => {
      const envelope = envelopeOf(c);
      const { dispatchGate, seen } = makeFakeDispatcher(new Map([[envelope.itemId, c.reply]]));
      const raw = await dispatchGate(envelope);
      // The envelope is what the model was handed: the id outside, every value untrusted.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.itemId).toBe(envelope.itemId);
      expect(seen[0]?.text.untrusted).toBe(true);

      const result = parseVerdict(raw, {
        gate: c.gate as 'A' | 'B' | 'C',
        items: new Map([[envelope.itemId, envelope]]),
      });
      if ('passthrough' in c.expect) {
        expect(result.ok).toBe(true);
        return;
      }
      if (c.expect.verdict === 'DROPPED') {
        expect(result).toMatchObject({ ok: false, code: c.expect.rule });
        return;
      }
      expect(result).toMatchObject({ ok: true, verdict: { verdict: c.expect.verdict, rule: c.expect.rule } });
    });
  }

  it('turns a refused rule id into the fixed sentence — never a model’s words', () => {
    const person = rightsRefusalLine('RIGHTS-PERSON');
    expect(person).toBe(RIGHTS_COPY.person);
    expect(isListRefusal('RIGHTS-PERSON')).toBe(true);
    // The public line names no rule, no verdict and no English: it is the table's sentence.
    expect(person).not.toMatch(/RIGHTS|REFUSED|[A-Za-z]{3}/u);
  });
});

describe('the corpus — size and shape', () => {
  it('holds every row of BOOK-DOC-37 §2 and says why the count is 45', () => {
    const rows = CASES.filter((c) => /^[ABCD]\d+$/u.test(c.id));
    // 23 A rows + 12 B rows (B8/B12/B13 are not in the table) + 9 C rows (C3 is not) + D1.
    expect(rows).toHaveLength(23 + 12 + 9 + 1);
    const a = rows.filter((c) => c.id.startsWith('A')).length;
    const b = rows.filter((c) => c.id.startsWith('B')).length;
    const c = rows.filter((c) => c.id.startsWith('C')).length;
    expect([a, b, c]).toEqual([23, 12, 9]);
    expect(CASES.length).toBe(45 + 12);
  });

  it('marks the false-positive set and keeps every id unique', () => {
    expect(CASES.filter((c) => c.fp === true).map((c) => c.id).sort()).toEqual(
      ['A13', 'A14', 'A15', 'A19', 'B10', 'B-ORDER', 'B9'].sort(),
    );
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });
});
