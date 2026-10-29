# Writer lane — the loop the book was missing

**Status:** built in `task/real-writer-lane` (BOOK-117). Run evidence at the end of this file.
**Contract for:** the writer process (`site/server/src/writer/*`), the engine route, the stage
store, the reader's stage stream. Visual design and motion of the stages are BOOK-116's; this
file fixes only what must not be lost: the facts, their names and how they are replayed.

Today the loop is dead in the middle: a reader files an intervention, the engine records it,
**nobody writes**. `engine/gates.ts` is explicit — «the engine does not judge prose and does not
call a model» — so prose must arrive from outside, through `/engine/control`. Nothing outside
did. This lane is that outside.

## 1. One pass, in order

```
queued   the engine opened the step (a premise pass for chapter N, or the head of the FIFO lane)
read     the writer assembled the prompt: canon files, the chapter's place, neighbours, the assignment
verdict  a gate answered (editor / consultant) — after the text landed; an adequacy verdict, if run, before
drafting a model call started / returned: characters written, tokens in and out
landed   the text is a revision: span (what was replaced), tokens, money for the pass
typing   the site published the revision — the reader's page is printing it
refused  the pass was parked with a visible reason; never a silent drop
```

A stage is written **when the work happens**. A late reader gets the stages that already happened,
with their original `at` — never an animation from the start.

## 2. The stage event (the contract)

`site/shared/src/stage.ts`:

```ts
export const PASS_STAGES = ['queued','read','verdict','drafting','typing','landed','refused'] as const;
export type PassStage = (typeof PASS_STAGES)[number];

export type StageActor = { process: 'engine' | 'writer' | 'site' | 'auditor'; model: string | null };

export type StageSpan = {
  blockId: string | null;   // null: the chapter is created from an empty slot
  before: string;           // the words being replaced ('' when the block is new)
  after: string;            // the words that replace them
  truncated: boolean;       // before/after were cut at the bound; the client reads the rest from the chapter
};

export type PassStageEvent = {
  passId: string;           // the engine's step id — one pass, one id
  chapter: number;          // 1..67
  stageSeq: number;         // monotonic inside the pass, from 1
  stage: PassStage;
  at: number;               // ms epoch, when the work happened
  actor: StageActor;
  changeId: string | null;
  summary: string;          // ≤200 chars, one factual line, built from values the lane holds
  span: StageSpan[] | null; // on `landed`; null elsewhere
  tokens: { in: number; out: number } | null;  // on `landed`; null elsewhere
  costUsd: number | null;   // on `landed`: this pass, from pipeline.json rates
};
```

Rules the payload must keep:

- **facts only** — a summary is assembled from values the lane has (`12 400 знаков`,
  `9 120 → 8 400 токенов`, `редактор: HOLDS`, `глава уже написана`), never from a template of
  nice sentences about work that did not happen;
- **no reader identity** — no display name, no alias, no IP, no session; the actor is a process
  and, when a model ran, its id; the intervention is quoted as the intent the change carries;
- **appendix-free** — no prose of the chapter, no findings text: `summary` is one line, `span`
  is bounded (`STAGE_SPAN_MAX_CHARS`, 2 000 per side, then `truncated: true`).

## 3. Where it is stored, how it is read

- Table `pass_stages` (`site/server/src/db/schema.ts`, additive migration): one row per event,
  `UNIQUE (pass_id, stage_seq)`, index on `(chapter, seq)`. `seq` is the store's own order and
  the replay cursor.
- `POST /internal/stage` (engine, bearer): the only write door. The chapter is read from the
  step named by `passId`, never from the body. `stageSeq` may be omitted — the store then assigns
  `max(stage_seq) + 1` for that pass atomically (the site emits `typing` and holds no counter).
  A repeat of `(passId, stageSeq)` returns the stored row: a retried call cannot duplicate a stage.
- `GET /api/chapters/:n/stages` (public, under the read limiter): `{ stages: PassStageEvent[] }`
  in `stageSeq` order, newest pass first, `?limit` (default 50, cap 200), ETag from `MAX(seq)`.
  This is how a reconnecting or late client learns what already happened — with `at`, not a replay.
