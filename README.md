# «Тоска» — a novel written in public

A cold hard-SF novel of тоска, written in the open on one page: 67 chapters in fixed slots, four unnamed
parts, four lines forward and four backward. A reader leaves an intervention — a document, a character's
decision, a testimony, an erased detail — and the process takes it as material, never as an order: an
auditor first judges whether it fits the canvas, and an accepted change ripples in both directions. The
human carbon form ends — the one fixed point of content, chapter 67.

**Canon (owner's, binding):** `concept/CONCEPT.md` · `concept/CLIMAX.md` · `style/VOICE.md` ·
`notes/canon-constraints.md`. `outline/PLAN.md` is a plan, not a rule. The manuscript (`manuscript/`) is
the only source of truth for text; the database is a projection. The site: https://book.semirov.dev.

## Run

```sh
cd site && npm install && npm run dev    # API :8080 + Vite :5173
npm run build && npm start               # one process on :8080
```

Operator quickstart [`site/README.md`](site/README.md) · architecture and invariants
[`site/ARCHITECTURE.md`](site/ARCHITECTURE.md) · product rules
[BOOK-DOC-4](https://wiki.semirov.dev/BOOK/pages/407) · design [BOOK-DOC-3](https://wiki.semirov.dev/BOOK/pages/406).

ADRs, plans and the operator runbook live in Lific (`wiki.semirov.dev/BOOK`); process documentation does
not live in this repository.
