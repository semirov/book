/**
 * BOOK-206 (ADR-045 §5) — the ladder as a **total function**, walked as a table.
 *
 * The four answers, the licence each owes, the anti-cheat caps and the three stored locks are
 * combined here row by row, and every combination must land on one of the four readings:
 * `as_said`, `through_paper`, `refused_in_world`, `inadmissible`. `escalated` is not in the
 * codomain any more — the compiler says so, and this table is the proof a reader can check:
 * no proposal, no cap and no missing field can hand a filing to a person.
 *
 * The last case is the applier's: an `OFF` filing whose reading cannot be licensed is still
 * placed — `accepted` with a rung, a `pending` change — and never a refusal without a lock.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { DISPOSITIONS, type CarrierKind } from '@book/shared';

import { readCommentRow, toCommentDto } from '../../src/comments/repo.ts';
import { poll } from '../../src/feedback/triageApplier.ts';
import { chooseDisposition, type ChooseDispositionInput } from '../../src/feedback/disposition.ts';
import { bootComments, commentBody, type Harness } from '../comments/helpers.ts';

const SENTENCE_ID = 'snt_01M6228MR887YPYF2BDC4ZRKT5';
const BLOCK = 'Он вошёл в регистратуру. Там сидела женщина с бланком. Срок — тридцать дней.';
const QUOTE = 'Там сидела женщина с бланком.';
/** Two sentences in one quote: ADR-044 resolved no single sentence for it. */
const TWO_SENTENCES = 'Он вошёл в регистратуру. Там сидела женщина с бланком.';
const WORDING = 'В регистратуре выдают уведомление: срок тридцать дней и подпись.';
const KEPT = 'срок тридцать дней и подпись';
const STAMP = 'не соответствует форме';

const CARRIER: { carrierKind: CarrierKind; quoteKept: string; factsChanged: number } = {
  carrierKind: 'document',
  quoteKept: KEPT,
  factsChanged: 1,
};
const REFUSAL = {
  establishedFact: 'срок уже стоит в бланке',
  namedPerson: 'смотритель',
  namedInstance: 'регистратура',
  cost: 'очередь',
  stamp: STAMP,
};
const FREE_CAPS = { inWorldInChapterByReader: 0, stampUsedInChapter: false, runBefore: 0 };

function input(overrides: Partial<ChooseDispositionInput> = {}): ChooseDispositionInput {
  return {
    chapterIsBasis: false,
    chapter: 12,
    blockText: BLOCK,
    blockIndex: 3,
    sentenceIndex: 1,
    sentenceId: SENTENCE_ID,
    quote: QUOTE,
    body: 'В сцене этого некому сказать.',
    proposedText: WORDING,
    rightsVerdict: 'CLEAR',
    guard: null,
    flags: [],
    proposal: {},
    caps: FREE_CAPS,
    ...overrides,
  };
}

/** The closed codomain: the three rungs and the four locks' one disposition. */
const CODOMAIN = ['as_said', 'through_paper', 'refused_in_world', 'inadmissible'];

