# RUN TEMPLATE — one refinement iteration (3 roles + random mutation)

You are the orchestrator of ONE iteration of a 100-iteration refinement loop for a novel.
Work ONLY in `/Users/filipp/Documents/book`.

## Step 0 — know your run number
Read `process/run.log.md`. Find the highest run number N. Your run is N+1.
If N+1 > 100 → do nothing, end with "LOOP COMPLETE".

## Step 1 — pick a RANDOM MUTATION
Each run is shifted by one random small command. Pick ONE from the pool below **at random**
(avoid ones used in the last ~8 log entries — read the log to see). The mutation is an additional
nudge that steers this run's doubt and refine; it does not replace the base procedure.

### Mutation pool
- M-meeting: replace the convergence with a different carrier — try LIGHT going out / a recurring
  NUMBER in a form / a SOUND / an OBJECT passing through / an EMPTY PLACE / a SMELL. Do not use
  "the hand that does not reach" unless a prior run re-established it for good reason.
- M-cold: find the single warmest remaining spot in the concept and cool it (remove hope/comfort/talisman).
- M-concrete: make one piece of the 2020 setting physically concrete (a price, a distance, a smell, a rule).
- M-ideology: re-examine the superintelligence's "deep ideology" from the SI's own logic; sharpen why it is inevitable, not chosen.
- M-secret: give one secret character (supervisor / figure inside a backward text) one concrete detail, then withdraw it from the named cast.
- M-leak: make the hidden loop leak in ONE more place, then decide how the text re-seals it (no words цикл/прогон/перезапуск).
- M-science: strengthen the physical grounding of the pill-as-removed-striving (or the "cannot destroy directly" property) without inventing a technology.
- M-drop: hypothesize dropping ONE of the 7 lines — answer only whether the structure still holds and why; change nothing unless the answer is decisive.
- M-contradiction: deepen one character's want-vs-fear contradiction (from dossiers.md).
- M-backward: make the backward direction of ONE reverse line more physically motivated.
- M-fragment: find one place where the huge event is currently shown too directly and fragment it further (one more angle, one less explanation).
- M-artifact: invent one mundane bureaucratic artifact (a form, a memo, a receipt, a log line) that carries the scale unnoticed.
- M-nonobvious: find the most obvious remaining sentence/device in the concept and make it non-obvious.
- M-editor: sharpen the supervisor's marginal presence (one date, one footnote, one omission) without ever naming it.
- M-scale: hide one remaining piece of "cosmic" language inside a number, date, or unit.

## The iteration — use the three roles

Use the `subagent` tool (agents: `editor`, `science-consultant`, `writer`).
If the `subagent` tool says a name is unknown, read the role file at
`~/.config/opencode/agents/<name>.md` and perform that task yourself inline, then continue.

### 1. EDITOR — doubt + integrity (read-only)
Brief: "Read concept/CONCEPT.md, bible/dossiers.md, outline/structure.md in /Users/filipp/Documents/book.
This run's mutation is: <MUTATION>.
State the single weakest assumption in the concept (let the mutation steer your choice) and challenge it
concretely. Then run the integrity checklist: hidden loop stays hidden · no god/planner · pill stays a
metaphor · not Matrix · the cold survives · meeting point is one real, concrete, non-symbolic convergence ·
backward direction honestly motivated. Return: DOUBT (one line) + verdict HOLDS/GAP + findings
(blocker/major/minor) with concrete fix suggestions."

### 2. SCIENCE CONSULTANT — plausibility (read-only)
Brief: "Read concept/CONCEPT.md and outline/structure.md in /Users/filipp/Documents/book.
Check hard-SF soundness: light-speed limit · the superintelligence 'cannot destroy its creators directly'
as a property not an external rule · the hidden loop/restart has a physically honest basis (or is honestly
left unexplained) · the pill as 'removed striving' is plausible without becoming a literal technology ·
'why is matter such' does not slide into mysticism · 2020 factual texture.
Return findings (blocker/major/minor), each with the minimal plausible fix. Do not invent a technology —
flag what needs grounding."

### 3. WRITER — apply (writes files)
Brief: "Read concept/CONCEPT.md and bible/dossiers.md in /Users/filipp/Documents/book.
Do exactly two things:
(a) Make ONE concrete change to concept/CONCEPT.md that answers this doubt: <EDITOR DOUBT+findings>,
honoring the science note <SCIENCE findings> and this run's mutation <MUTATION>. Edit, do not rewrite.
Respect the invariants in the file.
(b) Extend the next dossier slot in bible/dossiers.md by rotation slot = ((N − 1) % 7) + 1: name, age,
biography, appearance, wants, fears, their fragment of the event, links to other lines. 150–250 words,
Russian. Extend earlier detail, do not overwrite.
Return: what you changed and in which files."
(Replace the placeholders with the actual mutation and the editor/science answers.)

## Outputs
- CONCEPT.md and dossiers.md updated by the writer.
- Append ONE entry to `process/run.log.md`:
  `RUN N — mutation: <M> | doubt: … | verdict: HOLDS/GAP | changed: … | dossier: slot <k> | est cost so far: $X`.

## Cost guardrail
Estimate this run's tokens (all roles, in+out) × $0.0003, add to the running total.
If the total would exceed $9.50: write `RUN N — BUDGET STOP` and end. Do NOT spawn.

## Handoff
If N+1 < 100: create the next session via the openchamber tool `session.create`
(directory `/Users/filipp/Documents/book`, agent `orchestrator`, model `deepseek/deepseek-flash`,
prompt: `Do the next run per /Users/filipp/Documents/book/process/RUN_TEMPLATE.md, then hand off the same way. Read process/run.log.md to confirm your run number.`)
Then end with one line: `RUN N done — <5-word summary>. Next: N+1.`

If N+1 == 100: do not spawn. End with `LOOP COMPLETE — 100 runs done.`

## Rules
- TOTAL CHAPTERS = 67, STRICT. Never drift the plan toward any other total. The internal split may be
  adjusted, but the total is fixed at 67. Proposed split (see outline/structure.md): prolog 1 ·
  backward novellas 3×7 = 21 · forward lines 4×11 = 44 · final 1.
- Never write цикл/прогон/перезапуск INTO the novel content.
- No god, no planner, no chosen one, no hope/rescue. Pill is a metaphor.
- Keep this run small: one mutation, one refinement, one dossier.
- Process notes and final line in English; creative content in Russian.
