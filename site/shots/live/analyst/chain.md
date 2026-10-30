# BOOK-220 — chain timing, the real gaps

Source: the live store's public HTTP API on `192.168.1.76:8091` (commit `a424300`, schema v30),
read-only. **No DB file was opened** (no shell in this session — `docker cp` was not available);
every number below comes from rows the server itself serves: `changes` (`enqueued_at`,
`started_at`, `finished_at`), `steps` (via `/api/changes/:id`), and `pass_stages` (via
`/api/chapters/:n/stages`). Stage names, timings, counts only — no bodies, no prompts, no model
output.

Scope note: the store holds **9 changes** (seq 4–12) and **31 passes**; 12 of those passes carry
millisecond-precise stage rows across chapters 1, 3, 5, 13, 15, 20 and are the sample below.

## 1. One pass, every stage it writes (ms-precise)

`stp_01M63ES21MFEXRZZ0A8BQXTGZ5`, chapter 1, 2026-10-29 — the last pass the book ran:

| stage | at | Δ from previous |
|---|---|---|
| `queued` | 09:10:10.744 | — |
| `read` | 09:10:10.754 | +10 ms |
| `drafting` (call starts) | 09:10:10.756 | +2 ms |
| `drafting` (call returns) | 09:13:20.284 | **+189.528 s** (model) |
| `landed` | 09:13:26.374 | **+6.090 s** (gates) |
| `refused` | 09:13:26.380 | **+6 ms** |
| **total** | | **195.636 s** |

`typing` — the stage the page's printer is clocked from — is **absent**, here and everywhere
(0 rows of 253, `carets.md` §0).

## 2. The 12 sampled passes

| # | ch | pass | order (`que…ref`) | model, s | gates, s | total, s | start → end (UTC) |
|---|---|---|---|---|---|---|---|
| 1 | 3 | `ZWYVR1JZ` | que read dra dra dra dra ver ver dra dra ref | 190.6 | — | 705.2 | 10-28 00:01:03 → 00:12:48 |
| 2 | 5 | `ZZRCSANN` | que read dra dra ver dra dra ver lan ref | 249.3 | 497.0 | 746.3 | 00:49:57 → 01:02:23 |
| 3 | 3 | `0RNVBFTH` | que ver que lan ref que lan ref que lan ref | — | — | **4 660.4** | 08:41:55 → 09:59:36 |
| 4 | 5 | `0SCQ04SA` | que ver ver ver lan | — | — | 462.3 | 08:52:39 → 09:00:21 |
| 5 | 13 | `11EGVNZC` | que read dra dra ref | 183.7 | — | 370.6 | 10:38:45 → 10:44:55 |
| 6 | 13 | `122ZWM67` | que read dra dra dra dra ver ver ver lan | 336.0 | 381.3 | 717.3 | 10:49:55 → 11:01:53 |
| 7 | 15 | `13ZM4T59` | que read dra dra ref | 370.1 | — | 612.5 | 11:23:11 → 11:33:23 |
| 8 | 15 | `14VQPD68` | que read dra dra ver ver ver lan | 217.0 | 430.1 | 647.0 | 11:38:23 → 11:49:10 |
| 9 | 3 | `1C3HBTVP` | que read dra dra **que** ver ver ver lan **lan** ref | 115.8 | 191.2 | 342.8 | 13:44:59 → 13:50:42 |
| 10 | 20 | `1CD12BVD` | que read dra dra ver **que** ver ver lan lan ref | 219.3 | 137.4 | 550.8 | 13:50:10 → 13:59:21 |
| 11 | 1 | `1D6ZYX0C` | que read dra dra ver lan ref | 188.6 | **728.3** | 916.9 | 14:04:21 → 14:19:38 |
| 12 | 1 | `3ES21MFE` | que read dra dra lan ref | 189.5 | 6.1 | 195.6 | 10-29 09:10:10 → 09:13:26 |

Three structural facts fall out of the column "order":

- **Every pass that lands also refuses, except three.** 9 of the 12 end `…landed → refused`, and
  the gap is milliseconds (6 ms where the row has ms precision). A pass writes the text, then
  closes as `refused` because the close itself fails (`pass.ts:448-476` → `park`). The change's
  public outcome follows the refusal, not the landing — on the 09:10 pass the change reads
  `escalated · origin` while `rev 13` of chapter 1 exists and is served.
