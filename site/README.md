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
npm run frame:check -- --url=http://127.0.0.1:8091   # «what does the site actually serve» (HTTP, no DB)
# `--data <dir>` opens a LOCAL data dir. The live store is the `book-data` volume (BOOK-183): copy it out
# with `site/deploy/backup.sh` and point `--data` at that copy — never at a host path of the volume.
npm run validate             # the image's constants only: F005 + F020 (+ F006), naming the rules it skips
node bin/validate.mjs --from-db "$DATA_DIR" --strict   # the text as stored: the deploy's gate
node bin/validate.mjs --staged   # what the git hook runs: no `manuscript/` path may be staged
node bin/home-check.mjs --data-dir "$DATA_DIR"         # the volume holds the book and nothing else
```

Install the commit gate once per clone: `git config core.hooksPath site/bin/git-hooks && chmod +x site/bin/git-hooks/pre-commit`.

Environments: dev, test, prod — what may touch what — https://wiki.semirov.dev/BOOK/pages/457

The three data dirs, and the wall between them: **dev** is `site/.data` (API `:8080`, SPA `:5173`,
`scripts/dev.mjs`); **test** is a fresh `mkdtemp` per test file, forced by `test/setup.ts` (which also
drops an ambient `NODE_ENV`/`PRODUCTION_DATA_DIR`); **prod** is the `book-data` volume mounted at
`/data` in the containers on `:8091` with `NODE_ENV=production` (the host path `$HOME/book-site-data` is
only the launchd fallback's, and only while a flip back is in progress — BOOK-183). The boot refuses a
non-production run against a production data dir and a production run with `DATA_DIR` inside the
checkout; `bin/feedback.mjs` and `bin/restore.mjs` use the same guard before they open `book.db`, and
under `runtime=compose` they are run through `site/deploy/admin.sh`, i.e. inside the container.

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
node bin/restore.mjs --chapter 9 --list            # the revisions of a chapter, and what a restore would publish
node bin/restore.mjs --chapter 9 --rev 3 --dry-run # preview only: a restore is a revision, then reconcile
                                                  #   (in the container: site/deploy/admin.sh restore --chapter 9 --rev 3 --dry-run)
```