describe('the ladder is total: every rung × every licence × every lock', () => {
  it('never leaves the codomain, and never returns the removed fifth state', () => {
    const proposals: Array<[string, ChooseDispositionInput['proposal']]> = [
      ['absent (as_said)', {}],
      ['as_said', { disposition: 'as_said' }],
      ['paper, complete carrier', { disposition: 'through_paper', ...CARRIER }],
      ['paper, no carrier', { disposition: 'through_paper' }],
      ['paper, short kept fragment', { disposition: 'through_paper', ...CARRIER, quoteKept: 'тридцать дней' }],
      ['paper, not verbatim', { disposition: 'through_paper', ...CARRIER, quoteKept: 'срок тридцать дней и подпись автора' }],
      ['paper, unknown carrier', { disposition: 'through_paper', ...CARRIER, carrierKind: 'letter' as CarrierKind }],
      ['paper, no fact changed', { disposition: 'through_paper', ...CARRIER, factsChanged: 0 }],
      ['in world, complete', { disposition: 'refused_in_world', ...REFUSAL }],
      ['in world, a field missing', { disposition: 'refused_in_world', ...REFUSAL, cost: null }],
      ['in world, stamp past the bound', { disposition: 'refused_in_world', ...REFUSAL, stamp: 'ф'.repeat(121) }],
      ['inadmissible + finale', { disposition: 'inadmissible', lock: 'finale' }],
      ['inadmissible, no lock (a proposal may not refuse)', { disposition: 'inadmissible' }],
      ['an unknown word', { disposition: 'escalated' as never }],
      ['an unknown word with a carrier', { disposition: 'nonsense' as never, ...CARRIER }],
    ];
    const licences: Array<[string, Partial<ChooseDispositionInput>]> = [
      ['sentence resolved, nothing established moved', {}],
      ['no sentence resolved (a two-sentence quote)', { quote: TWO_SENTENCES, sentenceId: null, sentenceIndex: null }],
      ['a standing digit rewritten', { blockText: 'Срок — 30 дней. Он вошёл.', quote: 'Срок — 30 дней.', body: 'Срок — 30 дней, и всё.', proposedText: null }],
      ['a filing with no quote at all', { quote: null, blockText: null, blockIndex: null, sentenceId: null, sentenceIndex: null }],
    ];
    const caps: Array<[string, ChooseDispositionInput['caps']]> = [
      ['caps free', FREE_CAPS],
      ['this reader already refused in this chapter', { ...FREE_CAPS, inWorldInChapterByReader: 1 }],
      ['the stamp already stands in the chapter', { ...FREE_CAPS, stampUsedInChapter: true }],
      ['two in-world refusals in a row', { ...FREE_CAPS, runBefore: 2 }],
    ];
    const locks: Array<[string, Partial<ChooseDispositionInput>]> = [
      ['no lock', {}],
      ['the rights lock', { rightsVerdict: 'REFUSED' }],
      ['the harm lock', { guard: 'legal' }],
      ['the frame lock', { chapterIsBasis: true }],
    ];

    let cases = 0;
    for (const [proposalName, proposal] of proposals) {
      for (const [licenceName, licence] of licences) {
        for (const [capsName, capState] of caps) {
          for (const [lockName, lock] of locks) {
            cases += 1;
            const decision = chooseDisposition(input({ ...licence, ...lock, proposal, caps: capState }));
            const label = `${proposalName} · ${licenceName} · ${capsName} · ${lockName}`;
            expect(CODOMAIN, label).toContain(decision.disposition);
            expect(DISPOSITIONS, label).not.toContain('escalated');
            expect(decision.disposition, label).not.toBe('escalated');
            // A lock overrides every proposal; without one, a proposal never buys a refusal.
            if (lockName !== 'no lock') {
              expect(decision.disposition, label).toBe('inadmissible');
              expect(decision.lock, label).not.toBeNull();
            } else if (decision.disposition === 'inadmissible') {
              expect(decision.lock, label).toBe('finale');
            }
          }
        }
      }
    }
    // 15 proposals × 4 licence states × 4 cap states × 4 lock states.
    expect(cases).toBe(960);
  });

  it('keeps the floor when nothing above it is licensed', () => {
    // No resolved sentence, a paper that cannot be licensed, an in-world refusal without its
    // fields: every one of them ends at `as_said` on the block anchor, never at a person.
    const floor = chooseDisposition(
      input({
        quote: TWO_SENTENCES,
        sentenceId: null,
        sentenceIndex: null,
        proposal: { disposition: 'refused_in_world', ...REFUSAL, namedInstance: null },
      }),
    );
    expect(floor).toMatchObject({ disposition: 'as_said', lock: null, sentenceId: null, carrierKind: null });
  });
});

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe('the applier places a reading it cannot license (BOOK-206)', () => {
  it('an OFF filing with an unlicensed paper lands accepted on a rung, never refused without a lock', async () => {
    harness = await bootComments();
    const h = harness;
    const block = h.db.prepare('SELECT id FROM blocks WHERE chapter = 8 ORDER BY idx LIMIT 1').get() as { id: string };
    const posted = await h.app.inject({
      method: 'POST',
      url: '/api/comments',
      headers: h.headers(),
      payload: commentBody({
        chapter: 8,
        blockId: block.id,
        // The harness's own ch08 paragraph: the anchor has to resolve on a real block.
        quote: 'Тестовый абзац номер один.',
        body: 'Бумага вместо сцены.',
        proposedText: WORDING,
      }),
    });
    expect(posted.statusCode).toBe(201);
    const id = posted.json().comment.id as string;

    // The row the container leaves behind: gate C read it OFF, the answer carried a paper that
    // cannot be licensed (two kept words), and nothing was placed yet.
    h.db.prepare(`UPDATE comments SET audit_verdict = 'OFF', audit_reason = 'вне книги' WHERE id = ?`).run(id);
    h.db
      .prepare('UPDATE comment_attempts SET verdict = ?, verdict_at = ? WHERE comment_id = ? AND n = 1')
      .run(
        JSON.stringify({
          verdict: 'OFF',
          reason: 'вне книги',
          reading: {
            rung: 'through_paper',
            lock: null,
            intent: 'в абзаце сказано, что это служебный текст',
            carrier: { kind: 'document', quoteKept: 'тридцать дней', factsChanged: 1 },
            refusal: null,
          },
        }),
        new Date(h.clock.ms).toISOString(),
        id,
      );

    expect(poll({ db: h.db, emit: () => {}, notify: () => {}, now: h.clock.now })).toBe(1);
    const row = readCommentRow(h.db, id)!;
    expect(row).toMatchObject({ status: 'accepted', lock: null, disposition: 'as_said' });
    expect(CODOMAIN).toContain(row.disposition);
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE status = 'rejected' OR status = 'escalated'`).get()).toEqual({
      n: 0,
    });
    expect(h.db.prepare('SELECT status FROM changes').get()).toEqual({ status: 'pending' });
    expect(toCommentDto(h.db, row).report).toMatchObject({ line1: 'прочитано как сказано' });
  });
});
