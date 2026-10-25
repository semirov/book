/**
 * Sessions and identities (ARCHITECTURE.md §8, §9, §17; ADR-021).
 *
 * The cookie value is 32 random bytes; only its SHA-256 is stored (`sessions.cookie_hash`),
 * so a database leak does not become a set of usable sessions. There are no passwords, no
 * email and no profile: an identity is an opaque id, the Yandex subject (never rendered), a
 * display name and two flags.
 *
 * The cookie is `HttpOnly; SameSite=Lax`; `Secure` follows the public origin so local HTTP
 * development still works and production always sets it.
 */

import { randomBytes } from 'node:crypto';

import type { Db } from '../db/db.ts';
import type { IdentityRow } from '../db/repo/identities.ts';
import { readIdentity } from '../db/repo/identities.ts';
import { serializeCookie } from '../util/cookies.ts';
import { sha256Hex } from '../util/hash.ts';
import { newSessionId } from '../util/ulid.ts';

export const SESSION_COOKIE = 'book_session';
export const OAUTH_COOKIE = 'book_oauth';
/** The OAuth state is path-scoped so it is never sent with ordinary page requests. */
export const OAUTH_COOKIE_PATH = '/auth';

export type IssuedSession = { cookie: string; sessionId: string; expiresAt: string };

export type SessionStoreOptions = {
  db: Db;
  ttlMs: number;
  /** `true` whenever the public origin is HTTPS (always, in production). */
  secure: boolean;
  now?: () => Date;
  /** Required: a salt-less hash of an address is not the §14 promise. */
  ipHash: (ipKey: string) => string;
};

export type SessionLookup = { sessionId: string; identity: IdentityRow };

export class SessionStore {
  private readonly db: Db;
  private readonly ttlMs: number;
  private readonly secure: boolean;
  private readonly now: () => Date;
  private readonly ipHash: (ipKey: string) => string;

  constructor(options: SessionStoreOptions) {
    this.db = options.db;
    this.ttlMs = options.ttlMs;
    this.secure = options.secure;
    this.now = options.now ?? (() => new Date());
    this.ipHash = options.ipHash;
  }

  /** Mint a session for an identity. The raw cookie is returned once and never stored. */
  issue(identityId: string, context: { ipKey?: string; userAgent?: string } = {}): IssuedSession {
    const now = this.now();
    const cookie = randomBytes(32).toString('base64url');
    const sessionId = newSessionId(now.getTime());
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, identity_id, cookie_hash, created_at, expires_at, ip_hash, user_agent_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        identityId,
        sha256Hex(cookie),
        now.toISOString(),
        expiresAt,
        context.ipKey === undefined ? null : this.ipHash(context.ipKey),
        context.userAgent === undefined ? null : sha256Hex(context.userAgent),
      );
    return { cookie, sessionId, expiresAt };
  }

  /** `null` for a missing, unknown, revoked or expired cookie — never a partial identity. */
  read(cookie: string | undefined): SessionLookup | null {
    if (cookie === undefined || cookie.length === 0) return null;
    const row = this.db
      .prepare(`SELECT id, identity_id, expires_at, revoked_at FROM sessions WHERE cookie_hash = ?`)
      .get(sha256Hex(cookie)) as
      | { id: string; identity_id: string; expires_at: string; revoked_at: string | null }
      | undefined;
    if (row === undefined) return null;
    if (row.revoked_at !== null) return null;
    if (Date.parse(row.expires_at) <= this.now().getTime()) return null;
    const identity = readIdentity(this.db, row.identity_id);
    if (identity === undefined) return null;
    return { sessionId: row.id, identity };
  }

  revoke(cookie: string | undefined): void {
    if (cookie === undefined || cookie.length === 0) return;
    this.db
      .prepare(`UPDATE sessions SET revoked_at = ? WHERE cookie_hash = ? AND revoked_at IS NULL`)
      .run(this.now().toISOString(), sha256Hex(cookie));
  }

  cookieHeader(cookie: string): string {
    return serializeCookie(SESSION_COOKIE, cookie, {
      path: '/',
      maxAgeSeconds: Math.floor(this.ttlMs / 1000),
      httpOnly: true,
      secure: this.secure,
      sameSite: 'Lax',
    });
  }

  clearCookieHeader(): string {
    return serializeCookie(SESSION_COOKIE, '', {
      path: '/',
      maxAgeSeconds: 0,
      httpOnly: true,
      secure: this.secure,
      sameSite: 'Lax',
    });
  }
}

/** The OAuth state cookie: ten minutes, `/auth` only, never sent with the page. */
export function oauthStateCookie(state: string, secure: boolean, ttlMs: number): string {
  return serializeCookie(OAUTH_COOKIE, state, {
    path: OAUTH_COOKIE_PATH,
    maxAgeSeconds: Math.floor(ttlMs / 1000),
    httpOnly: true,
    secure,
    sameSite: 'Lax',
  });
}

export function clearOauthStateCookie(secure: boolean): string {
  return serializeCookie(OAUTH_COOKIE, '', {
    path: OAUTH_COOKIE_PATH,
    maxAgeSeconds: 0,
    httpOnly: true,
    secure,
    sameSite: 'Lax',
  });
}
