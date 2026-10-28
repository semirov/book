# book.semirov.dev — operator quickstart

**The manuscript is the only source of truth for text; the database is a projection of it.** Nothing here
writes prose: a writer session produces a file under a lease, the watcher publishes a revision, and the
database follows. If the two ever disagree, the files win and `POST /api/admin/reindex` rebuilds the
projection.

Architecture, invariants and the check that enforces each: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

**The reading surface prints the book, not the product.** On the book page — the running head, the flow of
chapters, the empty slots — only the book's own text, chapter numbers, the folio and the running head's
chapter number/title may appear. No state words («замысел», «правка»), no statuses («пишется глава»,
«глав ещё нет»), no counts («67 глав»), no explanations of the interface, no waits or failures: those live
in panels, the chronicle and the end matter. One exception is the filing's own state word: a slot that
already holds a reader's premise prints that premise's quote and its word («ждёт») — an empty slot prints
neither, and the word is never a label for the vacancy. `web/src/components/readingCopy.test.tsx` fails the
gate on any of them, so the rule is enforced, not remembered.
Product rules (owner) and the design live with the project's records, not in this repository: one decision
per page, and the operator runbook in the same place.

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
npm run frame:check          # F029: ch01 opens and ch67 closes on the canon; deploy.sh checks the live site
npm run frame:check -- --url=http://127.0.0.1:8091 --data="$HOME/book-site-data"   # «what does the site actually serve»
npm run validate             # F001–F009 + F020–F022 + F029 over manuscript/; exit 1 on errors
node bin/validate.mjs --staged   # what the git hook runs on the index
```

Install the commit gate once per clone: `git config core.hooksPath site/bin/git-hooks && chmod +x site/bin/git-hooks/pre-commit`.

Environments: dev, test, prod — what may touch what — https://wiki.semirov.dev/BOOK/pages/457

The three data dirs, and the wall between them: **dev** is `site/.data` (API `:8080`, SPA `:5173`,
`scripts/dev.mjs`); **test** is a fresh `mkdtemp` per test file, forced by `test/setup.ts` (which also
drops an ambient `NODE_ENV`/`PRODUCTION_DATA_DIR`); **prod** is `$HOME/book-site-data` on `:8091` with
`NODE_ENV=production`. The boot refuses a non-production run against a production data dir and a
production run with `DATA_DIR` inside the checkout; `bin/feedback.mjs` and `bin/restore.mjs` use the
same guard before they open `book.db`.

`npm test` snapshots both dirs (`test/globalSetup.ts`). **Fatal** is a structural change — any entry
added or removed, a dir that appears or vanishes, a non-database file whose size or mtime moved: a
token, a feedback batch, a version snapshot, a stray DB. **Reported, not judged**: the live SQLite
files (`book.db`, `-wal`, `-shm`) and the row counts read from them, printed as before → after pairs,
because a running service rewrites those pages itself and `stat` cannot attribute a write to a test.

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

Beats are automatic: the engine's own tick (`ENGINE_REAPER_MS`) refreshes the lease of every open step,
so a real pass longer than `LEASE_TTL_MS` is normal and a session never has to keep its lease alive by
hand. The **step wall** (`STEP_WALL_MS`, default 45 min from the step's opening) is the only bound: past
it the reaper escalates the step, records `escalated:gate_timeout` with «шаг не закрылся за отведённое
время — нужно решение» and releases the lease, so a dead session cannot hold a chapter past the wall.
A close (`done`/`seen`/`escalate`) that arrives after the lease expired but before the wall is accepted
and recorded as `expired-close`; `land`/`beat` still need a live lease, and a session whose step is now
held by another live lease is refused `LEASE_HELD`.

The engine's internal API needs a bearer token from `DATA_DIR/engine.token` (or `ENGINE_TOKEN_FILE`).
It reads no model, writes no prose, and is never proxied by Caddy.

`GET /healthz` is liveness plus the identity of the answering process: the build's `commit`, the
`bookRoot` and `dataDir` it reads, `startedAt`, and the watcher tick with the engine status. That is
what tells two hosts (and a stale client) apart after a deploy. Counts, the version, the lane holder
and integrity live behind the admin token at `/api/admin/*`, which Caddy answers 404 for; reach it
through `docker compose exec` or an SSH tunnel.

## Deploy shape (BOOK-172: one image, three services)

One image (`book:<40-char sha>`, never `latest`), three services from it — `site`
(`server/dist/index.js`, published on the Mac's LAN address for Caddy on the home-server), `engine`
(`server/dist/engine.js`, no published port) and `writer` (`server/dist/writer/main.js --loop`, no
port). The data dir is the **host path** `/Users/filipp/book-site-data` bind-mounted at `/data`; the
manuscript is read-only into `site` and `engine`, and only `manuscript/` is writable into `writer`.
Secrets are files: the environment carries **paths** (`SESSION_SECRET_FILE`, `IP_SALT_FILE`,
`YANDEX_CLIENT_ID_FILE`, `YANDEX_CLIENT_SECRET_FILE`, `CAPTCHA_SECRET_FILE` only when a captcha is
chosen) and the values live in `0600` files mounted at `/run/secrets/…`. `site` and `engine` both get
the session secret and the IP salt — the engine boots through the same `loadConfig()`, which refuses
production without them. In `NODE_ENV=production` a secret supplied as a plain environment value is
refused at boot (invariant 30), with no opt-out.

Sign-in is optional (ADR-021). To enable it, put the client id in `secrets/yandex_client_id` and the
client secret in `secrets/yandex_client_secret` (both `0600`) and point `YANDEX_CLIENT_ID_FILE` /
`YANDEX_CLIENT_SECRET_FILE` at them (`/run/secrets/…` for the compose services, `./secrets/…` in
`.env` for the launchd fallback). To run without OAuth, mount neither: the site stays readable and
sign-in answers `503 OAUTH_UNCONFIGURED`. Text rollback is unchanged (`bin/restore.mjs` for a chapter,
then `bin/engine.mjs reconcile`); the paragraphs below are about code.

| service | command | published | cpu / mem / pids | grace | healthcheck |
| --- | --- | --- | --- | --- | --- |
| site | `node server/dist/index.js` | `192.168.1.76:8091` → 8080 | 1.0 / 768 MiB / 256 | 20 s | `/healthz` 200, `ok:true` **and** the commit in `/app/build-info.json` |
| engine | `node server/dist/engine.js` | none (compose network) | 1.0 / 768 MiB / 256 | 60 s | `/internal/health` with the bearer read from `/data/engine.token` |
| writer | `node server/dist/writer/main.js --loop` | none | 2.0 / 1 GiB / 128 | 30 s | none — a portless lane that idles for 15 min between passes would flap |

`writer` declares `depends_on: engine: {condition: service_healthy}`: its first act at boot is a
request to the engine, and on a cold start the engine is still binding — the lane then logged
`ENGINE_UNREACHABLE` and slept its full 15-minute pause (measured, a real hole in the morning). `site`
has no such dependency on purpose: it tolerates an absent engine (it reports `engine.status: down` and
serves the book), so coupling its start would turn an engine restart into a site outage.

Caps are ceilings, not reservations: 4 of the VM's 10 CPUs and 2.5 of its 12 GiB, leaving the rest
for `docker build` and the agents. Every service runs as `501:20` (the host data dir's owner), with a
read-only root filesystem, `tmpfs /tmp`, `cap_drop: ALL` and `no-new-privileges`; logs are `json-file`
rotated at 10 MiB × 3 files (the writer 20 MiB × 5). Measured on this box (bookworm-slim +
better-sqlite3 as uid 501): WAL set, 300 inserts 4 ms, `wal_checkpoint(TRUNCATE)` busy=0, two
concurrent writer containers × 400 rows → 800 rows, `integrity_check ok`, identical under
`--read-only --tmpfs /tmp`.

**Single instance.** Compose cannot create a second `book-<role>-1` in its project; `deploy/entrypoint.sh`
adds the guard that covers everything else (another project, a stray `docker run`, a leftover launchd
job): `flock -n /locks/<role>.lock`, and a refusal is exit 75 naming the holder. The lock dir is
`~/.local/state/book-locks` — outside the data dir, so backups and the isolation guard never see it —
and **it must exist before the first `up`, created by the invoking user (0755)**: Docker would create
the bind source as root, uid 501 could not write its lock file, and every service would exit 75.
`flip.sh` and `compose-release.sh` both do this and refuse a root-owned dir with the exact `sudo rm -rf`
to run. A container left holding a lease is not a lock problem: `ENGINE_REAPER_MS=15000` expires a
`LEASE_TTL_MS=120000` lease, `STEP_WALL_MS` (45 min) escalates a step, and `deploy/lane-check.sh` reads
the engine's own state before anything is restarted. `docker compose restart writer` is the recovery.

**Deploy and rollback** (the only way; `deploy.yml` runs it, a human runs the same script):

```sh
site/deploy/compose-release.sh --ref main            # build book:<sha>, up -d --wait, health gate
site/deploy/compose-release.sh --rollback            # one command back to the previous image
site/deploy/compose-release.sh --status              # what runs, what it reports, which tags are kept
```

A rollback swaps the **image**, not the tree: the compose file is packaging and always comes from the
deployed release, so `--rollback` (and the red path) never check the deploy root out at the image's
sha — measured: a pre-container commit makes `docker compose` read the old single-service file and the
rollback never happens. `flip.sh --to launchd` is the one place that moves the tree, because launchd
serves the tree; it aligns the root to `last-good-image` first.

Exit codes: `0` the new image serves its own commit and every service is healthy; `1` the run failed
and the stack is back on the previous image (or could not be); `2` usage; `3` another deploy holds
`$STATE_DIR/deploy.lock` — nothing was built, started or rolled back. A failed rollback says what is
actually serving (`prod still answers <commit>` or `prod answers nothing`); it does not assume a dead
prod. Budget: `BOOK_HEALTH_TIMEOUT`
180 s with a 60 s grace window, 200 ms polls; a rollback needs two independent negatives **for a
health-window red** (the window spent its budget **and** a plain read does not name the built commit),
while a service that is not running/healthy is decisive on its own. The build
is bounded by `BOOK_BUILD_TIMEOUT` (1200 s). Images are pruned to the running one plus the 5 newest;
`$STATE_DIR/previous-image` names the rollback target and `$STATE_DIR/last-good-image` the last image
whose gate passed. **The gate runs no host `node`/`npm` and never mounts the data dir** — the full
suite is CI's (`gate.yml`), which also ends the BOOK-159 race with the writer lane.

**The flip** (documented once; `flip.sh` prints the same plan with `--dry-run`):

```sh
site/deploy/backup.sh                                        # a fresh consistent backup is required
site/deploy/flip.sh --to compose --ref main --confirm        # launchd -> containers
site/deploy/flip.sh --to launchd --confirm                   # back to the fallback
```

`--to compose` checks the backup is younger than an hour, stops the writer lane, then the site and the
engine, removes the stale pre-BOOK-172 `book-site` container (8090 and its named volume; the volume
stays until the cycle closes), runs `compose-release.sh`, and only after a green gate writes
`$STATE_DIR/runtime=compose` and `launchctl disable`s the three jobs. A failed flip re-bootstraps
launchd and leaves `runtime` alone, so the workflow keeps deploying the launchd way. The one host
dependency that remains: **OrbStack must start at login** (`orb config set app.start_at_login true`),
or a reboot leaves 8091 down until someone signs in.

Two host facts worth knowing. OrbStack can leave the LAN publish of a *recreated* container dead while
the container itself is healthy (measured here); `compose-release.sh` re-registers it with one
`docker restart site` — only after two refused reads ~400 ms apart, never to "fix" a 200 naming the
wrong commit. And if OrbStack rewrites the peer address of a LAN client to its own bridge gateway,
every reader lands in one per-IP bucket: the read/comment/edit caps collapse to a single client.
That cannot be measured from the host (a host-originated request to the published port is SNAT'd by
design), and it cannot be read off the address either — the request log carries **no address**, only
`peerTrusted: true|false`: whether the socket peer matched `TRUSTED_PROXIES` (i.e. whether
`X-Forwarded-For` was believed). One boolean, no PII, and no secret — it says a bucket is real, not
who is in it. So this is a **post-flip check that can fail**:

```sh
# one request through the real public path (Caddy -> the container), then read what the site recorded
curl -fsS https://book.semirov.dev/healthz >/dev/null
docker logs book-site-1 --since 5m 2>&1 | grep -c '"peerTrusted":false'
```

`0` — the proxy's peer is trusted, `X-Forwarded-For` is believed, per-IP buckets are real: nothing to
do. `>0` — OrbStack rewrote the peer to the bridge gateway and every reader shares one bucket: add
exactly `192.168.215.1/32` to `BOOK_TRUSTED_PROXIES` (never a /24, which would let every LAN machine
forge its own address), redeploy, and run the same two commands again — it must read `0`.

**Rehearsal (before any flip, prod untouched).** The same file, a spare port, a *copy* of the data dir
and a *copy* of the manuscript:

```sh
R=$HOME/.local/state/book-172-rehearsal; mkdir -p "$R/data" "$R/secrets" "$R/locks"
BACKUP_ROOT=$R/backups site/deploy/backup.sh                      # consistent snapshot (WAL)
cp -a "$R/backups/daily/$(ls "$R/backups/daily" | tail -1)/." "$R/data/"
cp -p "$HOME/book-site-data/engine.token" "$HOME/book-site-data/admin.token" "$R/data/"   # 0600
cp -p site/secrets/session_secret site/secrets/ip_salt "$R/secrets/"; chmod 0700 "$R/secrets"
rsync -a --exclude .git "$HOME/projects/book/" "$R/book/"         # a copy: the writer writes here

export BOOK_SITE_PUBLISH=192.168.1.76:8092 BOOK_DATA_DIR="$R/data" BOOK_MANUSCRIPT="$R/book" \
       BOOK_SECRETS_DIR="$R/secrets" BOOK_LOCKS_DIR="$R/locks" BOOK_PROJECT=book-rehearsal \
       BOOK_STATE_DIR="$R/state" BOOK_IMAGE_REPO=book-rehearsal
# BOOK_STATE_DIR and BOOK_IMAGE_REPO are not optional: with the prod state dir a rehearsal writes
# phantom last-good-image/audit lines into it, and with the default image repo it rebuilds `book:<sha>`
# — the very tag the next prod deploy builds from.
# The locks dir must be rehearsal-private: pointed at the prod one, the running prod containers hold
# the flock and every rehearsal service exits 75.
# --root must be a git clone at the ref the image is built from; BOOK_COMPOSE_FILE may instead pin
# the working tree under test (then the build context is that tree, not the clone).
site/deploy/compose-release.sh --ref <sha> --root <a clone checked out at that ref>
site/deploy/compose-release.sh --rollback                          # previous image, no rebuild
docker compose --env-file /dev/null -f site/docker-compose.yml -p book-rehearsal down   # teardown
```

## Configuration

Every variable is parsed with a default at boot (`server/src/config.ts`); a bad value fails the start
rather than the first request. `BOOK_ROOT` (default: the repository root), `DATA_DIR` (`site/.data`),
`WEB_DIST`, `PORT`/`HOST`, `LOG_LEVEL`, `BOOK_TZ`, `WATCH_POLL_MS`, `EMPTY_WRITE_GRACE_MS`,
`MAX_WS`/`WS_PER_IP`, `TRUSTED_PROXIES`, `READ_PER_MINUTE`, `COMMENTS_PER_HOUR_IP`,
`COMMENTS_PER_HOUR_IDENTITY`, `EDIT_SUBMISSIONS_PER_DAY`, `QUEUE_SOFT_CAP`, `BUDGET_*`, `DONATE_URL`
(the public gift link of the footer row — `https://t.tb.ru/…` only, empty means no row); `.env.example`
lists them with their defaults. `GET /privacy` and `/rules` state what the site runs, what it stores
and what the write gate is (BOOK-64: an authenticated identity plus the rate limits).
