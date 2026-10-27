/**
 * Yandex ID OAuth 2.0 (ARCHITECTURE.md §9, §17; ADR-021).
 *
 * Authorization-code flow, server-side exchange, no token ever reaches the browser. The
 * only facts we keep are the opaque subject (`id`, never rendered) and a display name. The
 * URLs are configurable so tests can point the flow at a stub IdP; production uses the
 * real endpoints and the owner-supplied client id/secret.
 */

import type { Config } from '../config.ts';
import { yandexRedirectUri } from '../config.ts';

export type OAuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type OAuthFailureCode = 'OAUTH_UNCONFIGURED' | 'OAUTH_FAILED' | 'OAUTH_STATE';

export class OAuthError extends Error {
  readonly code: OAuthFailureCode;

  constructor(code: OAuthFailureCode, message: string) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

const TIMEOUT_MS = 5_000;

/** The redirect the browser is sent to; `state` is the signed nonce, never an identity. */
export function authorizeUrl(config: Config, state: string): string {
  const url = new URL(config.yandexAuthorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.yandexClientId);
  url.searchParams.set('redirect_uri', yandexRedirectUri(config));
  // Explicit, not the app default: the profile call reads `display_name`/`login`, which
  // `login:info` provides. A renamed default in the dashboard must not silently drop them.
  url.searchParams.set('scope', 'login:info');
  url.searchParams.set('state', state);
  return url.toString();
}

export type YandexToken = { accessToken: string; expiresIn: number | null };

export async function exchangeCode(
  config: Config,
  code: string,
  fetchImpl: OAuthFetch = fetch,
): Promise<YandexToken> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.yandexClientId,
    client_secret: config.yandexClientSecret,
    redirect_uri: yandexRedirectUri(config),
  });

  let response: Response;
  try {
    response = await fetchImpl(config.yandexTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new OAuthError('OAUTH_FAILED', 'identity provider unreachable');
  }

  if (!response.ok) throw new OAuthError('OAUTH_FAILED', `token endpoint answered ${response.status}`);
  const payload = (await response.json().catch(() => null)) as
    | { access_token?: unknown; expires_in?: unknown }
    | null;
  if (payload === null || typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new OAuthError('OAUTH_FAILED', 'token endpoint returned no access token');
  }
  return {
    accessToken: payload.access_token,
    expiresIn: typeof payload.expires_in === 'number' ? payload.expires_in : null,
  };
}

export type YandexProfile = { sub: string; displayName: string | null };

/** The profile call: `id` is the stable subject; the rest is only used for a label. */
export async function fetchProfile(
  config: Config,
  accessToken: string,
  fetchImpl: OAuthFetch = fetch,
): Promise<YandexProfile> {
  let response: Response;
  try {
    response = await fetchImpl(config.yandexInfoUrl, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new OAuthError('OAUTH_FAILED', 'identity provider unreachable');
  }
  if (!response.ok) throw new OAuthError('OAUTH_FAILED', `profile endpoint answered ${response.status}`);

  const payload = (await response.json().catch(() => null)) as
    | { id?: unknown; login?: unknown; display_name?: unknown }
    | null;
  if (payload === null) throw new OAuthError('OAUTH_FAILED', 'profile endpoint returned no body');

  const rawId = payload.id;
  const sub = typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : '';
  if (sub.length === 0) throw new OAuthError('OAUTH_FAILED', 'profile carries no subject');

  const label =
    typeof payload.display_name === 'string' && payload.display_name.trim().length > 0
      ? payload.display_name
      : typeof payload.login === 'string'
        ? payload.login
        : null;
  return { sub, displayName: label };
}
