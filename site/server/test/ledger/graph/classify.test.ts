import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../src/db/db.ts';
import { migrate } from '../../../src/db/migrate.ts';
import { classify } from '../../../src/ledger/graph/classify.ts';
import { assertedFacts, walk } from '../../../src/ledger/graph/edges.ts';
import { AT, seedChapter } from '../helpers.ts';
import { promiseFixture } from './fixtures.ts';

/**
 * The constructed fixture BOOK-DOC-75 §2.3 demands: a promise voiced in ch05 and paid in ch12.
 * Everything else in this file is a variation of the four clauses of the predicate.
 */
let db: Db;

afterEach(() => {
  db.close();
});

function open(): void {
  db = openDatabase(':memory:');
  migrate(db);
}

describe('classify — mandatory is a predicate', () => {
  it('makes ch12 mandatory when the deadline value moved, and names the edge', () => {
    open();
    const { promise, deadline, edgeId } = promiseFixture(db, 'value');
    const moved = new Set<'value' | 'identity' | 'status' | 'existence'>(['value']);
    const walked = walk(db, [promise]);
    const classified = classify(walked.nodes, { moved, seeds: [promise], asserted: assertedFacts(db) });
    const ch12 = classified.find((node) => node.factId === deadline);
    expect(ch12).toEqual({
      factId: deadline,
      chapter: 12,
      mandatory: true,
      reason: `CAUSE_CHANGED:${edgeId}`,
      direction: 'forward',
      hops: 1,
      via: [edgeId],
    });
    // The seed is the point of change, not a consequence: it is not classified at all.
    expect(classified.map((node) => node.factId)).toEqual([deadline]);
  });

  it('leaves ch12 optional when the edge consumes an identity the change did not move', () => {
    open();
    const { promise, deadline } = promiseFixture(db, 'identity');
    const moved = new Set<'value' | 'identity' | 'status' | 'existence'>(['value']);
    const classified = classify(walk(db, [promise]).nodes, { moved, seeds: [promise], asserted: assertedFacts(db) });
    expect(classified.find((node) => node.factId === deadline)).toMatchObject({
      mandatory: false,
      reason: 'UNPROVEN_CAUSE',
    });
    // …and mandatory once the change itself moved identity.
    const identity = new Set<'value' | 'identity' | 'status' | 'existence'>(['identity']);
    expect(
      classify(walk(db, [promise]).nodes, { moved: identity, seeds: [promise], asserted: assertedFacts(db) }).find(
        (node) => node.factId === deadline,
      ),
    ).toMatchObject({ mandatory: true, reason: expect.stringMatching(/^CAUSE_CHANGED:/u) });
  });

  it('does not make an executed node mandatory again', () => {
    open();
    const { promise, deadline } = promiseFixture(db, 'value');
    const moved = new Set<'value' | 'identity' | 'status' | 'existence'>(['value']);
    const classified = classify(walk(db, [promise]).nodes, {
      moved,
      seeds: [promise],
      asserted: assertedFacts(db),
      executed: [deadline],
    });
    expect(classified.find((node) => node.factId === deadline)?.mandatory).toBe(false);
  });

  it('refuses to call a claim mandatory when its text no longer stands', () => {
    open();
    const { promise, deadline } = promiseFixture(db, 'value');
    // The block is re-written and the mention's witness is gone — the claim is not asserted.
    db.prepare(`UPDATE blocks SET text = 'Другая фраза.' WHERE chapter = 12`).run();
    const moved = new Set<'value' | 'identity' | 'status' | 'existence'>(['value']);
    const classified = classify(walk(db, [promise]).nodes, { moved, seeds: [promise], asserted: assertedFacts(db) });
    expect(classified.find((node) => node.factId === deadline)).toMatchObject({
      mandatory: false,
      reason: 'UNPROVEN_CAUSE',
    });
  });
});

