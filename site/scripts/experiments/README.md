# `scripts/experiments` — the BOOK-173 A/B/C harness

Measures, with **real API calls**, what BOOK-DOC-65 §6 and BOOK-DOC-75 ask for:

- **A** — today's full-rewrite pass (`promptA.ts` is a frozen copy of the committed builder's order);
- **B** — the point patch **plus the ripple the plan makes mandatory**, through the shipped
  `server/src/writer/patch/**` modules;
- **C** — the cache matrix: one baseline warmed once (W1), then every probe measured **against that
  prefix** (H0 same session, H1 reordered, H2 one style sentence changed, H3 the chapter placed
  inside the prefix, H4a/H4b the lane's own prefix), plus the `wide` row (one chapter, projected).

And one thing that needs no model at all: **the closure**. Each run builds a scratch ledger
(`:memory:` + `migrate`), projects the real `manuscript/` into it, runs `backfillLedger`, and asks
`buildPlan` what a filing reaches **across the whole book, with no chapter window**. That answer is
printed by `--dry` and written to `summary-dry.md`.

Nothing here writes to `manuscript/`, to the database, to the engine or to a production lane. The
only output is `site/.data/experiments/` (git-ignored): one JSON per measured thing plus
`summary.json` / `summary.md` / `summary-dry.md`.

## Run it

```
npx tsx scripts/experiments/run.ts --dry                     # zero calls: prompts, closures, checks
npx tsx scripts/experiments/run.ts smoke                     # ~$0.0002: key + stream + usage reader
npx tsx scripts/experiments/run.ts all                       # ab → gates → cache
npx tsx scripts/experiments/run.ts all --control             # …plus the seeded ripple fixture
npx tsx scripts/experiments/run.ts ab --only=ch01,ch03       # one command, two filings
npx tsx scripts/experiments/run.ts cache --force             # re-measure (a cache number is of a moment)
npx tsx scripts/experiments/selftest.ts                      # the whole harness on a fake provider, $0
```

`--dry` builds every prompt, prints its size and both hashes, prints the three filings' closures
(nodes, chapters touched, mandatory/optional, longest path, outcome, walk ms), writes the closure
table, and runs the arithmetic checks. It makes no network call.

## The three filings, and the control

`--dry` measures the closures of ch01, ch03 and ch06 — the three real filings. Two of them cannot
even **seed** (their anchor paragraph holds no extracted fact), and the third reaches 5 nodes in 4
chapters with **zero mandatory**. That is the honest state of the graph, and it is why `--control`
exists: it seeds the design's own promise/deadline fixture over the real ch05 and ch12 text
(«Обжалование — до 14.12.2065» → the deadline ch12 restates), which produces a real `ripple` with
one mandatory chapter. `cache --control` additionally seeds six synthetic nodes to force a `wide`
plan and prices it from one measured rewrite.

## Rules the harness keeps

- **One attempt per call.** No retry, no repair. A truncated, unparsed or rejected answer is a row
  with its code (`ANSWER_*`, `PATCH_*`, `PATCH_REJECTED:*`, `GATE_UNPARSED`), never a skip.
- **A hard cap of $1.95 on the peak basis** (the owner's bound is $2.00). After every call the total
  is added to `spend.json`; a call whose worst-case projection would cross the cap is not made, and
  the run writes what it has. The meter is **seeded from the artifacts**, not from `spend.json`:
  that file is last-writer-wins and two processes wrote it, so the artifacts are the source of the
  summary's `calls / $ book / $ peak` (one entry per call, several calls per artifact allowed).
- **A `wide` plan spends nothing.** The row is recorded as `wide` with its node count and the price
  the wide mode would take, computed from prompt sizes.
- **No secrets.** The key comes from `DEEPSEEK_API_KEY_FILE`, else `~/.config/book/deepseek.key`;
  it travels in an `authorization` header and never into a log line, an artifact or a message.
- **Resume by default.** A complete artifact is reused unless `--force`; it is re-run when the
  request bytes changed (`promptSha256`), because a stale row would be a table that is not true.

## What a reader must know about the numbers

- `$ book` = `(in − cached)·0.66 + cached·0.022 + out·1.98` per 1M; `$ peak` = the same on all three
  rates doubled. Rates come from `site/config/pipeline.json`.
- **closure** = `buildPlan`'s own: seeds resolved from the filing's anchor facts, a walk in both
  directions, `classify`'s predicate. `ledger: open` means the plan could not bind its seeds
  (`proven: false`) — the ledger's failure, never evidence of independence.
- **patches** = the point patch + one per mandatory chapter, capped at 3 chapters and by the
  design's 4 000-character bound.
- Gates read the whole chapter as in production, with `indexSlice: null` (engine-derived, absent);
  every landed chapter gets its own pair, named `gates-<mode>-<label>-ch<NN>-<role>.json`. The gate
  call's cap is **24 000** (production sends `WRITER_GATE_TOKENS` 32 000, because a gate reasons
  first); a call the cap cuts is `GATE_TRUNCATED` with its finish reason and token counts, and a
  cell no gate ever answered is `not measured (budget)`, never `GATE_UNPARSED`.
- A row whose mode is A and whose closure is `wide` is labelled `rewrite (not a patch)`: a rewrite
  is not a patch that failed to be local.
- `charsChanged` = Σ max(|before|,|after|) over the blocks that moved — the applier's own
  arithmetic, applied to both modes.
- `untouched hash` = sha256 over the untouched blocks' ids+hashes, pre vs post.
- A wide row measures **one** chapter; `wideProjectionUsd = perChapter × chapters`.
- A cache hit rate is `prompt_cache_hit_tokens / referencePrefixTokens`, where the reference is P0
  (for H4, the lane's own prefix): a cache is supposed to make *that* free. Every prefix carries a
  one-line **run marker** unique to the run, so a probe is never measured against a previous run's
  warm entry; the marker is identical across the seven calls, so the comparison stays about layout.
- The measured behaviour (2026-10-28): identical bytes hit 99–100 %; reordering, one appended
  sentence and an interleaved chapter each hit **0** — this prefix is all or nothing, so a dynamic
  block inside it costs the whole prefix, not its tail.
