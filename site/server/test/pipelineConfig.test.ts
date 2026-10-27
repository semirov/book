/**
 * T1 (ADR-038 §14, BOOK-62) — the pipeline's model has **one** machine source.
 *
 * `site/config/pipeline.json` names the model; `loadConfig` reads and validates it at boot; the
 * API model id is derived, never declared. The two prose files that state the same literal
 * (`process/ROLE_PROMPTS.md` §4, `.opencode/skills/writing-pass/SKILL.md` §3–4) are checked
 * here, and so is the reverse: no other shipped file may name the model, and nothing under the
 * app's sources may mention the model lane (the lane must stay outside every gate).
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadConfig, SITE_ROOT } from '../src/config.ts';
import { rateFor } from '../src/cost/rates.ts';
import { loadPipeline } from '../src/pipeline.ts';

const BOOK_ROOT = resolve(SITE_ROOT, '..');
const PIPELINE_FILE = join(SITE_ROOT, 'config', 'pipeline.json');
const pipeline = loadConfig({}).pipeline;
/** The literal as one contiguous string, read from the file — never retyped in code. */
const LITERAL = pipeline.model;
/** The request id the provider is asked for; derived here the same way the server does. */
const API_MODEL = 'deepseek-v4-pro';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.data', 'shots']);
const TEXT_EXT = /\.(ts|tsx|mjs|js|json|css|sql|md)$/u;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A test is not shipped source: the guard already exempts its own file, and `server/test/` now
 * holds another test that names the model for its own reasons (`cost.test.ts`). One rule, both
 * shapes: a `test/` directory segment, or a `*.test.ts(x)` file under `web/src`.
 */
const isTestFile = (file: string): boolean =>
  /[\\/]test[\\/]/u.test(relative(SITE_ROOT, file)) || /\.test\.tsx?$/u.test(file);

/**
 * The one shipped file allowed to name the model besides the pin: BOOK-114's **price registry**
 * (`USD_RATES_PER_MILLION`, keyed by model name). A registry must name models to price them, and
 * it must not default one; the tie to the pin is asserted below, so a price drift is red.
 */
const ALLOWED_CARRIERS = new Set(['server/src/cost/rates.ts']);

