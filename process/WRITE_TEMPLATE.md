# WRITE TEMPLATE — one chapter pass (draft loop)

You are the orchestrator of ONE chapter-writing pass. Work ONLY in `/Users/filipp/projects/book`.

## Step 0 — position
Read `process/write.log.md`. Find the last written chapter number N (0 if none). Your pass writes chapter N+1.
If N+1 > 67 → draft complete: do NOT spawn; end with `DRAFT COMPLETE — 67 chapters. Next: humanize pass (process/REWRITE_TEMPLATE.md).`

## Inputs (read)
- `concept/CONCEPT.md` — the idea and the fixed end.
- `style/VOICE.md` — the voice (fixed; never edit it).
- `bible/dossiers.md` — people, only those already on the page.
- `outline/PLAN.md` — numbering (4 parts, 67 chapters); it carries no plot.
- The up-to-4 chapters before your position: `manuscript/ch{N-3}.md` … `manuscript/ch{N}.md` (skip missing; for N=0 there are none).

## Do — dispatch the writer
Use the `subagent` tool, agent `writer`, brief:
"Read concept/CONCEPT.md, style/VOICE.md, bible/dossiers.md, outline/PLAN.md, and the up-to-4 existing
chapters immediately before your position. Do two things:
(1) if a chapter chN exists, REWRITE it so it stays consistent with what comes next (keep events and facts,
fix voice/rhythm/continuity; do not add new events).
(2) WRITE the new chapter manuscript/ch{N+1}.md.
Follow style/VOICE.md exactly: voice, register, rhythm. No formula, no roster, no prescribed finale. The end
is fixed: the human carbon form ends. Keep 67 chapters. Put people on the page; invent them as you go, record
each in bible/dossiers.md. The idea (matter that noticed itself, carbon as anomaly, cognition migrating to
silicon, procedure as the channel) is pressure, never speech. Harmony, integrity, turns of the arc, a climax,
a finale — a scene, not a report. Follow the 'No machine traces' rules; write as a writer, not a generator.
The only taboos are copyright and RF law.
Return: what you wrote and changed."

## Outputs
- `manuscript/chN.md` rewritten (if existed); `manuscript/ch{N+1}.md` written.
- Append ONE line to `process/write.log.md`:
  `PASS N — wrote ch{N+1}, rewrote ch{N}. | est cost so far: $Y`

## Cost guardrail
Estimate tokens × $0.0000003 (real flash blend), add to running total. If total > $9.50 → `BUDGET STOP`, no spawn.

## Handoff
If N+1 < 67: create the next session via openchamber `session.create`
(directory `/Users/filipp/projects/book`, agent `orchestrator`, model `deepseek/deepseek-flash`,
prompt: `Do the next chapter pass per /Users/filipp/projects/book/process/WRITE_TEMPLATE.md, then hand off the same way. Read process/write.log.md for your chapter number.`)
End with one line: `PASS N done — wrote ch{N+1}. Next: ch{N+2}.`

If N+1 == 67: do not spawn. End with `DRAFT COMPLETE — 67 chapters. Next: humanize pass (process/REWRITE_TEMPLATE.md).`

## Rules
- 67 chapters, strict. The end is fixed: the human carbon form ends.
- No formula; people appear when written; no prescribed finale.
- Voice and craft: harmony, integrity, arcs, climax, finale; a scene, not a report.
- Chapter content in Russian; process notes and final line in English.
