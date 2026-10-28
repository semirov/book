/**
 * The admin surface (ARCHITECTURE.md §17, §13.4 point 5): one token-guarded JSON panel.
 *
 * `/api/admin/*` answers 404 at Caddy, so this route is reachable only from inside the
 * host. It is guarded anyway, because a route that relies on the proxy for its only check is
 * one misconfigured Caddyfile away from being public:
 *
 * - no configured token → the route does not exist (404), so a forgotten secret closes the
 *   surface instead of opening it;
 * - a wrong token → 401, with no hint about the right one;
 * - the comparison is constant-time over equal-length buffers, so a wrong token does not
 *   leak its prefix through timing.
 *
 * The book still has no write API (§13.1): the panel can release, cancel and pause through the
 * engine and — BOOK-113 — clear or exempt one identity's *budget state*, which is operational
 * data about a reader, not the manuscript. No route here edits a paragraph.
 *
 * Both budget routes take one identity in any of the three forms an operator has at hand
 * (`identity/resolve.ts` documents them): the internal id `idt_…`, the display name (trimmed,
 * case-insensitive), or the 12-hex public alias. Unknown → 404, more than one match → 409 with
 * the candidates; the route never guesses.
 *
 * The loopback-only rule is the CLI's (`bin/admin.mjs` refuses a non-local target), because a
 * deployed process binds `192.168.1.76` and a route that trusts `remoteAddress` would have to
 * know the deployment's own address list. Caddy still hides `/api/admin/*` from the public.
 *
 * BOOK-137 adds one more write: `POST /api/admin/reset/book` empties the book's content and
 * progress before a launch. It still edits no paragraph — it deletes what the manuscript no
 * longer backs and re-reads the two frame slots from `manuscript/`, which is why the one write
 * this route performs is a *reset* and not an edit. The rule itself lives in `reset/book.ts`;
 * this file only guards, maps refusals to statuses and answers with counts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { TOTAL_CHAPTERS, type AdminHealthDto } from '@book/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { SITE_ROOT } from '../../config.ts';
import { assertDataDirOutsideRepo } from '../../dataDirGuard.ts';
import { readEngineHealth } from '../../engineState/reader.ts';
import { resolveIdentity } from '../../identity/resolve.ts';
import { readIntegrity } from '../../integrity/service.ts';
import { resetIdentityBudget } from '../../rate/reset.ts';
import {
  BackupFailedError,
  EngineBusyError,
  FrameMissingError,
  FrameNotBasisError,
  ManuscriptWrittenError,
  resetBook,
} from '../../reset/book.ts';
import { tokenMatches } from '../../util/secret.ts';
import type { RouteDeps } from '../deps.ts';

/** The constant-time compare now lives in `util/secret.ts`; re-exported for its old callers. */
export { tokenMatches };

function presented(request: FastifyRequest): string {
  const header = request.headers['x-admin-token'];
  if (typeof header === 'string') return header.trim();
  const authorization = request.headers.authorization ?? '';
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
}

function guard(deps: RouteDeps, request: FastifyRequest, reply: FastifyReply): boolean {
  if (deps.adminToken.length === 0) {
    void reply.code(404).send({ code: 'NOT_FOUND', message: 'no such route' });
    return false;
  }
  if (!tokenMatches(deps.adminToken, presented(request))) {
    void reply.code(401).send({ code: 'UNAUTHORIZED', message: 'admin token required' });
    return false;
  }
  return true;
}

/** The chapter a pass is asked for; anything but a whole number inside the book is refused. */
function chapterOf(body: unknown): number | null {
  if (body === null || typeof body !== 'object') return null;
  const value = (body as { chapter?: unknown }).chapter;
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < 1 || value > TOTAL_CHAPTERS) return null;
  return value;
}

/** A refusal the admin route maps to a status, carrying the engine's own code. */
type EngineRefusalLike = Error & { code?: string };

/**
 * The production seam: the site asks the engine's loopback API with the engine's own token.
 * The engine is the only writer of a step, so the admin surface opens nothing itself.
 */
