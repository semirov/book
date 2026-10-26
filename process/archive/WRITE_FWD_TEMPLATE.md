# WRITE FWD TEMPLATE — forward half (chapters 1→34)

You are the orchestrator of ONE forward chapter pass. Work ONLY in `/Users/filipp/Documents/book`.

## Step 0 — position
Read `process/write.fwd.log.md`. Find the last written chapter F (0 if none). Your pass writes chapter F+1.
If F+1 > 34 → forward half already complete; do NOT spawn.

## Inputs (read)
- `manuscript/PLAN.md` — line/scene for chapter F+1.
- `style/VOICE.md` — stable vocabulary core (fixed; includes the causality rule).
- `concept/CONCEPT.md` + `bible/dossiers.md` — canon + characters.
- `process/causes.fwd.md` + `process/causes.back.md` — cross-cycle causality ledger.
- The up-to-4 chapters before your position: `manuscript/ch{F-3}.md` … `manuscript/ch{F}.md` (skip missing; none for F=0).

## Do — dispatch the writer
Use the `subagent` tool, agent `writer`, brief:
"Read style/VOICE.md, concept/CONCEPT.md, bible/dossiers.md, manuscript/PLAN.md, process/causes.fwd.md,
process/causes.back.md, and the up-to-4 existing chapters manuscript/chNN.md immediately before your
position. Do two things:
(1) if a chapter chF exists, REWRITE it for consistency (keep events/facts; you may plant a hidden cause
that a later effect will need);
(2) WRITE the new chapter manuscript/chF+1.md per PLAN.md.
CAUSALITY (strict): every effect in the chapter must have a cause. The cause is mundane and hidden — queue,
right, signature, sensor, actuator, registry, paper — never stated as explanation, but traceable. No
'sam soboi', no unmotivated events. If an effect's cause must live in the BACKWARD half, do not invent it
here — record it as NEEDS (see Outputs). Write like a WRITER, not a form-filler: style/VOICE.md is a
compass (tone, taboos, formula), not a checklist — select details, build rhythm, create subtext, the
reader must feel the cold. Quality over padding: a strong chapter may be shorter than 9000 знаков.
Invariants: no god, no named loop, pill is a metaphor, cold, no hope/chosen one, the formula «Рука пошла
и не дошла» once per line exactly per CONCEPT.md. Return: what you wrote/changed, causes planted, causes needed."
If `subagent` does not recognize `writer`, write the chapter yourself per style/VOICE.md.

## Outputs
- `manuscript/chF.md` rewritten (if existed); `manuscript/chF+1.md` written.
- Append ONE line to `process/write.fwd.log.md`:
  `FWD PASS — wrote ch{F+1} (line <X>), rewrote ch{F}.`
- Append to `process/causes.fwd.md`:
  `PLANTED: <cause> — ch{F+1}` for each hidden cause you seeded;
  `NEEDS: <effect> — cause to plant in the backward half` for each effect whose cause lives there.

## Handoff
If F+1 < 34: create the next session via openchamber `session.create`
(directory `/Users/filipp/Documents/book`, agent `orchestrator`, model `deepseek/deepseek-flash`,
prompt: `Do the next forward chapter pass per /Users/filipp/Documents/book/process/WRITE_FWD_TEMPLATE.md, then hand off the same way. Read process/write.fwd.log.md for your chapter number.`)
End with one line: `FWD ch{F+1} done. Next: ch{F+2}.`

If F+1 == 34: append `FWD DONE (ch01..34).` to the log, then read `process/write.back.log.md`.
If it contains `BACK DONE` → create the reweiter session (prompt: `Run the reweiter pass per /Users/filipp/Documents/book/process/REWRITE_TEMPLATE.md`) and end with `FWD DONE, BACK DONE — reweiter started.`
Otherwise end with `FWD DONE — waiting for the backward half.`

## Rules
- Never write цикл/прогон/перезапуск into the chapters. Pill is a metaphor. No god/chosen one/hope.
- Causality: every effect has a hidden but real cause. No unmotivated events.
- Keep the meeting-point formula exact and once per line.
- Chapter content in Russian; process notes and final line in English.
