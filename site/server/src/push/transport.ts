/**
 * The network half of push (BOOK-189) — one function, and it is the only one that talks to a
 * push service.
 *
 * The engine never gets here: it writes rows, the site drains them. This module turns one queue
 * row and one device into one `web-push` call and reduces whatever happened to three words:
 *
 *   · `ok`   — the service accepted the message;
 *   · `gone` — 404 or 410: the subscription is dead (the browser was uninstalled, the permission
 *              withdrawn). The caller forgets the device; retrying would only repeat the answer;
 *   · `error` — everything else (a 5xx, a timeout, a malformed subscription). The row stays and
 *              is tried again later, because a push service being briefly down is not the
 *              reader's fault.
 *
 * The three words are the whole error surface on purpose: a `WebPushError` carries the endpoint
 * and the response body, and both are exactly what must not reach a log or a returned message.
 *
 * `send` is injectable so a test can prove the payload and the options without a network, and so
 * the mapping above can be proven by feeding it the status codes the service really returns.
 */

import webpush from 'web-push';

import type { PushTransport } from './sender.ts';

export type VapidDetails = { privateKey: string; publicKey: string };

/** The `web-push` call, in the shape the seam takes; the default is the library's own. */
export type WebPushSend = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

/** Service workers are told one notification per chapter for a day: the topic coalesces them. */
const TTL_SECONDS = 86_400;

export function createWebPushTransport(
  keys: VapidDetails,
  subject: string,
  send: WebPushSend = webpush.sendNotification,
): PushTransport {
  return async (subscription, message) => {
    try {
      await send(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(message),
        {
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: TTL_SECONDS,
          urgency: 'normal',
          topic: message.tag,
        },
      );
      return { status: 'ok' };
    } catch (error) {
      const status = (error as { statusCode?: unknown }).statusCode;
      // 404 and 410 are the push service saying «this subscription no longer exists», which is
      // the one failure that must delete the device instead of retrying it.
      if (status === 404 || status === 410) return { status: 'gone' };
      return { status: 'error' };
    }
  };
}
