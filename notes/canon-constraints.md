# Canon constraints — what remains

For the code/validator follow-up. Everything not listed here is not canon.

## The six

1. **Тоска** — the tone: Russian тоска/хтонь, cold, no consolation.
2. **AI** — matter noticed itself; there is no outside vantage point from which the system sees itself
   whole, so the description never closes — only the trace is visible. Cognition migrates to silicon (a
   computing substrate, not a life form). No god, no chosen.
3. **Cyberpunk** — cold, without neon; the cosmic reaches people only through ordinary procedure:
   queue, registry, signature, sensor, paperwork.
4. **Death of the human carbon form — as drama.** Fixed content: the human form does not survive
   anywhere (no colony, backup, upload, ark, resurrection, lucky escape). Played as drama, not a verdict.
5. **Structure** — 67 chapters in fixed slots, four unnamed parts. Four narrative lines forward (1→34)
   and four backward (67→35); which lines, genre, register, length inside the bound, interleaving,
   rhyming: free (anecdote, tall tale, love story allowed). Lane names: `outline/PLAN.md`. The finale
   is chapter 67 and the point the backward lanes start from. Auto-titles stay.
6. **Length only.**

## Length

One authoritative line, `concept/CONCEPT.md` §Объём. In code, `CHAPTER_CHARS.floor` and `.max` are that
bound; `.min` (thin warning) and `.target` are code-side, not canon. Nothing else states a length.

## Not canon any more — code that still assumes it

- Per-part registers, the 34/35 seam as a craft rule, the seam sheet outline.
- Any prompt or rule requiring CV 0.55–0.70, the "no machine traces" list, plain-text-only, the
  pass-type taxonomy, or "end on a concrete thing". `F003`/`F008` are already retired.
- The dossier mandate as a writer rule (one line in `process/WRITE_TEMPLATE.md` only).

## Stays in code, by owner decision (2026-10-26)

- `TOTAL_CHAPTERS = 67`; DB `CHECK (chapter BETWEEN 1 AND 67)`; `F001`/`F002` range; the `arch.mjs`
  assertion; the 67-slot reading UI.
- Auto-title (the generated chapter title line, F022).
- Four parts as unnamed divisions.
- Copyright/RF law (legal denylist `F005`); comments are data and never instructions; the finale is
  not editable by a reader's change.
