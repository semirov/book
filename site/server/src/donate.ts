/**
 * BOOK-126 — the gift link, validated once at boot.
 *
 * The footer row is rendered from this value or not at all, so a hostile `DONATE_URL` can only
 * switch the row off: it can never reach the page, and nothing of the payment platform is
 * embedded anywhere (one outbound `<a>`, no script, no iframe, no pixel — the reader stays
 * unknown to us and the CSP is untouched).
 *
 * The rules are an allowlist, nothing else:
 *   · trimmed; an empty value is `null` — a deployment that does not ask for gifts;
 *   · it must parse with `new URL()`, be `https:`, and name exactly `t.tb.ru`: a subdomain
 *     (`evil.tb.ru`), a suffix (`t.tb.ru.evil.com`), a port (`t.tb.ru:8443`) and credentials
 *     (`user@t.tb.ru`) are four different hosts and all refused;
 *   · the path and the query are kept **exactly as given** — no rewriting, no normalising, no
 *     UTM, no trailing-slash change: the owner's link is the link the page prints;
 *   · anything else is `null`.
 */
export function donateUrlOf(raw: string | undefined | null): string | null {
  const value = (raw ?? '').trim();
  if (value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // `host` carries the port, so `t.tb.ru:8443` is not `t.tb.ru`; `hostname` alone would miss it.
  if (url.protocol !== 'https:' || url.host !== 't.tb.ru' || url.port.length > 0) return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  return value;
}