These CLIs open the database, which since BOOK-183 lives in the `book-data` volume: run them through
`site/deploy/admin.sh <tool> …`, i.e. inside the `site` container — never with the host's `node` against
a host path. `site/deploy/backup.sh` is the same rule for backups (it dispatches on
`$STATE_DIR/runtime`), and `site/deploy/restore-drill.sh` proves a backup against the live store by
reading the live side **inside a container on the volume** (the drill refuses under `runtime=launchd`,
where there is no container to read it from — it will not open `book.db` from the host).

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
port). The data dir is the **named volume** `book-data` mounted at `/data` in all three services, never
a host bind (BOOK-183 — see "State is a volume" below). **No service mounts a book tree** (BOOK-187):
the canon (prompts, concept, style, the plan) is baked into the image at its root and the text is rows,
so there is no `manuscript/` to mount — read-only or writable — in any of the three.
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
sign-in answers `503 OAUTH_UNCONFIGURED`. A text rollback is a **revision**, not a file: it goes through
`POST /internal/restore` (`npm run writer -- --revert --chapter N` from the host), then
`bin/engine.mjs reconcile` marks it; `bin/restore.mjs` only lists and previews
(BOOK-187 — the book's text lives in the database). The paragraphs below are about code.

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

**State is a volume (BOOK-183).** SQLite in WAL mode shares its `-shm` through the OS, and a macOS
host bind mount into the OrbStack VM is two kernels: on 2026-10-28 a host `sqlite3` write while `site`
held the same file left `/api/state`, `/api/front` and `/api/authors` answering 500
`SQLITE_IOERR_SHORT_READ` until the container was restarted. So `/data` is a named volume
(`${BOOK_DATA_VOLUME:-book-data}`), measured inside the VM as `btrfs /dev/vdb1`, root
`/docker/volumes/<name>/_data`; `stat -f -c %T` says `btrfs`, where the old bind said `fuseblk` and
mountinfo said `virtiofs mac`.

* **The guard.** `deploy/entrypoint.sh` reads `$DATA_DIR` (default `/data`) out of
  `${BOOK_MOUNTINFO_FILE:-/proc/self/mountinfo}`, takes the longest mountpoint prefix, and refuses to
  start a role with **exit 78** when the fstype is `virtiofs`, `fuseblk`, `fuse*`, `9p`, `nfs*`,
  `cifs`, `smb*`, or the mount root starts with `/Users/`, `/Volumes/`, `/private/`, `/host_mnt/`. The
  message names the role, `DATA_DIR`, the fstype/source/root, the reason, the volume and this runbook:
  ```
  book: refusing to start site: DATA_DIR=/data is a host bind mount (virtiofs, root /Users/filipp/book-site-data, source "mac").
  SQLite in WAL mode shares its -shm through the OS; across the macOS/OrbStack boundary that is two kernels and the file stops being coherent (BOOK-183).
  Use the named volume ${BOOK_DATA_VOLUME:-book-data}, and run stateful commands inside the container (docker compose exec site …).
  ```
  A volume and a container-local dir pass; `BOOK_ROLE` unset (a one-off `compose run/exec`) skips both
  guards. `compose-release.sh` refuses to start the stack at all when the volume is missing or has no
  `book.db` (exit 1, named reason, nothing built/started/rolled back), and `--status` prints the volume
  name plus the `/data` fstype/source read from the running container.

* **Backups.** One command, both runtimes: `site/deploy/backup.sh` reads `$STATE_DIR/runtime` and either
  runs `docker compose exec -T site node /app/bin/backup.mjs --out /backups` (compose) or
  `deploy/backup-host.sh` (launchd). The container writes into the only host bind for state,
  `${BOOK_BACKUPS_DIR:-~/book-site-backups}` mounted at `/backups`, so copies land in
  `~/book-site-backups/daily/<YYYYmmddTHHMMSS>/` exactly as before, and `site/deploy/backup.sh --verify
  <that dir>` checks an existing copy (integrity + row counts, no writes). `dev.book-backup.plist`
  stays the nightly job and carries no `DATA_DIR`: the dispatcher decides. Exit codes pass through
  (0 ok · 1 failure · 75 another run holds the lock).

* **Admin, reset, restore.** All stateful CLIs go through `site/deploy/admin.sh`, which runs them inside
  the `site` container (and falls back to the host `node bin/<tool>.mjs` under `runtime=launchd`):
  ```sh
  site/deploy/admin.sh admin reset book             # the reset, in the container that owns the DB
  site/deploy/admin.sh admin --help
  site/deploy/admin.sh restore --chapter 9 --rev 3 --dry-run
  site/deploy/admin.sh feedback --list
  ```

* **The one-way migration** (once, with the stack stopped — the host copy is the source, the volume the
  target, and no host process touches the DB while a container holds it):
  ```sh
  site/deploy/migrate-to-volume.sh --dry-run                        # the plan, touches nothing
  site/deploy/migrate-to-volume.sh --from /Users/filipp/book-site-data --confirm
  ```
  Full mode, in this order: refuse if a running container mounts `--from`; refuse if the volume already
  holds `book.db` unless `--force`, which refuses the **serving** volume by name, needs `--confirm` as
  well (a bare `--seed-only --force` does not pass the gate either), and compares the whole counts line
  before overwriting — **any** difference is a refusal, because counting cannot tell extra rows from a
  partial seed: a partial copy is a fresh volume, so remove it and re-run without `--force`; stop the project (volumes kept; `STOPPED` is set only after a
  successful `down`, a failed one says "stack state is UNKNOWN — check `compose -p <p> ps`"); one-shot
  `cp -a` into the volume (+ `chown -R 501:20`, the destination's `-wal`/`-shm`/`-journal` deleted before
  the copy); verify `PRAGMA integrity_check` **and** the row counts inside a container on the volume
  against the host DB read by the host's `sqlite3` (stack down, so that read is safe); `compose-release.sh
  --ref <ref>` behind the health gate; **record `runtime=compose` and `launchctl disable` the three jobs**
  (a refused `disable` is exit 4 with the exact commands, runtime already recorded — without this the
  wrappers keep dispatching to the host path that just moved away); compare `/api/state` with the DB;
  prove the `versions/` file count; then **move** the host dir to
  `~/book-site-backups/pre-volume-<ts>/book-site-data` — kept as a backup, never deleted. `--seed-only`
  is stop → seed → verify and returns (that is what a first `flip.sh --to compose` calls); `--dry-run`
  needs no `--confirm` and touches nothing. Exit codes: `0` seeded/verified (and, in full mode, prod
  healthy + runtime recorded + host copy moved); `1` refused or failed, with the host copy untouched;
  `2` usage; `3` lock held; `4` prod is up on the volume but a launchd job could not be disabled. An
  exit `1` names **which of three states prod is in**, because the advice differs: *nothing stopped* →
  prod is as it was; *stopped, not released* → the stack is DOWN and `flip.sh --to launchd --confirm`
  brings it back (the only case that prints a `recovery:` line); *released* → **prod is UP on volume …,
  do NOT restart the stack** — it says what answers, points at `compose-release.sh --status` and
  `/api/state`, and offers no recovery command.

* **The flip back is an export, not a second store.** `flip.sh --to launchd` first proves no launchd job
  is serving the host dir, then runs `compose down`, copies the volume into
  `/Users/filipp/book-site-data` with a one-shot container, converts the export to a self-contained
  `journal_mode=DELETE` copy and reads its row counts **on the host** (`sqlite3`) — a container-side read
  cannot tell a real bind from a shadow, measured on this box — comparing them with the volume's. Only
  then does it bootstrap launchd; a failed export or a count mismatch is exit 1 with nothing
  bootstrapped. This one-way sync keeps the fallback data-compatible, and **a non-empty volume is not
  proof of anything**: after a fallback cycle the host dir has moved on while the volume stood still, so
  the next `--to compose` compares the two sides whenever both hold a `book.db` — host counts with the
  host `sqlite3` (launchd already stopped), volume counts in a one-shot container — and a difference is
  a refusal with **both counts printed** and the fresh-volume command
  (`migrate-to-volume.sh --from <host> --volume <fresh> --confirm`), launchd restored. There is no merge;
  only equal counts reach `compose-release.sh`, and the flip seeds from the host dir only when the volume
  has no `book.db` at all. Rehearse the pair, do not mix them.

* **Measured (2026-10-28): `~/OrbStack/docker/volumes/<v>/` is writable, and still must not be opened.**
  OrbStack mirrors a volume's contents on the host at that path (the VM sees the same directory as
  `/var/lib/docker/volumes/<v>/_data`). Measured with a rehearsal volume and a container holding the
  database open in WAL:

  ```
  touch  ~/OrbStack/docker/volumes/<v>/.probe        → ok, and rm ok
  sqlite3 …/<v>/new.db 'create table t(x)'            → ok (a brand-new database can be created there)
  sqlite3 …/<v>/book.db 'select count(*) from chapters'  → Error: unable to open database file (14)
  sqlite3 'file:…/<v>/book.db?immutable=1' 'select count(*) …'  → ok, 18 chapters
  ```

  So the directory is a real, writable window onto the volume — not a boundary. A normal second open of
  the live WAL database does fail (the `-shm` belongs to the VM's kernel), and `?immutable=1` reads a
  snapshot of whatever bytes were on disk rather than a consistent live view; but a byte-level write
  through that path is physically possible. The rule is therefore the same as for a bind mount: never
  open it, and take copies with `site/deploy/backup.sh`.

* **`journal_mode=DELETE` is a legitimate *format*, not a supported runtime over a bind mount.** It
  removes the exact failure of 2026-10-28 — no `-shm`, no shared-memory mapping, the journal is a
  plain file — so the `SQLITE_IOERR_SHORT_READ` class would disappear. It does not remove the class
  below it: `fcntl` locks taken inside the container are not guaranteed to be seen by the macOS side
  over virtiofs, and neither kernel's page cache is invalidated by the other, so a writer can still be
  handed a stale page. What it costs: no readers during a write (WAL's whole point), an fsync per
  commit, and the same lock-coherence risk. Use `DELETE` where it is already used — backup copies and
  one-way exports, which must be self-contained — and do not read it as permission to mount a live
  database from the host. The volume is one kernel and keeps WAL.

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
`$STATE_DIR/deploy.lock` — nothing was built, started or rolled back. A run also exits `1` with a named
reason when the data volume is missing or holds no `book.db`: a stack on an empty volume serves 500s,
and rolling a good image back for that would be a lie. A failed rollback says what is
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
stays until the cycle closes), **seeds `${BOOK_DATA_VOLUME:-book-data}` from the host dir when it holds
no `book.db`** (`migrate-to-volume.sh --seed-only`) and refuses to start containers on an empty volume,
runs `compose-release.sh`, and only after a green gate writes
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

**Rehearsal (before any flip, prod untouched).** The same file, a spare port, its **own volume** and a
*copy* of the manuscript. The snapshot comes from the container, never from the host (a host `sqlite3`
over the live bind is the incident) — `bin/backup.mjs`, or the online backup API through
`docker exec … node -e`, then `docker cp` it out:

```sh
R=$HOME/.local/state/book-183-rehearsal; mkdir -p "$R/host-data" "$R/locks" "$R/backups"
site/deploy/backup.sh                                             # a consistent snapshot, from the container
cp -a "$HOME/book-site-backups/daily/$(ls "$HOME/book-site-backups/daily" | tail -1)/." "$R/host-data/"
# The backup copy already carries versions/ (content-addressed snapshots) — no host data dir is read.
# The two tokens live in the volume: copy them out of the container, never out of a host path.
docker compose -p book cp site:/data/engine.token "$R/host-data/engine.token" 2>/dev/null || true
docker compose -p book cp site:/data/admin.token  "$R/host-data/admin.token"  2>/dev/null || true
chmod 0600 "$R/host-data/engine.token" "$R/host-data/admin.token" 2>/dev/null || true
# No book tree is copied or mounted any more (BOOK-187): the image carries the canon, the text is
# rows in the volume, and the writer writes no file.

export BOOK_SITE_PUBLISH=127.0.0.1:18095 BOOK_DATA_VOLUME=book-183-data BOOK_BACKUPS_DIR="$R/backups" \
       BOOK_SECRETS_DIR="$HOME/projects/book/site/secrets" \
       BOOK_LOCKS_DIR="$R/locks" BOOK_PROJECT=book-183-rehearsal BOOK_STATE_DIR="$R/state" \
       BOOK_IMAGE_TAG=book-183:<sha> BOOK_HOST_DATA_DIR="$R/host-data"
# BOOK_DATA_VOLUME names a volume of the rehearsal's own: pointed at `book-data` it would seed — or
# read — prod's store, and the guard cannot tell the two stacks apart.
# BOOK_STATE_DIR must be rehearsal-private: with the prod state dir a rehearsal writes phantom
# last-good-image/audit lines into it, and `runtime` would point the wrappers at the wrong project.
# The locks dir must be rehearsal-private too: pointed at the prod one, the running prod containers
# hold the flock and every rehearsal service exits 75.
# --root must be a git clone at the ref the image is built from; BOOK_COMPOSE_FILE may instead pin
# the working tree under test (then the build context is that tree, not the clone).
site/deploy/migrate-to-volume.sh --from "$R/host-data" --volume book-183-data --seed-only
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
