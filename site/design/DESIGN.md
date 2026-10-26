# Design system — book.semirov.dev

**Status:** proposal v1 · **Owner:** designer · **Date:** 2026-10-25
**Sources:** `site/SPEC.md`, `site/ARCHITECTURE.md` (rev. 2, §7, §10, §11, §12), `concept/CONCEPT.md`,
`style/VOICE.md`.
**Artifacts:** this document; the live implementation is `web/src` (components and `styles/`).

This document specifies the look. Where this document and the live implementation disagree on
*behaviour*, the architecture wins.

---

## 1. What is being designed

One page that is a book. It is written in public, from an empty manuscript, by two lanes that move
towards each other; a reader can lock onto a single edit and watch it propagate. The page must read as a
**book** first and as a **process** second — the process is the reason to stay.

Three consequences drive every decision below:

1. **The book is the interface.** No dashboards. Queue, cascade and revisions are typeset *into* the
   page as annotations, footnotes, marginalia and ledgers — the visual language of paper, not of apps.
2. **The sublime is administrative.** Forms, columns, dates, numbers, queues, stamps, signatures. The
   reader should feel the cold pleasure of a well-kept registry, not the excitement of a control room.
3. **The wow is the caret.** A cursor writing a sentence at 18 characters per second, a paragraph quietly
   turning ochre while it is being revised, a ring spreading from the paragraph where an edit landed.
   Nothing moves that is not data. No neon, no gradient, no glow, no glass, no confetti.

**Not** the aesthetic: sci-fi HUD, terminal green, "AI" sparkle icons, progress percentages,
dashboard cards, dark-mode-by-default neon.

---

## 2. Principles

| # | Principle | In practice |
|---|---|---|
| 1 | **Paper, then screen** | A cold grey paper field, ink text, hairlines. Surfaces are sheets, not cards; corners are square (2 px max). |
| 2 | **Two colours, two meanings** | Cold steel for anything live; muted ochre for anything being revised. Nothing else is coloured. |
| 3 | **Labels are a different voice** | Chrome speaks in narrow uppercase with wide tracking; the book speaks in serif. They never mix in one line. |
| 4 | **Numbers are always mono and tabular** | Chapter numbers, times, counts, identifiers align in columns and never jitter. |
| 5 | **Hairlines, not shadows** | Separation is a 1 px rule or a tone step. Shadow is used once, for the lit sheet in the прицел. |
| 6 | **Say what is true** | No invented progress, no "thinking…" spinner, no fake percentages. Silence is a state («тишина с 03:12»), not a bug. |
| 7 | **Motion is a fact, not decoration** | Text prints because it is new; a block is ochre because it is being rewritten; a ring spreads because a change propagated. |

---

## 3. Colour

### 3.1 Two themes, one book

**Day — «бланк»** is the default: the page is a form. **Night — «ночная смена»** is the same page at
night, and it matches the palette already fixed in `ARCHITECTURE.md` §11.1 (`#0F1113` / `#E8E6E1` /
`#6F9BB5`), so the architecture is not contradicted — it is the second theme. Theme follows
`prefers-color-scheme`; a manual switch lives in the colophon and persists in `localStorage.book.theme`.

| Token | Day | Night | Role |
|---|---|---|---|
| `--paper` | `#E9E8E2` | `#0F1113` | field |
| `--paper-2` | `#F1F0EA` | `#15181B` | raised sheet (footnote, composer, cascade band) |
| `--paper-3` | `#DEDDD4` | `#1B1F22` | inset / form header strip |
| `--ink` | `#16181A` | `#E8E6E1` | prose |
| `--ink-2` | `#4E5357` | `#B0B2AE` | secondary text, stamps, meta values |
| `--ink-3` | `#64686A` | `#8B8F8C` | labels, empty states, disabled |
| `--rule` | `#C7C6BE` | `#2C3134` | row dividers |
| `--rule-2` | `#A6A79E` | `#3E4549` | section rules, field borders |
| `--live` | `#2E6274` | `#6F9BB5` | caret, "now", pressed, accepted |
| `--live-bg` | `rgba(46,98,116,.07)` | `rgba(111,155,181,.09)` | live tint |
| `--revise` | `#8A5A1C` | `#C89A4E` | under revision |
| `--revise-bg` | `rgba(138,90,28,.075)` | `rgba(200,154,78,.09)` | revision tint |
| `--scrim` | `rgba(22,24,26,.46)` | `rgba(5,7,9,.66)` | overlay veil |
| rail | `#16181A` | `#05070A` | design furniture only |

**Contrast (day / night):** ink 14.4 / 14.9; ink-2 6.3 / 8.7; ink-3 4.7 / 5.7; live 5.5 / 6.2;
revise 4.8 / 7.2. All text passes AA at its size; `--rule` is decorative and never carries text.

### 3.2 Rules of colour

- **Live** means *now*: the caret, the "пишется/печатается" chip, the frontier of a cascade, an accepted
  decision, the current stage in a stage ledger. One live element per view, ideally.
- **Ochre** means *under revision*: the 2 px gutter rule, the block tint, the "правится" label, the
  "идёт" stamp, in-progress form fields. It is not a warning and never used for errors.
