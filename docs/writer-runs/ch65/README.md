# The chapter-65 pass — the receipt

One pass, production, 2026-10-27. The owner's filing «А как?» on chapter 65 (filed 18:04:17Z) became the
chapter below: written by the pinned model, landed through the same control API any writer uses, read by
both gates, closed, and paid for in the ledger.

## The rows it left

| table | row |
|---|---|
| `steps` | `stp_01M5ZMGCTRPYYRQXRV150RDNZT` · ch65 · pass `change` · outcome **`rewritten`** · model `deepseek/deepseek-v4-pro` · **72 473 in / 62 227 out** · opened 21:33:20Z · closed 21:41:36Z |
| `gate_verdicts` | `editor HOLDS` (29 272 / 17 998) · `consultant HOLDS` (13 935 / 15 753) — both with the pinned model |
| `pass_spend` | `usd 0.171042` · `priced 1` · the day's total `$0.359229` of `$10` |
| `changes` | the operator change for the same goal: applied |
| `pass_stages` | `queued` → `read` → `drafting` ×2 → `chapter:revision`/`typing` → `landed` (the last stage carries the span, the tokens and the money) |

`GET /api/chapters/65` — 29 093 characters, 114 paragraphs. The file is
`manuscript/ch65.md`, and the frozen frame is untouched: ch01 opens on «Я вошёл в пустую комнату. Её
освещал яркий свет.», ch67 is still exactly «Свет погас, потому что не осталось глаз, которым он был бы
нужен.».

## What the machine wrote

- **First line (the title):** «Управление исполнения волеизъявлений о прекращении»
- **First prose line:** «В четыре часа ночи в помещении 4-07 Управления исполнения волеизъявлений о
  прекращении углеродной формы горело шесть люминесцентных панелей, и ни одна не мигала.»
- **Last line:** «А пока — ночь, тишина и тёплая батарея, к которой она прижалась ладонью, прежде чем
  лечь.»

## The reading, seen while it happened

`reveal/frames.json` is the socket trace of the page that was open on the chapter: the `pass:stage`
frames of the pass, then `chapter:revision` rev 3 (12 patch ops, not truncated) and a `typing` stage.
The rendered text grew while the reader watched — 27 824 → 27 964 → 28 120 → 28 288 characters in
~2.8 s — and `reveal/mid-type-1.png` / `mid-type-4.png` are two frames of that typing.

## The transcript

`transcript.json` is the run's own receipt: prompt sections with their hashes and sizes, every call
(kind, system, user, answer, usage, latency), the estimate before the first call, the result. No key, no
bearer token, no address, no session, no reader identity — only the book's own text and numbers.

## Taking it back

One command, on the scratch copy: `npm run writer -- --revert --chapter 64`. A chapter that did not exist
before its pass was removed and the site dropped it from `written`; a chapter with a previous revision is
restored from the stored snapshot and compared by sha (`глава 64: файл удалён; было sha aa14eade…`). The
same command exists for every chapter, and the engine records the restore as an operator action.
