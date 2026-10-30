# the theatre's evidence — BOOK-227

`npm run theatre:check` (`scripts/theatre-cdp.mjs`) drives `web/harness/theatre.html` at 390×844 and
1440×900 and answers **30 checks a width**, all passing.

## what the harness is

The page is the site's own shell (`<div class="canvas">` → `<main class="page">`, `HeadLine`), and
every fact an act is made of arrives the way the site delivers it:

| the page mounts | what drives it |
|---|---|
| the real reducer — `applyFrame` / `initialClientState` / a `hello` whose `live` block is a fixture | synthetic `Envelope`s per act: `filing:reading`, `pass:stage`, `chapter:applied`, and the row a refetch would hand over |
| the real fact stores — `publishFilingLive`, `publishLiveChange`, `publishTheatrePage` | `App`'s own publish, on the harness's commit |
| main's `ChapterProse` with a fixture chapter — `ProseParagraph`, `SentenceRuns`, `FilingMark`, `MarginNote`, `PhoneStrip`, and **`PrintPass`** | the chapter's blocks, the stage log, and the print plans `appliedPrintPlans` gives the prose |
| main's `HeadLine` | `ClientState` + the frames |

The sentence is the book's own block `ch01#0594465f` (BOOK-DOC-86 §0), and the **filing's quote is
its second sentence** — 163 characters, 29 words, three lines at 640 and five at 342 — so the rule,
the stub, the foot and the tallies are measured **across lines**. A filing's quote is one sentence;
the block is not the performed unit.

## what is ours, and what is PR #121's

**Ours (the theatre):** `lib/theatre.ts` (the acts' machine), `lib/theatreLines.ts` (one
measurement), `lib/theatreStage.tsx` (the chapter's slice of the page's facts), `components/SentenceTheatre.tsx`,
`styles/theatre.css`, the five `tokens.css` tokens, and the acts' checks.

**PR #121's (never touched):** the print — `PrintPass`, `lib/printPlan.ts`, `lib/passMeasure.ts`,
`lib/appliedPrint.ts`, `useAppliedPrint`, `pass-live.css`, the one caret, the ghost, the follow, the
head. The **writing** act rides that print: the harness only asserts the theatre's share of it — one
print, one caret, our 2 px spine at `--spine-x`, `--live`, and the hand-off when the ink settles.

The three facts of the page the theatre reads are published by `App` and handed down by
`ChapterProse` — the same shape BOOK-220 already uses for a leaf's facts (`lib/filingLive.ts`,
`lib/liveChange.ts`). No prop was added to `ProseParagraph` or `SentenceRuns`.

## the plates — 12 a width

| act | 1440 × 900 | 390 × 844 |
|---|---|---|
| arrival (4 s into the fill) | `arrival-1440.png` | `arrival-390.png` |
| arrival · after the fill | `arrival-settled-1440.png` | `arrival-settled-390.png` |
| thinking | `thinking-1440.png` | `thinking-390.png` |
| verdict (accepted) | `verdict-1440.png` | `verdict-390.png` |
| queue | `queue-1440.png` | `queue-390.png` |
| **writing** — main's print, our spine | `writing-1440.png` | `writing-390.png` |
| checking (two tallies, the changed line) | `checking-1440.png` | `checking-390.png` |
| landing · the rule still standing | `landing-1440.png` | `landing-390.png` |
| landing · lifted | `landing-lifted-1440.png` | `landing-lifted-390.png` |
| failure · our fault | `failure-fault-1440.png` | `failure-fault-390.png` |
| failure · a verdict | `failure-verdict-1440.png` | `failure-verdict-390.png` |
| arrival · reduced | `arrival-reduced-1440.png` | `arrival-reduced-390.png` |
| writing · reduced | `writing-reduced-1440.png` | `writing-reduced-390.png` |

`all-1440.png` / `all-390.png` are contact sheets of the captures at 1:1, no state composed onto
one page. `frame-cost.json` is the measured numbers behind the checks.

## what the writing act adds, and what it does not

| ours | how |
|---|---|
| the act's clock | `chapter:applied.appliedAt`, and the act ends when the print's own window does (`PRINT_WINDOW_MS`, imported from `lib/appliedPrint.ts` — never a copy) |
| the block it belongs to | the write's `span` names it; a write that names another block, a truncated patch or a missing span performs nothing (the same three refusals `appliedPrintPlans` makes) |
| the spine | `--spine-x`, 2 px, `--live` — drawn by `theatre.css` **on `PrintPass`'s own `data-pass`** while the ink runs (a pseudo-element, no node, no fork), and by the sentence's overlay once the block is handed back (§9.4, "the spine stays") |
| the margin | `FilingMark` / `MarginNote` / the strip, unchanged: the act only says which ink the mark wears |
| the gates' height | §9.5 / BOOK-233 item 1 — a tally is as tall as the **changed** lines: the write's span gives the run (`passDiff.passSpanOf`, the same cut the print inks), the sentence's one measurement says which of its lines those words stand on, and the sentence's own count is the fallback when the run cannot be placed there |

The print's own spine has no birth animation: a pseudo-element cannot be born, so it stands from the
print's first frame (the fact is older than the paint, like a late reader's arrival). The overlay's
stroke — mounted when the block is handed back — keeps its 400 ms `--ease-out`.

## the ink, not the node

Every rule is measured as **painted width** — the node's own width minus the *computed* clip's right
inset, so the sheet's `inset(0 100% 0 0)` counts as the zero ink it is. Each check was watched
failing before its fix: the landing's un-clipped state fell back to that inset (six nodes, 0 px
painted), the fault's foot stood on an empty rule, and the phone's tick painted the accent by hand
under an act without a «now» (it is `currentColor` now).

## what the harness cannot prove

1. **The unit is the sentence, not the block.** BOOK-DOC-86 §0 measures the 349-character paragraph;
   the page performs one sentence of it (main's prose splits the block with `splitSentences`), and
   this harness measures that sentence — 3 lines at 1440, 5 at 390.
2. **A real socket.** The frames are the wire's shapes and the reducer is the real one; the delivery
   order is the harness's.
3. **The plates are Chromium's.** Fonts and hyphenation come from the machine that took them
   (`test:model`/`line:fonts` are the site's own guards for that).
