# book.semirov.dev — the site

The book is written in public, on one page, from an empty manuscript. This package is the
**M0 skeleton** of `ARCHITECTURE.md` §20: the API, the projection of the manuscript into
SQLite, the mobile-first page, and the integrity validator.

The requirements live in [`SPEC.md`](./SPEC.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md);
the look lives in [`design/DESIGN.md`](./design/DESIGN.md) and `design/prototype.html`.
Read those, not this file, for the *why*.

## Layout

```
site/
  server/   Fastify 5 + better-sqlite3: REST, projection, state derivation
  shared/   chapter arithmetic, wire types, the validator rules (F001–F009)
  web/      React + Vite SPA: one page, mobile-first, self-hosted PT fonts
  bin/      validate.mjs — the integrity gate (read-only)
  config/   cast.allowlist.json (F005)
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

npm test             # unit and integration tests (Vitest)
npm run test:coverage
npm run typecheck
npm run arch         # file-size limit, layer boundaries, invariants
npm run validate     # F001–F009 over the manuscript; exit 1 on errors
```

`npm run build && npm start` is the production shape: one process, one port, static SPA
and JSON API.

## Configuration

Every variable in `ARCHITECTURE.md` §21.2 is parsed with a default at boot (`server/src/config.ts`).
The ones that matter in M0:

| Variable | Default | Purpose |
|---|---|---|
| `BOOK_ROOT` | the repository root | read-only manuscript root |
| `DATA_DIR` | `site/.data` | SQLite, snapshots (gitignored) |
| `WEB_DIST` | `site/web/dist` | build served by the API |
| `PORT` / `HOST` | `8080` / `127.0.0.1` | listen address |
| `LOG_LEVEL` | `info` | pino |
| `BOOK_TZ` | `Europe/Moscow` | timezone of the ledger (the SPA uses it too) |

`MAX_WS`, `COMMENTS_PER_HOUR`, `QUEUE_SOFT_CAP`, `BUDGET_*`, `LEASE_TTL_MS`,
`WATCH_POLL_MS` are parsed and reserved for M3–M5.

## What M0 is

- `GET /api/state` — `StateSnapshot`, ETag `"state-<version>"`, version bumps only when the
  derived state changes.
- `GET /api/chapters` — all 67 slots; unwritten ones carry `rev: 0`.
- `GET /api/chapters/:n` — blocks with content-derived ids; **404 for an unwritten slot is
  the normal answer**, not an error.
- `GET /healthz` — liveness, the last scan, an honest `engine: unknown`.
- The whole schema of §8, including the engine and comment tables, so M3–M5 add code.
- `bin/validate.mjs` — F001–F009, stem-based name matching, `--allow-new-name=`,
  `--refresh-cast`, `--json`, `--rule=`.

Deferred: the watcher and the WebSocket hub (M2), the writing engine (M3), the cascade UI
(M4), comments and CAPTCHA (M5), git hooks and snapshots beyond the first copy (M7),
deployment (M1). Until then the page says only what the files prove: no invented progress,
no "online", no fake caret.
