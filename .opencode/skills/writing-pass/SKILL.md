---
name: writing-pass
description: "One pass = one engine step: claim the assignment, write under the lease, land, both gates, close with seams and the token line, then prove the step closed. Triggers: writing pass, write chNN, next chapter, continue the book, land/done/verdict, an escalated step, BOOK-5."
---

# Writing pass

One pass is one **step** of the engine — never "write the book this session". The engine owns order,
bounds and provenance; the prose is yours: stay inside its lease, close with proof or escalate. From
`site/`: `ENGINE_URL` defaults to `http://127.0.0.1:8081`, the token comes from `DATA_DIR/engine.token`
(`ENGINE_TOKEN` / `ENGINE_TOKEN_FILE`), one session name per pass ≤64 chars.

## 1. Claim the step

```sh
node bin/engine.mjs next --for fwd      # or bwd — your lane, not "the next chapter"
```

The assignment is the unit of work: `stepId`, `leaseId`, `pass`, `chapter`, `neighbours`,
`expectation.chars`, `intent`, `interventionKind`, `premise`, `seamsIn`, `cycle`, `findings`, `relevance`,
`verdicts`, `budget`, `landed`. `null` means nothing to do — `DRAFTING` is off or the lane is closed.

## 2. Write inside the lease

`manuscript/chNN.md`, one chapter per step, no other file. A `front` pass touches the title line of
`manuscript/00-front.md` only; that annotation is basis like the frozen sentences of ch01 and ch67
(ch67 is evaluated, never rewritten). Length: `expectation.chars`, `concept/CONCEPT.md`.

If `relevance` says the base moved (`anchor: moved|gone`), answer before touching the text — that is
where a change on a moved paragraph arrives; `STALE_ANCHOR` belongs to the reader's composer, not here:

```sh
node bin/engine.mjs start <leaseId> --decision adapt|drop|void --reason "…" [--intent "…"]
node bin/engine.mjs land <leaseId>    # → {landed, revAfter, sha, changed, deltaRatio, blocksTouched}
```

`changed:false` means the file is byte-identical to what the engine already had: that pass wrote
nothing. Re-landing the same content is a no-op; landing after an edit drops the verdicts on the old text.

## 3. Two gates, in order

```sh
node bin/engine.mjs next --role editor --session gate-editor-12   # → {stepId, chapter, landedSha, indexSlice}
node bin/engine.mjs verdict <stepId> --role editor --session gate-editor-12 --verdict HOLDS \
  --findings editor.json --model deepseek/deepseek-v4-pro
node bin/engine.mjs next --role consultant --session gate-consultant-12
node bin/engine.mjs verdict <stepId> --role consultant --session gate-consultant-12 --verdict GAP \
  --findings consultant.json --model deepseek/deepseek-v4-pro
```

`findings.json` is a list of `{severity: blocker|major|minor, location, defect, fix}`: the defect is
named in `defect`, the verdict word stays `HOLDS|GAP`. A gate is always a **different session**, and the
editor answers before the consultant (`GATE_ORDER`); only the dispatched session may answer
(`GATE_NOT_DISPATCHED`), a blockerless `GAP` is recorded as `HOLDS` — findings are provenance, not a veto.
`revise` puts them into the writer's next assignment: fix what was named, `land`, re-gate; a blocker past
the cycle cap publishes the step with its finding (editor) or stops it (consultant).

## 4. Close the step

```sh
node bin/engine.mjs done <leaseId> --seams '[{"boundary":"ch13","reason":"ch12 ends where ch13 opens"}]' \
  --note "ch12 · 21.4k in / 3.1k out ≈ $0.020" --model deepseek/deepseek-v4-pro \
  --tokens-in 21400 --tokens-out 3100
```

`--model` is **required** on `verdict`, `done` and `seen`, and it must be the pipeline's model
(`site/config/pipeline.json`): the engine refuses anything else with `MODEL_REQUIRED` or
`MODEL_NOT_PIPELINE`, so «prod is Pro» is a fact on the row, not a hope. `--seams` is inline JSON
`[{boundary, reason}]` (a path still reads, for an operator session): a step claims only its own lower
edge or the one above it (`ch` / `ch+1`, `front` at ch01, `ending` at ch67); anything else is
`INVALID_SEAM`. The note is ≤200 chars and carries the **real** tokens of this pass at the memo rate
($0.0000020 per output token, `process/ROLE_PROMPTS.md` §4) — estimate from the session, never invent.
The result `{outcome: holds|rewritten|evaluated|published_with_finding|escalated}` closes the step;
then the pass appends its memo line to `process/write.log.md` (created if absent):
`PASS N — lane <Пn | Оn | финал>, wrote chNN. | est cost so far: $Y`.

## 5. Bounds

Beats are automatic and the step wall (`STEP_WALL_MS`, 45 min) is the only bound; no lease is ever
extended by hand. Operator text: `process/ROLE_PROMPTS.md` §4.

## 6. Failure shapes

| code | what it means | what a pass does |
| --- | --- | --- |
| `LEASE_RELEASED`, `LEASE_EXPIRED` | the lease died under the step | `next` again; never retry a dead lease id |
| `STEP_WALL` | the step is past its wall | `next` for a fresh assignment |
| `VERDICTS_REQUIRED` | `done` before both gates | run the missing gate — no step closes on one verdict |
| `MODEL_REQUIRED` (engine, 422) | the same call reached the engine with an empty model — an HTTP or direct caller, not the CLI | send `model` in the body; this code is what a non-CLI caller branches on |
| `--model is required` (CLI, exit 1) | `verdict`/`done`/`seen` without `--model`: the CLI refuses locally, before any round trip, so there is no engine code | add `--model deepseek/deepseek-v4-pro` |
| `MODEL_NOT_PIPELINE` (engine, 422) | the declared model is not the pinned one | the detail names the expected model; re-read `site/config/pipeline.json` — never retry with another string |
| `LEASE_HELD`, `GATE_TAKEN` | another live session holds it | drop it, `next` again |
| `NOT_LANDED` | a gate or `done` before `land` | `land` first |
| `CHAPTER_TOO_SHORT`, `CHAPTER_TOO_LONG` | outside `CHAPTER_CHARS` | fix the text, not the bound |
| `RELEVANCE_DECISION` | the base moved, nobody answered | `start --decision …` with its reason |

Exit code 2 = the engine refused (a fact: read the code); 1 = engine unreachable or token, or a local
usage error (bad flag, unknown command). A pass that cannot close:

```sh
node bin/engine.mjs escalate <leaseId> --because "…"   # ≤200 chars; Russian reaches the reader
node bin/engine.mjs trace <changeId|stepId>            # the ripple, step by step
node bin/engine.mjs reconcile                          # at boot or after a restore: lane, leases, stranded steps
```

## 7. Proof the pass closed

```sh
node bin/engine.mjs trace <stepId>
#   step 01J… · draft · closed · rewritten · chapter 12 · wave 1 · model deepseek/deepseek-v4-pro
#   gates: editor:HOLDS [deepseek/deepseek-v4-pro] · consultant:HOLDS [deepseek/deepseek-v4-pro]
node bin/validate.mjs ; echo $?        # 0
git diff --name-only                   # manuscript/ch12.md and process/write.log.md — nothing else
git diff process/write.log.md          # one appended PASS line, not a rewrite
```

The pass is all four: `trace` prints `state · closed` with both roles in `gates:`; `validate.mjs` exits 0
(F001, F002, F005–F007, F009, F020–F022, F029); `git status --short` carries that one chapter and the memo
line, nothing else (the commit is the orchestrator's); the note carries the tokens and cost. Else escalate.