- **Some passes land twice and re-emit `queued`** (#3, #9, #10): a resumed step re-emits
  `queued` (`pass.ts:255-263` runs on every entry) and a revision lands again before the final one.
  Because `applyStage` keeps `stageSeq` monotonic in the store (`tables.ts:130-147`,
  `UNIQUE(pass_id, stage_seq)`, assigned by the store) the order stays readable — but a reader's
  `passes` map sees the pass go "in flight" again mid-pass (`lib/passes.ts:52-56`).
- **Pass #10 (ch20) overlaps pass #9 (ch3) by 32 s** (13:50:10 vs 13:50:42). The lane serializes
  *changes*; a premise/draft pass on another chapter is not behind the same mutex.

## 3. The gaps, as p50 / min / max (seconds)

| gap | n | min | p50 | max | what it is |
|---|---|---|---|---|---|
| filing accepted → lane claim (`enqueued_at → started_at`) | 8 | 0 | **3.5** | **1 257** | the queue wait; the 1 257 s is change seq 11 (21 min) |
| lane claim → the writer's first stage (`started_at → queued`) | 4 | 0 | **0.37** | **2 082** | the lease is taken 34.7 min before the writer touches it (seq 8) |
| model call (`drafting` start → return) | 10 | 115.8 | **203.8** | 370.1 | the only long pole with no frame of its own until it returns |
| draft returned → landed (**the gates**) | 7 | 6.1 | **381.3** | **728.3** | text is already on the page here; the print waits for this |
| landed → refused | 1 (ms) | 0.006 | 0.006 | 0.006 | same second for the other 8 |
| whole pass (`queued → last stage`) | 12 | 195.6 | **629.8** | **4 660.4** | 10.5 min typical, 77.7 min worst |

**"The gap between one landing and the next print starting"** has two answers, and both are the
point:

- *same chapter, no queue*: ch1 landed 10-28 14:19:38 → the next ch1 pass opened 10-29 09:10:10 —
  **67 832 s (18.8 h)** of a settled book. Nothing was waiting.
- *within the busy hour*: no hand-off happened, because the four changes (seq 9–12) were all
  enqueued at **13:43:25.081** and the lane ran them one at a time: seq 9 claimed 13:44:59, seq 10
  `decided` 13:56:07 (a premise, 0 steps), seq 11 claimed 14:04:21. So the serializer is the
  queue, not the previous landing: **decided → next claim = 855 s** (seq 9 → seq 11) and
  **494 s** (seq 10 → seq 11).

**"The gap between the previous pass settling and the next `typing`"** is undefined: 0 `typing`
rows. When the page has to decide "is text printing now", there is no fact to read.

## 4. The five change chains

| change | ch | enqueued | claimed | first stage | landed | decided | notes |
|---|---|---|---|---|---|---|---|
| seq 8 | 5 | 08:17:57 | 08:17:57 | 08:52:39 (+2 082 s) | 09:00:21 | 09:00:21 | resumed step: `que → ver×3 → lan` only |
| seq 9 | 3 | 13:43:25.081 | 13:44:59 (+93.9 s) | 13:44:59 (+0) | 13:50:41 | 13:50:06 | decided **36 s before** the pass's last stage |
| seq 10 | 20 | 13:43:25.081 | — (premise, no lease) | 13:50:10 | 13:59:21 | 13:56:07 | a premise that lands inside a running draft pass |
| seq 11 | 1 | 13:43:25.081 | 14:04:21 (+1 256.5 s) | 14:04:21 (+0) | 14:19:38 | 14:19:38 | gates 728.3 s |
| seq 12 | 1 | 09:08:35.091 | 09:10:10 (+94.9 s) | 09:10:10 (+0.7 s) | 09:13:26 | 09:13:26 | landed, then refused 6 ms later |

Changes seq 4, 5, 6, 7 all `decided` at **10:03:05Z on the same second** with `gate_timeout` —
one sweep closing four timed-out steps at once. Seq 5 decided 6 s after being enqueued (`origin`),
i.e. an immediate escalate with no pass at all.

## 5. Frame latency: `pass_stages` → socket

From code, not from measurement:

- the tailer polls every **500 ms** (`stages/tailer.ts:24`, `DEFAULT_INTERVAL_MS = 500`), reads all
  rows past its cursor in `seq` order and publishes one `pass:stage` per row **synchronously**
  (`tailer.ts:68-79`), so a row reaches an open socket within **(0, 500 ms]** of being written;
- the row's own `at` is the moment of the work, so a frame's payload is already `0–500 ms` stale
  and, for `landed`, `6–728 s` stale relative to the text it describes;
- the change side is slower by design: the bridge polls `change_events` every **500 ms**
  (`engineState/bridge.ts:93`) and the hub coalesces `state:updated` to **1 000 ms per
  connection** (`ws/hub.ts:116,309-345`); `cascade:progress` is coalesced to **1 000 ms per
  cascade** (`bridge.ts:96`); triage decisions are polled every **1 000 ms** (`index.ts:125-145`).

**Not measured:** actual arrival times on a socket. This session has no WebSocket client
(`execute`'s `fetch` cannot upgrade) and no shell, so the `at` vs arrival delta is stated from the
interval in code only.

## 6. What was not available, and why

- **`leases.acquired_at`, `leases.released_at`, `steps.landed_at`, `steps.closed_at`** — the
  columns the brief asks for by name. They are not in any public DTO (`/api/changes/:id` exposes
  `steps[].at` and `rev_before/rev_after` only; `engineState/changes.ts` never selects the lease
  columns), and the DB file could not be copied out (no shell → no `docker cp`). `started_at`
  from `changes` is used as the claim's proxy, and it agrees with the writer's first `queued`
  stage to within 0.7 s in 3 of the 4 cases where both exist — so the proxy is safe for the
  p50, not for the 2 082 s outlier, which is a real difference (the lease was held 34.7 min
  before the writer ran).
- **The tailer's own tick history**, `pass_spend` rows, transcripts — behind no public route or
  behind an admin route.
