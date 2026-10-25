/**
 * The OAuth `state` (ARCHITECTURE.md §9, §17): a signed, short-lived value that ties the
 * callback to the browser that started the flow. It is stored in its own `HttpOnly` cookie
 * and compared to the query parameter in constant time; the nonce makes a replay of an old
 * callback useless even if the URL leaks.
 */

import { createHmac } from 'node:crypto';

import { secretsEqual } from '../util/ipHash.ts';

export type OAuthState = { nonce: string; issuedAt: number };

function mac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

export function signState(secret: string, state: OAuthState): string {
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  return `${payload}.${mac(secret, payload)}`;
}

/** `null` for any malformed, forged or expired value — never a partial state. */
export function verifyState(
  secret: string,
  token: string,
  nowMs: number,
  ttlMs: number,
): OAuthState | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!secretsEqual(signature, mac(secret, payload))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const state = parsed as Partial<OAuthState>;
  if (typeof state.nonce !== 'string' || state.nonce.length < 8) return null;
  if (typeof state.issuedAt !== 'number' || !Number.isFinite(state.issuedAt)) return null;
  const age = nowMs - state.issuedAt;
  if (age < -5_000 || age > ttlMs) return null;
  return { nonce: state.nonce, issuedAt: state.issuedAt };
}
