# book.semirov.dev — the site

The book is written in public, on one page, from an empty manuscript. This package is
**M0–M7** of `ARCHITECTURE.md` revision 4 (§20): the API, the projection of the manuscript
into SQLite **schema v6**, a polling watcher with live WebSocket deltas, the mobile-first
page with a cover, page 2, a live TOC, 67 slots and the «Авторы» end matter, the printing
reveal, the integrity validator and its panel — and **`book-engine`**, the second process
that owns the FIFO lane, the leases, the three-role gate cycle, the seam-driven cascade
(ripple) and its budgets (§6A, §6B).

The requirements live in [`SPEC.md`](./SPEC.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md);
the look lives in [`design/DESIGN.md`](./design/DESIGN.md) and `design/prototype.html`.
Read those, not this file, for the *why*.

## Layout

```
site/
  server/   Fastify 5 + better-sqlite3: REST, projection, state derivation
    engine/ book-engine: lane, leases, gates, cascade, budgets, internal API :8081
  shared/   the book model (book.ts, change.ts) and the validator (F001–F009, F019–F022)
  web/      React + Vite SPA: one page, mobile-first, self-hosted PT fonts
  bin/      validate.mjs — the integrity gate; engine.mjs — the session protocol;
            restore.mjs — the operator's rollback; git-hooks/pre-commit — the commit gate
  config/   imprint.json (F020), legal.denylist.json (F005)
  scripts/  arch.mjs (the architecture gate), dev.mjs (run both processes)
```

The manuscript (`../manuscript`, or `BOOK_ROOT`) is **read-only** to everything in this
directory: the `.md` files are the only source of truth for text, and the database is a
projection plus the (future) home of comments.

## Run

```sh
npm install

npm run dev          # API on :8080, SPA on :5173 with a proxy
npm run build        # shared → server/dist, web/dist
npm start            # the site serves web/dist and the API on :8080
npm run engine       # book-engine: internal API on 127.0.0.1:8081, no public port
npm run engine:cli -- next --for fwd     # what a writer session runs (see below)

npm test             # unit and integration tests (Vitest)
npm run test:coverage
npm run typecheck
npm run arch         # file-size limit, layer boundaries, invariants
npm run validate     # F001–F009 + F019–F022; exit 1 on errors
```

`npm run build && npm start` is the production shape: one process, one port, static SPA
and JSON API.

## The manuscript format

- `manuscript/00-front.md` — line 1 the live title (≤80 chars), line 2 blank, then the
  annotation «о чём эта книга» as 1–4 blocks of 300–900 characters. It is the cover and
  page 2, one file, one lease, one `front` step.
- `manuscript/chNN.md` — line 1 the chapter title (≤80 chars, no markdown, no trailing
  colon), line 2 blank, then plain paragraphs separated by blank lines. The title line is
  not a block and is not counted in `chars`.
- `manuscript/` contains **nothing else**: the plan lives in `outline/PLAN.md`, and a
  stray `.md` is F002. An empty slot is the *absence* of a file — never a zero-byte file.

At launch `manuscript/` holds only `00-front.md` and `.gitkeep`: the site renders the
cover, page 2 and 67 empty slots, and `/api/state` reports `written: []`.

## What M3 is — the engine and its gates

Two processes, one SQLite file (WAL), one image (§4.2). `book-site` serves readers and
writes the text projection; `book-engine` owns the queue and every process fact. The engine
**never writes prose and never calls a model** (ADR-012; the arch gate enforces both): it
decides what is complete, what is in bounds, and which chapter may be written now.

- **The lane** (§6A.3): one change at a time, strictly by `seq`; claiming is a conditional
  `UPDATE` on the single `lane` row, so a second process gets nothing. Admission is capped
  by `QUEUE_SOFT_CAP` (503 `QUEUE_FULL`); a change is never reordered.
