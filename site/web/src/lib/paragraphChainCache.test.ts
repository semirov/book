import type { ParagraphChainDto } from '@book/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { knownParagraphChain, loadParagraphChain, resetParagraphChainCache } from './paragraphChainCache.ts';

/**
 * BOOK-68 — a history the client already knows is not asked for twice.
 *
 * A 404 and a DTO with no versions are both answers, and both are kept; a failure is not an
 * answer, so nothing is kept for it and the next open reaches the server again.
 */

const CHAIN: ParagraphChainDto = {
  blockUid: 'blk_1',
  blockId: 'ch08#aa11bb22',
  chapter: 8,
  alive: true,
  versions: [],
  line: 'без переписей',
};

function answer(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  resetParagraphChainCache();
  vi.unstubAllGlobals();
});

describe('the paragraph chain memo', () => {
  it('keeps a 404 as an answer: two loads, one request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer({ code: 'NOT_FOUND', message: 'no block' }, 404));
    vi.stubGlobal('fetch', fetchMock);
    expect(knownParagraphChain('ch08#none').known).toBe(false);
    expect(await loadParagraphChain('ch08#none')).toBeNull();
    expect(knownParagraphChain('ch08#none')).toEqual({ known: true, chain: null });
    expect(await loadParagraphChain('ch08#none')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/history/paragraphs/ch08%23none');
  });

  it('keeps a chain with no versions: the panel has its answer already', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(CHAIN));
    vi.stubGlobal('fetch', fetchMock);
    expect(await loadParagraphChain(CHAIN.blockId)).toEqual(CHAIN);
    expect(await loadParagraphChain(CHAIN.blockId)).toEqual(CHAIN);
    expect(knownParagraphChain(CHAIN.blockId)).toEqual({ known: true, chain: CHAIN });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks once while the first request is still in flight', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(CHAIN));
    vi.stubGlobal('fetch', fetchMock);
    const [first, second] = await Promise.all([loadParagraphChain(CHAIN.blockId), loadParagraphChain(CHAIN.blockId)]);
    expect(first).toEqual(CHAIN);
    expect(second).toEqual(CHAIN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing for a failure: the retry reaches the server', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer({ code: 'INTERNAL', message: 'boom' }, 500))
      .mockResolvedValueOnce(answer(CHAIN));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadParagraphChain(CHAIN.blockId)).rejects.toThrow();
    expect(knownParagraphChain(CHAIN.blockId).known).toBe(false);
    expect(await loadParagraphChain(CHAIN.blockId)).toEqual(CHAIN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
