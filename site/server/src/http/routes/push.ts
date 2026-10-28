/**
 * Web Push (BOOK-189): the public key, one device in, one device out.
 *
 * Three routes, and the shape of each is a leak decision:
 *
 *   · **the key is public** — a browser needs it to subscribe before it has anything to protect,
 *     and it identifies the site, not the reader. No session is required to read it;
 *   · **subscribing takes the browser's own `PushSubscription`** and answers a **count**. The
 *     server stores a capability (the endpoint is a secret: whoever holds it can post to that
 *     device) and there is deliberately no route that reads one back, so a stolen session can
 *     add and remove devices but can never enumerate another device's handle;
 *   · **unsubscribing works with push switched off.** Cleanup must not need the key: a deployment
 *     that removed the VAPID file still has to be able to forget the rows it once stored, or a
 *     reader's dead endpoint would outlive the feature.
 *
 * An endpoint is validated instead of trusted: it is an `https:` URL on a host with a dot, no
 * credentials, no port but 443, and never an IP literal or a `.local`/`localhost` name. The push
 * service is a third party; a body that names the reader's own machine would make the site's
 * drain knock on a LAN door, and a `192.168.x` endpoint is not a subscription, it is a probe.
 */

import { isIP } from 'node:net';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { PushDevicesDto, PushKeyDto, PushSubscribeInput } from '@book/shared';

import { countSubscriptions, deleteSubscription, upsertSubscription } from '../../push/repo.ts';
import { pushSpecs } from '../../rate/policy.ts';
import { clientIp, ipKey } from '../../util/ip.ts';
import { checkMutation } from '../origin.ts';
import type { RouteDeps } from '../deps.ts';
import { sessionOf, unauthenticated } from '../session.ts';

/** A push endpoint is a URL, not a document: 1024 characters is already generous. */
const ENDPOINT_MAX = 1024;
/** Both keys are base64url of binary material: 16 bytes of `auth`, 65 of `p256dh`, at least. */
const KEY = /^[A-Za-z0-9_-]{16,200}$/u;

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(422).header('cache-control', 'no-store').send({ code: 'INVALID', message });
}

function pushOff(reply: FastifyReply): FastifyReply {
  return reply
    .code(503)
    .header('cache-control', 'no-store')
    .send({ code: 'PUSH_OFF', message: 'уведомления выключены' });
}

/** The reader's network, hashed — the same key every other budget uses (§14 stores no address). */
function ipOf(request: FastifyRequest, deps: RouteDeps): string {
  const trusted = deps.config.trustedProxies.split(',').map((part) => part.trim());
  return clientIp(
    request.headers as Record<string, string | string[] | undefined>,
    request.socket.remoteAddress ?? request.ip,
    trusted,
  );
}

/**
 * BOOK-189 — a device list is a write surface, so it spends a budget like a comment does: 20 an
 * hour per reader and per network (`rate/policy.ts`). One `429` shape, the same the comment and
 * author routes send, with the wait the page can print.
 */
function limitOrRefuse(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: RouteDeps,
  identityId: string,
): FastifyReply | null {
  const limited = deps.limiter.consume(pushSpecs(deps.ipHash, ipKey(ipOf(request, deps)), identityId));
  if (limited.allowed) return null;
  const blocked = limited.blocked;
  const resetAt = blocked.resetAtMs === null ? undefined : new Date(blocked.resetAtMs).toISOString();
  reply.header('retry-after', String(Math.max(1, Math.ceil(blocked.retryAfterMs / 1000))));
  // The shape the comment route refuses with, so one component can print either wait.
  return reply.code(429).header('cache-control', 'no-store').send({
    code: 'RATE_LIMITED',
    message: 'слишком много изменений подписки — попробуйте позже',
    retryAfterMs: blocked.retryAfterMs,
    ...(resetAt === undefined ? {} : { resetAt }),
  });
}

/**
 * The endpoint rule, in one place. `new URL` already refuses a relative or malformed value; the
 * rest is what a push service can honestly be: https, a named host with a dot, the default port
 * and no credentials. An IP literal is refused on the host itself (brackets stripped for IPv6)
 * so `https://[::1]/…` and `https://127.0.0.1/…` fail the same way.
 */
export function isPushEndpoint(value: string): boolean {
  if (value.length === 0 || value.length > ENDPOINT_MAX) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username.length > 0 || url.password.length > 0) return false;
  // `new URL` drops the default port, so an empty port means 443 and nothing else is allowed.
  if (url.port.length > 0) return false;
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (host.length === 0 || !host.includes('.')) return false;
  if (isIP(host) !== 0) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  return true;
}

