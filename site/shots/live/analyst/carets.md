# BOOK-220 — why the carets were never seen (measured, not guessed)

Host `192.168.1.76:8091`, commit `a424300`, store schema v30, read through the public HTTP API
only (`/healthz`, `/api/chapters`, `/api/chapters/:n/stages`, `/api/changes*`, `/api/queue`,
`/api/state`, `/api/history/*`). No DB file was opened, no page was driven.

> **Status of the four prescribed measurements.** (a) 60–100 ms DOM sampling, (b) measured px/s,
> (c) a mounted mid-pass arrival, (d) an after-pass page, and the screenshots were **not run**:
> this session has **no shell** (`shell` is denied for the whole session, so `pass-frames.mjs`,
> `docker cp book.db`, Chromium-over-CDP and `node` are out of reach), and the in-app browser
> panel is **display-only** (`drivable: false` — `browser.snapshot`/`inspect`/`capture` refuse).
> What follows is the same question answered from three exact instruments that *were* available:
> the stage store's own timestamps (millisecond precision, 253 rows), a verbatim port of
> `lib/passMotion.ts`'s clock run on the real landed span, and the source's own conditions.
> A ready-to-run probe for (a)–(d) is in `probe/carets.probe.mjs`; it was not executed here.

## 0. The store census (measured)

`pass_stages` as served by `GET /api/chapters/:n/stages` across all 42 chapters:

| stage | rows |
|---|---|
| `queued` | 43 |
| `read` | 32 |
| `drafting` | 79 |
| `verdict` | 47 |
| `landed` | 26 |
| `refused` | 26 |
| **`typing`** | **0** |
| total rows | **253** |

**31 passes, 17 chapters, and not one `typing` row in the book's whole history.**

That single number matters more than any animation measurement. `livePassOf` takes the print's
clock from the `typing` stage and only falls back to `landed` when `typing` is absent
(`lib/passRail.ts:58-66`). With `typing` never written, every print on the page is anchored to
the pass's **close**.

Why it is never written: `appendTypingStage` (`ingest/typingStage.ts:21`) returns unless the
chapter's write carries both a `changeId` **and** a `stepId`, and those come from a **live
lease** at the instant the file is read (`ingest/attribution.ts:61-72` — `Date.parse(expires_at)
<= nowMs` gives `NO_CAUSE`, `stepId: null`). A file ingested a moment after the lease was
released attributes to nobody, so the stage is skipped **silently** (it is wrapped in
`try/catch` + a log line, `typingStage.ts:32-34`). 0/253 is what that produces.

## 1. (a) When a caret exists at all

From source, the element's life is exactly this (`components/LivePass.tsx`):

| moment | `.caret-read` / `.caret-write` |
|---|---|
| before mount | absent |
| mount (only if `!reduced && !broken`, `LivePass.tsx:91`) | **present, `opacity: 0`** (`pass-live.css:69`) |
| first frame, `at < 260 ms` (replacement) | present, still 0: `frame.blue === null` until `splitMs` (`passMotion.ts:378`, `splitMs` = 260) |
| `at ∈ [260 ms, settle)` | opacity written each frame (ink-in over `CARET_INK_MS` = 120 ms, `LivePass.tsx:41,46`) |
| `at ≥ settleMs` | `finish()` → `setCarets(false)` → **removed from the tree** (`LivePass.tsx:99-106`) |
| `reducedMotion()` | **never created** — settles in the mount pass (`LivePass.tsx:157-160`) |

So a caret exists only inside `[mount, settleMs)`, and — measured for the real span — that is a
**3.2 s** (1440) / **4.4 s** (390) window.

The plan for the pass that actually landed on 2026-10-29 (`stp_01M63ES21MFEXRZZ0A8BQXTGZ5`,
chapter 1), computed by porting `planPass` verbatim and feeding it the real `span` entry
(block `ch01#4a41f831`: 237 → 261 graphemes, the diffed run = **87 graphemes**, kind
`replacement`; 4 breath pauses, 0 sentence pauses):

| | 1440×900 (`linePx` 30.24, block ≈ 4 lines) | 390×844 (`linePx` 28.56, block ≈ 7 lines) |
|---|---|---|
| cps chosen by `rateFor(87, base)` | 40 | 34 |
| `splitMs` | 260 | 260 |
| ink (87 graphemes + pauses) | 2 390 ms | 2 769 ms |
| blue caret on screen | 260 → 2 830 ms | 260 → 3 209 ms |
| red caret on screen | 260 → 3 207 ms | 260 → 4 419 ms |
| **`settleMs`** | **3 207** | **4 419** |
| blue travel | 4 lines × 30.24 = **120.96 px** in 1 000 ms | 7 × 28.56 = **199.9 px** in 1 750 ms |
| red travel | 1 line × 30.24 = **30.24 px** in 417 ms | 3 × 28.56 = **85.7 px** in 1 250 ms |

