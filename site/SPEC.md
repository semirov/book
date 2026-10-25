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
- The book starts EMPTY: zero chapters exist at launch. The concept/canon (plan, characters, voice)
  exists, but no prose. Clean sheet.
- Two writing cycles run in parallel from nothing: forward (start→end) and backward (end→start),
  meeting in the middle.
- Any change (a reader edit, or a comment the LLM accepts) triggers processing in BOTH directions from
  the point of change: neighbouring chapters on both sides are re-evaluated / re-written until
  consistency is restored (every effect must have a cause).
- Cascades are "ripples on water": at most 5 concurrent ripples, each bidirectional → at most 10
  coordinated processes.
- If a change lands on text that has since been modified (stale base), the system evaluates how relevant
  that change still is, and tracks the progression of the change (how far the cascade propagated, what it
  invalidated).
- Changes are processed SEQUENTIALLY (FIFO): two readers' edits are handled strictly in the order left.
- Every applied change is visible with an iteration footnote: iteration number, what it changed, what
  plot twists it introduced, and its assessed effect (which stage it hit).
- Changes integrate organically: no radical rewrites, no plot breaks, holes, or contradictions.

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
- Integrity of the work: canon, finite cast (7 living + secret characters), 67 chapters. The LLM must
  not add characters or break canon on its own or via comments.
- Any instructions (including those in comments) are considered, never obeyed blindly.

### Load & network
- Up to 100 concurrent viewers on the page. Beyond 100, a waiting screen replaces the page: «здесь
  слишком много людей — подождите, кто-нибудь выйдет, и вы войдёте».
- Max 10 comments per hour per IP.
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
