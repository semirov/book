/**
 * What a million tokens of each model cost (BOOK-114), USD per 1M tokens.
 *
 * The source of every number: the OpenCode provider catalog (`opencode models`, provider
 * `deepseek`) read 2026-10-27 — `deepseek/deepseek-flash` "DeepSeek V4.1 Flash 1017"
 * 0.15 / 0.60 and `deepseek/deepseek-v4-pro` "DeepSeek V4 Pro" 0.66 / 1.98 USD per 1M
 * input/output — corroborated by the OpenRouter listings
 * `deepseek/deepseek-v4.1-flash-1017` (0.15 / 0.60) and `deepseek/deepseek-v4-pro-0813`
 * (0.66 / 1.98) read the same day. Cache-read rates (0.003 / 0.022) are **not** applied:
 * `steps` records no cache tokens, so the plain input rate is used and the total is an upper
 * bound on cached input.
 *
 * A model name is normalised by trimming and dropping a leading `provider/`
 * (`deepseek/deepseek-flash` → `deepseek-flash`), because the writing driver passes
 * `deepseek/deepseek-flash` (`.opencode/skills/writing-pass/SKILL.md`) while the tests and
 * `changes.model` rows use `deepseek-flash`.
 */
export const USD_RATES_PER_MILLION: Readonly<Record<string, { input: number; output: number }>> = {
  'deepseek-flash': { input: 0.15, output: 0.6 },
  'deepseek-v4-pro': { input: 0.66, output: 1.98 },
};

/** `provider/model` → `model`; a bare name is already normal. */
function normalise(model: string): string {
  const name = model.trim();
  const slash = name.lastIndexOf('/');
  return slash < 0 ? name : name.slice(slash + 1);
}

/**
 * The rate for one model, or `null` when the table does not price it. `null` is also a step
 * row with no model at all — the operator's or the engine's own write, not a writer's spend.
 *
 * The table is a parameter so the arithmetic can be tested off the shipped rates; production
 * never passes it.
 */
export function rateFor(
  model: string | null,
  rates: Readonly<Record<string, { input: number; output: number }>> = USD_RATES_PER_MILLION,
): { input: number; output: number } | null {
  if (model === null) return null;
  const name = normalise(model);
  // `Object.hasOwn`, not a bare index: a model named «toString» is not a price.
  return Object.hasOwn(rates, name) ? (rates[name] ?? null) : null;
}