- WS frame `pass:stage`, payload = `PassStageEvent`. The site tails `pass_stages` (500 ms,
  in-process cursor seeded at boot from `MAX(seq)`) and fans out through the existing hub. A
  socket that was not connected when the stage happened reads it from the GET route.

## 4. The engine route the lane needs

`POST /internal/pass` — an operator/session opens a **first pass** for one chapter, because the
draft lanes can only offer their own next slot and the owner's premise waits in chapter 65:

```
{ chapter: 1..67, session: string }  →  WriterAssignment (the same shape /internal/next returns)
INVALID_CHAPTER (422) not a chapter in 1..67
NOT_DRAFTING (409)   drafting is off — writing is the owner's switch
CHAPTER_WRITTEN (409) the chapter has text; a written chapter changes through the FIFO lane
TOKENS_EXHAUSTED (409) the day's token budget is spent
PASS_LEASED (409)    another session holds the pass
STEP_CAP / PROCESS_CAP  the existing capacity refusals
```

It reuses `openPass()` in `engine/queue.ts` — the same function `startDraft` calls — so there is
one implementation of "open a draft step, ride its premise, take its lease".

## 5. The writer process

`npm run writer -- [--once] [--chapter N] [--dry-run] [--revert --chapter N] [--loop]`
- `--once` — one pass, then exit (exit `0` closed, `1` parked with a reason, `2` could not run).
- `--chapter N` — open the pass for that chapter (`POST /internal/pass`) instead of the lane's next.
- `--dry-run` — resolve config, prompt, assignment and validation shape; **zero** model calls,
  nothing written, no transcript.
- `--loop` — the supervised shape: one pass, then sleep; the launchd job `dev.book-writer`.
- `--ripple`, `--plan ID`, `--backfill-ledger`, `--audit-samples [N]` — **operator commands**, not
  the lane: they need the ledger and open the volume, so they live in `site/bin/ledger.mjs`
  (`backfill`, `plan <id>`, `ripple`, `audit [N]`) and the writer refuses the flag with that line.
- `--revert --chapter N [--rev R]` — publish the earlier text as a **new** revision through
  `POST /internal/restore` (`cause_kind='restore'`); the old text is read from the revision's
  snapshot row, never from a file. The revert prints the new revision and the sha it verified.
  A pre-image file does not exist: nothing the writer holds could be lost, because the text was
  never written anywhere but the database.

**The mode default is a switch, not a constant** (BOOK-173 §4). `WRITER_MODE_DEFAULT` takes
`patch` — the signed-off default: a filing on a sentence in a written chapter patches it — or
`rewrite`, the owner's kill switch, which forces the whole-chapter path for every ordinary pass
regardless of scope or anchor (a ripple chapter keeps its own mode: it is a consequence of a
patch). An unknown value is refused at boot (`CONFIG_INVALID`), and the resolved value is printed
in the config line. **Prod usage:** run with `WRITER_MODE_DEFAULT=rewrite` until the patch path is
trusted, then remove the line — the default is `patch`.

**Where the lane's own state lives.** Not in the data dir: `writer_state` (one row, the day's
counter and the pause) and `pass_transcripts` (one row per model call, redacted to section ids,
hashes and token counts — no prompt, no answer, no key, no address, no session) are tables. The
writer reaches them through the engine (`/internal/writer-state`, `/internal/transcript`), so one
process owns the database. Retention: 30 days (`TRANSCRIPT_RETENTION_DAYS`).