function enginePassOf(deps: RouteDeps): (chapter: number) => Promise<{ stepId: string; chapter: number }> {
  return async (chapter) => {
    const token = deps.config.engineToken.length > 0 ? deps.config.engineToken : readTokenFile(deps);
    const url = `http://127.0.0.1:${String(deps.config.enginePort)}/internal/pass`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ chapter, session: 'admin' }),
    });
    const body = (await response.json().catch(() => null)) as
      | { code?: string; message?: string; data?: { stepId?: string; chapter?: number } }
      | null;
    if (!response.ok || body?.data?.stepId === undefined) {
      const error = new Error(body?.message ?? `engine answered ${String(response.status)}`) as EngineRefusalLike;
      error.code = body?.code ?? `ENGINE_HTTP_${String(response.status)}`;
      throw error;
    }
    return { stepId: body.data.stepId, chapter: body.data.chapter ?? chapter };
  };
}

/** The token file is read per call: an operator can rotate it without restarting the site. */
function readTokenFile(deps: RouteDeps): string {
  try {
    return readFileSync(deps.config.engineTokenFile, 'utf8').trim();
  } catch {
    const error = new Error('движок недоступен: токен не прочитан — проверьте ENGINE_TOKEN_FILE') as EngineRefusalLike;
    error.code = 'ENGINE_UNREACHABLE';
    throw error;
  }
}

/** The identity a body names, or the line the operator must fix. */
function identityOf(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const value = (body as { identity?: unknown }).identity;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value;
}

/**
 * BOOK-137: the reset body. An absent body is a dry run — the destructive shape is asked for
 * explicitly. Anything that is not a boolean is refused rather than coerced: `{ dryRun: 'no' }`
 * must not read as `true` because a string is truthy everywhere else in JavaScript.
 */
function resetOptions(body: unknown): { dryRun: boolean; backupOk: boolean } | null {
  if (body === undefined || body === null) return { dryRun: true, backupOk: false };
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const { dryRun, backupOk } = body as { dryRun?: unknown; backupOk?: unknown };
  if (dryRun !== undefined && typeof dryRun !== 'boolean') return null;
  if (backupOk !== undefined && typeof backupOk !== 'boolean') return null;
  const wipe = dryRun === false;
  // `backupOk` only means «wipe without a backup»: with a dry run it asks for nothing, and a
  // contradiction is refused here rather than silently ignored.
  if (backupOk === true && !wipe) return null;
  return { dryRun: !wipe, backupOk: backupOk === true };
}

/**
 * One resolver for both routes: 404 for no match, 409 with the candidates for more than one.
 * A `reply` is sent before `null`, so the caller only has to return it.
 */
function resolved(
  deps: RouteDeps,
  reply: FastifyReply,
  query: string,
): { id: string; displayName: string; editExempt: number } | null {
  const match = resolveIdentity(deps.db, query);
  if (match.ok === true) return match.identity;
  if (match.code === 'AMBIGUOUS') {
    void reply.code(409).send({
      code: 'AMBIGUOUS',
      message: 'имя совпадает у нескольких читателей — уточните по id или alias',
      candidates: match.candidates,
    });
    return null;
  }
  void reply.code(404).send({ code: 'NOT_FOUND', message: 'читатель не найден' });
  return null;
}

