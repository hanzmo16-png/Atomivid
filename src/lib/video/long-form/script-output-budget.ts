/** Sonnet 5 thinks by default: leave room for reasoning plus the documentary JSON. */
export function documentaryOutputBudget(model: string) {
  return model === "claude-sonnet-5"
    ? { max_tokens: 16_000, effort: "medium" as const }
    : { max_tokens: 8_000 };
}