- **Leases** (§6A.11): time-bounded (`LEASE_TTL_MS` 120 s), chapter-exclusive by a unique
  index, held across the whole gate cycle. `beat` keeps one alive; the reaper (15 s) takes a
  write that landed without a report, re-issues a job whose session vanished, and escalates
  after three interrupted attempts. A dead session can never block a chapter.
- **The gates** (§6B): every step is `writer → editor → science consultant`. The editor
  answers first (`422 GATE_ORDER`), a verdict needs a landed file (`409 NOT_LANDED`), a
  verdict must come from the session the step was dispatched to, and `done` refuses without
  **both** verdicts (`409 VERDICTS_REQUIRED`). `GAP` without a `blocker` is downgraded to
  `HOLDS`; three writer revisions are allowed, then the text is **published anyway** with
  the finding kept and an admin alert — the site never hides text.
- **The cascade** (§6A.6): a step reports the seams it broke; the ripple runs down to
  chapter 1 first, then up to 67 one wave behind, and never more than one chapter away from
  the origin per wing. `front` (title + annotation) is issued once when the ripple reaches
  the beginning; `ending` is **evaluate only** — chapter 67 is never rewritten by a ripple
  (ADR-024). Every stop is a row: `consistent`, `absorbed`, `frontier`, or
  `escalated:budget|oscillation|origin|delta|finding|ending|gate_timeout`.
- **Budgets** (§6D.2): `MAX_WAVE 3 · MAX_CHAPTERS 5 · MAX_STEPS 8 · MAX_WALL_MS 30 min ·
  MAX_TOKENS 1.5M · DAILY_TOKENS 24M · GATE_CYCLES 3 · MAX_DELTA_RATIO 0.35`, frozen into
  `cascades.budget` at open. Exhaustion escalates; it never silently continues.
- **Relevance** (§6A.7): at dequeue the engine grades the base `fresh/rebased/partial/
  unknown/void` from block hashes and the anchor; `partial`/`unknown` require the writer's
  `adapt|drop|void` with a cited reason **before** any text is touched.
- **Journal**: every fact goes to `events` (global `hseq`), `change_events`, `steps` and
  `gate_verdicts`. `engine.mjs trace <changeId|stepId>` prints the whole story.

### The session protocol

`bin/engine.mjs` talks to the engine's internal API (`http://127.0.0.1:8081`, bearer token
from `DATA_DIR/engine.token` or `ENGINE_TOKEN_FILE`); it never opens `book.db` and never
writes anywhere.

```sh
engine.mjs next --for fwd|bwd              # a writer assignment (file, pass, seams, findings)
engine.mjs next --role editor|consultant   # a gate assignment (landed step, dispatch)
engine.mjs start <leaseId> [--decision adapt|drop|void --reason … [--intent …]]
engine.mjs land <leaseId> [--rev N] [--no-write]
engine.mjs verdict <stepId> --role … --session S --verdict HOLDS|GAP --findings f.json
engine.mjs done <leaseId> --seams seams.json --note "…"   # requires both verdicts
engine.mjs seen <leaseId> --note "…"        # read, no seam — also both verdicts
engine.mjs escalate <leaseId> --because "…" # stop the lane, keep the evidence
engine.mjs beat <leaseId>                   # keep a long step alive
engine.mjs trace <changeId|stepId>          # the ripple, step by step
engine.mjs reconcile                        # boot check: lane, leases, stranded steps
```

M3 ships **stubbed** sessions: `server/test/engine/helpers.ts` contains a scripted
writer/editor/consultant that drives the real protocol with no model. M6 replaces the stub
with the actual sessions; the protocol does not change.

## What M5 is — identity, comments, CAPTCHA

A reader may read everything anonymously; **writing needs a Yandex ID session** (§9, ADR-021).
The site stores an opaque identity id, the Yandex subject (never rendered), a display name
and a session whose cookie value is random — only its SHA-256 is kept.