- **No red, no green.** A rejected comment is grey ink; a failed change is grey with an honest sentence.
  Colour is reserved for time (live) and work (ochre), so a page full of red would be a design failure.
- **One stamp per item**, one tilt per screen (the `идёт` stamp in the прицел is rotated −1.1°; nothing
  else is).
- **Tints never exceed 9 % alpha.** Paper stays paper.

### 3.3 Paper

A single fixed, non-interactive grain layer over everything at 4.5 % opacity (SVG `feTurbulence`,
150 × 150 tile). It is the only texture. No lines, no fibres, no vignette, no "archive photo" overlay.
It is applied to the viewport, not to elements, so it never scrolls with the text and never affects
layout or selection.

---

## 4. Typography

### 4.1 Families — one superfamily, three voices

| Voice | Family | Why |
|---|---|---|
| **Prose** | **PT Serif** 400/700 + italic | ParaType's PT Serif was commissioned for Russian *official documents*. The site is a book written by a registry: the body text is set in the typeface of Russian paperwork. Excellent Cyrillic, free, OFL-adjacent (PT Free Font License). |
| **Chrome** | **PT Sans Narrow** 400/700 | Labels, stamps, chapter meta, buttons. Narrow uppercase with 0.13–0.15 em tracking reads as a printed form field, not as an app. |
| **Figures** | **PT Mono** 400 | Numbers, times, chapter numerals in ledgers, identifiers, readouts. Tabular by design; nothing drifts. |

Fallbacks: `Georgia, "Times New Roman", serif` / `"PT Sans", system-ui` / `ui-monospace, "SF Mono"`.
Georgia has Cyrillic on macOS and Windows and keeps the page readable if the webfont fails.

**Self-host** (do not use the Google Fonts CDN in production): `PT Serif 400/700/400i`, `PT Sans Narrow
400/700`, `PT Mono 400`, Cyrillic + Latin subsets, WOFF2, `font-display: swap`, preload the two faces used
above the fold (serif 400, narrow 400). Budget ≈ 90–110 KB.

### 4.2 Scale

| Token | Size / line | Family | Use |
|---|---|---|---|
| `--fs-nano` | 9.5 / 1.2 | narrow | spine labels, form labels inside notes, plate notes |
| `--fs-label` | 10.5 / 1.3 | narrow | section headers, stamps, chapter meta, rail |
| `--fs-meta` | 12.5 / 1.45 | serif | decision reasons, small values |
| `--fs-note` | 13.5 / 1.42 | serif | footnote form values |
| `--fs-body` | 17 / 1.68 | serif | prose |
| `--fs-lead` | 18.5 / 1.62 | serif | the paragraph inside the прицел |
| chapter numeral | 26 / 1 | serif 700 | `07`, `08`, `67` |
| title | 34 / 1, tracking .26 em | serif | «БЕЗ НАЗВАНИЯ» on the title sheet |
| plate title | 22 / 1, tracking .24 em | serif | the 0/67 plate |

No size below 9 px carries meaning; 9–9.5 px is used only for tracked uppercase where the shapes are
still distinguishable. Everything that must be read on a phone at arm's length is ≥ 12.5 px.

### 4.3 Russian specifics (normative)

- Quotes: «ёлочки», nested „лапки“. The UI copy follows this.
- Dash: em dash with a non-breaking space before it (`— `).
- Numbers with a space: `99 410`, non-breaking, tabular. Never `99,410`, never `99410`.
- Dates in the UI: `25.10.2026` in ledgers, `12:04` for times, `13-го` only inside prose.
- Chapter numbers are zero-padded everywhere (`07`, `67`) — they are field numbers, not ordinals.
- Hyphenation: `hyphens: auto` **only** where the measure is narrow (≤ 600 px). On wider columns the
  dictionary breaks short words badly («Ка-литка»), so hyphenation is disabled at ≥ 600 px.
- Justification: justified on 360–600 px (with hyphenation); ragged right below 360 px and inside the
  прицел, where reflow during typing would make the paragraph twitch.
- Partial words never hyphenate: the printing span and the typed span set `hyphens: none`.
- No bold or italic inside prose. The book's text arrives as plain paragraphs; the site adds no emphasis.
  Italic is reserved for the *author's voice* in annotations (the intent quote, decision reasons).

### 4.4 Measure and rhythm

