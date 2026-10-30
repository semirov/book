# BOOK-220 — the state table

Every state the reader's page can be in, its frame (if any), its emitter, its handler, its gap.
Evidence: source in this worktree (`a424300`) + the live store's public API on `192.168.1.76:8091`
(read-only GETs; no DB file was opened — see `carets.md` §"what could not be measured").

Classes (A–F from the brief; **G added**, the evidence demanded it):

| class | meaning |
|---|---|
| **A** | state exists in the DB, **no frame is ever emitted** for that transition |
| **B** | frame is emitted (or declared), **no client handler** — the reducer ignores it |
| **C** | handler exists but is **stale by design** — poll interval / throttle (interval given) |
| **D** | **fetch-only** — a GET is the only way to learn it (interval or trigger given) |
| **E** | frame is emitted but its payload **cannot update the surface** (needs another GET, or carries less than the surface shows) |
| **F** | **ordering / dedupe / reconnect hole** — seq gap, no snapshot heal, duplicated or lost applies |
| **G** | handler exists, **no emitter** — a client path that can never run (inverse of B) |

## 1. The full frame list (protocol.ts:27–52)

`hello` · `state:snapshot` · `state:updated` · `chapter:created` · `chapter:revision` ·
`block:revising` · `cursor:moved` · `front:updated` · `authors:update` · `change:queued` ·
`change:processing` · `change:stale` · `change:decided` · `cascade:progress` · `engine:state` ·
`comment:added` · `comment:decision` · `feedback:batch` · `history:event` · `pass:stage` ·
`presence` · `error` · `pong` — **23 types** (`ServerEventType`, protocol.ts:27-52).

Emitted by the server: 19. **Never emitted by any code path**: `block:revising`, `cursor:moved`,
`presence` (3). **Emitted but never handled**: `engine:state`, `pong`, `error` (3).

## 2. The table