Model: `site/config/pipeline.json` is the single source — `provider`, `model`, `endpoint`, and
the rate `table` for every model the book may run (the same table BOOK-114's line reads).
`WRITER_MODEL` may restate the pin; a different value is refused (`MODEL_NOT_PIPELINE`), never
silently honoured. The key comes from `DEEPSEEK_API_KEY_FILE` (0600) and never appears in argv, a
log line, an error, a transcript or a commit.

## 6. Budget and bounds — money, in the engine

- one pass at a time (the lease);
- **the bound is money, not tokens**: `BOOK_BUDGET_DAY_USD` (default 10) and
  `BOOK_BUDGET_BOOK_USD` (default 1000), enforced by the engine's guard
  (`server/src/budget.ts`) before a pass is handed out — `openPass`, `claimOpenStep`,
  `claimHead`, `startDraft`. `engine/budget.ts` keeps the cascade bounds; the ledger is its own
  module.
- **the ledger** `pass_spend` (one row per closed pass: `at`, `day`, `pass_id`, `chapter`,
  `pass`, `change_id`, `model`, `tokens_in`, `tokens_out`, `usd`, `priced`) is the only source of
  totals — never a counter. `usd` is computed from the one rate table in `site/config/pipeline.json`
  (`table[model]`), the table BOOK-114's line reads; an unpriced model is counted in tokens and
  given no invented price (`priced: 0`).
- **pause** at the day cap — nothing opens, the queue is untouched, and it lifts by itself at
  00:00 UTC (the sum is keyed by the UTC date): `пауза · дневной потолок 10,00 $ · возобновится в 00:00 UTC`.
- **stop** at the book cap — nothing opens again until the owner raises it:
  `остановлено · потолок книги 1 000,00 $`.
- **80 %** of either cap is a `warn` state with one plain sentence and one alert per scope per
  day, never one per pass.
- **estimates precede spending**: the writer prices the pass it is about to run (prompt tokens +
  expected completion + the calls the contour may need) and refuses to open it when
  `spent + estimate` would cross a cap; the engine's guard is the second, independent check.
- **tokens are information**: `WRITER_DAILY_TOKENS` and the engine's daily token number are shown,
  never used as a bound. Per-chapter token ceilings stay as a runaway guard.
- `WRITER_MAX_TOKENS_PER_CALL` (32 000 in production — the model serves up to 393 216 output
  tokens and is a reasoning model, so a pass needs most of its completion tokens for prose),
  `WRITER_TIMEOUT_MS`, one transport retry, `WRITER_MAX_PASSES_PER_DAY` (default 4 — pacing) and
  `WRITER_PAUSE_MS` between supervised passes.

## 7. Install on prod (runbook)

The engine and the writer run from their own checkout, like `dev.book-engine` does; the site is
deployed by `deploy.sh` and is not touched here.

1. **A lane checkout**, so the engine the writer talks to carries `/internal/pass` and the stage
   store: `git worktree add --detach /Users/filipp/book-lane <sha>`, then `npm ci` and
   `npm run build -w @book/shared && npm run build -w @book/server` inside `/Users/filipp/book-lane/site`.
2. **One variable, no value in any file**: add `DEEPSEEK_API_KEY_FILE=/Users/filipp/.config/book/deepseek.key`
   to `site/.env` (the engine's and the writer's `--env-file`); the key itself stays in a `0600` file.
3. **The switch**: `DRAFTING=on` on `dev.book-engine` (the plist's environment wins over `.env`),
   then `launchctl kickstart -k gui/$(id -u)/dev.book-engine`.
4. **The writer**: `cp site/deploy/dev.book-writer.plist ~/Library/LaunchAgents/`,
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.book-writer.plist`.
   `launchctl list | grep dev.book-writer` shows it; `~/Library/Logs/book-writer.log` has one line
   per stage.
5. **One real pass before the loop is trusted**: `npm run writer -- --once --chapter 65`, then read
   `steps`, `changes`, `GET /api/chapters/65`, the `pass_stages` rows and the transcript.

**Rollback** (any step, in this order): `launchctl bootout gui/$(id -u)/dev.book-writer` (the text
already landed stays — it is a revision like any other, and `--revert --chapter N` publishes a
restore revision that takes it back);
`DRAFTING=off` + kickstart the engine; point the engine plist's `WorkingDirectory` back at
`/Users/filipp/projects/book/site` and kickstart. The schema only gained a table (`v14`), which an
older binary ignores.

## 8. Run evidence

Filled by the real pass.
