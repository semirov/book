/**
 * One pass = one session (BOOK-173 §5): our message array, appended to, never rebuilt.
 *
 * The provider is stateless, so "same session" can only mean "same growing array and the same
 * first message". Two facts are asserted here: a turn appends rather than rebuilds (the system
 * message is byte-identical and the appended instruction is short), and a turn that would carry
 * a different prefix is refused with a line an operator can find. The pass-level half uses the
 * scripted provider: with a cache hit, the second call's *uncached* input is much smaller than
 * the first — a total can only grow in an append-only session, a bill need not.
 */


import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../src/util/hash.ts';
import { continuationInstruction, headOf, openSession } from '../../src/writer/session.ts';
import { chapterAnswer, createHarness, receiptsOf } from './harness.ts';

const SYSTEM = '### канон\n\n# WRITER\n\n## Что вернуть\n\nодно тело главы';
const USER = '## Место\nглава 12';

describe('openSession — one prefix, appended', () => {
  it('opens with the system prefix and one user tail, and hashes the exact system string', () => {
    const session = openSession({ system: SYSTEM, user: USER });
    expect(session.messages()).toEqual([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: USER },
    ]);
    expect(session.prefixSha256).toBe(sha256Hex(SYSTEM));
    expect(session.chars().opened).toBe(SYSTEM.length + USER.length);
  });

  it('appends a turn: the model’s answer, then our instruction — never a rebuilt prompt', () => {
    const session = openSession({ system: SYSTEM, user: USER });
    const turn = session.append({ kind: 'repair', assistant: 'первый ответ', user: '## Отказ\n\n…' });
    expect(turn.ok).toBe(true);
    expect(session.messages().map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(session.messages()[0]?.content).toBe(SYSTEM);
    expect(session.chars().current).toBeGreaterThan(session.chars().opened);
  });

  it('refuses a turn whose prefix moved, and says so in one line', () => {
    const logs: string[] = [];
    const session = openSession({ system: SYSTEM, user: USER, log: (line) => logs.push(line) });
    const turn = session.append({ kind: 'repair', assistant: 'a', user: 'b', system: `${SYSTEM}\nлишняя строка` });
    expect(turn).toEqual({ ok: false, code: 'PREFIX_MOVED', detail: expect.stringContaining('≠') as unknown as string });
    expect(logs.join('\n')).toContain('[writer] префикс сдвинут');
    // The refused turn appended nothing: a session that half-sends is worse than one that stops.
    expect(session.messages()).toHaveLength(2);
    expect(session.append({ kind: 'continue', assistant: 'a', user: 'b', system: SYSTEM }).ok).toBe(true);
  });

  it('clamps what a rejected answer shows of itself', () => {
    expect(headOf('x'.repeat(2_000))).toHaveLength(1_500);
    expect(headOf('short')).toBe('short');
  });
});

describe('one session per pass — the continuation turn is appended, not rebuilt', () => {
  it('keeps the prefix byte-identical and shrinks the uncached input of the second call', async () => {
    const harness = await createHarness({ env: { WRITER_CONTINUE_MAX: '1' } });
    try {
      harness.script.push(
        { text: chapterAnswer(), usage: { in: 40_000, out: 200, cachedIn: 0 } },
        // A cache hit on the prefix the first call already sent: the second call is nearly free.
        { text: `Глава сорок\n\n${'Дописанный абзац. '.repeat(80)}`, usage: { in: 42_000, out: 200, cachedIn: 41_000 } },
        'HOLDS',
        'HOLDS',
      );
      const result = await harness.run({ chapter: 40 });
      expect(result.status).toBe('closed');

      const [draft, continuation] = harness.calls;
      expect(draft).toBeDefined();
      expect(continuation).toBeDefined();
      // Same session, same prefix: the first message is byte-identical, the array only grew.
      expect(continuation?.messages[0]?.content).toBe(draft?.messages[0]?.content);
      expect(draft?.messages).toHaveLength(2);
      expect(continuation?.messages).toHaveLength(4);
      expect(continuation?.messages[2]?.role).toBe('assistant');
      expect(continuation?.messages[3]?.content).toBe(continuationInstruction());
      // The continuation's own instruction is short: it is a turn, not a second prompt.
      expect((continuation?.messages[3]?.content ?? '').length).toBeLessThan(200);

      // BOOK-187 AC7: the receipt is rows — the call's tokens and the cached share are facts.
      const { rows: receiptRows } = receiptsOf(harness, result.stepId ?? '');
      const calls = receiptRows
        .filter((row) => row.role === 'draft' || row.role === 'continue')
        .map((row) => ({ kind: row.role, uncached: row.tokensIn - Number(row.facts.cachedIn ?? 0) }));
      expect(calls.map((call) => call.kind)).toEqual(['draft', 'continue']);
      const uncached = calls.map((call) => call.uncached);
      expect(uncached[1] ?? 0).toBeLessThan((uncached[0] ?? 0) / 10);
    } finally {
      await harness.close();
    }
  });
});
