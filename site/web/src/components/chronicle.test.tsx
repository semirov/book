import type { CatalogEntry, ParagraphChainDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Chronicle } from './Chronicle.tsx';
import { ParagraphChain } from './ParagraphChain.tsx';
import { ViewSwitch } from './ViewSwitch.tsx';

const CHAIN: ParagraphChainDto = {
  blockUid: 'bkd_1',
  blockId: 'ch08#0b7e9c31',
  chapter: 8,
  alive: true,
  line: 'переписано в 14:20 правкой 7 (Марк) · было: правка 3 (Аня)',
  versions: [
    {
      blockUid: 'bkd_1',
      ver: 1,
      blockId: 'ch08#aa11bb22',
      chapter: 8,
      rev: 2,
      at: '2026-10-25T11:04:00Z',
      op: 'introduced',
      textHash: 'aa11bb22',
      chars: 96,
      changeId: 'chg_3',
      stepId: 'stp_1',
      actor: { kind: 'reader', identityId: 'idt_1', label: 'Аня' },
      replacedBy: null,
    },
    {
      blockUid: 'bkd_1',
      ver: 2,
      blockId: 'ch08#0b7e9c31',
      chapter: 8,
      rev: 5,
      at: '2026-10-25T11:20:00Z',
      op: 'revised',
      textHash: '0b7e9c31',
      chars: 112,
      changeId: 'chg_7',
      stepId: 'stp_2',
      actor: { kind: 'reader', identityId: 'idt_2', label: 'Марк' },
      replacedBy: null,
    },
  ],
};

const CATALOG: CatalogEntry[] = [
  {
    n: 8,
    part: 1,
    title: 'Тестовая глава',
    rev: 5,
    chars: 9_000,
    blocks: 120,
    written: true,
    basis: false,
    writtenAt: '2026-10-25T11:00:00Z',
    updatedAt: '2026-10-25T11:20:00Z',
    direction: 'forward',
  },
];

describe('the chronicle’s surface (§11.10)', () => {
  it('renders the toggle with the active view marked', () => {
    const book = renderToStaticMarkup(<ViewSwitch view="book" onChange={() => undefined} />);
    expect(book).toContain('книга');
    expect(book).toContain('хроника');
    expect(book).toContain('aria-pressed="true"');
    const chronicle = renderToStaticMarkup(<ViewSwitch view="chronicle" onChange={() => undefined} />);
    expect(chronicle).toContain('is-on');
  });

  it('renders the filters, the scrubber and the read-only empty state', () => {
    const html = renderToStaticMarkup(
      <Chronicle catalog={CATALOG} frontRev={1} tick={0} onOpenChange={() => undefined} />,
    );
    for (const label of ['всё', 'правки', 'черновики', 'первая страница', 'перезаписи']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('type="range"');
    expect(html).toContain('сейчас');
    expect(html).toContain('пока ничего не записано');
    // The past is not offered before a moment is chosen.
    expect(html).not.toContain('вернуться к «сейчас»');
  });

  it('renders a paragraph chain with the SPEC’s copy and every version', () => {
    const html = renderToStaticMarkup(<ParagraphChain chain={CHAIN} loading={false} onClose={() => undefined} />);
    expect(html).toContain('откуда эта фраза');
    expect(html).toContain('переписано в 14:20 правкой 7 (Марк) · было: правка 3 (Аня)');
    expect(html).toContain('эта строка сейчас в тексте · глава 8');
    expect(html).toContain('написано');
    expect(html).toContain('ch08#0b7e9c31');
    // The chain never shows the text of any version — it is metadata and ids only.
    expect(html).not.toContain('Тестовая глава');
  });

  it('says so when a paragraph has no history', () => {
    const html = renderToStaticMarkup(<ParagraphChain chain={null} loading={false} onClose={() => undefined} />);
    expect(html).toContain('у этой строки нет истории');
    const loading = renderToStaticMarkup(<ParagraphChain chain={null} loading onClose={() => undefined} />);
    expect(loading).toContain('цепочка читается');
  });
});