- Mobile 390 px: 342 px column ≈ 39–41 characters. Paragraph spacing `1.02 em`; **no first-line indent**
  (the manuscript is one paragraph per line; blank-line rhythm is the book's own).
- Desktop: 480–496 px column at 18 px ≈ 56–60 characters. Same scale, more air — wider never means denser.
- Section rhythm: 40 px above a chapter rule, 22 px between the rule and the first paragraph, 44–52 px
  between a chapter and the next state block.

---

## 5. Layout

### 5.1 Viewports

| Range | Column | Gutter | Body | Notes |
|---|---|---|---|---|
| 320–359 | fluid | 24 | 17 / 1.68 | ragged right (justification breaks into rivers), header unchanged |
| 360–599 **(design target 390)** | fluid | 24 | 17 / 1.68 | justified + hyphenation; all states designed here |
| 600–1023 | 34 rem (544) centred | 32 | 17.5 / 1.68 | hyphens off; rail centred |
| ≥ 1024 | 35 rem (560) centred | 32 | 18 / 1.68 | more air in the header and title sheet; same hierarchy |

Height: `100dvh` where a fixed surface is needed (прицел); header offsets use
`env(safe-area-inset-top)`, action bars `env(safe-area-inset-bottom)`. Tap targets ≥ 44 px on every
action. No hover-only affordances; everything reachable on a phone without a long-press is listed in
§7.19.

### 5.2 The page, top to bottom

```
sticky header   brand · count │ live chip · queue │ spine 6 px │ ribbon 4 px (only while a cascade runs)
title sheet     title (a live slot) / author / caption / rule / 3-column ledger
ch 07           rule · 07 · meta │ prose, one revised paragraph, footnote 013
ch 08           rule · 08 · meta › правится │ prose, one paragraph under revision
cascade band    правка 014 · идёт │ intent quote │ ring field │ readout │ stage ledger │ прицел →
ch 09           rule · 09 · печатается │ prose, tail printing with caret
опись           67 slots in order: written rows, empty rows, one summary row
ch 67           rule · ← 67 · meta │ short excerpt (the backward front)
обсуждение      queue line │ 4 comments with decision lines │ composer + CAPTCHA
plate 0/67      the day-one screen, pasted in like an exhibit
colophon        counts, time, theme switch
```

The order is the book's order. There is no sidebar, no tab bar (the bottom rail is design
furniture), no navigation except: the header chip (jump to the live chapter), the spine (jump to a
chapter by tapping a position), the опись rows (jump), and the прицел.

### 5.3 Header and spine

- Header height 52 px + 6 px spine + 4 px ribbon. Two micro-rows: `КНИГА · 67 ГЛАВ` / `11 / 67`, then
  `■ ПИШЕТСЯ ГЛАВА 9` / `4 ЗАМЕЧАНИЯ`.
- The **spine** maps chapter 1→67 onto the column width. Written chapters are a 55 % ink fill from each
  end; the unwritten middle is a faint 45° hatch; a 1 px tick at 51.4 % marks the 34 | 35 seam.
- The **ribbon** is a 4 px strip under the spine and exists *only* while a cascade is running: a 1 px
  live segment over the chapters it covers, a 4 px origin tick, one dot at the current step. It is not a
  progress bar and never fills towards a percentage of the book.
- While a cascade runs, the spine's live segment and the header chip are the only ambient signals. This
  is why the full cascade band lives in the flow, at the chapter where the change landed: a reader who
  is not looking at that chapter needs one quiet hint, not a dashboard.

### 5.4 Desktop

The phone layout is the design; desktop adds air and one thing more: the column is centred with generous
margins, and a chapter's footnote form may hang 24 px into the outer margin (planned enhancement).
No multi-column reading, no side navigation, no wider type.

---

## 6. Motion

### 6.1 Tokens

| Token | Value | Use |
|---|---|---|
| `--dur-tick` | 120 ms | press, hover, focus |
| `--dur-ui` | 220 ms | theme change, button, switch |
| `--dur-fade` | 400 ms | a rewritten block cross-fades to the new revision |
| `--ease-out` | `cubic-bezier(.22,.68,.24,1)` | everything entering |
| `--ease-inout` | `cubic-bezier(.4,0,.2,1)` | theme, size changes |
| caret | `1.06 s steps(1,end) infinite` (50 % on / 50 % off) | the only blink on the site |
| ripple | 2600 ms, 3 rings, 870 ms stagger | cascade propagation |
| reveal | 18 characters / second | printing new prose |

Nothing else animates. No parallax, no scroll-triggered fades, no hover lifts, no skeleton shimmer.

### 6.2 The printing reveal (client-side theatre, labelled as such)

Server ships complete blocks (ADR-006). The client animates only what is **new to this reader, in the
viewport**:

```
cps = 18 · min 260 ms · max 2600 ms per block
animate only within [scrollTop − 1.5vh, scrollTop + 2.5vh] ; elsewhere reveal synchronously
scrolling away drains the queue at 8×
chapter younger than 5 min on join → print only the last 8 blocks
"показать сразу" empties the queue
caret sits at the reveal front, disappears when the queue is empty
```

- One `requestAnimationFrame` loop per printing block, one `textContent` write per frame, grapheme
  clusters (`Intl.Segmenter`), never splitting a surrogate pair or a combining mark.
- The paragraph is `text-align: left` while its tail is printing (`.p.is-printing`) and becomes
  justified at rest, so characters never push the lines above them.
- The caret is ink-honest: it does not wobble, it does not "write by hand", it does not speed up to look
  alive. It blinks because a cursor blinks.

### 6.3 Caret

