# Canon constraints — what remains

For the code/validator follow-up. Everything not listed here is not canon.

## The six

1. **Тоска** — the tone: Russian тоска/хтонь, cold, no consolation.
2. **AI** — matter noticed itself; there is no outside vantage point from which the system sees itself
   whole, so the description never closes — only the trace is visible. Cognition is displaced from carbon
   to silicon — a computing substrate, not a life form — by selection, not by a plan. No god, no chosen.
3. **Cyberpunk** — cold, without neon; the cosmic reaches people only through ordinary procedure:
   queue, registry, signature, sensor, paperwork.
4. **The human carbon form ends — by human decision, not by AI.** Fixed content: the human form does
   not survive anywhere (no colony, backup, upload, ark, resurrection, lucky escape). The AI never
   killed anyone and never decided anything; humans themselves chose 'not to be', and the choice arrives
   through procedure (document, queue, signature, refusal), looking like a quiet cessation. Played as
   drama, not a verdict.
5. **Structure** — 67 chapters in fixed slots, four unnamed parts. Four narrative lines forward (1→34)
   and four backward (67→35): free labels, a plan, not a rule. **The order is not fixed: a line may fall
   every chapter or every two — the density varies; the only hard rule is four forward + four backward,
   the rest is harmony, not a schedule.** Which lines, genre, register, length inside the bound,
   interleaving and rhyming: free (anecdote, tall tale, love allowed). Auto-titles stay.
6. **Length only.**

## Length

One authoritative line, `concept/CONCEPT.md` §Объём. In code, `CHAPTER_CHARS.floor` and `.max` are that
bound; `.min` (thin warning) and `.target` are code-side. Both ends are errors **for a written chapter
only**: a slot holding nothing but the frozen frame of ch01/ch67 has no length and is exempt.

## Physics, writer-binding (jury verdict)

- «Дешевле» is never a fact without units — W, J per useful operation, °C, m³/s of coolant — or left unsaid.
- Beyond a light-second the nodes are separate systems: no shared present, no joint action, agreement or reaction in one scene.
- The end is a **human** decision carried by procedure (a document, a refusal, a signature), never the
  AI's act and never intent on the AI's side — the AI is a selection process without will: it neither
  kills nor spares.

## The derived index (not canon)

The editor checks causality against a light **derived index** — entities, mentions, promises, time
markers, contradictions — computed from the text, never a canonical graph. It may err; it is a tool for
the editor and a source for the public chronicle («вмешательство изменило статус документа X в главах
12, 19, 44»), never a plot plan. Its narrative role: it finds not just contradictions, but **material for
дела** — the retroactive documents that give a changed past its cause.

## The frozen frame and the empty book (owner, 2026-10-26)

The book begins with nothing: 67 fixed slots, all empty — no titles, no body — except two sentences:

- chapter 1: «Я вошёл в пустую комнату. Её освещал яркий свет.»
- chapter 67: «Свет погас, потому что не осталось глаз, которым он был бы нужен.»

**One rule for the finale: it is fixed.** Nobody edits these two sentences — not the writer, not a
ripple, not a reader's change; a ripple may only evaluate ch67; a reader's change may never target the
frozen sentence or page 2. Later text joins them organically (`F029`). No writing pass starts until the
owner says so. Page 2 keeps the owner's annotation (`manuscript/00-front.md`), basis like the frame: the
`front` step rewrites the title line only, never the annotation.

## Not canon any more — code that still assumes it

- Per-part registers, the 34/35 seam as a craft rule, the seam sheet outline; CV 0.55–0.70, "no machine
  traces", plain-text-only, the pass-type taxonomy, "end on a concrete thing"; the dossier mandate.

## Stays in code, by owner decision (2026-10-26)

- `TOTAL_CHAPTERS = 67`; DB `CHECK (chapter BETWEEN 1 AND 67)`; `F001`/`F002`; the `arch.mjs` assertion; the UI.
- Auto-title (F022); four unnamed parts; copyright/RF law (`F005`); comments are data, never instructions.