(`blockLines` is the only estimated input: 71 chars/line at 1440 and 40 at 390, from
`--measure: 640px` / `--fs-body: 18px` and the 342 px phone column in `book.css:79-99`. The ink
duration is layout-free and exact to the millisecond; `settleMs` moves by ≤ ~0.4 s if the block
is one line shorter or longer.)

## 2. (b) Do they move as designed

By construction, yes — and the arithmetic reproduces the spec exactly:

- blue: start line = `blockLines` (the block's bottom), travels `distanceLines` over
  `climbMs = distanceLines / 4.0 × 1000`, i.e. **4.00 lines/s** (`passMotion.ts:281-287`); on the
  measured block that is **121.0 px/s at 1440** and **114.2 px/s at 390** (a line is 30.24 / 28.56 px).
  Blue's `top` **decreases** from 4×30.24 = 120.96 px to 0 (`blueAt` → `line = startLine − d·eased`,
  `placeCaret` writes `translate3d(…, line*linePx)`), so it rises.
- red: starts at the line of the last revealed grapheme inside the run, then descends the
  remaining `blockLines − 1 − lastRunLine` lines at `2.4 lines/s` (`passMotion.ts:432-441`);
  **72.6 px/s at 1440**, **68.5 px/s at 390**, top **increases**.
- their `opacity` is written per frame; both start at 1 when born and fade over 180 / 140 ms.

Two geometry facts worth the architect's eye (measured off the plan, not off a screen):

1. **Blue is born one line below the last line of the paragraph.** For a replacement, `blueStartLine
   = layout.blockLines` (`passMotion.ts:282`) — the line *index* equal to the line count, i.e. the
   bottom edge, so its box sits **below** the paragraph. `.p-pass` is `position: relative` and the
   caret is `position: absolute` with no clipping (`pass-live.css:12-14,59-72`), so it *shows*, but
   it spends its first frame in the gap under the paragraph, not in the text.
2. On a 4-line block the whole blue climb is 121 px — one paragraph's height. At 4 lines/s it is
   over in **1 s**, and because `blueFadeStart = max(climb end, persist)` it then simply *rests*
   at the top until the ink ends (2 650 ms). The blue caret is a 1-second vertical wipe, then a
   stationary line for ~1.6 s.

What I could **not** confirm: whether the two `transform`+`opacity` writes land on screen as
described (no computed style, no rect, no screenshot). The `~` risk there is low — `.p-pass`
carries `position: relative`, the carets are `display: block` with no zero-size parent — but it
is unverified, not verified.

## 3. The window: why he never saw them (the answer, in numbers)

The measured pass (`ch1`, 2026-10-29), millisecond timestamps from `pass_stages`:

```
queued      09:10:10.744
read        09:10:10.754   (+10 ms)
drafting    09:10:10.756   model call starts
drafting    09:13:20.284   model returns        ← 189.528 s of nothing on the page
landed      09:13:26.374   ← +6.090 s (gates)   ← the print can start only here
refused     09:13:26.380   (+6 ms)              ← the pass is over
```

- **The pass is 195.636 s long. The pass's whole animation is 3.207 s from mount, of which the ink
  is visible for 2.947 s** (1440) — **1.64 % / 1.51 %** of the pass. At 390 it is 4.419 s / 4.159 s
  — **2.26 % / 2.13 %**. For the same hour's other pass (`ch1` 14:04:21 → 14:19:38, 916.943 s,
  gates 728.288 s) it is **0.35 % / 0.32 %**.
- **The ink starts 6.090 s after the chapter's text was already live** (`catalog.updatedAt` for
  ch1 is `09:13:20Z`, the drafting-return second). On the 14:04 pass the same offset is
  **728.288 s**: the reader's paragraph changed at ~14:07:30 and the carets appeared at 14:19:38.
- **One block of eight.** The pass rewrote **8** blocks (`span.length = 8`, +1 063 chars);
  `livePassOf` paints **one** (`passRail.ts:54-57` picks a single entry) and `ChapterProse` allows
  one renderer per chapter (`ChapterProse.tsx:96,104-105`).
- **And only if that chapter is on screen**: the prose is fetched when a slot comes within 1.5
  viewports (`ChapterArticle.tsx:191-206`); a reader on the cover, the TOC or another chapter sees
  no ink at all.