- **OAuth** (`server/src/identity/`): `GET /auth/yandex/start` mints a signed, ten-minute,
  `/auth`-scoped `state` cookie and redirects to the IdP; `GET /auth/yandex/callback`
  validates `state` in constant time, exchanges the code **server-side**, reads only the
  subject and a label, mints our own session cookie and redirects to `/`. `POST /auth/logout`
  revokes the row. Without credentials the site is readable and sign-in answers
  `503 OAUTH_UNCONFIGURED` — it never opens an unprotected write path.
- **Comments** (`server/src/comments/`): `POST /api/comments` runs
  identity → queue soft cap → CAPTCHA → sanitize → dedupe → anchor → guard → rate slots →
  store → `comment:added`. The body is NFKC-normalized, controls/invisibles dropped, HTML
  and fences stripped, angle brackets mapped to `‹ ›`, capped at 1200 characters; the stored
  form is the only form. A reader's `proposedText` is data and is never applied verbatim.
- **CAPTCHA** (`server/src/captcha/`): Turnstile by default, hCaptcha as a switch, verified
  server-side (`siteverify`) with a 3 s timeout, **fail-closed**: a refused token is
  `403 CAPTCHA_FAILED` and consumes **no** rate slot; an unreachable verifier is
  `503 CAPTCHA_UNAVAILABLE` and the composer closes. Nothing from the challenge is stored.
- **CSP is app-owned** (`server/src/http/csp.ts`): computed at boot from
  `CAPTCHA_PROVIDER` and `METRIKA_ID`, sent on every response, never `unsafe-inline`. The
  theme bootstrap is a same-origin file (`web/public/theme.js`) because of that rule.
- **Rate limits** (`server/src/rate/`): exact sliding windows in SQLite, keyed by IP (`/64`)
  **and** identity for comments (10/h each) and by identity for reader edits (1/24 h), plus
  a 60/min and 400/h site cap. The read API (`/api/history/*`, `/api/state`, `/api/changes`)
  takes its own per-network `READ_PER_MINUTE` budget in one `onRequest` hook
  (`server/src/http/readLimit.ts`). A proposed edit and a comment accepted by triage share
  one edit budget.
- **What a comment publishes**: `status` and the public `reason`, never the guard's category
  or its flags — a rendered taxonomy lets a stranger map the detector. `/healthz` is
  liveness only; the counts and the lane's holder are behind the admin token
  (`/api/admin/health`). The authors list and `/api/history/contributors` publish
  `sha256(identityId)` truncated, never the identity key.
- **Triage is a file exchange** (`bin/feedback.mjs`, `server/src/feedback/`):
  `inbox` writes an immutable batch (`data/feedback/batches/<id>.jsonl`, JSON values only),
  `read` marks it delivered, `decide … accepted --intent "…" --rev chNN@R` validates the
  intent (one goal, own chapter only, no meta-vocabulary; chapter 67 is `ENDING_FROZEN`) and
  creates a `pending` change, `decide … rejected --reason "…"` records the public reason.
  The site tails `decisions.jsonl` and emits `comment:decision`, `change:queued` and
  `feedback:batch`, idempotently.

The full acceptance path is in `server/test/commentsApi.test.ts`, `auth.test.ts` and
`feedback.test.ts`: anonymous 401, a broken CAPTCHA with no slot consumed, the 11th comment
429 with `resetAt`, the second edit `EDIT_DAILY_LIMIT`, an injection fixture quarantined,
XSS fixtures stored as text, and a comment becoming a change only with a valid intent.
**Credentials are not in the repository**: the owner supplies `YANDEX_CLIENT_ID`,
`YANDEX_CLIENT_SECRET`, `CAPTCHA_SITE_KEY`, `CAPTCHA_SECRET` (and optionally `METRIKA_ID`);
tests use stubs.

## What M6b is — history and time travel (§6F, §11.10)

The history is a product, not an audit trail: the book tells how it was written, and every
public view is a projection of one append-only log.

