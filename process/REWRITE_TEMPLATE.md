# REWRITE TEMPLATE — pass 2 (humanize, remove AI tells)

Run AFTER the draft loop completes (67 chapters). ONE pass over all chapters, 1→67.

Per chapter: load the skill (`skill` id `ai-text-rewriter`) and rewrite the chapter so AI detectors and
human readers stop seeing LLM tells — PRESERVING meaning, facts, stance and the voice (style/VOICE.md).
Verify with the `ai-text-detector` skill; iterate the chapter until it reads clean, then move on.
Do not flatten the voice, do not warm the cold.

Log progress in `process/write.log.md` (`REWEITER chN done`). Final line: `REWEITER COMPLETE — 67 chapters humanized. Next: optional polish pass.`
