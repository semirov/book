import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../../src/db/db.ts';
import { migrate } from '../../../src/db/migrate.ts';
import { classify } from '../../../src/ledger/graph/classify.ts';
import { closure } from '../../../src/graph/closure.ts';
import { graphFixture, promiseFixture, type GraphFixture } from './fixtures.ts';

/**
 * The constructed fixture BOOK-DOC-75 §2.3 demands: a promise voiced in ch05 and paid in ch12.
 * The split itself is BOOK-185's `mandatoryOf()` — these tests are about the adapter: the seeds
 * and the executed set are the two things this module adds, and nothing else.
 */
let db: Db;
let fixture: GraphFixture;

afterEach(() => {
  db.close();
});

function open(): void {
  db = openDatabase(':memory:');
  migrate(db);
  fixture = graphFixture(db);
}

describe('classify — the mandatory split is main’s, the seeds and the executed set are ours', () => {
  it('makes ch12 mandatory when its only support is the touched fact, and names the edge', () => {
    open();
    const { promise, deadline, edgeId } = promiseFixture(db);
    const classified = classify(db, closure(db, [promise]).nodes, {
      origin: 5,
      seeds: [promise],
      touched: [promise],
    });
    expect(classified).toEqual([
      {
        factId: deadline,
        chapter: 12,
        mandatory: true,
        reason: `sole support: ${edgeId}`,
        direction: 'descendant',
        hops: 1,
        via: edgeId,
      },
    ]);
    // The seed is the point of change, not a consequence: it is not classified at all.
    expect(classified.map((node) => node.factId)).not.toContain(promise);
  });

  it('leaves ch12 optional when another live fact still supports it', () => {
    open();
    const { promise, deadline } = promiseFixture(db);
    const second = fixture.fact({ id: 'f:other@ch03#cc', chapter: 3, statement: 'Второе основание.' });
    fixture.edge({ id: 'dep_other', from: second, to: deadline, chapter: 12, kind: 'cause' });
    const classified = classify(db, closure(db, [promise]).nodes, {
      origin: 5,
      seeds: [promise],
      touched: [promise],
    });
    expect(classified.find((node) => node.factId === deadline)).toMatchObject({
      mandatory: false,
      reason: 'support: dep_other',
    });
  });

  it('does not make an executed node mandatory again', () => {
    open();
    const { promise, deadline } = promiseFixture(db);
    const classified = classify(db, closure(db, [promise]).nodes, {
      origin: 5,
      seeds: [promise],
      touched: [promise],
      executed: [deadline],
    });
    expect(classified.find((node) => node.factId === deadline)).toMatchObject({
      mandatory: false,
      reason: 'executed',
    });
  });

  it('lists a node in the origin chapter as the change itself, never as mandatory', () => {
    open();
    fixture.fact({ id: 'f:a@ch05#aa', chapter: 5, statement: 'Первое.' });
    fixture.fact({ id: 'f:b@ch05#bb', chapter: 5, statement: 'Второе.' });
    fixture.edge({ id: 'dep_ab', from: 'f:a@ch05#aa', to: 'f:b@ch05#bb', chapter: 5, kind: 'cause' });
    const classified = classify(db, closure(db, ['f:a@ch05#aa']).nodes, {
      origin: 5,
      seeds: ['f:a@ch05#aa'],
      touched: ['f:a@ch05#aa'],
    });
    expect(classified).toEqual([
      expect.objectContaining({ factId: 'f:b@ch05#bb', mandatory: false, reason: 'origin' }),
    ]);
  });

  it('calls a fact with no support to lose optional, not mandatory', () => {
    open();
    const { promise } = promiseFixture(db);
    fixture.fact({ id: 'f:source@ch01#dd', chapter: 1, statement: 'Документ сам по себе.' });
    fixture.edge({ id: 'dep_promise', from: 'f:source@ch01#dd', to: promise, chapter: 5, kind: 'document' });
    const classified = classify(db, closure(db, [promise]).nodes, {
      origin: 5,
      seeds: [promise],
      touched: [promise],
    });
    // The promise is a seed (not classified); its source has no incoming edge of its own.
    expect(classified.find((node) => node.factId === 'f:source@ch01#dd')).toMatchObject({
      mandatory: false,
      reason: 'no support to lose',
    });
  });
});
