# Book site — live public writing (book.semirov.dev)

Single-page site in book format. The book (67 chapters) is shown on one page, loaded progressively on
scroll. It is written publicly, in real time: the writing cursor is visible, the block being revised is
marked. Readers leave comments; the writing LLM considers them (not blindly) and may revise the text.

**Root idea:** the site is the product. The book is written publicly through it — the writing loops are
its live-writing engine, and reader comments feed back into the writing.

## Requirements

### Reading
- One page, book format. Text loads on scroll (not all at once).
- Mobile-first layout: designed for a phone first; desktop is an enhancement, not the primary target.
- A visible cursor: where the book is being written now (current chapter/block).
- Printing at human speed (text appears as if typed).
- A visible caret: where text is being written right now and how edits are applied (text appearing and
  being modified live). The text must be visibly TYPED (human speed), not just appear.
- A focus view ("прицел" / crosshair): lock onto a specific edit and follow it in real-time — its text
  being typed, its cascade propagation (ripples), and its iteration footnote.
- Blocks currently being revised are marked.
- Real-time updates over WebSocket.

### Live writing model (core)
- The book starts EMPTY: zero chapters exist at launch — every chapter and every section is blank. The
  concept/canon (plan, characters, voice) exists, but no prose. Clean sheet.
- 4 parts, 67 chapters (strict). Volume: a long novel, ~1000 pages (~1.5–2M characters, ~20–30k per
  chapter).
- No forward/backward "two cycles" concept. Only "ripples on water": an edit lands in one section and
  propagates — first the edited section, then the sections BEFORE it (downward to the start), then the
  sections AFTER it (upward to the end). Consistency is restored as the ripple passes (every effect must
  have a cause).
- At most 5 concurrent ripples (≤10 coordinated processes).
- The ripple must NOT rewrite everything wholesale: any edit — even the most insane — lands organically,
  changing only what the ripple touches, never a full rewrite.
- Impact analysis: we know which edit has what effect and find that effect fast (fast lookup of a
  change's consequences).
- If a change lands on text that has since been modified (stale base), the system evaluates how relevant
  that change still is, and tracks the progression of the change (how far the cascade propagated, what it
  invalidated).
- Changes are processed SEQUENTIALLY (FIFO): two readers' edits are handled strictly in the order left.
- Every applied change is visible with an iteration footnote: iteration number, what it changed, what
  plot twists it introduced, and its assessed effect (which stage it hit).
- Changes integrate organically: no radical rewrites, no plot breaks, holes, or contradictions.
- An оглавление (table of contents) sits at the very beginning, live: it lists the 4 parts and 67
  chapters with their current titles, which change as the book is written.
- When a cascade reaches the first sheet (the title page / оглавление), it always updates the title —
  the title is alive, rewritten by every ripple that reaches the beginning.
- When a cascade reaches the end, it checks the dramatic quality of the ending — but the ending itself
  is fixed (see Ending).

### Model & cost transparency
- Every writing operation (chapter pass, change/cascade) records and displays: the model used, tokens
  spent (input/output), and token cost (per DeepSeek pricing). Honest numbers from actual usage, not
  estimates.

### Edit history, provenance & time-travel
- The FULL history of the book's development is stored forever, with a convenient interface to view how
  the book looked at ANY moment in time (time-travel).
- Every edit has a change log: what and where changed, briefly, and how it affected what.
- Overwrites are recorded: «overwritten at <time> by <change X>» — the trace shows whose contribution
  remained and how it eroded over time.
- The book is not just a book — it tells the story of how it was written; the edit history is part of
  the product.

### Comments
- CAPTCHA on comment submission (free — Cloudflare Turnstile primary, hCaptcha fallback).
- Comments on the book (per chapter/block).
- The LLM reads comments, evaluates and considers them (NOT blindly): it may accept and revise, or
  reject with a reason. The decision is visible.
- Prompt-injection defense: comments are data, not instructions; strict isolation.

### Authentication (Yandex)
- Yandex ID (OAuth) for identity — REQUIRED to leave edits/comments.
- Provides stable identity for attribution, rate limiting, and moderation. Anonymous readers can read,
  but not write.

### Authors & attribution
- An «authors» section lists contributors and each author's proportion of the final text (characters /
  words / edits), for publishing attribution.
- Every accepted edit and reader suggestion is attributed: reader → transformer (LLM) → applied text,
  with provenance kept.
