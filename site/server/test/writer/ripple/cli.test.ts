/**
 * The ripple's two commands (BOOK-173, BOOK-DOC-75 §6): `--ripple` runs one chapter of the oldest
 * plan still owed work, `--plan <id>` prints the reviewable table and runs nothing. Arguments are
 * data here — the parse is what a test can prove without a process, and the table is a pure
 * renderer over the plan and the blocks the plan points at.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Db } from '../../../src/db/db.ts';
import { planTable } from '../../../src/writer/ripple/drain.ts';
import { parseArgs } from '../../../src/writer/main.ts';
import { AT, ledgerFixture, seedChapter, type LedgerFixture } from '../../ledger/helpers.ts';

function cliOf(argv: string[]): { mode: string; changeId: string | null } {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(`refused: ${parsed.error}`);
  return { mode: parsed.cli.mode, changeId: parsed.cli.changeId };
}

function errorOf(argv: string[]): string {
  const parsed = parseArgs(argv);
  if (parsed.ok) throw new Error(`expected a refusal for ${argv.join(' ')}`);
  return parsed.error;
}

describe('the writer CLI and the ripple', () => {
  it('knows --ripple and --plan, and keeps them apart from the other shapes', () => {
    expect(cliOf(['--ripple'])).toEqual({ mode: 'ripple', changeId: null });
    expect(cliOf(['--plan', 'chg_1'])).toEqual({ mode: 'plan', changeId: 'chg_1' });
    expect(cliOf(['--plan=chg_1']).changeId).toBe('chg_1');
    expect(errorOf(['--ripple', '--chapter', '12'])).toContain('--ripple chooses its own chapter');
    expect(errorOf(['--ripple', '--revert', '--chapter', '12'])).toContain('two different shapes');
    expect(errorOf(['--plan', 'chg_1', '--ripple'])).toContain('runs nothing');
    expect(errorOf(['--plan'])).toContain('flag --plan needs a value');
  });
});

describe('the reviewable table', () => {
  let fixture: LedgerFixture;
  let db: Db;

  afterEach(() => {
    db.close();
    fixture.close();
  });

  it('prints chapter, block, the block’s text, the claim, the reason and the price', () => {
    fixture = ledgerFixture();
    db = fixture.db;
    const blocks = seedChapter(db, { chapter: 12, texts: ['Допуск всё ещё выдан, и смена стоит.'], at: AT });
    const first = blocks[0];
    if (first === undefined) throw new Error('no block');
    const rows = planTable(db, {
      changeId: 'chg_1',
      chapter: 5,
      outcome: 'ripple',
      proven: true,
      seeds: [],
      nodes: [
        {
          factId: 'f:d:допуск@ch12#status',
          chapter: 12,
          blockId: first.id,
          mandatory: true,
          reason: 'CAUSE_CHANGED:edg_doc_12' as never,
          direction: 'descendant' as never,
          hops: 1,
          via: '',
          quote: 'Допуск всё ещё выдан.',
        },
        {
          factId: 'f:tone',
          chapter: 19,
          blockId: null,
          mandatory: false,
          reason: 'TONE' as never,
          direction: 'ancestor' as never,
          hops: 2,
          via: '',
          quote: '',
        },
      ],
      edges: [],
      edgeDetail: [],
      patches: [],
      closureSize: { nodes: 2, edges: 0, chapters: 2, parts: 0 },
      chaptersTouched: [5, 12, 19],
      bounds: { chars: 4_000, usd: 0.6, iterations: 4, nodes: 1_500, edges: 3_000 },
      unresolved: [],
      truncated: false,
    });
    expect(rows[0]).toContain('план chg_1: ripple');
    expect(rows[1]).toContain('гл. 12');
    expect(rows[1]).toContain(first.id);
    // Before → after from `block_versions`: version 1 is a checkpoint, so there is no earlier text.
    expect(rows[1]).toContain('— → «Допуск всё ещё выдан, и смена стоит.»');
    expect(rows[1]).toContain('CAUSE_CHANGED:edg_doc_12');
    expect(rows[1]).toContain('обязательный');
    expect(rows[1]).toContain('$0.14');
    // A node with no block prints «—», and an optional node carries no price.
    expect(rows[2]).toContain('—');
    expect(rows[2]).toContain('отсрочиваемый');
    expect(rows[2]).not.toContain('$0.14');
  });
});
