/**
 * Yandex OAuth and logout (ARCHITECTURE.md §9, §17; ADR-021).
 *
 * `start` mints a signed, short-lived `state` into its own `HttpOnly` cookie and redirects
 * to the IdP. `callback` validates that state in constant time, exchanges the code
 * server-side, reads only the subject and a display name, mints our own opaque session
 * cookie and redirects to the book. No token is ever rendered or placed in a URL the
 * browser can read; failures are sanitized (`OAUTH_FAILED`), with the detail only in the log.
 */

import { randomBytes } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { yandexConfigured } from '../../config.ts';
import { upsertIdentity } from '../../db/repo/identities.ts';
import { signState, verifyState } from '../../identity/oauthState.ts';
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  clearOauthStateCookie,
  oauthStateCookie,
} from '../../identity/session.ts';
import { OAuthError, authorizeUrl, exchangeCode, fetchProfile } from '../../identity/yandex.ts';
import { oauthSpec } from '../../rate/policy.ts';
import { parseCookies } from '../../util/cookies.ts';
import { clientIp, ipKey } from '../../util/ip.ts';
import { secretsEqual } from '../../util/ipHash.ts';
import { checkMutation } from '../origin.ts';
import type { RouteDeps } from '../deps.ts';

export function registerAuthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const secure = deps.config.publicOrigin.startsWith('https');
  const fetchImpl = deps.oauthFetch ?? fetch;

  app.get('/auth/yandex/start', async (request, reply) => {
    if (!yandexConfigured(deps.config)) {
      return reply.code(503).send({
        code: 'OAUTH_UNCONFIGURED',
        message: 'вход через Яндекс ещё не настроен',
      });
    }

    const ip = ipOf(request, deps);
    const limited = deps.limiter.consume([oauthSpec(deps.config, deps.ipHash, ipKey(ip))]);
    if (!limited.allowed) {
      reply.header('retry-after', String(Math.max(1, Math.ceil(limited.blocked.retryAfterMs / 1000))));
      return reply.code(429).header('cache-control', 'no-store').send({
        code: 'RATE_LIMITED',
        message: 'слишком много попыток входа — попробуйте позже',
        retryAfterMs: limited.blocked.retryAfterMs,
        resetAt: limited.blocked.resetAtMs === null ? null : new Date(limited.blocked.resetAtMs).toISOString(),
      });
    }

    const state = signState(deps.sessionSecret, {
      nonce: randomBytes(16).toString('base64url'),
      issuedAt: deps.now().getTime(),
    });
    reply.header('set-cookie', oauthStateCookie(state, secure, deps.config.oauthStateTtlMs));
    return reply
      .code(302)
      .header('cache-control', 'no-store')
      .header('location', authorizeUrl(deps.config, state))
      .send();
  });

  app.get('/auth/yandex/callback', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const code = typeof query.code === 'string' ? query.code : '';
    const returned = typeof query.state === 'string' ? query.state : '';
    const cookies = parseCookies(request.headers.cookie);
    const cookieState = cookies[OAUTH_COOKIE];

    // The callback must come from the browser that started the flow: same cookie, valid
    // signature, inside the TTL. Any mismatch is the same refusal, compared in constant time.
    if (cookieState === undefined || returned.length === 0 || !secretsEqual(returned, cookieState)) {
      return oauthFailure(reply, secure, 'OAUTH_STATE', 'вход не завершён — начните заново');
    }
    if (verifyState(deps.sessionSecret, cookieState, deps.now().getTime(), deps.config.oauthStateTtlMs) === null) {
      return oauthFailure(reply, secure, 'OAUTH_STATE', 'вход не завершён — начните заново');
    }
    if (typeof query.error === 'string' || code.length === 0) {
      return oauthFailure(reply, secure, 'OAUTH_FAILED', 'вход отменён или не удался');
    }

    try {
      const token = await exchangeCode(deps.config, code, fetchImpl);
      const profile = await fetchProfile(deps.config, token.accessToken, fetchImpl);
      const at = deps.now().toISOString();
      const identity = upsertIdentity(deps.db, {
        yandexSub: profile.sub,
        displayName: profile.displayName,
        at,
      });
      if (identity.blocked !== 0) {
        return oauthFailure(reply, secure, 'OAUTH_FAILED', 'вход недоступен для этого автора');
      }
      const session = deps.sessions.issue(identity.id, {
        ipKey: ipKey(ipOf(request, deps)),
        ...(typeof request.headers['user-agent'] === 'string' ? { userAgent: request.headers['user-agent'] } : {}),
      });
      reply.header('set-cookie', [deps.sessions.cookieHeader(session.cookie), clearOauthStateCookie(secure)]);
      return reply.code(302).header('location', '/').send();
    } catch (error) {
      // The reader gets a code and one sentence; the cause stays in the log.
      const detail = error instanceof OAuthError ? error.message : 'unexpected oauth failure';
      request.log.warn({ detail }, 'yandex oauth failed');
      return oauthFailure(reply, secure, 'OAUTH_FAILED', 'вход не удался — попробуйте ещё раз');
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const guard = checkMutation(request, deps.config.publicOrigin);
    if (guard !== 'ok') {
      return reply.code(403).send({
        code: guard,
        message: guard === 'ORIGIN' ? 'запрос с чужого источника отклонён' : 'нужен application/json',
      });
    }
    const cookies = parseCookies(request.headers.cookie);
    deps.sessions.revoke(cookies[SESSION_COOKIE]);
    reply.header('set-cookie', deps.sessions.clearCookieHeader());
    return reply.code(204).send();
  });
}

function oauthFailure(
  reply: FastifyReply,
  secure: boolean,
  code: string,
  message: string,
): FastifyReply {
  reply.header('set-cookie', clearOauthStateCookie(secure));
  return reply
    .code(code === 'OAUTH_STATE' ? 400 : 502)
    .header('cache-control', 'no-store')
    .send({ code, message });
}

function ipOf(request: FastifyRequest, deps: RouteDeps): string {
  const trusted = deps.config.trustedProxies.split(',').map((part) => part.trim());
  return clientIp(
    request.headers as Record<string, string | string[] | undefined>,
    request.socket.remoteAddress ?? request.ip,
    trusted,
  );
}