- **The log** (`server/src/history/log.ts`): every fact appends a row to `events` with a
  global monotonic `hseq`; the triggers refuse `UPDATE`/`DELETE`, so a correction is a new
  event. `hseq` orders, `at` only labels (§6F.1 rule 2).
- **One choke point** (`ingest/applyChapter.ts`, `ingest/applyFront.ts`): the watcher, the
  boot scan and the engine's `land` all publish a revision through the same function, so a
  revision, its `hseq`, its cause (`draft` · `change` · `cascade` · unattributed), its actor
  (the reader whose change holds the lease → writer → «правка вне процесса») and its
  paragraph chain are written in one transaction. The ingest is idempotent by sha, so a
  re-land or a watcher catch-up never duplicates a revision.
- **The paragraph chain** (`history/blocks.ts`, `history/similarity.ts`): a stable
  `block_uid` (ULID) survives a rewrite; `block_versions` keeps `(uid, ver, text_hash,
  step_id, actor, op, prev_ver)`; a paragraph rewritten at ≥ 0.6 similarity continues its
  identity, a disappeared one is `erased` and gets an `overwrites` row («переписано в 14:20
  правкой 7 · было: правка 3 (Аня)»), with no invented heir when the slot is empty.
- **Impact and erosion** (`history/impact.ts`, `history/erosion.ts`): `change_impact` is
  materialized at close and rebuildable (`rebuildImpacts`); the nightly job appends one
  immutable `contribution_history` point per identity per day and refreshes `contributions`.
