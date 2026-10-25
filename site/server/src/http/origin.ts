/**
 * Origin and content-type checks for mutating routes (ARCHITECTURE.md §9, §17).
 *
 * There is no CSRF token, by design: `SameSite=Lax` keeps the session cookie off a
 * cross-site form post, and every mutating route additionally requires a same-origin
 * `Origin` and `Content-Type: application/json`. A loopback origin is accepted **outside
 * production only**, so the Vite dev server on `127.0.0.1:5173` can talk to the API while a
 * deployed site refuses a page served from the reader's own machine.
 */

import type { FastifyRequest } from 'fastify';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** `NODE_ENV` is the switch: a dev convenience must never widen a deployed origin list. */
function loopbackAllowed(nodeEnv: string | undefined): boolean {
  return nodeEnv !== 'production';
}

export function isAllowedOrigin(
  origin: string | undefined,
  publicOrigin: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  const expected = publicOrigin.replace(/\/+$/u, '');
  if (origin === expected) return true;
  if (!loopbackAllowed(nodeEnv)) return false;
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function hasJsonContentType(request: FastifyRequest): boolean {
  const value = request.headers['content-type'];
  if (typeof value !== 'string') return false;
  return value.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

export type MutationGuard = 'ok' | 'ORIGIN' | 'CONTENT_TYPE';

export function checkMutation(
  request: FastifyRequest,
  publicOrigin: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): MutationGuard {
  if (!isAllowedOrigin(request.headers.origin, publicOrigin, nodeEnv)) return 'ORIGIN';
  if (!hasJsonContentType(request)) return 'CONTENT_TYPE';
  return 'ok';
}
