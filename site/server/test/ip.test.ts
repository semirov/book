import { describe, expect, it } from 'vitest';

import { clientIp, connectionKey, ipInRange, ipKey, normalizeIp } from '../src/util/ip.ts';

describe('normalizeIp', () => {
  it('strips the IPv4-mapped prefix, brackets and a port', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('[2001:db8::1]')).toBe('2001:db8::1');
    expect(normalizeIp('203.0.113.7:41234')).toBe('203.0.113.7');
    expect(normalizeIp(' 127.0.0.1 ')).toBe('127.0.0.1');
  });
});

describe('ipInRange', () => {
  it('matches IPv4 ranges and single addresses', () => {
    expect(ipInRange('192.168.1.44', '192.168.1.0/24')).toBe(true);
    expect(ipInRange('192.168.2.44', '192.168.1.0/24')).toBe(false);
    expect(ipInRange('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(ipInRange('127.0.0.2', '127.0.0.1')).toBe(false);
    expect(ipInRange('10.1.2.3', '0.0.0.0/0')).toBe(true);
  });

  it('matches IPv6 ranges and refuses malformed entries', () => {
    expect(ipInRange('::1', '::1')).toBe(true);
    expect(ipInRange('2001:db8::5', '2001:db8::/32')).toBe(true);
    expect(ipInRange('2001:db9::5', '2001:db8::/32')).toBe(false);
    expect(ipInRange('127.0.0.1', 'not-an-ip')).toBe(false);
    expect(ipInRange('::1', '::1/999')).toBe(false);
  });
});

describe('clientIp', () => {
  it('ignores X-Forwarded-For from an untrusted peer', () => {
    expect(clientIp({ 'x-forwarded-for': '203.0.113.9' }, '198.51.100.4', ['127.0.0.1'])).toBe('198.51.100.4');
  });

  it('takes the rightmost address not in the trusted set', () => {
    expect(
      clientIp({ 'x-forwarded-for': '203.0.113.9, 192.168.1.2' }, '127.0.0.1', ['127.0.0.1', '192.168.1.0/24']),
    ).toBe('203.0.113.9');
  });

  it('falls back to X-Real-IP and then to the peer', () => {
    expect(clientIp({ 'x-real-ip': '203.0.113.11' }, '127.0.0.1', ['127.0.0.1'])).toBe('203.0.113.11');
    expect(clientIp({}, '127.0.0.1', ['127.0.0.1'])).toBe('127.0.0.1');
  });

  it('treats an array header as one chain', () => {
    expect(clientIp({ 'x-forwarded-for': ['203.0.113.9, 127.0.0.1'] }, '127.0.0.1', ['127.0.0.1'])).toBe(
      '203.0.113.9',
    );
  });
});

describe('ipKey', () => {
  it('groups IPv6 by /64 so one household cannot rotate its address away', () => {
    expect(ipKey('2001:db8:1:2:aaaa::1')).toBe('2001:0db8:0001:0002::/64');
    expect(ipKey('2001:db8:1:2:bbbb::9')).toBe(ipKey('2001:db8:1:2:aaaa::1'));
    expect(ipKey('2001:db8:1:3::1')).not.toBe(ipKey('2001:db8:1:2::1'));
  });

  it('leaves IPv4 alone', () => {
    expect(ipKey('192.168.1.44')).toBe('192.168.1.44');
    expect(connectionKey('::ffff:192.168.1.44')).toBe('192.168.1.44');
  });
});