So the honest answer to "why were they never seen" is not "they are invisible". It is: **they are
~3 s of motion, once per pass, on 1 of N changed paragraphs, at the very end of a 196–917 s
silence, and they are clocked from the pass's close rather than from the write.** To see one the
reader must be idle on exactly that paragraph during a 3-second window that opens 6 s to 12 min
after the text he was reading had already changed.

**One cheap hypothesis to rule out first (not testable here):** `reducedMotion()`
(`web/src/dom.ts`, used at `LivePass.tsx:88,136,157`) removes the carets entirely for a reader
whose OS has "reduce motion" on. If the owner's Safari/macOS has it on, no measurement of speed
matters — there is nothing to see. This is a single `prefers-reduced-motion` media query and
should be checked before any redesign.

## 4. (c) A reader who opens mid-pass

What the code does — exactly, and it is not a restart:

- `LivePass` computes `elapsed = max(0, now − startAt)` **once, at mount** (`LivePass.tsx:156`),
  then advances it by `performance.now()` deltas (`tick`, `LivePass.tsx:235-239`). `startAt` is a
  fixed epoch (`typing.at`, else `landed.at`), so every frame is `frameAt(plan, elapsed + Δ)` and
  a late mount simply lands on a later frame.
- `elapsed >= plan.settleMs` → `settleNow()`: wash off, ink on, `onSettled` fires at once, the
  carets are **never created** (`LivePass.tsx:157-160`).
- `0 < elapsed < settleMs` → the first painted frame is the frame at `elapsed`; **nothing is
  replayed** (`passMotion.ts:468-472` documents the same rule).

At 30 % / 70 % / 95 % of `settleMs` the reader therefore sees, respectively, the ink roughly a
third in, most of it in, and the last few graphemes — with a blue caret already partly up the
block and a red caret mid-descent. At ≥ 100 % (any arrival later than ~3.2 s / ~4.4 s after
`landed.at`) the paragraph is plain and settled.

Which of those a **live** reader gets: always the first case. The mount is triggered by the
`landed` frame, which the tailer publishes within one 500 ms tick (`stages/tailer.ts:24,52-58`),
so `elapsed ≈ 0–0.5 s` and the whole print runs. The mid-pass and after-pass branches are
reachable only for a slow first render, a sleeping tab, or a page opened **after** the pass —
where the stage log is empty and the branch is simply "no spec, plain paragraph".

## 5. (d) A reader who opens after the pass

No carets, settled text, and **nothing on the page says a pass happened**:

- `useStages` starts empty and is fed only by `pass:stage` frames (`lib/useStages.ts:70-78`); a
  fresh page receives none, and the client never calls `GET /api/chapters/:n/stages`
  (`http/routes/stages.ts:36` — zero callers in `web/src`).
- The tailer seeds its cursor at `MAX(seq)` on boot (`tailer.ts:42`), so even a reconnect does not
  replay a pass.
- In the **record** the pass does survive: `pass_stages` rows (stage, `at`, tokens, cost), the
  change's step (`?change=`), `pass_spend`, the transcript. All of it is behind a GET the page
  does not make for stages.

## 6. What could not be measured, and why

| asked | status | why |
|---|---|---|
| 60–100 ms sampling of `.caret-read`/`.caret-write` (present, opacity, rect) | **not run** | no shell (CDP/Chromium/`node` unavailable); in-app browser not drivable |
| start/end `top` in px, measured px/s at both widths | **not run** — computed from the plan instead (121.0 / 72.6 px/s at 1440; 114.2 / 68.5 at 390) | same |
| real page mounted at 30/70/95 % of `settleMs` | **not run** — answered from the code path | same |
| screenshots at 1440 and 390 with both carets | **not produced** | same |
| a real pass watched live on `:8091` | **not observed** — no pass ran during the session (`/healthz`: `writer.passes = 1`, `lastPassAt = 09:13:26Z`, session began ~10:30Z; queue depth 0) | the writer had nothing to do; the page could not be driven anyway |
| `prefers-reduced-motion` on the owner's browser | **unknown** | not readable from here; the single cheapest hypothesis to check |

The measurement instruments exist and are good: `site/scripts/pass-frames.mjs` +
`lib/{passProbe,passBook,cdp}.mjs` already do (a)–(d) and write JPEGs. They need a shell and a
DB copy (`docker cp book-site-1:/data/book.db`); the probe in `probe/carets.probe.mjs` is the
minimal wrapper around them for this ticket.