describe('classify — the optional reasons are closed codes, not sentences', () => {
  it('calls a premise reached backwards a MOTIF', () => {
    open();
    const blocks = seedChapter(db, { chapter: 6, texts: ['Приказ 3-Б подписан оператором.'], at: AT });
    const causeBlocks = seedChapter(db, { chapter: 3, texts: ['Решено: приказ готовят к подписи.'], at: AT });
    const block = blocks[0];
    const causeBlock = causeBlocks[0];
    if (block === undefined || causeBlock === undefined) throw new Error('fixture did not seed a block');
    db.prepare(
      `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, created_at)
       VALUES ('f:cause', 3, 'decision', 'решено', 'решено', 3, ?),
              ('f:seed', 6, 'state', 'приказ 3-б подписан', 'приказ 3-Б', 6, ?)`,
    ).run(AT, AT);
    db.prepare(
      `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, role, witness, edge_path)
       VALUES ('bkd_T6_0:1:0', ?, 6, 0, 25, 'fact', 'f:seed', 'assert', 'Приказ 3-Б подписан оператором.', '[]')`,
    ).run(block.id);
    db.prepare(
      `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, role, witness, edge_path)
       VALUES (?, ?, 3, 0, 34, 'fact', 'f:cause', 'assert', ?, '[]')`,
    ).run(`${causeBlock.uid}:1:0`, causeBlock.id, causeBlock.text);
    db.prepare(
      `INSERT INTO edges (id, from_fact, to_fact, chapter, kind, on_component, evidence, origin, created_at)
       VALUES ('edg_premise', 'f:cause', 'f:seed', 6, 'follows', 'status', '', 'backfill', ?)`,
    ).run(AT);

    const classified = classify(walk(db, ['f:seed']).nodes, {
      moved: new Set(['value']),
      seeds: ['f:seed'],
      asserted: assertedFacts(db),
    });
    expect(classified[0]).toMatchObject({ factId: 'f:cause', direction: 'backward', reason: 'MOTIF', hops: 1 });
  });

  it('calls a bare document bucket a GENERIC_KEY and a value hop that did not move TONE', () => {
    open();
    const ch07 = seedChapter(db, { chapter: 7, texts: ['Заявление лежит в деле.', 'Срок — сорок дней.'], at: AT });
    const ch08 = seedChapter(db, { chapter: 8, texts: ['Заявление всё ещё в деле.', 'Срок — сорок дней.'], at: AT });
    const [seedBlock, seedValueBlock] = ch07;
    const [bucketBlock, valueBlock] = ch08;
    if (
      seedBlock === undefined ||
      seedValueBlock === undefined ||
      bucketBlock === undefined ||
      valueBlock === undefined
    ) {
      throw new Error('fixture did not seed blocks');
    }
    const insert = db.prepare(
      `INSERT INTO facts (id, chapter, kind, statement, term, valid_from_chapter, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('f:seed', 7, 'state', 'срок — сорок дней', 'срок', 7, AT);
    insert.run('f:d:заявление@ch08#aa', 8, 'document', 'заявление всё ещё в деле', 'заявление', 8, AT);
    insert.run('f:n:40@ch08#bb', 8, 'state', 'срок — сорок дней', 'сорок дней', 8, AT);
    const mention = db.prepare(
      `INSERT INTO mentions (span_id, block_id, chapter, start, end, kind, fact_id, role, witness, edge_path)
       VALUES (?, ?, ?, 0, ?, 'fact', ?, 'assert', ?, '[]')`,
    );
    mention.run('bkd_T7_0:1:0', seedBlock.id, 7, 7, 'f:seed', seedBlock.text);
    mention.run('bkd_T8_0:1:0', bucketBlock.id, 8, 25, 'f:d:заявление@ch08#aa', bucketBlock.text);
    mention.run('bkd_T8_1:1:0', valueBlock.id, 8, 18, 'f:n:40@ch08#bb', valueBlock.text);
    db.prepare(
      `INSERT INTO edges (id, from_fact, to_fact, chapter, kind, on_component, evidence, origin, created_at)
       VALUES ('edg_bucket', 'f:seed', 'f:d:заявление@ch08#aa', 8, 'references', 'identity', '', 'backfill', ?),
              ('edg_tone', 'f:seed', 'f:n:40@ch08#bb', 8, 'follows', 'value', '', 'backfill', ?)`,
    ).run(AT, AT);

    const classified = classify(walk(db, ['f:seed']).nodes, {
      moved: new Set(['status']),
      seeds: ['f:seed'],
      asserted: assertedFacts(db),
    });
    expect(classified.find((node) => node.factId === 'f:d:заявление@ch08#aa')).toMatchObject({
      mandatory: false,
      reason: 'GENERIC_KEY',
    });
    expect(classified.find((node) => node.factId === 'f:n:40@ch08#bb')).toMatchObject({
      mandatory: false,
      reason: 'TONE',
    });
  });
});
