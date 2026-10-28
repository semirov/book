/**
 * The writer's environment (BOOK-117 §5–6). What is asserted here is the contract, not the
 * parsing: a restatement of the pin passes, a different model is refused with both values, the
 * key comes from its file, the plain variable is a development convenience only, and the key
 * value never reaches a message or a printable shape.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_ENGINE_TOKEN_FILE, WriterConfigError, loadWriterConfig } from '../../src/writer/config.ts';

const SITE = resolve(import.meta.dirname, '..', '..', '..');
const PIPELINE = join(SITE, 'config', 'pipeline.json');

const dirs: string[] = [];
const FAKE_KEY = 'sk-writer-test-key-never-print-me-7f3a9c';

function keyFile(contents = FAKE_KEY): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-writer-config-'));
  dirs.push(dir);
  const path = join(dir, 'deepseek.key');
  writeFileSync(path, `${contents}\n`, { mode: 0o600 });
  return path;
}

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PIPELINE_PATH: PIPELINE,
    DEEPSEEK_API_KEY_FILE: keyFile(),
    ...overrides,
  };
}

function refusalOf(input: NodeJS.ProcessEnv): WriterConfigError {
  try {
    loadWriterConfig(input);
  } catch (error) {
    if (error instanceof WriterConfigError) return error;
    throw error;
  }
  throw new Error('loadWriterConfig accepted an invalid environment');
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('loadWriterConfig — the model is the pipeline pin', () => {
  it('takes the model and endpoint from the pipeline and derives the wire id', () => {
    const config = loadWriterConfig(env());
    expect(config.provider).toBe('deepseek');
    expect(config.model).toBe('deepseek/deepseek-v4-pro');
    expect(config.apiModel).toBe('deepseek-v4-pro');
    expect(config.endpoint).toBe('https://api.deepseek.com/chat/completions');
  });

  it('accepts a restatement that is equal to the pin', () => {
    const config = loadWriterConfig(env({ WRITER_MODEL: 'deepseek/deepseek-v4-pro' }));
    expect(config.model).toBe('deepseek/deepseek-v4-pro');
  });

  it('refuses a different model with both values and never honours it', () => {
    const failure = refusalOf(env({ WRITER_MODEL: 'deepseek/deepseek-flash' }));
    expect(failure.code).toBe('MODEL_NOT_PIPELINE');
    expect(failure.detail).toEqual({ declared: 'deepseek/deepseek-flash', expected: 'deepseek/deepseek-v4-pro' });
  });

  it('refuses an endpoint that is not the pinned one', () => {
    const failure = refusalOf(env({ WRITER_ENDPOINT: 'https://example.com/chat/completions' }));
    expect(failure.code).toBe('ENDPOINT_NOT_PIPELINE');
    expect(failure.detail).toEqual({
      declared: 'https://example.com/chat/completions',
      expected: 'https://api.deepseek.com/chat/completions',
    });
  });
});

describe('loadWriterConfig — the key', () => {
  it('reads the value from the file and trims it', () => {
    const config = loadWriterConfig(env());
    expect(config.apiKey).toBe(FAKE_KEY);
    expect(config.keySource).toBe('file');
  });

  it('refuses a missing key file as KEY_MISSING', () => {
    const failure = refusalOf(env({ DEEPSEEK_API_KEY_FILE: join(SITE, 'config', 'no-such.key') }));
    expect(failure.code).toBe('KEY_MISSING');
    expect(failure.message).toContain('DEEPSEEK_API_KEY_FILE');
  });

  it('refuses an empty key file as KEY_MISSING', () => {
    const failure = refusalOf(env({ DEEPSEEK_API_KEY_FILE: keyFile('  ') }));
    expect(failure.code).toBe('KEY_MISSING');
  });

  it('accepts the plain variable outside production', () => {
    const config = loadWriterConfig({ NODE_ENV: 'test', PIPELINE_PATH: PIPELINE, DEEPSEEK_API_KEY: FAKE_KEY });
    expect(config.apiKey).toBe(FAKE_KEY);
    expect(config.keySource).toBe('env');
  });

  it('refuses the plain variable under NODE_ENV=production', () => {
    const failure = refusalOf({ NODE_ENV: 'production', PIPELINE_PATH: PIPELINE, DEEPSEEK_API_KEY: FAKE_KEY });
    expect(failure.code).toBe('KEY_MISSING');
    expect(failure.message).toContain('DEEPSEEK_API_KEY_FILE');
  });

  it('refuses an environment with no key at all', () => {
    expect(refusalOf({ NODE_ENV: 'test', PIPELINE_PATH: PIPELINE }).code).toBe('KEY_MISSING');
  });

  it('never puts the key value in a message, a detail or a printable shape', () => {
    const failures: WriterConfigError[] = [];
    for (const overrides of [
      { WRITER_MODEL: 'deepseek/deepseek-flash' },
      { WRITER_ENDPOINT: 'https://example.com/chat/completions' },
      { WRITER_TIMEOUT_MS: 'not-a-number' },
      { WRITER_ENGINE_URL: 'ftp://example.com' },
    ]) {
      failures.push(refusalOf(env(overrides)));
    }
    for (const failure of failures) {
      expect(failure.message).not.toContain(FAKE_KEY);
      expect(JSON.stringify(failure.detail)).not.toContain(FAKE_KEY);
    }

    const config = loadWriterConfig(env());
    expect(JSON.stringify(config)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(config.redacted())).not.toContain(FAKE_KEY);
    expect('apiKey' in config.redacted()).toBe(false);
  });
});

describe('loadWriterConfig — bounds and defaults', () => {
  it('ships the documented defaults', () => {
    const config = loadWriterConfig(env());
    expect(config.timeoutMs).toBe(420_000);
    expect(config.maxTokensPerCall).toBe(64_000);
    // A gate verdict is a thinking call, not a short one: on the first real pass (chapter 65) the
    // editor spent 24 254 in / 10 161 out on a 1 027-character answer, and its reasoning alone
    // outgrew the old cap on the revised chapter (22 691 characters, PROVIDER_SHAPE). Both caps
    // are runaway guards; the bound is money ($10 a day), and the pass guard sums what one pass
    // may legitimately spend (53 739 in / 60 102 out measured, with a revision and both gates).
    expect(config.gateTokens).toBe(64_000);
    expect(config.maxTokensPerPass).toBe(200_000);
    expect(config.continueMax).toBe(2);
    expect(config.dailyTokens).toBe(1_500_000);
    expect(config.maxPassesPerDay).toBe(4);
    expect(config.pauseMs).toBe(900_000);
    expect(config.engineUrl).toBe('http://127.0.0.1:8081');
    // The engine is local but single-threaded: 60 s, not the old hard-coded 10 — on the measured
    // pass (chapter 65) `land` outran 10 s after the chapter had landed and been published.
    expect(config.engineTimeoutMs).toBe(60_000);
    expect(config.engineTokenFile).toBe(DEFAULT_ENGINE_TOKEN_FILE);
    expect(config.session).toBe('writer');
    expect(config.pipelinePath).toBe(PIPELINE);
  });

  it('reads an override and refuses a non-integer without echoing it', () => {
    const config = loadWriterConfig(env({ WRITER_CONTINUE_MAX: '0', WRITER_PAUSE_MS: '1000' }));
    expect(config.continueMax).toBe(0);
    expect(config.pauseMs).toBe(1_000);

    const failure = refusalOf(env({ WRITER_MAX_TOKENS_PER_CALL: 'sixteen thousand' }));
    expect(failure.code).toBe('CONFIG_INVALID');
    expect(failure.message).toContain('WRITER_MAX_TOKENS_PER_CALL');
    expect(failure.message).not.toContain('sixteen');
  });

  it('lets the environment still set the per-pass guard', () => {
    expect(loadWriterConfig(env({ WRITER_MAX_TOKENS_PER_PASS: '60000' })).maxTokensPerPass).toBe(60_000);
    expect(refusalOf(env({ WRITER_MAX_TOKENS_PER_PASS: '0' })).message).toContain('WRITER_MAX_TOKENS_PER_PASS');
  });

  it('lets the environment set each of the three token guards, and refuses a zero', () => {
    const config = loadWriterConfig(env({ WRITER_MAX_TOKENS_PER_CALL: '32000', WRITER_GATE_TOKENS: '48000' }));
    expect(config.maxTokensPerCall).toBe(32_000);
    expect(config.gateTokens).toBe(48_000);
    // The pass guard is its own variable: one override does not move the other two.
    expect(config.maxTokensPerPass).toBe(200_000);
    expect(refusalOf(env({ WRITER_GATE_TOKENS: '0' })).message).toContain('WRITER_GATE_TOKENS');
  });

  it('lets the environment set the engine’s own timeout, and refuses one below a second', () => {
    expect(loadWriterConfig(env({ WRITER_ENGINE_TIMEOUT_MS: '90000' })).engineTimeoutMs).toBe(90_000);
    // It is a request cap, not a lease: a value under a second cannot be anything but a mistake.
    expect(refusalOf(env({ WRITER_ENGINE_TIMEOUT_MS: '999' })).message).toContain('WRITER_ENGINE_TIMEOUT_MS');
    // The printable shape carries it, so an operator can read which cap the process ran under.
    expect(loadWriterConfig(env()).redacted().engineTimeoutMs).toBe(60_000);
  });

  it('refuses an integer below its floor and a number that is not safe', () => {
    expect(refusalOf(env({ WRITER_MAX_PASSES_PER_DAY: '0' })).message).toContain('WRITER_MAX_PASSES_PER_DAY');
    expect(refusalOf(env({ WRITER_TIMEOUT_MS: '9'.repeat(40) })).code).toBe('CONFIG_INVALID');
  });
});
