# `scripts/experiments` — the BOOK-173 A/B/C harness

Measures, with **real API calls**, what BOOK-DOC-65 §6 asks for:

- **A** — today's full-rewrite pass (`promptA.ts` is a frozen copy of the committed builder's order);
- **B** — the surgical patch, through the shipped `server/src/writer/patch/**` modules;
- **C** — the four-variant cache matrix on the stable prefix (canon + role + protocol).

Nothing here writes to `manuscript/`, to the database, to the engine or to a production lane. The
only output is `site/.data/experiments/` (git-ignored): one JSON per measured thing plus
`summary.json` / `summary.md`.

## Run it

```
npx tsx scripts/experiments/run.ts --dry                 # zero calls: prompts, sizes, hashes, checks
npx tsx scripts/experiments/run.ts smoke                 # ~$0.0002: key + stream + usage reader
npx tsx scripts/experiments/run.ts all                   # ab → gates → cache
npx tsx scripts/experiments/run.ts ab --only=ch01,ch03   # one command, two filings
npx tsx scripts/experiments/run.ts cache --force         # re-measure (a cache number is of a moment)
npx tsx scripts/experiments/selftest.ts                  # the whole harness on a fake provider, $0
```

`--dry` builds every prompt, prints its size and both hashes, runs the arithmetic checks and
exits non-zero if one of them fails. It makes no network call.

## Rules the harness keeps

- **One attempt per call.** No retry, no repair. A truncated, unparsed or rejected answer is a
  row with its code (`ANSWER_*`, `PATCH_*`, `PATCH_REJECTED:*`, `GATE_UNPARSED`), never a skip.
- **A hard cap of $1.75 on the peak basis.** After every call the total is added to
  `spend.json`; a call whose worst-case projection would cross the cap is not made, and the run
  writes the summary of what it has. The cap spans commands: a second `run.ts` inherits the
  spend of the first.
- **No secrets.** The key comes from `DEEPSEEK_API_KEY_FILE`, else `~/.config/book/deepseek.key`;
  it travels in an `authorization` header and never into a log line, an artifact or a message.
- **Resume by default.** A complete artifact is reused unless `--force`; it is re-run when the
  request bytes changed (`promptSha256`), because a stale row would be a table that is not true.

## What a reader must know about the numbers

- `$ book` = `(in − cached)·0.66 + cached·0.022 + out·1.98` per 1M; `$ peak` = the same on all
  three rates doubled (the provider's peak window). Rates come from `site/config/pipeline.json`.
- Gates read the whole chapter as in production, with `indexSlice: null` (engine-derived, absent).
- `charsChanged` = Σ max(|before|,|after|) over the blocks that moved — the applier's own
  arithmetic, applied to both modes.
- `untouched hash` = sha256 over the untouched blocks' ids+hashes, pre vs post; the count of those
  blocks is in the artifact, because a hash of nothing equals a hash of nothing.
- A cache hit rate is `prompt_cache_hit_tokens / prompt_tokens` of the **largest prompt sent
  before this call** — the thing a cache is supposed to make free.
