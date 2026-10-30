# the theatre's evidence — BOOK-227

`npm run theatre:check` (`scripts/theatre-cdp.mjs`) drives `web/harness/theatre.html`: the real
`SentenceTheatre`, `FilingMark`, `MarginNote`, `PhoneStrip`, `MarginTail`, `HeadStatus` and the real
sheets, on block `ch01#0594465f` (349 characters, 57 words). Every act starts from a real frame
payload in the real store; `all-1440.png` / `all-390.png` are contact sheets of the captures at 1:1,
no state composed onto one sentence.

**The writing act is not here.** The print, its caret, its clock and the head belong to
`task/live-continuum` (PR #121), which owns `LivePass` / `passMotion` / the `chapter:applied` frame
and lands before this branch. The theatre will read that module at the rebase: `LivePass` mounts
inside the paragraph, and the `writing` capture joins this table there. Nothing in this branch
redefines the print — `LivePass.tsx`, `passMotion.ts`, `pass-live.css`, `HeadStatus.tsx` and
`ProseParagraph.tsx` are `origin/main`'s, byte for byte.

| act | 1440 × 900 | 390 × 844 |
|---|---|---|
| arrival (4 s into the fill) | `arrival-1440.png` | `arrival-390.png` |
| arrival · after the fill | `arrival-settled-1440.png` | `arrival-settled-390.png` |
| thinking | `thinking-1440.png` | `thinking-390.png` |
| verdict (accepted) | `verdict-1440.png` | `verdict-390.png` |
| queue | `queue-1440.png` | `queue-390.png` |
| checking (two tallies) | `checking-1440.png` | `checking-390.png` |
| landing · the rule still standing | `landing-1440.png` | `landing-390.png` |
| landing · lifted | `landing-lifted-1440.png` | `landing-lifted-390.png` |
| failure · our fault | `failure-fault-1440.png` | `failure-fault-390.png` |
| failure · a verdict | `failure-verdict-1440.png` | `failure-verdict-390.png` |
| arrival · reduced | `arrival-reduced-1440.png` | `arrival-reduced-390.png` |

## the numbers (`frame-cost.json`; 27 checks a width, all passing)

| width | arrival p95 / max | frame deltas p95 | lines | overlay nodes (arrival) | overlay nodes (landing) | tallies |
|---|---|---|---|---|---|---|
| 1440 | 0.2 / 0.2 ms | 26.3 ms (headless 60 Hz) | 6 | 9 | 10 | 2 |
| 390 | 0.1 / 0.1 ms | 24.5 ms (headless 60 Hz) | 10 | 13 | 14 | 2 |

The overlay is the sentence's **lines**, never its words: 1 host + one rule per line + the nib +
the spine + the foot + the rule-end + the note's hairline + ≤ 3 tallies is 13 at 390 and 9 at 1440
against the ≤ 19 the design allows — the count is the sentence's line count, not its length. The fill writes
one clip a frame (a line's edge) and one transform (the pen) — 0 child-list and 0 character-data
mutations during the 800 ms sample — and the pen stands on the word the clock gives at 30/70/95 %
of the sweep (word 18 / 41 / 55 of 57 at both widths).

**The margin does not move for the act.** Measured mid-fill and compared with the `queue` act's own
boxes: the numeral's top is 174.55 px at 1440 and 224.02 px at 390 (Δ 0.00), the note's top is
181.42 px (Δ 0.00), and the phone strip's box is 525.2 – 569.2 px, unchanged. The sentence's spans
are the same one, and the paragraph's line grid is identical in both acts, line for line.

## the ink, not the node

The review's finding was that the harness counted nodes: a rule can exist, carry a width and a
clip, and paint nothing. Every line is now measured as **painted width** — the node's own width
minus the *computed* clip's right inset (so the sheet's `inset(0 100% 0 0)` counts as the zero ink
it is). Three checks ride on it, and each was watched failing before its fix:

| check | what it measures | what it caught |
|---|---|---|
| landing — every line is painted at full width, visible, before the lift | painted width per line at the sink, before the lift's 120 ms | six lines, six nodes, **0 px painted**: the un-clipped state fell back to the sheet's `inset(0 100% 0 0)` |
| failure, our fault — the rule is painted, ends short, the foot under its end | every line painted but the last, which ends short; the 2 × 4 foot's x = the painted edge | the same fallback: the foot stood alone on an empty rule |
| arrival after the fill — the pen has left, the cite is solid, the margin unchanged | the fill's **own** end (mounted 900 ms before `sweepMs`), not a late mount: nib width 0, opacity 0 | the pen's 2 px bar stayed parked under the last word at 113 px wide for the rest of the read |

Two more checks came with the same review: the unread rule's own ink in the arrival (dotted
`--ink-3`, never the accent) and the phone's tick following the act's ink (its `::before` bar is
`currentColor`, so queue and our fault are quiet at 390 — the bar used to be the accent by hand).
A sixth measures the paragraph `SentenceRuns` renders with `history` **off**: the text has no
`.sentence-door` wrapper, the numeral and the note sit inside the same `[data-s]`, and the reading
must still walk the sentence's 57 words (the harness reported 80 words and 17 lines, and the pen
at x 854 on a 640 px measure, before the run was cut by `data-quote`).

## the two checks a theatre's margin must pass

| check | what it measures |
|---|---|
| the numeral and the note (1440) / the strip (390) stand through the reading | `.margin-note` (1440) or `.phone-strip` (390) is `display`-visible with an opacity above 0.5, and the numeral's target is drawn |
| they stand where the queue act leaves them (≤ 0.5 px) | the same boxes, before the act and mid-fill: x and y within half a pixel |

## what the harness cannot prove

1. **The performed unit is the block**: BOOK-DOC-86 §0 measures the 349-character paragraph and the
   plate rules all of it. The acts are mounted on one `[data-s]` span over the block (the harness's
   own paragraph), not on the four sentences the shipped `ProseParagraph` splits it into.
2. **The rows are the harness's**: the filing's status is set here; the frames are real, the
   server is not.
3. **"Frame work" is the rAF callback's own script time**, not paint or composite (LoAF keeps only
   frames over 50 ms).
4. **The words are the renderer's own**: `window.__theatre.geometry()` calls the same `measure`
   the component calls, so "57 words" is the number the fill walks, not a fixture's claim.
5. **The print is not measured at all** — its clock, caret, node count, deletion and document order
   are `#121`'s checks, and its `writing` plate is theirs to add at the rebase.