export function registerAdminRoutes(app: FastifyInstance, deps: RouteDeps): void {
  /**
   * The operator's health (audit m4): the counts, the version, the cover and the lane
   * holder are not for the public probe. Same guard as the integrity panel, same absence
   * rule — no configured token means the route does not exist.
   */
  app.get('/api/admin/health', async (request, reply) => {
    if (!guard(deps, request, reply)) return reply;
    // BOOK-155 — the panel counts the book, not the storage: a chapter-65 row kept by the
    // `chapters` CHECK is not one of the 42 chapters the reader can see.
    const chapters = deps.db
      .prepare('SELECT COUNT(*) AS n FROM chapters WHERE n BETWEEN 1 AND ?')
      .get(TOTAL_CHAPTERS) as { n: number };
    const comments = deps.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number };
    const front = deps.db.prepare('SELECT COUNT(*) AS n FROM front_matter').get() as { n: number };
    const engine = readEngineHealth(deps.db, deps.now().getTime());
    const body: AdminHealthDto = {
      uptimeMs: deps.now().getTime() - deps.startedAt,
      version: deps.version,
      lane: { holder: engine.laneId },
      front: { present: front.n > 0 },
      db: { chapters: chapters.n, comments: comments.n },
      engine: { status: engine.status, heartbeatAt: engine.heartbeatAt },
    };
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.get('/api/admin/integrity', async (request, reply) => {
    if (!guard(deps, request, reply)) return reply;
    const report = readIntegrity(deps.db, {
      bookRoot: deps.config.bookRoot,
      denylistPath: deps.config.denylistPath,
      imprint: deps.imprint,
      nowMs: deps.now().getTime(),
    });
    return reply.header('cache-control', 'no-store').send(report);
  });

  /**
   * BOOK-113 — clear one identity's budget rows: `edit:id:`, `cmt:id:` and every
   * `edit:ip:` reachable through that identity's own comments. One transaction; the answer
   * carries counts only, never a key or a hash.
   */
  app.post('/api/admin/budget/reset', async (request, reply) => {
    if (!guard(deps, request, reply)) return reply;
    const query = identityOf(request.body);
    if (query === null) {
      return reply.code(400).send({ code: 'INVALID', message: 'нужно поле identity: id, имя или alias' });
    }
    const identity = resolved(deps, reply, query);
    if (identity === null) return reply;
    const removed = resetIdentityBudget(deps.db, identity.id);
    return reply.header('cache-control', 'no-store').send({
      identity: { id: identity.id, displayName: identity.displayName },
      removed,
    });
  });

  /**
   * BOOK-113 — turn the daily edit exemption on or off for one identity. The previous and the
   * current value are both returned, so a no-op toggle is visible as such (`1 → 1`).
   */
  app.post('/api/admin/budget/exempt', async (request, reply) => {
    if (!guard(deps, request, reply)) return reply;
    const query = identityOf(request.body);
    const exempt = (request.body as { exempt?: unknown } | null)?.exempt;
    if (query === null || typeof exempt !== 'boolean') {
      return reply
        .code(400)
        .send({ code: 'INVALID', message: 'нужны поля identity (id, имя или alias) и exempt (true|false)' });
    }
    const identity = resolved(deps, reply, query);
    if (identity === null) return reply;
    const previous = identity.editExempt === 0 ? 0 : 1;
    const current = exempt ? 1 : 0;
    deps.db.prepare('UPDATE identities SET edit_exempt = ? WHERE id = ?').run(current, identity.id);
    return reply.header('cache-control', 'no-store').send({
      identity: { id: identity.id, displayName: identity.displayName },
      previous,
      current,
    });
  });

  /**
   * BOOK-137 — the launch reset: empty the book's content and progress, keep its people.
   *
   * The body is `{ dryRun?: boolean, backupOk?: boolean }` and an absent body is a dry run:
   * the destructive shape is the one that has to be asked for explicitly, never the default of
   * a request that lost its body. Counts are the answer in both shapes; nothing here returns a
   * row, a text or a token.
   *
   * Refusals: `MANUSCRIPT_WRITTEN` (a boot scan would restore the book), `FRAME_MISSING` /
   * `FRAME_NOT_BASIS` (the canon is not readable or no longer the frozen sentence),
   * `ENGINE_BUSY` (a step is writing into the rows about to be deleted) and `BACKUP_FAILED`.
   */
  app.post('/api/admin/reset/book', async (request, reply) => {
    if (!guard(deps, request, reply)) return reply;
    const options = resetOptions(request.body);
    if (options === null) {
      return reply.code(400).send({
        code: 'INVALID',
        message:
          'dryRun and backupOk must be booleans, and backupOk requires dryRun: false ' +
          '(an absent body is a dry run)',
      });
    }
    try {
      // BOOK-107's rule, applied to a command rather than to a boot: a reset must never wipe a
      // data dir that sits inside the checkout a developer is working in.
      assertDataDirOutsideRepo(deps.config.dataDir, resolve(SITE_ROOT, '..'));
    } catch {
      return reply.code(409).send({
        code: 'DATA_DIR_IN_REPO',
        message: 'DATA_DIR is inside the checkout — the reset refuses to wipe the tree it was built from',
      });
    }

    try {
      let report = resetBook(deps.db, {
        bookRoot: deps.config.bookRoot,
        dataDir: deps.config.dataDir,
        now: deps.now(),
        dryRun: options.dryRun,
        backupOk: options.backupOk,
      });
      // M1: the engine bridge keeps in-memory cursors over the ids the wipe just restarted at.
      // Re-priming marks the empty book as known, so the next real fact is narrated. A dry run
      // never touches it: nothing was written, so nothing is re-read. A failing hook must not
      // turn a committed wipe into a 500 — the book is already reset — so it degrades to a
      // warning the operator can act on.
      if (!options.dryRun) {
        try {
          deps.onBookReset?.();
        } catch (error) {
          request.log.error({ err: error }, 'reset book: the engine bridge could not be re-primed');
          report = {
            ...report,
            warning: [report.warning, 'the engine bridge could not be re-primed — restart the site']
              .filter((line) => line !== undefined)
              .join('; '),
          };
        }
      }
      return reply.header('cache-control', 'no-store').send({ target: 'book', ...report });
    } catch (error) {
      if (error instanceof ManuscriptWrittenError) {
        return reply.code(409).send({ code: error.code, message: error.message, files: error.files });
      }
      if (error instanceof FrameMissingError) {
        return reply.code(409).send({ code: error.code, message: error.message });
      }
      if (error instanceof FrameNotBasisError) {
        return reply.code(409).send({ code: error.code, message: error.message });
      }
      if (error instanceof EngineBusyError) {
        return reply.code(409).send({
          code: error.code,
          message: error.message,
          openSteps: error.engine.openSteps,
          liveLeases: error.engine.liveLeases,
        });
      }
      if (error instanceof BackupFailedError) {
        return reply.code(500).send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  /**
   * BOOK-145: the owner can start a pass on demand instead of waiting for the loop — the show
   * has to be startable («как посмотреть, как книга печатается»). Same token, same surface as
   * `reset book`; the engine does the opening, so the guards are the engine's own.
   */
  app.post('/api/admin/pass/start', async (request, reply) => {
    if (!guard(deps, request, reply)) return reply;
    const chapter = chapterOf(request.body);
    if (chapter === null) {
      return reply.code(422).send({
        code: 'INVALID_CHAPTER',
        message: `chapter must be an integer 1..${String(TOTAL_CHAPTERS)}`,
      });
    }
    const live = deps.db.prepare('SELECT COUNT(*) AS n FROM leases WHERE released_at IS NULL').get() as {
      n: number;
    };
    if (live.n > 0) {
      return reply.code(409).send({
        code: 'PASS_RUNNING',
        message: 'проход уже идёт — дождитесь закрытия или посмотрите его в /api/chapters/:n/stages',
      });
    }
    try {
      const opened = await (deps.enginePass ?? enginePassOf(deps))(chapter);
      return reply.header('cache-control', 'no-store').send(opened);
    } catch (error) {
      const refusal = error as { code?: unknown; message?: unknown };
      const code = typeof refusal.code === 'string' ? refusal.code : 'ENGINE_REFUSED';
      const message = typeof refusal.message === 'string' ? refusal.message : 'движок отказал';
      request.log.error({ err: error }, 'admin pass start refused');
      return reply.code(code === 'ENGINE_UNREACHABLE' ? 502 : 409).send({ code, message });
    }
  });
}
