/**
 * BOOK-187 AC7 — the pass's receipt is facts, and only facts.
 *
 * The old transcript was a file with the prompt and the answer in it: a second copy of the book,
 * with the canon in it and 7 MB of it on disk. These tests drive the row builder with the worst
 * input a pass can hold — a key, an endpoint, a session id and a paragraph of prose — and prove
 * that not one of those strings reaches the row, while the sha and the length are exactly right.
 */

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../src/util/hash.ts';
import { EngineRefusalError, type EngineClient } from '../../src/writer/client.ts';
import { buildTranscriptRows, storeTranscript, type CallRecord, type PromptSectionFact } from '../../src/writer/transcript.ts';

const KEY = 'sk-test-9f2b7c41e0d34a1b8c5e';
const URL_OF_ENGINE = 'http://127.0.0.1:8081/internal/land';
const SESSION = 'writer-a7f3c9e1';
const PROSE =
  'Свет погас, и на лестнице остался только запах дыма — тот самый, что она помнила с зимы.';

const SECTIONS: PromptSectionFact[] = [
  { id: 'role', sha256: sha256Hex('роль'), chars: 4 },
  { id: 'canon', sha256: sha256Hex('канон'), chars: 5 },
];

function callOf(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    kind: 'draft',
    at: 1_790_000_000_000,
    system: `ты писатель; ключ ${KEY}; движок ${URL_OF_ENGINE}; сессия ${SESSION}`,
    user: `замысел: ${PROSE}`,
    answer: `Глава сорок\n\n${PROSE}\n\n${PROSE}`,
    usage: { in: 1_234, out: 567, cachedIn: 0 },
    cachedIn: 0,
    prefixSha256: sha256Hex('prefix'),
    ...overrides,
  };
}

describe('buildTranscriptRows — facts instead of a second copy of the book', () => {
  it('keeps the shas and the lengths and none of the strings', () => {
    const call = callOf();
    const rows = buildTranscriptRows({ calls: [call], sections: SECTIONS, promptBundle: 'bundle-abc' });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ seq: 1, role: 'draft', at: call.at, tokensIn: 1_234, tokensOut: 567, promptBundle: 'bundle-abc' });

    // Not one of the four dangerous strings survives, and neither does a sentence of the answer.
    const stored = JSON.stringify(rows);
    for (const secret of [KEY, URL_OF_ENGINE, SESSION, PROSE, 'Глава сорок']) {
      expect(stored, `the receipt must not carry ${secret.slice(0, 12)}…`).not.toContain(secret);
    }
    // No field name that would invite a body either.
    for (const name of ['prompt', 'answerText', 'system', 'user', 'model', 'session', 'endpoint', 'key']) {
      expect(Object.keys(JSON.parse(row.content) as object), name).not.toContain(name);
    }

    const facts = JSON.parse(row.content) as {
      promptSha256: string;
      sections: PromptSectionFact[];
      answer: { sha256: string; chars: number };
      verdict?: string;
      failure?: string;
    };
    // The hash is of the exact bytes the model saw, and the length is code points.
    expect(facts.promptSha256).toBe(sha256Hex(`${call.system}\n\n${call.user}`));
    expect(facts.answer.sha256).toBe(sha256Hex(call.answer));
    expect(facts.answer.chars).toBe(call.answer.length);
    expect(facts.sections).toEqual(SECTIONS);
    expect(facts.verdict).toBeUndefined();
    expect(facts.failure).toBeUndefined();
  });

  it('records a gate verdict on its own row and the failure code once, on the last one', () => {
    const rows = buildTranscriptRows({
      calls: [
        callOf(),
        callOf({ kind: 'gate:editor', verdict: 'HOLDS', usage: { in: 10, out: 20, cachedIn: 0 } }),
      ],
      sections: SECTIONS,
      promptBundle: null,
      failure: 'ANSWER_REFUSAL',
    });
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    const first = JSON.parse(rows[0]!.content) as { verdict?: string; failure?: string };
    const last = JSON.parse(rows[1]!.content) as { verdict?: string; failure?: string };
    expect(first.verdict).toBeUndefined();
    expect(first.failure).toBeUndefined();
    expect(last).toMatchObject({ verdict: 'HOLDS', failure: 'ANSWER_REFUSAL' });
    expect(rows[1]?.promptBundle).toBeNull();
  });

  it('drops a failure that is a sentence rather than a code, and stores nothing for no calls', () => {
    const rows = buildTranscriptRows({ calls: [callOf()], sections: SECTIONS, promptBundle: null, failure: 'проход сломался' });
    expect((JSON.parse(rows[0]!.content) as { failure?: string }).failure).toBeUndefined();
    // A pass that parked before the model ran has no receipt: its `refused` stage says why.
    expect(buildTranscriptRows({ calls: [], sections: SECTIONS, promptBundle: null })).toEqual([]);
  });

  it('counts the unit the book counts, so a receipt’s length compares with a revision’s', () => {
    const rows = buildTranscriptRows({
      calls: [callOf({ answer: '𝔅' })],
      sections: [],
      promptBundle: null,
    });
    // `parseChapter` sums `text.length`: a surrogate pair is two units there, and here.
    expect((JSON.parse(rows[0]!.content) as { answer: { chars: number } }).answer.chars).toBe(2);
  });
});

describe('storeTranscript — evidence, never the pass', () => {
  const rows = buildTranscriptRows({ calls: [callOf()], sections: SECTIONS, promptBundle: 'bundle-abc' });

  it('sends the rows once and reports what was stored and pruned', async () => {
    const sent: Array<{ passId: string; rows: unknown[] }> = [];
    const logs: string[] = [];
    const engine = {
      transcript: async (input: { passId: string; rows: unknown[] }) => {
        sent.push(input);
        return { stored: 1, pruned: 2 };
      },
    } as unknown as EngineClient;

    await storeTranscript({ engine, log: (line) => logs.push(line), passId: 'stp_1', calls: [callOf()], sections: SECTIONS, promptBundle: 'bundle-abc' });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.passId).toBe('stp_1');
    expect(sent[0]?.rows).toEqual(rows);
    expect(logs).toEqual(['[writer] транскрипт: 1 строк, удалено старых 2']);
  });

  it('swallows a refusal and a plain failure, with the code when there is one', async () => {
    const logs: string[] = [];
    const refusing = {
      transcript: async () => {
        throw new EngineRefusalError('ENGINE_TIMEOUT', 'the engine did not answer', 0);
      },
    } as unknown as EngineClient;
    await storeTranscript({ engine: refusing, log: (line) => logs.push(line), passId: 'stp_1', calls: [callOf()], sections: [], promptBundle: null });
    expect(logs).toEqual(['[writer] transcript not stored: ENGINE_TIMEOUT']);

    const broken = {
      transcript: async () => {
        throw new Error('boom');
      },
    } as unknown as EngineClient;
    await storeTranscript({ engine: broken, log: (line) => logs.push(line), passId: 'stp_1', calls: [callOf()], sections: [], promptBundle: null });
    expect(logs.at(-1)).toBe('[writer] transcript not stored: сбой');
  });

  it('does not call the engine for a pass that never reached the model', async () => {
    let called = 0;
    const engine = {
      transcript: async () => {
        called += 1;
        return { stored: 0, pruned: 0 };
      },
    } as unknown as EngineClient;
    await storeTranscript({ engine, log: () => undefined, passId: 'stp_1', calls: [], sections: [], promptBundle: null });
    expect(called).toBe(0);
  });
});
