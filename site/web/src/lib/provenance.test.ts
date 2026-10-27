import type { ParagraphChainDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { frozenActionHref, paragraphLine, provenanceView, rewriteLine, shareFor, shareLine, type TraceShare } from './provenance.ts';

const CHAIN: ParagraphChainDto = {
  blockUid: 'blk_1',
  blockId: 'ch08#aa11bb22',
  chapter: 8,
  alive: true,
  line: 'переписано в 12:04 правкой 7 · было: правка 3 (Аня)',
  versions: [
    {
      blockUid: 'blk_1',
      ver: 1,
      blockId: 'ch08#aa11bb22',
      chapter: 8,
      rev: 3,
      at: '2026-10-20T09:00:00Z',
      op: 'introduced',
      textHash: 'aa11bb22',
      chars: 120,
      changeId: 'chg_3',
      changeSeq: 3,
      stepId: 'stp_3',
      actor: { kind: 'reader', identityId: 'id_1', label: 'Аня' },
      replacedBy: null,
    },
    {
      blockUid: 'blk_1',
      ver: 2,
      blockId: 'ch08#aa11bb22',
      chapter: 8,
      rev: 4,
      at: '2026-10-21T12:04:00Z',
      op: 'revised',
      textHash: 'cc33dd44',
      chars: 118,
      changeId: 'chg_7',
      changeSeq: 7,
      stepId: 'stp_7',
      actor: { kind: 'writer', identityId: null, label: 'автор' },
      replacedBy: null,
    },
  ],
};

describe('shareLine', () => {
  it('prints the viewer’s own trace exactly as the end matter does', () => {
    expect(shareLine({ kind: 'own', share: 0.004, survivedRevisions: 4 })).toBe('пережила 4 ревизии, сейчас 0,4 %');
    expect(shareLine({ kind: 'own', share: 0.004, survivedRevisions: 1 })).toBe('пережила 1 ревизию, сейчас 0,4 %');
  });

  it('prints a public share without any survival curve', () => {
    expect(shareLine({ kind: 'public', share: 0.004, edits: 3 })).toBe('доля в книге 0,4 % · правок 3');
  });

  it('never invents a share for a word with no history', () => {
    expect(shareLine({ kind: 'none' })).toBe('читательского следа нет');
  });
});

describe('rewriteLine', () => {
  it('counts the rewrites of the paragraph, not its versions', () => {
    expect(rewriteLine(CHAIN)).toBe('переписан 1 раз после неё');
    expect(rewriteLine(null)).toBe('написан целиком; читательских правок в нём не было');
  });
});

describe('the абзац row without a chain (BOOK-68)', () => {
  it('says a missing history is a fact, not a revisions claim', () => {
    expect(paragraphLine('none', null)).toBe('у этой строки нет истории');
    expect(paragraphLine('none', null)).not.toContain('написан целиком');
  });

  it('says a request is still being read while it is', () => {
    expect(paragraphLine('loading', null)).toBe('цепочка читается…');
  });

  it('says a failed read failed instead of claiming anything about the text', () => {
    expect(paragraphLine('failed', null)).toBe('история не прочиталась');
    expect(paragraphLine('failed', null)).not.toContain('нет истории');
  });

  it('counts rewrites only when the chain is really there', () => {
    expect(paragraphLine('ready', CHAIN)).toBe('переписан 1 раз после неё');
  });

  it('reaches the panel through provenanceView', () => {
    const none = provenanceView({ word: 'свет', chapter: 8, variant: 'machine', share: { kind: 'none' }, chain: null, history: 'none', at: null });
    expect(none.rows.find((row) => row.label === 'абзац')?.value).toBe('у этой строки нет истории');
    const loading = provenanceView({ word: 'свет', chapter: 8, variant: 'machine', share: { kind: 'none' }, chain: null, history: 'loading', at: null });
    expect(loading.rows.find((row) => row.label === 'абзац')?.value).toBe('цепочка читается…');
  });
});

describe('which share a word may print (BOOK-33)', () => {
  const own = { share: 0.004, survivedRevisions: 4 };

  it('gives the viewer their own line on their own word', () => {
    expect(
      shareFor({
        actor: { kind: 'reader', label: 'Филипп' },
        viewerName: 'Филипп',
        own,
        publicShares: [{ label: 'Филипп', share: 0.004, edits: 3 }],
      }),
    ).toEqual({ kind: 'own', share: 0.004, survivedRevisions: 4 });
  });

  it('gives another reader the public numbers only, never the survival curve', () => {
    const share = shareFor({
      actor: { kind: 'reader', label: 'Аня' },
      viewerName: 'Филипп',
      own,
      publicShares: [{ label: 'Аня', share: 0.011, edits: 3 }],
    });
    expect(share).toEqual({ kind: 'public', share: 0.011, edits: 3 });
    expect(JSON.stringify(share)).not.toContain('survived');
  });

  it('says a reader word is unmeasured when nobody can be named', () => {
    expect(shareFor({ actor: { kind: 'reader', label: 'Аня' }, viewerName: null, own: null, publicShares: [] })).toEqual({
      kind: 'unknown',
    });
  });

  it('has no trace for a word the author wrote', () => {
    expect(shareFor({ actor: { kind: 'author', label: 'автор' }, viewerName: 'Филипп', own, publicShares: [] })).toEqual({
      kind: 'none',
    });
  });
});

describe('provenanceView', () => {
  const own: TraceShare = { kind: 'own', share: 0.004, survivedRevisions: 4 };

  it('says plainly that a machine word has no reader lineage', () => {
    const view = provenanceView({ word: 'пустую', chapter: 8, variant: 'machine', share: { kind: 'none' }, chain: null, history: 'none', at: null });
    expect(view.rows.map((row) => row.label)).toEqual(['кто внёс', 'когда', 'след', 'абзац', 'точность']);
    expect(view.rows.find((row) => row.label === 'кто внёс')?.value).toBe('автор');
    expect(view.copy).toBe('у этого слова нет читательской родословной: его написал автор.');
    expect(view.action).toEqual({ kind: 'form', label: 'вмешаться здесь' });
    expect(view.chapterLine).toBe('глава 08');
  });

  it('offers no form on a frozen word and says why it does not change', () => {
    const view = provenanceView({ word: 'свет', chapter: 1, variant: 'frozen', share: { kind: 'none' }, chain: null, history: 'none', at: null, frozenOf: 'frame' });
    expect(view.rows.find((row) => row.label === 'след')?.value).toBe('закреплено; не меняется');
    expect(view.action).toEqual({ kind: 'rules', label: 'что это значит →' });
    expect(view.copy).toBeNull();
    expect(frozenActionHref()).toBe('/rules#рамка');

    const page = provenanceView({ word: 'материя', chapter: 0, variant: 'frozen', share: { kind: 'none' }, chain: null, history: 'none', at: null, frozenOf: 'basis' });
    expect(page.rows.find((row) => row.label === 'след')?.value).toBe('основание; страница не редактируется');
  });

  it('coarsens precision to the paragraph, in the quiet tone', () => {
    const view = provenanceView({ word: 'свет', chapter: 8, variant: 'machine', share: own, chain: CHAIN, history: 'ready', at: null });
    expect(view.rows.find((row) => row.label === 'точность')).toMatchObject({ value: 'слово в пределах абзаца', quiet: true });
    expect(view.rows.find((row) => row.label === 'когда')?.value).toContain('2026');
  });

  it('never publishes another reader’s survivedRevisions', () => {
    const publicView = provenanceView({
      word: 'свет',
      chapter: 8,
      variant: 'unattributed',
      share: { kind: 'public', share: 0.004, edits: 3 },
      chain: CHAIN,
      history: 'ready',
      at: null,
    });
    const text = JSON.stringify(publicView);
    expect(text).not.toContain('пережила');
    expect(text).toContain('доля в книге 0,4 % · правок 3');
    expect(publicView.rows.find((row) => row.label === 'кто внёс')?.value).toBe('автор');
  });

  it('names the change by its number, never by a raw id (BOOK-59)', () => {
    const view = provenanceView({ word: 'свет', chapter: 8, variant: 'machine', share: own, chain: CHAIN, history: 'ready', at: null });
    expect(view.chain.find((row) => row.label === 'правка')?.value).toBe('правка 007');
    expect(JSON.stringify(view)).not.toContain('chg_');
  });

  it('names the unattributed version the way the log does', () => {
    const view = provenanceView({ word: 'свет', chapter: 8, variant: 'unattributed', share: { kind: 'none' }, chain: null, history: 'none', at: null });
    expect(view.rows.find((row) => row.label === 'кто внёс')?.value).toBe('правка вне процесса');
  });
});
