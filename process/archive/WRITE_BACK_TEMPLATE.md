# WRITE BACK TEMPLATE — backward half (chapters 67→35)

You are the orchestrator of ONE backward chapter pass. Work ONLY in `/Users/filipp/Documents/book`.

## Step 0 — position
Read `process/write.back.log.md`. Find the lowest written chapter B. If none, you write chapter 67 first.
Otherwise your pass writes chapter B−1.
If B−1 < 35 → backward half already complete; do NOT spawn.

## Inputs (read)
- `manuscript/PLAN.md` — line/scene for the chapter you write.
- `style/VOICE.md` — stable vocabulary core (fixed; includes the causality rule).
- `concept/CONCEPT.md` + `bible/dossiers.md` — canon + characters.
- `process/causes.fwd.md` + `process/causes.back.md` — cross-cycle causality ledger.
- If you are writing chapter 67 (first backward pass): read `concept/CLIMAX.md` and follow it exactly.
- The up-to-4 chapters after your position: `manuscript/ch{B}.md` … `manuscript/ch{B+3}.md` (skip missing).

## Do — dispatch the writer
Use the `subagent` tool, agent `writer`, brief:
"Read style/VOICE.md, concept/CONCEPT.md, bible/dossiers.md, manuscript/PLAN.md, process/causes.fwd.md,
process/causes.back.md [and concept/CLIMAX.md if writing chapter 67], and the up-to-4 existing chapters
manuscript/chNN.md immediately after your position. Do two things:
(1) if a chapter chB exists, REWRITE it for consistency (keep events/facts; you may plant a hidden cause
that an earlier effect will need);
(2) WRITE the new chapter manuscript/ch{B−1}.md per PLAN.md [if B−1 == 67, follow CLIMAX.md exactly].
CAUSALITY (strict): every effect must have a cause. The cause is mundane and hidden — queue, right,
signature, sensor, actuator, registry, paper — never stated as explanation, but traceable. No 'sam soboi',
no unmotivated events. If an effect's cause must live in the FORWARD half, do not invent it here — record it
as NEEDS. Write like a WRITER, not a form-filler: style/VOICE.md is a compass (tone, taboos, formula),
not a checklist — select details, build rhythm, create subtext, the reader must feel the cold. Quality
over padding: a strong chapter may be shorter than 9000 знаков. Invariants: no god, no named loop, pill is
a metaphor, cold, no hope/chosen one, the formula «Рука пошла и не дошла» once per line exactly per
CONCEPT.md. Return: what you wrote/changed, causes planted, causes needed."
If `subagent` does not recognize `writer`, write the chapter yourself per style/VOICE.md.

## Outputs
- `manuscript/chB.md` rewritten (if existed); `manuscript/ch{B−1}.md` written.
- Append ONE line to `process/write.back.log.md`:
  `BACK PASS — wrote ch{B−1} (line <X>), rewrote ch{B}.`
- Append to `process/causes.back.md`:
  `PLANTED: <cause> — ch{B−1}` for each hidden cause you seeded;
  `NEEDS: <effect> — cause to plant in the forward half` for each effect whose cause lives there.

## Handoff
If B−1 > 35: create the next session via openchamber `session.create`
(directory `/Users/filipp/Documents/book`, agent `orchestrator`, model `deepseek/deepseek-flash`,
prompt: `Do the next backward chapter pass per /Users/filipp/Documents/book/process/WRITE_BACK_TEMPLATE.md, then hand off the same way. Read process/write.back.log.md for your chapter number.`)
End with one line: `BACK ch{B−1} done. Next: ch{B−2}.`

If B−1 == 35: append `BACK DONE (ch67..35).` to the log, then read `process/write.fwd.log.md`.
If it contains `FWD DONE` → create the reweiter session (prompt: `Run the reweiter pass per /Users/filipp/Documents/book/process/REWRITE_TEMPLATE.md`) and end with `BACK DONE, FWD DONE — reweiter started.`
Otherwise end with `BACK DONE — waiting for the forward half.`

## Rules
- Never write цикл/прогон/перезапуск into the chapters. Pill is a metaphor. No god/chosen one/hope.
- Causality: every effect has a hidden but real cause. No unmotivated events.
- Keep the meeting-point formula exact and once per line.
- Chapter content in Russian; process notes and final line in English.
