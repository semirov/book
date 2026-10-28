/**
 * Web Push (BOOK-189): the four shapes the page and the site exchange, and nothing else.
 *
 * A push subscription is a capability, not a profile: `endpoint`, `p256dh` and `auth` are the
 * secrets of one device, and the server treats them as such. So none of them travels back out —
 * the key is public, the subscribe input goes one way, and every answer is a **count**. A reader
 * who loses a phone can therefore never read another device's handle out of this API, and the
 * page's own storage of it is the only copy that matters to it.
 */

/** The VAPID public key a browser needs to subscribe; public by nature. */
export type PushKeyDto = { key: string };

/**
 * The browser's `PushSubscription`, as `pushManager.subscribe()` returns it. The site stores it
 * and never echoes it: the input shape exists so the page and the route agree on the fields.
 */
export type PushSubscribeInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/** Which device to forget; omitted means «this reader, every device». */
export type PushUnsubscribeInput = { endpoint?: string };

/** How many devices the reader has left — the only thing an answer says about subscriptions. */
export type PushDevicesDto = { devices: number };