2 px × 1.02 em, `--live`, `steps(1)` blink. One caret per lane, never one "book cursor". Where exactly:
after the cursor block; if the block is unknown, after the last block of the chapter. A cascade moves no
caret (that was revision 1's mistake) — it moves rings, in the band and in the прицел.

### 6.4 Ripples

A change has a point of origin and a front in both directions. Drawn once, in the cascade band:

- horizontal waterline = chapters; ticks and two-digit labels every chapter in range;
- origin = taller tick + filled dot; touched = filled dot; evaluated without changes = hollow dot;
- three concentric arcs rise from the origin and fade (`scale .3 → 1`, `opacity .68 → 0`), staggered
  870 ms, 2.6 s cycle; one static arc at 16 % marks the reached radius so a still frame still reads;
- the frontier is *text*, not geometry: `фронт ← 06 → 10` in the readout. Rings say "how far it
  reached", the readout says "where the front is now" — rings alone would invite a percentage reading.

### 6.5 Rewrites

A rewritten block does not re-type. The old text dims, the new revision cross-fades over 400 ms, the
ochre rule turns grey and fades after 24 h. The client keeps `revisedAt` in `localStorage` so a reload
still shows «правлено сегодня».

### 6.6 Reduced motion

`prefers-reduced-motion: reduce` (and the manual toggle) → text appears instantly, carets are solid,
rings are static at 16–22 %, every transition is 0 ms. The site remains fully legible and fully live; it
just stops performing.

---

## 7. Components

Sizes are for the 390 px target. All borders 1 px unless stated. All corners 0 except where noted.

### 7.1 Header

Two label rows (10.5 px / 10.5 px, 19 % tracking on the brand) on `--paper`, 1 px `--rule` bottom,
sticky. The live chip is the only coloured text in the header; the queue count is a right-aligned label
that opens the thread.

### 7.2 Spine + ribbon

6 px bar, full column width, `--paper-3` + hatch. Fills `--ink-2` at 55 %. Seam tick `--rule-2`.
Ribbon 4 px: `--live` at 55 % for the covered range, origin tick 100 %, step dot 2 px. `aria-hidden`,
with a text summary in the header for screen readers.

### 7.3 Title sheet

Centred. `БЕЗ НАЗВАНИЯ` (34 px, .26 em, uppercase; **the title is a live slot** — it follows
`manuscript/00-front.md`, and the block does not depend on its length) → author → 46 px double rule →
caption in italic, max 26 ch.

### 7.4 Ledger

Three equal cells, `--rule-2` rules above and below, 1 px `--rule` between cells. Label (nano, tracked)
over value (15 px mono, tabular). Used for `ГЛАВ 67 / НАПИСАНО 11 / ЗНАКОВ 99 410`, and any future
summary (queue, viewers) — never more than three cells on mobile.

### 7.5 Chapter head

1 px `--ink` rule (the book's only full-strength rule), 9 px gap, then `numeral 26 px` on the left and
the meta label on the right (`9 003 ЗНАКА · 11:52`, or `■ ПЕЧАТАЕТСЯ · 12:07`). A backward chapter
carries `←` before the numeral; forward chapters carry nothing (the default direction is silent).

### 7.6 Paragraph

17 / 1.68, justified, hyphens on ≤ 600 px, `text-wrap: pretty`, 1.02 em below. Selection is
`--live` on `--paper`. No indent, no drop caps, no ornaments.

### 7.7 Block under revision

2 px ochre inset rule drawn in the gutter (`background: linear-gradient(90deg, var(--revise) 0 2px,
var(--revise-bg) 2px)`), 10 px bleed each side, 7/10 px padding so the text does not shift. Above the
text, a 9.5 px label in ochre: `ПРАВИТСЯ · ПО ЗАМЕЧАНИЮ АНИ →` — it is a `<button>` that opens the
прицел, 44 px hit height. One paragraph per block, never a whole chapter ochre.

### 7.8 Revised block

Same geometry, `--rule-2` rule, no tint, label `ПРАВЛЕНО 12:06 · СНОСКА 013` in `--ink-3`; the footnote
number is the link into the form below. After 24 h the rule fades to 0.

### 7.9 Iteration footnote

A **form**, not a tooltip: 1 px `--rule-2` border, `--paper-2` body, `--paper-3` header strip with
`СНОСКА 013` (mono, 10.5 px) on the left and a stamp on the right. Inside, a definition grid of
88 px labels and serif values, one `--rule` hairline per row:

```
ОСНОВАНИЕ     замечание Игоря · 12:03 · глава 8
ЧТО ИЗМЕНЕНО  «…» → «…»; соседняя глава сведена
ЧТО ВНЕСЛО    «…» — следствие, названное обычным словом
ЗАТРОНУТО     07 · 08 (глава 6 проверена, правок нет)
ОЦЕНКА        черновик · волна 1 · 2 главы · −4 знака
```

Rules: the numbers are mono; the words are the book's; an unfilled field is a dotted 84 px rule with
the italic word `формируется` — never a spinner; the form is expanded at the paragraph it belongs to
(collapsible on tap, default open for the change the reader came from, closed for older ones).

### 7.10 Stamp

`display:inline-block; border:1px solid currentColor; padding:3px 6px 2px; font:700 9px narrow;
letter-spacing:.15em; uppercase`. Variants: `accepted / applied` → `--live`; `in progress` → `--revise`
(this one may tilt −1.1°); `rejected / void` → `--ink-3`; `waiting` → `--ink-2`; `escalated` → `--ink`.
A stamp is the only element allowed to look "pressed". Never two stamps side by side.

### 7.11 Intent quote

The change's goal, rendered as the author's voice, never as site copy: italic serif 14.5/1.5, 1 px
`--rule-2` left rule, 11 px padding, footer label `ФОРМУЛИРОВКА АВТОРА · ИЗ ЗАМЕЧАНИЯ АНИ` (nano).
Capped at 280 characters (architecture §10.3a), escaped.

### 7.12 Cascade band

Full-bleed inside the column (negative 24 px margins on mobile), `--paper-2`, `--rule-2` rules top and
bottom, 15/16 px padding. Contents in order: `ПРАВКА 014` + stamp `ИДЁТ`; intent quote; ring field
(96 px tall SVG); readout (`ВОЛНА 2/3 · ФРОНТ ← 06 → 10 · ШАГОВ 5/14 · 00:41`) as tracked labels with
mono figures; stage ledger; `ПРИЦЕЛ →`. The band sits **after** the chapter it originated in and before
the chapter it created, so the layout itself tells the direction.

### 7.13 Stage ledger

Rows `26 px / 1fr / auto`: mono chapter number, label with a lane glyph (`→`, `←`, `·` for a local
edit), mono delta (`+46`, `+9 240`, `0`). 1 px `--rule` between rows. The row in flight is `--live`.
Order = chronological, not numeric — it is a log, not a table of contents.

### 7.14 Прицел (aperture)

A full-screen dialog. **The page goes dark; one sheet stays lit.**

```
top bar      ПРИЦЕЛ · ПРАВКА 014 ······································ ВЫЙТИ
where        ГЛАВА 08 · АБЗАЦ 3 · 12:07
sheet        the paragraph, 18.5 px, day-paper tokens in BOTH themes, four corner ticks outside
readout      ВОЛНА 2/3   ФРОНТ ← 06 → 10   ШАГОВ 5/14   00:41   + 1 px budget rule (36 %)
rings        the same ring field, drawn on the dark panel
footnote     the 014 form, half-filled: «формируется», «волна 2 из 3 · этап не назначен»
actions      [ К ГЛАВЕ 8 ]  [ СЛЕДИТЬ ]      (sticky, safe-area padded)
```

- Panel: `#14171A` in both themes, text `#E9E8E2`, hairlines at 17 % — the instrument housing.
- The sheet always uses day-paper tokens, so it reads as *a document under a lamp* even in night mode.
- The incoming fragment types at 16 cps in `--live`; the rest of the sentence is static. **A rewrite is
  never re-typed** — only the fragment that actually changes is written, which is both honest and the
  most legible way to show "what is being changed".
- Corner ticks (12 px, 1 px, `#7FA8C0`) sit 5 px outside the paper: the crosshair belongs to the device,
  not to the text.
- Entry: the ochre label of a revising block, the cascade band's `ПРИЦЕЛ →`, a comment's change link, or
  `?ap=…` / a deep link (`/p/chg_…`) later. Exit: `ВЫЙТИ`, `Esc`, or tap outside the sheet. Focus moves
  to the dialog on open and back to the trigger on close; body scroll is locked.
- One прицел at a time; it is a *reading* surface — no editing, no reply box.

### 7.15 Slot row (опись)

`22 px` mono number, a dotted leader, a 9 px label (`ПУСТО`, `9 121 ЗНАК · ←`). 14 px vertical padding
(44 px row). Written rows use `--ink` for the number, empty rows `--ink-2`, the live chapter `--live`.
A summary row (`10—65 ⋯ 56 ГЛАВ · ОПИСЬ НЕ ЗАПОЛНЕНА`) closes a run of empty chapters so 56 empty slots
cost one row, not a screen and a half. This is the launch state's main visual: a form with blank fields,
not an error page.

### 7.16 Comment

Author (a 6 px wash square hashed from the name, then the name in narrow caps), time and anchor
(`12:04 · АБЗАЦ 3`), stamp at the right; body 15.5/1.6 serif, ragged right; then the decision line —
2 px rule (live if accepted, ink-3 if rejected, rule if waiting), italic 12.5 px reason, and one link
(`СНОСКА 013 →` or `ПРИЦЕЛ 014 →`). Queue position is stated as a fact: `ПРИНЯТО · 4-Я В ОЧЕРЕДИ`.

Six author washes (all ≤ 12 % saturation): `#7A6A58` `#5E6A55` `#6A5A6E` `#55677A` `#7A5C58` `#5C6E63`.

### 7.17 Composer

`--paper-2` sheet, 1 px `--rule-2` border, 13 px padding. Label `ОСТАВИТЬ ЗАМЕЧАНИЕ`; textarea with a
1 px top and bottom rule and a placeholder that teaches the scope («о тексте этой главы — не о том, что
должно случиться»); a row with the display name (bottom-ruled input, 120 px) and the counter
`0 / 1200` in mono; the **CAPTCHA slot** — a dashed 1 px field with a 14 px empty square, the label
`ПРОВЕРКА · TURNSTILE` and `БЕЗ ЗАДАНИЙ` at the right; then a full-width 44 px ink button `ПЕРЕДАТЬ`.
Below it, one 11 px line explaining the contract: comments are data, the author may accept or reject
with a reason, the answer appears here.

The CAPTCHA is designed as a **form field**, not as a widget: when Turnstile/hCaptcha mounts, it fills
the dashed box and keeps the 44 px height; no badge floats over the page.

### 7.18 Plate 0/67

The day-one screen pasted into the page like an exhibit: 1 px border, mini header (`КНИГА · 67 ГЛАВ`,
`0 / 67`), a 4 px hollow spine with **a caret at each end**, `БЕЗ НАЗВАНИЯ`, `→ 01
ВПЕРЁД / ← 67 НАЗАД`, and `ЧИСТЫЙ ЛИСТ · 67 ГРАФ · 0 ЗНАКОВ`. Used as the empty state of the site and
as the "начало" reference.

### 7.19 Anchoring a comment (deviation from §11.6)

The architecture asks for a persistent 32 px «＋» in the left gutter of every paragraph. On a 390 px
phone that gutter does not exist: the column is 342 px with 24 px margins, so a 32 px mark would either
overlap the text or shrink the measure to ~32 characters. The design keeps the measure and offers three
ways in, all reachable with one thumb:

1. **Chapter composer** at the chapter footer (`ОСТАВИТЬ ЗАМЕЧАНИЕ`) — always visible, anchors to the
   chapter. This is the primary path and the one the design shows.
2. **Selection action** — the system selection toolbar carries «прокомментировать»; the chosen range
   fills `quote` and the anchor, exactly as §11.6 already specifies.
3. **Tap on a paragraph's revision label** (when present) opens the прицел, not the composer; a
   long-press anywhere in a paragraph opens the same composer sheet with the paragraph quoted.

No floating «＋», no hover-only affordance. If the architect prefers a persistent mark, the only honest
way is a 4 px wider gutter on ≥ 600 px screens, where there is room — recommended, not required.

### 7.20 Талон (the floating notice)

A rectangular ticket, not a pill: `--ink` field, `--paper` label, 2 px offset shadow, 44 px tall, sitting
above the bottom safe area on the right. It appears only when something happened to a chapter the reader
is **not** looking at: `НОВАЯ ГЛАВА 9 ↓` on `chapter:created`, `ГЛАВА 9 ПОПРАВЛЕНА ↓` on
`chapter:revision`. It never appears for the chapter the reader is in (the header chip carries that), it
never counts, it never pulses, and it disappears once the chapter enters the viewport or is tapped.
Designed, not yet implemented (it requires the scroll state the static page does not have).

---

## 8. The six states

### 8.1 Book page

**Purpose:** read the book in order and see where it ends.
**Screen:** header + spine, title sheet, chapters in order, the опись of unwritten chapters where the
book stops, the backward front, the discussion, the colophon.
**Motion:** text prints only where it is new (see 6.2); nothing else moves.
**Data:** `hello.catalog` (all 67 slots), `GET /api/chapters/:n` with ETag, `IntersectionObserver`
1.5 viewports ahead.
**Failure modes designed:** 0/67 (plate), a gap between loaded chapters («главы 2–6 не загружены ·
загрузить» as a collapsed row in the опись), a chapter older than 5 min (no printing), engine down
(«правки приостановлены» in the header chip, the text still reads).

### 8.2 Live writing

**Purpose:** feel that a person-shaped process is writing *now*, without being lied to.
**Screen:** `■ ПИШЕТСЯ ГЛАВА 9` in the header; the chapter header carries `■ ПЕЧАТАЕТСЯ · 12:07`; the
tail of the last paragraph prints at 18 cps with a 2 px caret; the rest of the chapter is already set.
**Motion:** caret blink 1.06 s; characters at 18/s; `показать сразу` empties the queue.
**Honesty:** the site says "пишется глава" (the lane's state) and "печатается" (what you see). It never
says "модель пишет 37-й абзац" and never shows a token stream it does not have.
**Resting:** the caret stops, the chip reads `ПАУЗА · 14 МИН`, and after 6 h of silence `ТИШИНА С 03:12`
— never "offline", never a fake progress.

### 8.3 Прицел

**Purpose:** lock onto one edit and follow it: its text, its propagation, its footnote.
**Screen:** as 7.14. The reader sees the sentence being completed, the rings, the frontier, the form
filling in.
**Motion:** 16 cps typed fragment, rings 2.6 s, readout figures update once per `cascade:progress`
(≤ 1/s) — no counting animation, no ticking milliseconds. `00:41` is computed from the cascade's
`startedAt`, not from a local stopwatch, so it stays true across tab switches and reconnects.
**Data:** `GET /api/changes/:id` once on open, then `cascade:progress` and `change:decided` for that id.
**Exit:** back to the same scroll position, with the block now carrying the footnote.

### 8.4 Cascade (круги)

**Purpose:** show that an edit propagates in both directions, how far, and where the front is.
**Screen:** the band (7.12) in the flow at the point of change; the 4 px ribbon in the header for
readers who are elsewhere; the stage ledger as the trace.
**Motion:** rings; the in-flight row in live colour; nothing else.
**Never:** a percentage, a countdown, a "progress" bar over the book, or rings whose radius implies a
chapter count it did not reach. The band shows *those chapters*, never the book.

### 8.5 Iteration footnote

**Purpose:** make every applied change auditable in one glance: number, cause, what changed, what it
introduced, what it touched, how it was assessed.
**Screen:** the form (7.9). Two variants: closed (stamp `ВНЕСЕНО`, all fields filled) and in progress
(stamp `ИДЁТ`, `формируется` fields, stage `волна 2 из 3`).
**Rule:** the footnote is attached to the paragraph the change landed in, not to the chapter — and a
cascade that touched three chapters produces three marks and **one** footnote (the change), linked from
each mark.

### 8.6 Comments

**Purpose:** let a reader say something about the prose and see exactly what happened to it.
**Screen:** 7.16 + 7.17, with the queue line above the thread (`В ОЧЕРЕДИ 4 · ПРАВКИ ИДУТ ПО ОДНОЙ, В
ПОРЯДКЕ ЗАПИСИ`).
**States shown:** `ЖДЁТ ОЧЕРЕДИ`, `ПРИНЯТО` (queued, with position), `ВНЕСЕНО` (applied, with the
footnote link), `СНЯТО` (with the reason), plus `ПОХОЖЕ НА ИНСТРУКЦИЮ` and `НЕ РАССМОТРЕНО` for the
quarantined and expired cases.
**Rule:** acceptance is a promise, application is a fact; the thread shows both lines, in order, and
never collapses them into one "готово".

---

## 9. Copy deck

The interface speaks like a registry clerk: short, exact, no exclamation, no ellipsis, no "Упс".

| Where | Copy |
|---|---|
| header live | `ПИШЕТСЯ ГЛАВА 9` · `ПАУЗА · 14 МИН` · `ТИШИНА С 03:12` · `ПРАВКИ ПРИОСТАНОВЛЕНЫ` |
| header queue | `4 ЗАМЕЧАНИЯ` · `ЗАМЕЧАНИЙ НЕТ` |
| chapter meta | `9 003 ЗНАКА · 11:52` · `ПЕЧАТАЕТСЯ · 12:07` · `← 8 952 ЗНАКА` |
| block | `ПРАВИТСЯ · ПО ЗАМЕЧАНИЮ АНИ` · `ПРАВЛЕНО 12:06 · СНОСКА 013` |
| footnote | `СНОСКА 013` · `ОСНОВАНИЕ` · `ЧТО ИЗМЕНЕНО` · `ЧТО ВНЕСЛО` · `ЗАТРОНУТО` · `ОЦЕНКА` · `ФОРМИРУЕТСЯ` |
| cascade | `ПРАВКА 014` `ИДЁТ` `ВОЛНА 2 / 3` `ФРОНТ ← 06 → 10` `ШАГОВ 5 / 14` `ПРИЦЕЛ →` |
| stages | `ПРАВИТСЯ` `СОЗДАНА` `ПРОВЕРЕНА, ПРАВОК НЕТ` `ПЕРЕПИСАНА` `ЖДЁТ РЕШЕНИЯ` |
| опись | `ПУСТО` · `10—65 ⋯ 56 ГЛАВ · ОПИСЬ НЕ ЗАПОЛНЕНА` · `ПОДГРУЖАЕТСЯ ПО ХОДУ ЧТЕНИЯ` |
| decision | `ПРИНЯТО` · `ВНЕСЕНО` · `СНЯТО` · `ЖДЁТ ОЧЕРЕДИ` · `ПОХОЖЕ НА ИНСТРУКЦИЮ` · `НЕ РАССМОТРЕНО` |
| decision reasons | one line, concrete, about the text: «одно упоминание — оставил первое» · «вне рамок: не про текст» |
| composer | `ОСТАВИТЬ ЗАМЕЧАНИЕ` · placeholder `о тексте этой главы — не о том, что должно случиться` · `ПЕРЕДАТЬ` |
| прицел | `ПРИЦЕЛ` · `ГЛАВА 08 · АБЗАЦ 3` · `СЛЕДИТЬ` · `К ГЛАВЕ 8` · `ВЫЙТИ` |
| empty | `0 / 67` · `БЕЗ НАЗВАНИЯ` · `ЧИСТЫЙ ЛИСТ · 67 ГРАФ · 0 ЗНАКОВ` |

**Forbidden:** «онлайн», «в реальном времени» as a boast (a factual «печатается по ходу письма» is allowed), percentages of the book, «ИИ печатает»,
spinners with «подождите», «осталось ~N минут», emoji, exclamation marks, any English UI word except
`Turnstile` inside the CAPTCHA slot.

---

## 10. Accessibility and performance

- Contrast ≥ 4.5:1 for all text; `--live` and `--revise` are tested on both papers.
- The ochre revision rule must never be the **only** signal: the label above the block carries the same
  information in words.
- The прицел is a `role="dialog" aria-modal="true"` with focus moved in, `Esc` to close, focus returned
  to the trigger; body scroll locked; the sheet's paragraph is `aria-live="off"` (typing must not
  announce itself), the footnote form is ordinary text.
- The caret is `aria-hidden`; the chapter header carries `aria-label="печатается глава 9"`.
- Printing respects `prefers-reduced-motion` and a manual toggle; the "показать сразу" control is always
  available while printing.
- No layout shift: the revision rule is drawn with `background`, not with padding; fonts are preloaded;
  the spine and the cascade band reserve their height.
- Budget: CSS ≈ 12 KB gzip (hand-written, tokens + components), fonts ≈ 90–110 KB, JS ≈ 120 KB budget
  as agreed with the architecture. No UI kit, no icon font, no animation library.
- Animate `transform` and `opacity` only; the grain is one fixed layer; typing writes one text node per
  frame.

---

## 11. Handoff

### 11.1 Tokens

Everything in §3–§6 is a CSS custom property in `:root` and `[data-theme="night"]`, exactly as named in
`web/src/styles/tokens.css`. The component CSS follows that token order.

### 11.2 Markup contracts (suggested)

| Element | Attribute | Meaning |
|---|---|---|
| `<article class="ch">` | `data-n="8"` `data-rev="3"` | chapter slot |
| `<p class="p">` | `data-block-id="ch08#aa11bb22"` | stable block id from ingestion |
| paragraph | `data-revising="draft|cascade"`, `data-change="chg_…"` | drives the ochre rule and the label |
| paragraph | `data-revised-at="ISO"` | drives the grey rule and the 24 h fade |
| footnote | `data-change="chg_…"` | one form per change, rendered once |
| comment | `data-status="new|accepted|applied|rejected|quarantined|expired|superseded"` | stamp + decision line |
| comment | `data-change="chg_…"` | link into the прицел |
| cascade band | `data-cascade="csc_…"` | rebuilt on reconnect |
| spine | `data-written="1-9,66-67"` | fills |

### 11.3 Server event → UI

| Event | UI |
|---|---|
| `hello` | catalog → опись, spine, header; `state` → live chip, queue |
| `state:updated` | queue count, chip, ribbon; **never** re-render chapter text |
| `chapter:created` | insert the chapter at its position, print it if it is in view, offer the pill if not |
| `chapter:revision` | apply the patch iff `rev === loadedRev + 1`; cross-fade 400 ms; mark blocks |
| `block:revising` | ochre rule + label; on `active:false` turn grey, fade after 24 h |
| `cursor:moved` | place the caret in the lane's chapter (draft only) |
| `change:queued` | queue count, comment line `ПРИНЯТО · N-Я В ОЧЕРЕДИ` |
| `change:processing` | chip «правится глава N», band header `ИДЁТ` |
| `change:stale` | one quiet line in the прицел: «основа изменилась: …» — never a modal |
| `cascade:progress` | band readout, stage ledger row, rings frontier; ≤ 1/s, coalesce |
| `change:decided` | footnote becomes closed, stamp `ВНЕСЕНО/СНЯТО`, thread line, band collapses to a record |
| `comment:added` | optimistic insert already done; reconcile by id |
| `comment:decision` | stamp + reason + link; `accepted` also shows the queue position |
| `engine:state` | header chip: `ПАУЗА` / `ПРАВКИ ПРИОСТАНОВЛЕНЫ`; text keeps reading |
| `presence` | one label at most, in the colophon — do not build a counter into the header |

### 11.4 Reveal

```
queue = blocks of the chapter not yet read by this client, in view ±window
for each block: chars = graphemes(text); cps = 18; t0 = now
onFrame: n = floor((now − t0)/1000 * cps); write chars[0..n]; if n == len → done
if scrolled away → drain at 8×; if reduced-motion → set full text, no caret
caret element follows the last printing block; remove when the queue is empty
```

### 11.5 What is theatre, and is labelled as such

The printing is a client-side performance over a finished file (ADR-006). That is why the copy says
«печатается» (what you see) and never claims to relay tokens. The прицел types only the changed
fragment, because a rewrite must not re-type old text. No other surface pretends to be live.

---

## 12. Deliberate exclusions, open questions

**Excluded on purpose:** dashboard, counters of viewers in the header, toasts, modals for comments,
progress rings, avatars, emoji, gradients, glow, blur/glass, rounded cards, icon set, sound.

**Open:**

1. The title is a live slot: `manuscript/00-front.md` line 1 starts as «Без названия» and changes when a
   front step lands. Only that line changes; the sheet is built for 5–12 characters.
2. Deep links into the прицел (`/p/chg_…`) — recommended, makes a change shareable; needs a 404 state
   for an old change («правка закрыта · сноска 013»).
3. The desktop outer-margin rail (footnote forms hanging into the margin at ≥ 1024 px) — drawn in this
   document, not built in v1.
4. Nothing in the design depends on the writing being fast. If the lane rests for hours, the page is
   still a book — that is the test every future addition must pass.