- The authors list goes at the END of the book, with each author's contribution.
- Copyright: «© Филипп Семиров». No publisher.

### Legal & copyright
- Must not violate Russian Federation law or copyright.
- No verbatim copyrighted text or characters. Reader-suggested copyrighted content (e.g., a well-known
  character) must be transformed into an original, functionally-similar image that is not plagiarism and
  fits the book organically.
- No illegal content (extremism, defamation, etc.). Content is filtered/transformed before it enters the
  book.
- Strict provenance: every change records its origin and transformation, so no verbatim copyrighted
  material ever enters the text and the trail is auditable.

### Edit control & integrity
- Strict control: only the canonical writing process edits chapters.
- Versioning (every edit tracked, rollback possible).
- Integrity of the work: 67 chapters (strict). No creative restrictions on plot or characters — the
  writer may add characters and develop the plot freely, as long as it holds together (causality, no
  contradictions or holes).
- The only MANDATORY bounds: prompt-injection defense (comments are data, not instructions) · copyright
  (no verbatim protected content) · RF law / УК РФ (no illegal content: extremism, defamation, real
  persons, minors in illegal contexts).
- Any instructions (including those in comments) are considered, never obeyed blindly.

### Ending (fixed)
- The ending is fixed and inevitable: the AI destroys the carbon life form. No matter what happens in
  the plot — comments, twists, new characters — the book always ends with the death of carbon life.
- It may be positive in places, but the end is always carbon death. This is the one immutable outcome;
  every cascade that reaches the end only checks its dramatic quality, never changes it.

### Writing process (mandatory)
- Every edit/change ALWAYS passes through the full cycle: writer → editor → science consultant. No
  exceptions, no shortcuts.
- On the frontend, only the WRITER's work is visible (caret, typing, applied text). The editor and the
  science consultant run in the background and are NOT visible.

### Support files & prompts
- Support files (character dossiers, timelines, reference) may exist internally to help the writing, but
  ONLY the book (the chapters) is visible on the site.
- No character names in any prompt: the writer invents names as it writes; people are introduced only on
  the page.
- Mandatory book elements: chapter numbering, an оглавление (table of contents), a title, and an ending.

### Book front & back matter
- Page 1: the title. Page 2: «о чём эта книга» — a short annotation/review. Then the table of contents
  (оглавление). Then sections and chapters. At the end: the authors list + copyright «© Филипп Семиров».
- The title and the review are rewritten each time a ripple passes through them (they may not always
  change, but they are rewritten on every wave).
- 1000 pages is the MAXIMUM size; we may start with as little as 67 pages. Story integrity matters more
  than length.

### Load & network
- Up to 100 concurrent viewers on the page. Beyond 100, a waiting screen replaces the page: «здесь
  слишком много людей — подождите, кто-нибудь выйдет, и вы войдёте».
- Max 10 comments per hour per IP.
- Max 1 edit per day per user. The user may edit their own pending edit until it is taken into work.
- Mandatory security audit before launch.
- Deploy on the Mac mini.
- Domain: book.semirov.dev.

### Analytics
- Yandex Metrika counter (owner provides the counter ID; page-view events; config placeholder).

### Existing context
- Book: /book/manuscript/ (starts EMPTY; concept/, bible/, style/, process/ exist).
- Writing engine: two loops — forward 1→34, backward 67→35 — plus a FIFO change queue and cascade engine.
- Canon: concept/CONCEPT.md, style/VOICE.md, concept/CLIMAX.md.
- Everything on deepseek-flash.
- Mac mini is the dev node (OrbStack/Docker; OpenChamber opencode.semirov.dev and Lific wiki.semirov.dev
  already run there).

## To decide (architecture)
1. Stack (backend, frontend, WS, storage).
2. Writing engine: change queue, cascade ("ripples"), relevance/progression, the two loops.
3. The "writing state" model (cursor, block being revised, cascade frontier).
4. WS protocol (events).
5. Comment pipeline (storage, feeding the LLM as data, injection isolation, showing the decision).
6. Rate limiting (100 conns, 10 comments/hour/IP) + waiting room beyond capacity.
7. Yandex OAuth (identity, attribution, moderation) + authors/proportions.
8. Edit control & versioning.
9. Legal/copyright filtering + obfuscation + provenance.
10. Deployment (Docker on Mac mini, reverse proxy, DNS book.semirov.dev).