/** The subscribe body: the browser's own shape, and every field of it checked. */
export function parseSubscribe(body: unknown): { ok: true; value: PushSubscribeInput } | { ok: false; message: string } {
  if (body === null || typeof body !== 'object') return { ok: false, message: 'тело запроса пустое' };
  const value = body as { endpoint?: unknown; keys?: unknown };
  if (typeof value.endpoint !== 'string' || !isPushEndpoint(value.endpoint)) {
    return { ok: false, message: 'endpoint должен быть https-адресом push-сервиса' };
  }
  const keys = value.keys as { p256dh?: unknown; auth?: unknown } | null | undefined;
  if (keys === null || typeof keys !== 'object') return { ok: false, message: 'keys обязательны' };
  if (typeof keys.p256dh !== 'string' || !KEY.test(keys.p256dh)) {
    return { ok: false, message: 'p256dh не похож на ключ подписки' };
  }
  if (typeof keys.auth !== 'string' || !KEY.test(keys.auth)) {
    return { ok: false, message: 'auth не похож на ключ подписки' };
  }
  return { ok: true, value: { endpoint: value.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } } };
}

export function registerPushRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/push/key', async (_request, reply) => {
    if (deps.pushKey === null) return pushOff(reply);
    const dto: PushKeyDto = { key: deps.pushKey };
    return reply.header('cache-control', 'no-store').send(dto);
  });

  app.post('/api/push/subscribe', async (request, reply) => {
    const guard = checkMutation(request, deps.config.publicOrigin);
    if (guard !== 'ok') {
      return reply.code(403).header('cache-control', 'no-store').send({
        code: guard,
        message: guard === 'ORIGIN' ? 'запрос с чужого источника отклонён' : 'нужен application/json',
      });
    }
    const session = sessionOf(deps, request);
    if (session === null) return unauthenticated(reply);
    // Never promise what cannot work: with no key the row would be a device the site cannot
    // ever reach, and the page would show «уведомления включены» over a dead queue. The check
    // comes before the budget, so a deployment with push off never charges a reader for a call
    // that could not have stored anything.
    if (deps.pushKey === null) return pushOff(reply);
    const limited = limitOrRefuse(request, reply, deps, session.identity.id);
    if (limited !== null) return limited;

    const parsed = parseSubscribe(request.body);
    if (!parsed.ok) return invalid(reply, parsed.message);

    upsertSubscription(deps.db, session.identity.id, {
      endpoint: parsed.value.endpoint,
      p256dh: parsed.value.keys.p256dh,
      auth: parsed.value.keys.auth,
    }, deps.now().getTime());
    const dto: PushDevicesDto = { devices: countSubscriptions(deps.db, session.identity.id) };
    return reply.header('cache-control', 'no-store').send(dto);
  });

  app.post('/api/push/unsubscribe', async (request, reply) => {
    const guard = checkMutation(request, deps.config.publicOrigin);
    if (guard !== 'ok') {
      return reply.code(403).header('cache-control', 'no-store').send({
        code: guard,
        message: guard === 'ORIGIN' ? 'запрос с чужого источника отклонён' : 'нужен application/json',
      });
    }
    const session = sessionOf(deps, request);
    if (session === null) return unauthenticated(reply);
    // Cleanup has to work with push switched off (a deployment that removed the key must still be
    // able to forget its rows), so the budget, not the key, is what gates this route.
    const limited = limitOrRefuse(request, reply, deps, session.identity.id);
    if (limited !== null) return limited;

    // An absent body means «every device» — the reader asked the site to forget push entirely,
    // and the page has nothing to name. A body that names an endpoint is validated like any
    // other, because it decides which row of *this* identity is deleted.
    const body = request.body as { endpoint?: unknown } | null;
    let endpoint: string | undefined;
    if (body !== null && typeof body === 'object' && body.endpoint !== undefined) {
      if (typeof body.endpoint !== 'string' || body.endpoint.length > ENDPOINT_MAX) {
        return invalid(reply, 'endpoint должен быть строкой не длиннее 1024 символов');
      }
      endpoint = body.endpoint;
    }
    const devices = deleteSubscription(deps.db, session.identity.id, endpoint);
    const dto: PushDevicesDto = { devices };
    return reply.header('cache-control', 'no-store').send(dto);
  });
}
