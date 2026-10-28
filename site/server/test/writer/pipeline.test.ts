/**
 * The writer's view of the pin (BOOK-117). The pin and its validation are ADR-038's
 * (`server/test/pipelineConfig.test.ts`), the prices are BOOK-114's (`cost/rates.ts`, covered by
 * `server/test/cost.test.ts`); this file pins only the facade the lane calls: `loadPipeline`
 * returns the pin plus the pinned model's rate from the book's one table, `apiModelOf` derives
 * the wire id, and `costUsd(pricing, usage)` is the same arithmetic the ledger uses.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { apiModelOf, costUsd, loadPipeline } from '../../src/writer/pipeline.ts';

const SITE = resolve(import.meta.dirname, '..', '..', '..');
const COMMITTED = join(SITE, 'config', 'pipeline.json');

const dirs: string[] = [];

function copy(document: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-pipeline-'));
  dirs.push(dir);
  const path = join(dir, 'pipeline.json');
  writeFileSync(path, typeof document === 'string' ? document : JSON.stringify(document));
  return path;
}

const valid = (): Record<string, unknown> => ({
  provider: 'deepseek',
  model: 'deepseek/deepseek-v4-pro',
  endpoint: 'https://api.deepseek.com/chat/completions',
  maxOutputTokens: 32768,
  pricing: { currency: 'USD', per: 1_000_000, input: 0.66, output: 1.98, cacheRead: 0.022, source: 'models.dev', date: '2026-10-27' },
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('writer/pipeline — the pin the lane reads', () => {
  it('loads the committed pin and derives the pinned model’s rate from the book’s table', () => {
    const pipeline = loadPipeline(COMMITTED);
    expect(pipeline.model).toBe('deepseek/deepseek-v4-pro');
    expect(pipeline.apiModel).toBe('deepseek-v4-pro');
    expect(apiModelOf(pipeline)).toBe('deepseek-v4-pro');
    expect({ input: pipeline.pricing.input, output: pipeline.pricing.output }).toEqual({ input: 0.66, output: 1.98 });
    expect(pipeline.pricing.per).toBe(1_000_000);
  });

  it('prices whatever the pin names, not a second literal: a flash pin carries flash’s row', () => {
    const document = valid();
    document.model = 'deepseek/deepseek-flash';
    const pipeline = loadPipeline(copy(document));
    expect({ input: pipeline.pricing.input, output: pipeline.pricing.output }).toEqual({ input: 0.15, output: 0.6 });
  });

  it('refuses a pin whose model the book’s table does not price', () => {
    const document = valid();
    document.model = 'deepseek/deepseek-unknown';
    expect(() => loadPipeline(copy(document))).toThrow(/no rate for deepseek\/deepseek-unknown/u);
  });

  it('carries the pin’s own validation message, never a second one', () => {
    expect(() => loadPipeline(join(tmpdir(), 'book-pipeline-missing', 'pipeline.json'))).toThrow(/^pipeline: /u);
    expect(() => loadPipeline(copy({ ...valid(), extra: 1 }))).toThrow(/^pipeline: /u);
  });

  it('throws Error, so a caller can branch on the class', () => {
    expect(() => loadPipeline(copy('not json'))).toThrow(Error);
  });
});

describe('writer/pipeline costUsd — the pass arithmetic', () => {
  const pipeline = loadPipeline(COMMITTED);

  it('charges input and output at the pinned price, per the file’s unit', () => {
    // 8 000 in and 9 000 out on Pro: 8000/1e6*0.66 + 9000/1e6*1.98 = 0.00528 + 0.01782
    expect(costUsd(pipeline.pricing, { in: 8_000, out: 9_000, cachedIn: 0 })).toBeCloseTo(0.0231, 6);
  });

  it('is zero for a pass that spent nothing, not a guess', () => {
    expect(costUsd(pipeline.pricing, { in: 0, out: 0, cachedIn: 0 })).toBe(0);
  });

  it('ignores the cache split a step cannot record, so it can only overstate a pass', () => {
    const withCache = costUsd(pipeline.pricing, { in: 8_000, out: 0, cachedIn: 8_000 });
    const withoutCache = costUsd(pipeline.pricing, { in: 8_000, out: 0, cachedIn: 0 });
    expect(withCache).toBe(withoutCache);
  });
});