| # | state | emitted frame (or none) | emitter file:line | client handler file:line | gap |
|---|---|---|---|---|---|
| 1 | socket opens | `hello` | `ws/hub.ts:177-181` (payload `hub.ts:243-292`) | `App.tsx:186-204` | **F** — `hello` calls `stages.reset()` (`App.tsx:196`) and re-reads changes/comments/loaded chapters, but there is no stage backlog: a reader who connects mid-pass has an empty log until the next stage row |
| 2 | hub full / per-IP cap | none (close 1013) | `ws/hub.ts:140-147` | `lib/ws.ts:136-141` → status `capacity` | — (`CapacityPlate`, no data lost) |
| 3 | reader asks `resync` | `state:snapshot` | `ws/hub.ts:407-410` | `App.tsx:205-215` | heals state only |
| 4 | slow client skipped, then drained | `state:snapshot` | `ws/hub.ts:357-368` | `App.tsx:205` | heals state only; the frames that were skipped while `stale` are gone (`hub.ts:313-318`) |
| 5 | a `seq` gap | none (client-side) | `lib/ws.ts:171` | `App.tsx:347` → `refreshAll(true)` | **F** — refetches `/api/state`+`/api/chapters`+`/api/front` only. Not refetched: the change feed, the comment feed, the per-chapter filings, and **the stage log** (`useStages` has no GET, see `#33`) |
| 6 | ping / pong | `pong` (every 25 s) | client `App.tsx:351`; server `ws/hub.ts:402-405` | **none** (falls through `App.tsx:341`) | **B** — a `pong` is a real envelope with a `seq`; it keeps the gap detector honest but has no consumer |
| 7 | protocol error / rate limit / payload | `error` | `ws/hub.ts:397,411` | **none** | **B** — `RATE_LIMITED`, `PAYLOAD`, `INVALID` are invisible to the reader |
| 8 | presence | `presence` — **never emitted** | — | **none** | **B** + dead type |
| 9 | engine status changed (running/paused/throttled/down/absent) | `engine:state` | `engineState/bridge.ts:156-161` | **none** (`default:` at `App.tsx:341`) | **B** — the head's status line reads `state.engine` from `state:updated` instead (`lib/headStatus.ts:112`) |
| 10 | any snapshot change, reason `engine` | `state:updated` | `engineState/bridge.ts:145` | `App.tsx:216-226` (+`ribbonAfterSnapshot`) | **C** — throttled to **1 000 ms per connection**, last payload wins (`ws/hub.ts:309-345`, default `stateThrottleMs = 1_000`) |
| 11 | a file on disk changed | `state:updated` (reason `file`) | `ingest/watcher.ts:429` | `App.tsx:216` | **C** — same 1 s throttle |
| 12 | full snapshot on demand | `state:snapshot` | `ws/hub.ts:200` — `publishSnapshot()` **has no caller** (grep: 1 match, the definition) | `App.tsx:205` | **G** — a whole heal path exists and is never used; reconnects heal by `hello` instead |
| 13 | chapter created | `chapter:created` | `ingest/watcher.ts:324` | `App.tsx:227-235` | ok |
| 14 | chapter revised | `chapter:revision` | `ingest/watcher.ts:330` | `App.tsx:236-242` → `ChapterArticle.tsx:209-262` (patch, else refetch) | **E** — the frame carries a patch; a `patchTruncated` or unappliable patch needs a GET, and the prose refetch is lazy (only if the slot is within 1.5 viewports, `ChapterArticle.tsx:191-206`) |
| 15 | first sheet revised / removed | `front:updated` | `ingest/watcher.ts:382-391`, `404-413` | `App.tsx:243-250` | ok |
| 16 | byline count moved | `authors:update` | `ingest/watcher.ts:418-423` | `App.tsx:251` | ok |
| 17 | edition number / export size | **none** | — | `useFrontRevision.ts:57-71` → `GET /api/front` | **C/D** — 1 000 ms trailing debounce after any text frame |
| 18 | blocks the engine marks as revising | `block:revising` — **never emitted** | — | `App.tsx:279-283` | **G** — `revising` state is always `{}`; `ChapterProse` reads it (`ChapterProse.tsx:94`) |
| 19 | lane cursor moved (draft) | `cursor:moved` — **never emitted** | — | `App.tsx:252-278` | **G** — `state.current` comes from `state:updated` only |
| 20 | comment posted (someone else's) | `comment:added` | `comments/service.ts:350`, `comments/revise.ts:165` | `App.tsx:296-300` → `refreshComments(chapter)` | **E** — the frame is the trigger; the rows come from `GET /api/comments` |
| 21 | filing posted (own) | none (HTTP 201 body) | — | `App.tsx:399-403` (`acceptComment`) | ok — the DTO enters the feed before any GET |
| 22 | comment decided (accepted/refused/registered) | `comment:decision` | `feedback/decisions.ts:151,248,296,331`, `feedback/triageApplier.ts:140` | `App.tsx:301-309` | **C** — the triage poller runs every **1 000 ms** (`index.ts:125-145`) |
| 23 | feedback batch closed | `feedback:batch` | `feedback/decisions.ts:358` | `App.tsx:296-299` | **E** — trigger only |
| 24 | comment `new → held / quarantined / expired / hidden` | **none** | — (`comment_events` type ∈ posted/quarantined/held/released/queued/delivered/decided/rights/hidden/expired/applied, `schema.ts:245`; only *decided* is narrated) | — | **A** — the reader learns it only by refetching the thread |
| 25 | filing attempt counted (`comment_attempts`) | **none** | — | — | **A** — the "three tries left" fact is GET-only (`/api/comments`) |
| 26 | the reader's own filing trail | **none** | — | `components/TrailPage.tsx:40-56` → `GET /api/me/filings` | **D** — fetched **once on mount**; no frame updates it; `#след` while a pass runs shows a still page |
| 27 | the reader's own decisions | none (frame-triggered) | — | `useReaderFeed.ts:171-197` (`/api/me/decisions`) | **E/F** — refreshed only when a `comment:decision`/`change:decided` names **one of the viewer's own** comments (`lib/ownDecisions.ts`); a missed frame leaves the record stale until reconnect |
| 28 | change enqueued | `change:queued` | `engineState/bridge.ts:182`, `feedback/decisions.ts:265` | `App.tsx:310-317` | **E** — the payload (**queue depth + `ahead`**, `bridge.ts:212-228`) is **ignored**: the handler only calls `refreshChanges()` (`GET /api/changes?limit=6`) and bumps the history tick |
| 29 | change starts processing | `change:processing` | `engineState/bridge.ts:185-191` | `App.tsx:318-323` | ok — payload drives the ribbon (`reduceRibbon`) |
| 30 | change went stale | `change:stale` | `engineState/bridge.ts:196-202` | `App.tsx:324-326` | **E** — payload (grade, evidence, options) dropped; only `refreshChanges()` |
| 31 | change decided / escalated / cancelled | `change:decided` | `engineState/bridge.ts:205` (`decidedPayload` `231-260`) | `App.tsx:332-340` | **E** — outcome word + chapter list reach the follow notice at once; the thread row itself needs `refreshChanges()`. **F** — the follow store is in-memory (`lib/follow.ts:101`), so a missed `change:decided` leaves the follow unresolved for the life of the page |
| 32 | cascade step opened/closed, cascade opened/closed | `cascade:progress` | `engineState/bridge.ts:299,315` | `App.tsx:327-331` | **C** — coalesced to **1 000 ms per cascade** (`bridge.ts:296-319`) |
| 33 | a pass stage written (`queued/read/verdict/drafting/typing/landed/refused`) | `pass:stage` | `stages/tailer.ts:74` (row from `pass_stages`) | `App.tsx:284-288` → `lib/useStages.ts:70-78` | **F** — the tailer reads `pass_stages` every **500 ms** (`tailer.ts:24`); the client has **no snapshot heal**: `GET /api/chapters/:n/stages` (`http/routes/stages.ts:36`) **is never called by the web app** (grep: zero callers) |
| 34 | the page prints a pass | derived from `pass:stage` | — | `components/ChapterProse.tsx:89-105,130-141`, `LivePass.tsx:97-247` | **E** — `livePassOf` paints **one** block per pass (`lib/passRail.ts:54-57` picks a single span entry; `ChapterProse.tsx:96,104-105` allows one renderer). The store shows a pass that rewrote **8** blocks and painted **1** (`ch1`, pass `stp_01M63ES2…`) |
| 35 | `typing` (the site's own stage, the ink's clock) | `pass:stage` — **0 rows ever written** | `ingest/typingStage.ts:14-35`, called from `ingest/watcher.ts:323,329` | `App.tsx:284`; consumer `lib/passRail.ts:58-66` | **A** — the row is written only if the write attributes to a **live lease** (`ingest/attribution.ts:61-72,88-97`); measured: **0 `typing` rows in 253 `pass_stages` rows, 31 passes**. Consequence: `startAt` falls back to `landed.at` — the print starts when the pass *closes* |
| 36 | queue depth / position | `state:updated` + `change:queued` | see #10, #28 | `useQueuePoll.ts:16-30` → `GET /api/queue` | **C** — polled every **10 000 ms**, and **skipped entirely** when the tab is hidden or the engine is `down/absent/unknown` (`useQueuePoll.ts:18-20`) |
| 37 | `change_events` type `adapted` | **none** | — | — | **A** — `bridge.ts:181-207` handles queued / processing / stale / decided / escalated / cancelled only |
| 38 | `change_events` type `released` | **none** | — | — | **A** — same allow-list |
| 39 | a step is claimed (lease acquired), started, `landed_at` set, `closed_at` set | **none** | — | — | **A** — `leases` / `steps` columns (`schema.ts:204-220`, `tables.ts:359-371`) are never narrated. The only trace a reader's socket gets is the *next* `history:event` tick or `state:updated` |
| 40 | the history log moved | `history:event` (`{hseq, at}`) | `engineState/bridge.ts:272` | `App.tsx:289-295` → `historyTick` → `Chronicle`/`Record` refetch | **E** — the frame is deliberately a bare tick (BOOK-102); every surface needs its own GET |
| 41 | pass/pipeline census for the operator | **none** | — | — | **A** — `pass_spend`, `pass_stages.summary`, transcripts: no reader surface by design |

## 3. Counts by class

Each of the **41 rows** is counted once, in its primary class. (A row can carry a second class;
where it does, the table names it, and the secondary is listed in the note below.)

| class | count | rows |
|---|---|---|
| **A** — DB state, no frame | **7** | #24 comment held/expired, #25 attempt counter, #35 `typing`, #37 `adapted`, #38 `released`, #39 lease/step claim+start+close, #41 pass census |
| **B** — frame, no handler | **4** | #6 `pong`, #7 `error`, #8 `presence`, #9 `engine:state` |
| **C** — stale by design | **6** | #10 (1 s), #11 (1 s), #17 (1 s debounce), #22 (1 s poll), #32 (1 s coalesce), #36 (10 s poll) |
| **D** — fetch-only | **1** | #26 the trail (`/api/me/filings`, mount only) |
| **E** — payload can't update the surface | **8** | #14, #20, #23, #28, #30, #31, #34, #40 |
| **F** — ordering / dedupe / reconnect | **4** | #1 (`hello` resets the stage log), #5 (`seq` gap heals state only), #27 (own record only on a frame that names it), #33 (`pass:stage` has no heal) |
| **G** — handler, no emitter | **3** | #12 `publishSnapshot`, #18 `block:revising`, #19 `cursor:moved` |
| **clean** | **8** | #2, #3, #4, #13, #15, #16, #21, #29 |
| | **41** | |

Secondary classes not counted above: #27 also **E**; #31 also **F**; #33 also **D** (the
`/api/chapters/:n/stages` route exists and the client never calls it); #4 heals state only.

