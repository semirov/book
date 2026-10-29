/**
 * `GET`/`PUT /api/me/place` — where this reader stopped reading (BOOK-209, requirement 3).
 *
 * The place is **own only and server-side**, so a second device resumes: the identity comes from
 * the session cookie and from nowhere else — no id in the path, no id in the query, and a body
 * that carries one is refused as an unknown field rather than quietly ignored (an identity field
 * that validated would be a way of writing into another reader's row).
 *
 * The two verbs answer in the shapes a client can branch on:
 *
 *   · `GET` → `401` anonymous, `204` when this identity has never left a place (an empty answer,
 *     not an invented chapter 1 — the client then starts at the top on its own terms), `200` with
 *     the DTO otherwise;
 *   · `PUT` → `401` anonymous, `400 {code:'BAD_PLACE'}` for a body that is not exactly the DTO,
 *     `204` once handled. The write is idempotent and it only moves forward: a body whose `at` is
 *     older than the stored visit — or the very same instant — leaves the row alone and still
 *     answers `204`, because «your place is recorded, and the one on record is at least as new as
 *     yours» is what the reader asked to be true. A second tab with a slow clock therefore cannot
 *     carry them back to a paragraph they left an hour ago.
 *
 * Every answer is `no-store`: a place that just moved must not be answered from a copy, and the
 * whole point is that the other device asks now. There is no limiter of its own — the surface is
 * under `/api/me`, so the read budget covers `GET` (as it covers every `/api/me` read) and the
 * app's body limit covers a body that is trying to be a document. Encoding a `PUT` as a form post
 * is not possible (a JSON body needs a preflight `CORS` will not grant), so no origin check is
 * needed beside the cookie: a cross-site page cannot make this write.
 *
 * `deltaPx` is a measurement of one screen, so it is bounded (`|x| ≤ 10000`): anything larger is
 * a client bug or a hostile body, and a stored value outside the bound would push the next
 * device's render to nonsense. The anchor stays a key, never a pixel — `sentenceId` names a block
 * and a sentence inside it (`ch12#b3/s4`), with the characters a block id can hold and nothing
 * else, so the client can build it without an escape rule of its own.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { TOTAL_CHAPTERS, type ReaderPlaceDto } from '@book/shared';

import { readPlace, writePlace } from '../../db/repo/places.ts';
import type { RouteDeps } from '../deps.ts';
import { sessionOf, unauthenticated } from '../session.ts';

/** The anchor key: a block id plus a sentence index, bounded to 200 characters. */
const SENTENCE_ID = /^[A-Za-z0-9#._:/-]{1,200}$/u;
/** `YYYY-MM-DDTHH:MM:SS[.sss](Z|±HH:MM)` — `Date.parse` alone accepts «2026», which is not one. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
/** The one DTO field the wire may carry; `identityId` is not one of them, by design. */
const PLACE_FIELDS = ['chapter', 'sentenceId', 'deltaPx', 'at'] as const;
/** The reading line is at most a few screens away: 10 000 CSS px is already absurd. */
const DELTA_MAX = 10_000;

function badPlace(reply: FastifyReply): FastifyReply {
  return reply.code(400).header('cache-control', 'no-store').send({
    code: 'BAD_PLACE',
    message: 'место в книге не сохранено: глава, предложение и смещение проверяются',
  });
}

function noPlace(reply: FastifyReply): FastifyReply {
  return reply.code(204).header('cache-control', 'no-store').send();
}

/**
 * The body, checked against the DTO field for field: exactly these four keys, a chapter inside
 * the book, an anchor key of the allowed characters, a finite bounded offset and a full ISO
 * instant. An extra key — `identityId` above all — makes the whole body wrong: accepting one and
 * dropping it would let a client believe it had addressed another reader.
 */
export function parsePlace(body: unknown): { ok: true; place: ReaderPlaceDto } | { ok: false } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false };
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== PLACE_FIELDS.length) return { ok: false };
  if (!PLACE_FIELDS.every((field) => keys.includes(field))) return { ok: false };

  const { chapter, sentenceId, deltaPx, at } = value;
  if (typeof chapter !== 'number' || !Number.isInteger(chapter)) return { ok: false };
  if (chapter < 1 || chapter > TOTAL_CHAPTERS) return { ok: false };
  if (typeof sentenceId !== 'string' || !SENTENCE_ID.test(sentenceId)) return { ok: false };
  if (typeof deltaPx !== 'number' || !Number.isFinite(deltaPx)) return { ok: false };
  if (Math.abs(deltaPx) > DELTA_MAX) return { ok: false };
  if (typeof at !== 'string' || !ISO_INSTANT.test(at) || Number.isNaN(Date.parse(at))) {
    return { ok: false };
  }
  return { ok: true, place: { chapter, sentenceId, deltaPx, at } };
}

export function registerPlaceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/api/me/place', async (request, reply) => {
    const session = sessionOf(deps, request);
    if (session === null) return unauthenticated(reply);
    const place = readPlace(deps.db, session.identity.id);
    // A reader who never left a place gets an empty answer, not a chapter 1 they did not read.
    if (place === null) return noPlace(reply);
    return reply.header('cache-control', 'no-store').send(place);
  });

  app.put('/api/me/place', async (request, reply) => {
    const session = sessionOf(deps, request);
    if (session === null) return unauthenticated(reply);
    const parsed = parsePlace(request.body);
    if (!parsed.ok) return badPlace(reply);
    writePlace(deps.db, session.identity.id, parsed.place);
    return noPlace(reply);
  });
}
