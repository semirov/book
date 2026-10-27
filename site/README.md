# book.semirov.dev — operator quickstart

**The manuscript is the only source of truth for text; the database is a projection of it.** Nothing here
writes prose: a writer session produces a file under a lease, the watcher publishes a revision, and the
database follows. If the two ever disagree, the files win and `POST /api/admin/reindex` rebuilds the
projection.

Architecture, invariants and the check that enforces each: [`ARCHITECTURE.md`](./ARCHITECTURE.md).
Product rules (owner): [BOOK-DOC-4](https://wiki.semirov.dev/BOOK/pages/407). Design: [BOOK-DOC-3](https://wiki.semirov.dev/BOOK/pages/406).
ADRs (one decision per page) and the operator runbook live in Lific, not in this repository.

## Run

```sh
npm install
npm run dev                  # API :8080 + Vite :5173 (proxy)
npm run build                # shared → server/dist, web/dist
npm start                    # one process: static SPA + API on :8080
npm run engine               # book-engine: 127.0.0.1:8081, never a public port
```

`npm run build && npm start` is the production shape: one process, one port.

## Check

```sh
npm test                     # vitest: shared, server, web
npm run test:coverage
npm run typecheck
npm run arch                 # file-size limit, layer boundaries, F023, no model in the engine
npm run validate             # F001–F009 + F020–F022 + F029 over manuscript/; exit 1 on errors
node bin/validate.mjs --staged   # what the git hook runs on the index
```

Install the commit gate once per clone: `git config core.hooksPath site/bin/git-hooks && chmod +x site/bin/git-hooks/pre-commit`.

## Operate

```sh
node bin/engine.mjs next --for fwd|bwd            # a writer assignment
node bin/engine.mjs next --role editor|consultant # a gate assignment
node bin/engine.mjs land <leaseId>                # after the file is written
node bin/engine.mjs verdict <stepId> --role … --session … --verdict HOLDS|GAP --findings f.json
node bin/engine.mjs done <leaseId> --seams seams.json --note "…"   # requires both verdicts
node bin/engine.mjs trace <changeId|stepId>       # the ripple, step by step
node bin/engine.mjs reconcile                     # boot check: lane, leases, stranded steps
node bin/index.mjs show|rebuild                   # the derived index: paths, hash, counts; rebuild
node bin/restore.mjs --chapter 9 --rev 3 --dry-run # a human rollback, then reconcile
```

The engine's internal API needs a bearer token from `DATA_DIR/engine.token` (or `ENGINE_TOKEN_FILE`).
It reads no model, writes no prose, and is never proxied by Caddy.

`GET /healthz` is liveness plus the facts an operator needs first: watcher tick, engine heartbeat, front
present, pricing loaded. Counts, the lane holder and integrity live behind the admin token at
`/api/admin/*`, which Caddy answers 404 for; reach it through `docker compose exec` or an SSH tunnel.

## Deploy shape

One image, two entries (`server/dist/index.js`, `server/dist/engine.js`), one SQLite file in WAL, one
Caddy in front. The repository is mounted read-only; only the data volume is writable. Secrets are files
mounted as Docker secrets (`SESSION_SECRET_FILE`, `IP_SALT_FILE`, `CAPTCHA_SECRET_FILE`,
`YANDEX_CLIENT_SECRET_FILE`); a secret in an environment value is refused at boot.

```sh
docker compose build
docker compose up -d book engine
curl -fsS http://127.0.0.1:8080/healthz | jq '{watcher,engine,front,pricing}'
```

Rollback: `bin/restore.mjs` for text, the previous image tag for code, then `engine.mjs reconcile`.

## Configuration

Every variable is parsed with a default at boot (`server/src/config.ts`); a bad value fails the start
rather than the first request. `BOOK_ROOT` (default: the repository root), `DATA_DIR` (`site/.data`),
`WEB_DIST`, `PORT`/`HOST`, `LOG_LEVEL`, `BOOK_TZ`, `WATCH_POLL_MS`, `EMPTY_WRITE_GRACE_MS`,
`MAX_WS`/`WS_PER_IP`, `TRUSTED_PROXIES`, `READ_PER_MINUTE`, `COMMENTS_PER_HOUR_IP`,
`COMMENTS_PER_HOUR_IDENTITY`, `EDIT_SUBMISSIONS_PER_DAY`, `QUEUE_SOFT_CAP`, `BUDGET_*`; `.env.example`
lists them with their defaults. `GET /privacy` and `/rules` name the one CAPTCHA and say how to read
without it.
