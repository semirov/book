/**
 * The rate-limit table of ARCHITECTURE.md §14, as data.
 *
 * Two keys are checked on every write, because the SPEC's limit and the abuse limit
 * measure different things: the network (`ip:`) stops a script that has not signed in, the
 * identity (`id:`) stops one person with many networks. Both must pass. Keys are namespaced
 * with the surface they belong to, so a reader edit can never share a counter with a
 * comment or with OAuth.
 *
 * §14 stores no address: an IP key is `HMAC-SHA256(IP_SALT, ipKey)` before it becomes a
 * key, so `rate_events` only ever holds a hash. The hasher is passed in, never built here:
 * one salt for the process, one hash for every surface.
 */

import { COMMENT_HOUR_MS, EDIT_DAY_MS } from '@book/shared';

import type { Config } from '../config.ts';
import type { LimitSpec } from './limiter.ts';

/** `HMAC-SHA256(salt, ipKey)` — `createIpHasher` in `util/ipHash.ts`. */
export type IpHasher = (ipKey: string) => string;

export const GLOBAL_MINUTE_LIMIT = 60;
export const GLOBAL_HOUR_LIMIT = 400;

export function commentIpKey(ipHash: IpHasher, ipKey: string): string {
  return `cmt:ip:${ipHash(ipKey)}`;
}

export function commentIdentityKey(identityId: string): string {
  return `cmt:id:${identityId}`;
}

export function editIdentityKey(identityId: string): string {
  return `edit:id:${identityId}`;
}

/**
 * Hiding or restoring the public name is a state mutation like any other: one reader may
 * not churn the list for everyone. It has its own namespace so a toggle never spends a
 * comment or an edit budget.
 */
export const HIDE_TOGGLE_PER_HOUR = 30;

export function hideIdentityKey(identityId: string): string {
  return `authors:hide:id:${identityId}`;
}

export function hideSpecs(identityId: string): LimitSpec[] {
  return [{ key: hideIdentityKey(identityId), limit: HIDE_TOGGLE_PER_HOUR, windowMs: COMMENT_HOUR_MS }];
}

export function oauthIpKey(ipHash: IpHasher, ipKey: string): string {
  return `oauth:ip:${ipHash(ipKey)}`;
}

/** The SPEC's 10 comments/hour/IP, the anti-farming limit on the identity, and the site cap. */
export function commentSpecs(
  config: Config,
  ipHash: IpHasher,
  ipKey: string,
  identityId: string,
): LimitSpec[] {
  return [
    { key: commentIpKey(ipHash, ipKey), limit: config.commentsPerHour, windowMs: COMMENT_HOUR_MS },
    { key: commentIdentityKey(identityId), limit: config.commentsPerHourIdentity, windowMs: COMMENT_HOUR_MS },
    { key: 'cmt:all:min', limit: GLOBAL_MINUTE_LIMIT, windowMs: 60_000 },
    { key: 'cmt:all:hour', limit: GLOBAL_HOUR_LIMIT, windowMs: COMMENT_HOUR_MS },
  ];
}

/** One budget for both paths: a proposed edit and an accepted comment share `edit:id:`. */
export function editSpecs(config: Config, identityId: string): LimitSpec[] {
  return [
    { key: editIdentityKey(identityId), limit: config.editSubmissionsPerDay, windowMs: EDIT_DAY_MS },
  ];
}

export function oauthSpec(config: Config, ipHash: IpHasher, ipKey: string): LimitSpec {
  return { key: oauthIpKey(ipHash, ipKey), limit: config.oauthStartPerHour, windowMs: COMMENT_HOUR_MS };
}
