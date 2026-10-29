import { AGE_COOKIE, AGE_MAX_AGE_SECONDS, ageDateOf } from '@book/shared';
import type { FastifyInstance } from 'fastify';

import { serializeCookie } from '../../util/cookies.ts';
import type { RouteDeps } from '../deps.ts';

/**
 * `POST /api/age` — the reader answered the book's one question (BOOK-225).
 *
 * The answer is a fact about this device, so it is written where the device keeps it: a cookie
 * the **page can read** (`HttpOnly` off), because the page resumes from it at boot and must not
 * ask the API who it is before it can paint the first screen. It is not a credential — the value
 * names a day and nothing else — and it is not signed: forging it buys the same book a reader
 * would read after one click, and the route that refuses prose is a gate before an adult book,
 * not an authentication boundary.
 *
 * `Path=/` so every chapter request carries it, `SameSite=Lax` so a cross-site page cannot make
 * a reader's browser answer for them, and `Max-Age` is the same year the value is bound by
 * (`shared/src/age.ts`). `Secure` follows the public origin, like the session cookie: the
 * deployment is https, and a local http run would otherwise lose the value on every reload.
 *
 * The day comes from `deps.now()` — the app's one clock seam — so a test can pin it and the
 * cookie can never name a day the server's own rows would disagree with.
 */
export function registerAgeRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post('/api/age', async (_request, reply) => {
    const acknowledgedAt = ageDateOf(deps.now());
    reply.header(
      'set-cookie',
      serializeCookie(AGE_COOKIE, acknowledgedAt, {
        httpOnly: false,
        secure: deps.config.publicOrigin.startsWith('https'),
        sameSite: 'Lax',
        path: '/',
        maxAgeSeconds: AGE_MAX_AGE_SECONDS,
      }),
    );
    return reply.send({ acknowledgedAt });
  });
}