- **The API** (§6F.2): `GET /api/history/timeline` (cursor, filters), `/at/:hseq` (the whole
  book's metadata at a moment; `hseq` or ISO, `now` at the right edge), `/chapters/:n?at=`
  (the then-text, `ETag: ch09@h1043`, 404 when the chapter did not exist), `/diff`
  (added/replaced/removed blocks, ≤ 500), `/paragraphs/:blockId` (the chain, by content id or
  uid), `/impact/:changeId`, `/contributors`, `/status`. `GET /api/history/at/:hseq` uses 67
  indexed lookups and no bodies; bodies come per visible chapter from `data/versions/`.
- **The chronicle** (`web/src/components/Chronicle.tsx`): «книга · хроника» in the same
  page; a day-grouped timeline of one-line summaries, four filters (правки · черновики ·
  первая страница · перезаписи), a scrubber with one tick per event, and the past rendered
  read-only (cover, page 2, the TOC of that moment with «ещё не написана», chapters behind a
  tap). «⋯ откуда эта фраза» on any paragraph — in the past *and* in the live book — opens
  its lineage chain.
- **`history:event`** (`engineState/bridge.ts`): one frame per log entry, with the summary
  and no body; the chronicle ticks live without reloading.

Checks: `server/test/history/*` (`T-history`, `T-time`, `T-impact`), `server/test/engine/
history.test.ts` (a scripted run's every revision is in the log with its cause) and
`web/src/lib/history.test.ts` + `web/src/components/chronicle.test.tsx`.

## What M6c is — the focus view «прицел» (§11.9)

The focus view is a **mode of the same page**, not a second page: the hash
`#правка-<changeId>` selects one change, the page goes dark and one sheet stays lit.

- **Entry.** The comment thread's link, the change card, a chronicle row and the cascade
  band all point at the same hash; from a thread it is one tap.
- **The lit sheet** (`web/src/components/FocusView.tsx`) prints **only the blocks the change
  moved**, at 16 cps: the live `chapter:revision` patch names them while a step lands; for a
  finished change they are read from the change's log span (`/api/history/diff` filtered by
  `changeId` + `/api/history/chapters/:n?at=toHseq`) and offered again as «ещё раз». A
  rewrite never re-types the old text (§11.5, ADR-006).
- **Following.** `cascade:progress` moves the ring and switches the sheet to the chapter
  being rewritten (8 → 7 → 9). The reader's first scroll stops following; «следовать»
  resumes it. The ring field is a local window around the ripple, not a percentage of the
  book.
- **The panel** shows the basis (the reader's quote), the intent as data, the stage
  (очередь · основа изменилась · правка · вниз · вверх · готово), the wings («вниз: глава 7 ·
  вверх: глава 9»), the iteration footnote, the touched chapters and the actual
  tokens/cost/model from `change_impact`. A gate verdict, a finding and a role name have no
  field in the public DTO, so the panel cannot render one (§6B.6).
- **Degenerate cases.** A dropped change shows its public reason and types nothing; a stale
  one shows its relevance grade and evidence; an unknown id says «правка не найдена»; the
  change may be overwritten («правка перекрыта более поздней»). `Esc`, «выйти» and a tap on
  the dimmed area return to the exact scroll offset the reader had.

Checks: `web/src/lib/focus.test.ts` (hash, stage, wings, sheet choice, patch/diff block
selection, cost and degenerate copy) and `web/src/components/focusView.test.tsx` (the panel,
the ring moving 7 → 9, the dropped change without typing, no gate word in the markup).

## What M7 is — integrity and the book matter (§13, §6C.5)

Four things make the site safe to leave running, and none of them is a UI feature.

- **The commit gate** (`bin/git-hooks/pre-commit` → `bin/validate.mjs --staged`): reads the
  **index**, runs F001–F009 + F019–F022 over exactly what is being committed and adds
  **F010** — one book file per commit, unless the subject starts with `sweep:`. Install once
  per clone:

  ```sh
  git config core.hooksPath site/bin/git-hooks
  chmod +x site/bin/git-hooks/pre-commit
  ```

  A human can still `--no-verify`; CI runs the same gate without that door (§13.4).
- **The legal gate with teeth** (`config/legal.denylist.json`, F005): real persons and
  protected characters are errors, organisations are warnings, illegal-content patterns are
  errors. The list is curated by hand and reviewed at M9; it is never generated from the
  book, because a gate that agrees with the writer is not a gate.
- **The authors list** (`/api/authors`, `server/src/authors/contributions.ts`, §6C.5): shares
  are the characters whose *last* cause is a reader's change, floored to six decimals, and
  **the author is the remainder** (`1 − Σ shares`), so the book never reads as co-authored in
  law and a printed column cannot sum above 1. The same database gives the same list.
  An opt-out (`identities.hide_from_authors`) removes the reader from the list, not from the
  measurement.
- **The integrity panel** (`GET /api/admin/integrity`, token-guarded): cast and dossiers
  state, chapter count and thin chapters, the denylist (version, counts, problems), the
  validator's findings, the revisions with no lease (F015), the **ungated** restores and the
  reconcile marks. No token configured → 404; wrong token → 401; the comparison is
  constant-time. There is no admin *write* endpoint (§13.1).
- **F025, the ending freeze** (`server/src/engine/freeze.ts`): no revision of chapter 67 may
  have `cause_kind='cascade'`; the engine refuses to close a step on top of one, and a
  ripple evaluates the ending instead of rewriting it.

### Rollback and reconcile (the operator runbook, §13.3)

A restore is a human overriding the process: it does not queue and does not cascade.

```sh
# 1. see the revisions of a chapter — rev, time, kind, and whether a lease owned the write
node site/bin/restore.mjs --chapter 9 --list

# 2. put a snapshot back (dry run first if you like)
node site/bin/restore.mjs --chapter 9 --rev 3 --dry-run
node site/bin/restore.mjs --chapter 9 --rev 3

#    the watcher then publishes: attributed:false · kind:restore · ungated
#    (a boot rescan classifies it the same way, because the detection is by content:
#     the text is byte-identical to a stored revision)

# 3. run the gates and record your reason — the chapter stops being ungated
node site/bin/engine.mjs reconcile 9 --because "restore rev 3"

#    without a chapter, `engine.mjs reconcile` is still the maintenance pass over leaked
#    leases — the two meanings are kept apart by the argument, not by a second command
```

A failed gate after a restore is recorded as `passed:false` and shown in the panel; the
mark is an observation, not a permission. The next step that touches the chapter replaces
the restore as its latest revision, and `ungated` clears by itself.

## What M2 is

- **Watcher** (`server/src/ingest/watcher.ts`): chokidar in polling mode on `manuscript/`
  (§6.2), per-path serialisation, a coalescing window, `00-front.md` included, `archive/`
  and temporaries ignored. A write raises the chapter's `rev`, re-parses its title line and
  broadcasts `chapter:created` / `chapter:revision`; a first-sheet write broadcasts
  `front:updated`. A removal updates the projection; a missing directory is reported as a
  fault, never as an empty book. An empty write is held for 5 s and then the previous
  revision is kept (it can never blank a chapter).
- **WebSocket hub** (`server/src/ws/hub.ts`, `/ws`): `hello` snapshot on join,
  `state:updated`, `state:snapshot`, `chapter:created`, `chapter:revision`,
  `front:updated`, `cursor:moved`, `block:revising`, `presence`, `pong`, `error`;
  per-connection `seq`; 100 connections hard, 4 per IP soft, `1013 CAPACITY`;
  4 KB inbound frames, 5 frames/min, 30 s heartbeat, backpressure healed by a snapshot.
- **SPA**: cover + page 2 + live TOC (four parts, 67 entries from title lines) + 67 slots
  (empty ones are slim, designed fields) + `0/67` beginning screen; lazy chapter fetch at
  1.5 viewports; printing reveal at 18 cps with grapheme-safe reveal, viewport/tail rules
  and «показать сразу»; spine with two fronts, seam, two carets and the cascade ribbon;
  revision patches applied by `rev`; reconnect with 0.5–15 s backoff and a one-click retry
  on `1013`.
- `GET /api/state` now carries the first sheet and the 67-entry TOC; `/healthz` reports
  the watcher (`lastTickAt`, `lastEventAt`, `missing`).

`cursor:moved` and `block:revising` are accepted and rendered, but M2 has no leases, so it
does not invent them: they are emitted by the engine in M3. The draft carets are therefore
static at the last written chapter of each lane (the files' truth), and blink only when a
lease exists.

## The API and the projection (M0–M2)

- `GET /api/state` — `StateSnapshot`, ETag `"state-<version>"`, version bumps only when the
  derived state changes; carries the first sheet and the 67-entry TOC.
- `GET /api/front` — live title + annotation + TOC + imprint (author, copyright).
- `GET /api/chapters` — all 67 slots with `part`, `title`, `written`; unwritten ones carry
  `rev: 0`.
- `GET /api/chapters/:n` — the title line and blocks with content-derived ids; **404 for an
  unwritten slot is the normal answer**, not an error. A chapter without a title line
  still publishes (F022 is a commit gate, not a reader gate).
- `GET /healthz` — liveness, the last scan, `front.present`, an honest `engine: unknown`.
- SQLite **schema v5** (`PRAGMA user_version = 5`): chapters, blocks, revisions (each with
  its `hseq`), front
  matter, the engine tables (changes, cascades, steps, gate verdicts, leases, lane), identity
  and sessions, and the history tables (events with append-only triggers, front revisions,
  block lineage, overwrites, change impact, contribution history). `obligations` is gone.
- `bin/validate.mjs` — F001, F002, F005–F007, F009 and F019–F022: file naming, stray files,
  the legal denylist (F005), 67 chapters, chapter length (F007: >30 000
  is an error, <20 000 a `thin chapter` warning), markdown, the dossiers record (F019,
  warning), the exact imprint (F020), the front matter (F021) and the chapter title line
  (F022). `--json`, `--rule=`, `--strict`, `--denylist=`, `--imprint=`.

## Configuration

Every variable in `ARCHITECTURE.md` §21.2 is parsed with a default at boot (`server/src/config.ts`).
The ones that matter in M2:

| Variable | Default | Purpose |
|---|---|---|
| `BOOK_ROOT` | the repository root | read-only manuscript root |
| `DATA_DIR` | `site/.data` | SQLite, snapshots (gitignored) |
| `WEB_DIST` | `site/web/dist` | build served by the API |
| `IMPRINT_PATH` | `site/config/imprint.json` | read-only imprint (F020) |
| `DENYLIST_PATH` | `site/config/legal.denylist.json` | the legal gate's source (F005) |
| `ADMIN_TOKEN_FILE` / `ADMIN_TOKEN` | `site/.data/admin.token` / — | guards `/api/admin/*`; empty = the route 404s |
| `PORT` / `HOST` | `8080` / `127.0.0.1` | listen address |
| `LOG_LEVEL` | `info` | pino |
| `BOOK_TZ` | `Europe/Moscow` | timezone of the ledger (the SPA uses it too) |
| `WATCH_POLL_MS` | `700` | chokidar polling interval (§6.2) |
| `WATCH_COALESCE_MS` | `1500` | collapses a truncate-then-write burst into one revision |
| `EMPTY_WRITE_GRACE_MS` | `5000` | how long an empty write waits for its follow-up |
| `MAX_WS` / `WS_PER_IP` | `100` / `4` | socket capacity (§10.1) |
| `WS_HEARTBEAT_MS` | `30000` | protocol ping; two missed pongs close the socket |
| `TRUSTED_PROXIES` | `127.0.0.1,::1,192.168.1.44/32` | where `X-Forwarded-For` is believed (§14) |
| `READ_PER_MINUTE` | `60` | per-network budget for `/api/history`, `/api/state`, `/api/changes` |

`COMMENTS_PER_HOUR`, `QUEUE_SOFT_CAP` and `BUDGET_*` are parsed and reserved for M3–M5.

### Secrets

Every secret is read from `<NAME>_FILE` first (`SESSION_SECRET_FILE`, `IP_SALT_FILE`,
`CAPTCHA_SECRET_FILE`, `YANDEX_CLIENT_SECRET_FILE`); a named file wins over the plain
variable in every environment, and a file that is missing, unreadable or empty is a boot
failure. In docker-compose the files arrive as `secrets:` mounts under `/run/secrets/`
(see `docker-compose.yml`), never as environment values: a value in the environment is
readable with `docker inspect` and from `/proc/1/environ`.

```sh
mkdir -p secrets && chmod 700 secrets
openssl rand -hex 32 > secrets/session_secret
openssl rand -hex 32 > secrets/ip_salt
printf '%s' "$CAPTCHA_SECRET" > secrets/captcha_secret        # from the provider dashboard
printf '%s' "$YANDEX_CLIENT_SECRET" > secrets/yandex_client_secret
chmod 600 secrets/*
```

The container runs as `node` (uid 1000) with a read-only root filesystem, so a **fresh**
`book-data` volume inherits that ownership from the image. An existing root-owned volume
needs one fix-up:

```sh
docker run --rm -v book_book-data:/data alpine chown 1000:1000 /data
```

A CAPTCHA sitekey or secret that is one of the vendor's **published test keys**
(`1x00000000000000000000AA`, `1x0000000000000000000000000000000AA`, hCaptcha's
`10000000-ffff-ffff-ffff-000000000001`, …) is refused at boot: it accepts any token, so the
challenge would be decorative.

`/privacy` and `/rules` are static documents (a client route in `web/src/lib/route.ts`, the
shell served by an explicit server route): they name the CAPTCHA and the Metrika counter,
what each can see, and how to read the book without either.

Deferred to M8–M9: the paragraph footnote «правка N» as a fourth entry point and the
before/after chronicle links of a finished change, the closure length gate F026, the load
test and the restore drill, and the owner's review of the denylist (M9). Until then the page
says only what the files prove: no invented progress, no "online", no writing lease it does
not have.
