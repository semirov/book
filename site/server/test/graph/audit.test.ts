/**
 * `graph audit` (BOOK-185, BOOK-DOC-77 §6): the witnesses of the live facts, judged again.
 *
 * The command is read-only by contract: it opens the projection, asks the validator's own
 * `supportProblem` of every live fact's `assert` mention and prints. The tests seed one fact whose
 * witness proves its value and one whose witness does not (`document:12` vs «Приказ 121 подшит»),
 * then check what the tool says and that it changed nothing.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { auditFacts, renderAudit } from '../../src/graph/audit.ts';
import { runGraph } from '../../src/graph/cli.ts';
import { graphFixture, seedFact, seedMention, type GraphFixture } from './helpers.ts';

let fixture: GraphFixture;

afterEach(() => {
  fixture.close();
});

function rows(sql: string): unknown[] {
  return fixture.db.prepare(sql).all();
}

/** Chapter 3's date is proven by its quote; chapter 5's «12» is part of 121. */
function seed(): void {
  fixture = graphFixture();
  seedFact(fixture.db, { id: 'fct_date', chapter: 3, kind: 'date', key: 'date:2065-09-14' });
  seedMention(fixture.db, { factId: 'fct_date', chapter: 3, witness: 'Акт от 14.09.2065' });
  seedFact(fixture.db, { id: 'fct_doc', chapter: 5, kind: 'document', key: 'document:12' });
  seedMention(fixture.db, { factId: 'fct_doc', chapter: 5, witness: 'Приказ 121 подшит' });
}

const io = (): { log: (line: string) => void; error: (line: string) => void; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  return { log: (line) => out.push(line), error: (line) => err.push(line), out, err };
};

describe('the audit of the live facts', () => {
  it('reports the witness that does not prove its value and passes the one that does', () => {
    seed();
    const report = auditFacts(fixture.db);
    expect(report).toMatchObject({ checked: 2, failed: 1, skipped: 0 });
    expect(report.failures).toEqual([
      {
        chapter: 5,
        key: 'document:12',
        quote: 'Приказ 121 подшит',
        reason: 'the quote does not contain the document number or its words',
      },
    ]);
  });

  it('narrows to one chapter', () => {
    seed();
    expect(auditFacts(fixture.db, { chapter: 3 })).toMatchObject({ checked: 1, failed: 0, failures: [] });
    expect(auditFacts(fixture.db, { chapter: 5 })).toMatchObject({ checked: 1, failed: 1 });
    expect(auditFacts(fixture.db, { chapter: 6 })).toMatchObject({ checked: 0, failed: 0, failures: [] });
  });

  it('counts a live fact with no assert mention instead of guessing a quote', () => {
    seed();
    seedFact(fixture.db, { id: 'fct_bare', chapter: 7, kind: 'term', key: 'term:очередь' });
    const report = auditFacts(fixture.db);
    expect(report).toMatchObject({ checked: 2, failed: 1, skipped: 1 });
    expect(renderAudit(report).at(-1)).toBe('audit: 2 live facts checked, 1 unsupported, 1 without a witness');
  });

  it('reads one witness per fact: a second assert mention is the same fact, not a second check', () => {
    seed();
    seedMention(fixture.db, { factId: 'fct_doc', chapter: 5, witness: 'Приказ 121 подшит', start: 20 });
    const report = auditFacts(fixture.db);
    expect(report).toMatchObject({ checked: 2, failed: 1 });
    expect(report.failures).toHaveLength(1);
  });

  it('writes nothing', () => {
    seed();
    const before = JSON.stringify({
      facts: rows('SELECT * FROM facts ORDER BY id'),
      mentions: rows('SELECT * FROM mentions ORDER BY id'),
      literals: rows('SELECT * FROM literals ORDER BY id'),
    });
    auditFacts(fixture.db);
    auditFacts(fixture.db, { chapter: 5 });
    const after = JSON.stringify({
      facts: rows('SELECT * FROM facts ORDER BY id'),
      mentions: rows('SELECT * FROM mentions ORDER BY id'),
      literals: rows('SELECT * FROM literals ORDER BY id'),
    });
    expect(after).toBe(before);
  });

  it('renders the finding and the summary', () => {
    seed();
    const lines = renderAudit(auditFacts(fixture.db));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('ch5 document:12 — the quote does not contain the document number or its words · «Приказ 121 подшит»');
    expect(lines[1]).toBe('audit: 2 live facts checked, 1 unsupported');
  });
});

describe('the command', () => {
  it('prints the findings and exits 1, and exits 0 on a clean chapter', () => {
    seed();
    const dirty = io();
    expect(runGraph(['audit', '--data-dir', fixture.dataDir], dirty, { bookRoot: fixture.dataDir })).toBe(1);
    expect(dirty.out[0]).toContain('ch5 document:12');
    expect(dirty.out.at(-1)).toBe('audit: 2 live facts checked, 1 unsupported');

    const clean = io();
    expect(runGraph(['audit', '--data-dir', fixture.dataDir, '--chapter', '3'], clean, { bookRoot: '' })).toBe(0);
    expect(clean.out.at(-1)).toBe('audit: 1 live facts checked, 0 unsupported');

    const json = io();
    expect(runGraph(['audit', '--data-dir', fixture.dataDir, '--json'], json, { bookRoot: '' })).toBe(1);
    expect(JSON.parse(json.out[0] ?? '{}')).toMatchObject({ checked: 2, failed: 1 });
  });

  it('refuses a missing data directory, an unknown flag and a non-chapter', () => {
    seed();
    const missing = io();
    expect(runGraph(['audit'], missing, { bookRoot: '' })).toBe(2);
    expect(missing.err[0]).toBe('graph: --data-dir is required');

    const unknown = io();
    expect(runGraph(['audit', '--data-dir', fixture.dataDir, '--nope'], unknown, { bookRoot: '' })).toBe(2);
    expect(unknown.err[0]).toContain('--nope');

    const badChapter = io();
    expect(runGraph(['audit', '--data-dir', fixture.dataDir, '--chapter', 'первая'], badChapter, { bookRoot: '' })).toBe(2);
    expect(badChapter.err[0]).toBe('graph: --chapter must be a chapter number');

    const outOfRange = io();
    expect(runGraph(['audit', '--data-dir', fixture.dataDir, '--chapter', '68'], outOfRange, { bookRoot: '' })).toBe(2);
    expect(outOfRange.err[0]).toBe('graph: --chapter must be between 1 and 67');
  });
});
