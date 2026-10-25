import { describe, expect, it } from 'vitest';

import { RateLimiter } from '../src/rate/limiter.ts';
import { commentIpKey, commentSpecs, editIdentityKey } from '../src/rate/policy.ts';
import { loadConfig } from '../src/config.ts';
import { createFixture, type Fixture } from './helpers.ts';
import { createIpHasher } from '../src/util/ipHash.ts';

/** §14: exact sliding windows, one synchronous check-and-insert, IP and identity both pass. */

function limiterWithClock(): { limiter: RateLimiter; clock: { ms: number }; fixture: Fixture } {
  const clock = { ms: 1_000_000 };
  const fixture = createFixture();
  const limiter = new RateLimiter(fixture.db, () => clock.ms);
  return { limiter, clock, fixture };
}

/** §14: the persisted key is a hash of the network, never the network itself. */
const ipHash = createIpHasher('test-salt');

describe('RateLimiter', () => {
  it('allows exactly the limit, then blocks with a reset moment', () => {
    const { limiter, clock } = limiterWithClock();
    const spec = { key: 'test:one', limit: 2, windowMs: 60_000 };
    expect(limiter.consume([spec]).allowed).toBe(true);
    clock.ms += 1_000;
    expect(limiter.consume([spec]).allowed).toBe(true);
    const blocked = limiter.consume([spec]);
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) return;
    expect(blocked.blocked.used).toBe(2);
    expect(blocked.blocked.remaining).toBe(0);
    expect(blocked.blocked.retryAfterMs).toBe(59_000);
    expect(blocked.blocked.resetAtMs).toBe(1_060_000);
  });

  it('slides: an event that leaves the window frees a slot', () => {
    const { limiter, clock } = limiterWithClock();
    const spec = { key: 'test:slide', limit: 1, windowMs: 10_000 };
    expect(limiter.consume([spec]).allowed).toBe(true);
    clock.ms += 9_999;
    expect(limiter.consume([spec]).allowed).toBe(false);
    clock.ms += 2;
    expect(limiter.consume([spec]).allowed).toBe(true);
  });

  it('is all-or-nothing across an IP and an identity key', () => {
    const { limiter, clock } = limiterWithClock();
    const config = loadConfig({ COMMENTS_PER_HOUR_IP: '2', COMMENTS_PER_HOUR_IDENTITY: '5' });
    const ip = commentIpKey(ipHash, '203.0.113.0/24');
    const specs = commentSpecs(config, ipHash, '203.0.113.0/24', 'idt_1');

    expect(limiter.consume(specs).allowed).toBe(true);
    clock.ms += 1_000;
    expect(limiter.consume(specs).allowed).toBe(true);
    clock.ms += 1_000;
    const blocked = limiter.consume(specs);
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) return;
    expect(blocked.blocked.key).toBe(ip);
    // The identity key did not take a third event: neither key may be half-counted.
    expect(limiter.check(specs[1]!).used).toBe(2);
    expect(limiter.check(specs[3]!).used).toBe(2);
  });

  it('stores a hashed network key, never the address it came from', () => {
    const { limiter, fixture } = limiterWithClock();
    const config = loadConfig({});
    limiter.consume(commentSpecs(config, ipHash, '203.0.113.0/24', 'idt_1'));

    const keys = (fixture.db.prepare('SELECT key FROM rate_events').all() as Array<{ key: string }>).map(
      (row) => row.key,
    );
    expect(keys).toContain(commentIpKey(ipHash, '203.0.113.0/24'));
    for (const key of keys) {
      expect(key).not.toContain('203.0.113');
    }
  });

  it('keeps keys namespaced: a comment budget is not an edit budget', () => {
    const { limiter } = limiterWithClock();
    limiter.record('cmt:id:idt_1', 1_000_000);
    expect(limiter.check({ key: 'edit:id:idt_1', limit: 1, windowMs: 60_000 }).used).toBe(0);
    expect(limiter.check({ key: 'cmt:id:idt_1', limit: 1, windowMs: 60_000 }).used).toBe(1);
  });

  it('prunes old rows without touching live ones', () => {
    const { limiter, clock } = limiterWithClock();
    const key = 'test:prune';
    limiter.record(key, clock.ms - 120_000);
    limiter.record(key, clock.ms);
    limiter.pruneKey(key, 60_000);
    expect(limiter.check({ key, limit: 5, windowMs: 60_000 }).used).toBe(1);
    clock.ms += 60_000;
    limiter.pruneKey(key, 60_000);
    expect(limiter.check({ key, limit: 5, windowMs: 60_000 }).used).toBe(0);
  });

  it('prunes counters after an hour but keeps the daily edit budget for a day', () => {
    const fixture = createFixture();
    try {
      const clock = { ms: 1_000_000 + 3 * 60 * 60_000 };
      const limiter = new RateLimiter(fixture.db, () => clock.ms);
      const hourly = commentIpKey(ipHash, '203.0.113.0/24');
      const daily = editIdentityKey('idt_1');
      limiter.record(hourly, clock.ms - 2 * 60 * 60_000);
      limiter.record(daily, clock.ms - 2 * 60 * 60_000);

      // Any consume of a new key runs the due prune (it is due once an hour).
      limiter.consume([{ key: 'test:trigger', limit: 5, windowMs: 60_000 }]);

      expect(limiter.check({ key: hourly, limit: 5, windowMs: 60 * 60_000 }).used).toBe(0);
      // The reader edit is still counted: pruning it early would hand the slot back.
      expect(limiter.check({ key: daily, limit: 1, windowMs: 24 * 60 * 60_000 }).used).toBe(1);

      clock.ms += 25 * 60 * 60_000;
      limiter.consume([{ key: 'test:trigger', limit: 5, windowMs: 60_000 }]);
      expect(limiter.check({ key: daily, limit: 1, windowMs: 24 * 60 * 60_000 }).used).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('treats an empty spec list as allowed (no write path is unlimited by accident)', () => {
    const { limiter } = limiterWithClock();
    expect(limiter.consume([])).toEqual({ allowed: true, verdicts: [] });
  });
});
