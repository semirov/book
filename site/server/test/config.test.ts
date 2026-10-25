import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { createFixture } from './helpers.ts';

describe('loadConfig', () => {
  it('fills the defaults', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8080);
    expect(config.host).toBe('127.0.0.1');
    expect(config.tz).toBe('Europe/Moscow');
    expect(config.maxWs).toBe(100);
    expect(config.leaseTtlMs).toBe(90_000);
    expect(config.bookRoot.endsWith('book')).toBe(true);
  });

  it('reads the environment', () => {
    const config = loadConfig({
      BOOK_ROOT: '/book',
      DATA_DIR: '/data',
      PORT: '9090',
      HOST: '0.0.0.0',
      LOG_LEVEL: 'warn',
      BUDGET_MAX_STEPS: '20',
    });
    expect(config).toMatchObject({
      bookRoot: '/book',
      dataDir: '/data',
      port: 9090,
      host: '0.0.0.0',
      logLevel: 'warn',
      budgetMaxSteps: 20,
    });
  });

  it('fails fast with a readable message', () => {
    expect(() => loadConfig({ PORT: 'не-порт' })).toThrow(/invalid configuration: port/u);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/logLevel/u);
  });
});

describe('migrate', () => {
  it('is idempotent and reports the version it found', () => {
    const fixture = createFixture();
    try {
      const second = migrate(fixture.db);
      expect(second.from).toBe(1);
      expect(second.to).toBe(1);
      const lane = fixture.db.prepare('SELECT COUNT(*) AS n FROM lane').get() as { n: number };
      expect(lane.n).toBe(1);
    } finally {
      fixture.close();
    }
  });
});