describe('T1 — config/pipeline.json is the only place the model lives', () => {
  it('loads the file into the config, with the prices and the derived API model', () => {
    const file = JSON.parse(readFileSync(PIPELINE_FILE, 'utf8')) as Record<string, unknown>;
    expect(pipeline).toMatchObject({
      provider: file.provider as string,
      model: file.model as string,
      endpoint: file.endpoint as string,
      pricing: file.pricing as Record<string, unknown>,
    });
    // AC1: the value itself, pinned by the shape and the derived request id.
    expect(pipeline.model).toBe(`${pipeline.provider}/${API_MODEL}`);
    expect(pipeline.apiModel).toBe(API_MODEL);
    expect(pipeline.provider).toBe('deepseek');
    expect(pipeline.endpoint.startsWith('https://')).toBe(true);
    for (const price of [pipeline.pricing.input, pipeline.pricing.output, pipeline.pricing.cacheRead]) {
      expect(price).toBeGreaterThan(0);
    }
    expect(pipeline.pricing.per).toBe(1_000_000);
    expect(pipeline.pricing.source.length).toBeGreaterThan(0);
    expect(pipeline.pricing.date.length).toBeGreaterThan(0);
    // The output cap is part of the pin: the provider's default is eaten by reasoning and a real
    // answer comes back empty with `finish_reason: "length"` (BOOK-62, measured 2026-10-27).
    expect(Number.isInteger(pipeline.maxOutputTokens)).toBe(true);
    expect(pipeline.maxOutputTokens).toBeGreaterThan(0);
    expect(pipeline.maxOutputTokens).toBe((JSON.parse(readFileSync(PIPELINE_FILE, 'utf8')) as { maxOutputTokens: number }).maxOutputTokens);
  });

  it('refuses a mutated copy: an unknown key, a bad model and a price at zero all fail the boot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-pipeline-'));
    tempDirs.push(dir);
    const base = JSON.parse(readFileSync(PIPELINE_FILE, 'utf8')) as Record<string, unknown>;
    const write = (name: string, value: unknown): string => {
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(value), 'utf8');
      return path;
    };

    // A typo is not a default: `modelId` is an unknown key and `model` is then missing.
    expect(() => loadPipeline(write('typo', { ...base, modelId: base.model }))).toThrow(/pipeline: /u);
    // The provider prefix must match, or the derived request id would name another model.
    expect(() =>
      loadPipeline(write('provider', { ...base, model: `other/${API_MODEL}` })),
    ).toThrow(/provider/u);
    // A price of zero silently makes every cost report lie.
    expect(() =>
      loadPipeline(
        write('price', { ...base, pricing: { ...(base.pricing as object), input: 0 } }),
      ),
    ).toThrow(/pricing\.input/u);
    // The output cap must be a positive integer: zero, a fraction and a string all stop the boot.
    for (const bad of [0, -1, 1.5, '32768']) {
      expect(() => loadPipeline(write(`cap-${String(bad)}`, { ...base, maxOutputTokens: bad }))).toThrow(
        /maxOutputTokens/u,
      );
    }
    // Missing file and invalid JSON are boot failures too, with a path and no value.
    expect(() => loadPipeline(join(dir, 'absent.json'))).toThrow(/cannot read/u);
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json', 'utf8');
    expect(() => loadPipeline(broken)).toThrow(/invalid JSON/u);
  });

  it('prices the pinned model from the registry with exactly the pin’s numbers (BOOK-114)', () => {
    // A renamed model or a drifted price turns this red: the registry must price what the pin
    // names, at the pin's own numbers — two files are the only price places, and they agree.
    expect(rateFor(pipeline.model)).toEqual({
      input: pipeline.pricing.input,
      output: pipeline.pricing.output,
    });
  });

  it('names the literal in the two prose files and in no other shipped file — the lane included', () => {
    const prose = [
      join(BOOK_ROOT, 'process', 'ROLE_PROMPTS.md'),
      join(BOOK_ROOT, '.opencode', 'skills', 'writing-pass', 'SKILL.md'),
    ];
    for (const file of prose) {
      expect(readFileSync(file, 'utf8').includes(LITERAL), relative(BOOK_ROOT, file)).toBe(true);
    }
    // `model-lane` is scanned too: the lane reads the pin and must never restate it. Without this
    // root a second literal in the lane would leave the guard green (review, AC1).
    const roots = ['server', 'shared', 'web', 'bin', 'scripts', 'config', 'model-lane'].map((dir) =>
      join(SITE_ROOT, dir),
    );
    const carriers: string[] = [];
    for (const root of roots) {
      for (const file of walk(root)) {
        if (!TEXT_EXT.test(file)) continue;
        if (isTestFile(file)) continue;
        if (resolve(file) === resolve(PIPELINE_FILE)) continue;
        const relativePath = relative(SITE_ROOT, file);
        if (ALLOWED_CARRIERS.has(relativePath)) continue;
        if (readFileSync(file, 'utf8').includes(LITERAL)) carriers.push(relativePath);
      }
    }
    expect(carriers).toEqual([]);
  });

  it('drops the flash rate from both prose files, and keeps the lane out of the app sources', () => {
    const prose = [
      join(BOOK_ROOT, 'process', 'ROLE_PROMPTS.md'),
      join(BOOK_ROOT, '.opencode', 'skills', 'writing-pass', 'SKILL.md'),
    ];
    for (const file of prose) {
      const text = readFileSync(file, 'utf8');
      expect(text.includes('0.0000003'), relative(BOOK_ROOT, file)).toBe(false);
      expect(text.includes('$0.0000003'), relative(BOOK_ROOT, file)).toBe(false);
    }
    const appRoots = [
      join(SITE_ROOT, 'server', 'src'),
      join(SITE_ROOT, 'shared', 'src'),
      join(SITE_ROOT, 'web', 'src'),
      join(SITE_ROOT, 'bin'),
    ];
    const mentions: string[] = [];
    for (const root of appRoots) {
      for (const file of walk(root)) {
        if (!TEXT_EXT.test(file)) continue;
        if (readFileSync(file, 'utf8').includes('model-lane')) mentions.push(relative(SITE_ROOT, file));
      }
    }
    expect(mentions).toEqual([]);
  });

  it('keeps the file where the config looks for it and refuses an override that points nowhere', () => {
    expect(dirname(PIPELINE_FILE)).toBe(join(SITE_ROOT, 'config'));
    expect(() => loadConfig({ PIPELINE_PATH: join(tmpdir(), 'no-such-pipeline.json') })).toThrow(
      /pipeline: cannot read/u,
    );
  });
});