## 4. Transitions that emit **no frame at all** (class A, named)

1. `change_events.type = 'adapted'` — the intent was rewritten by relevance (`bridge.ts:181-207`).
2. `change_events.type = 'released'`.
3. lease acquired → step claimed (`leases.acquired_at`): nothing. The gap between a filing being
   queued and anything visible is the whole queue wait (measured: 0 s – 1 256 s, `chain.md`).
4. step `started` (`steps.at`) — no frame; only the writer's own `queued` stage (up to 34.7 min
   later, `chain.md`).
5. step `landed_at` / `closed_at` — no frame. A non-cascade step close narrates only as a
   `history:event` tick (if it writes a history row).
6. `pass_stages.stage = 'typing'` — the transition exists in the schema and in the writer's
   vocabulary, and **has never been taken** (0/253 rows).
7. comment `new → held / quarantined / expired / hidden` (`comment_events`), and the attempt
   counter (`comment_attempts`).

Also worth naming, from the caret section: **"a pass wrote text"** (the land itself) emits no
frame — the chapter's text is already on the page, and the only signal is `landed` N seconds
later (6.1 s – 728.3 s, `carets.md`).

## 5. HTTP-poll / fetch-only paths and their intervals

| path | interval / trigger | file:line |
|---|---|---|
| `GET /api/queue` | **10 000 ms**, skipped when hidden or engine down | `useQueuePoll.ts:16-30` |
| `GET /api/front` (edition, export size) | **1 000 ms trailing debounce** after a text frame | `useFrontRevision.ts:6-71` |
| `GET /api/comments?limit=20` + `GET /api/chapters/:n/comments` | on `comment:added` / `comment:decision` / `feedback:batch` frames, on `hello` | `useReaderFeed.ts:85-97,126-129` |
| `GET /api/changes?limit=6` | on `change:queued` / `processing` / `stale` / `decided`, on `hello` | `useReaderFeed.ts:62-68` |
| `GET /api/me/decisions` | on a frame that names one of the viewer's own comments | `useReaderFeed.ts:171-179` |
| `GET /api/me/filings` + `GET /api/authors/me` | **mount only** | `TrailPage.tsx:40-56` |
| `GET /api/chapters/:n` (prose) | when the slot is within 1.5 viewports; on an unappliable revision | `ChapterArticle.tsx:143-206` |
| `GET /api/history/timeline` | on mount and on every `history:event` tick | `App.tsx:289-295`, `Chronicle`/`Record` |
| `GET /api/chapters/:n/stages` | **never called by the web app** | `http/routes/stages.ts:36` |

State a reader can only learn **by reloading or refetching** (no frame can deliver it):
the reader's own filings (`#след`), the pass record of any pass that finished before the page
opened, a filing's attempt count, a comment held or expired at triage, the queue position of a
filing, and every stage of a pass whose `pass:stage` frames arrived while the socket was down.
