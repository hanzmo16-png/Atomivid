/** Minimal, non-secret configuration for the authenticated admin panel. */
export function scriptConfigSummary(env: Record<string, string | undefined>) {
  const safeModel = (value: string) => /^claude-[a-z0-9.-]{1,80}$/.test(value) ? value : "Configuración no reconocida";
  const rate = (key: string, fallback: number) => {
    const raw = env[key];
    const parsed = Number(raw);
    return { usd: raw && Number.isFinite(parsed) ? parsed : fallback, source: raw && Number.isFinite(parsed) ? "Configurada" : "Valor predeterminado" };
  };
  const general = env.ANTHROPIC_SCRIPT_MODEL || "claude-sonnet-5";
  return {
    shortModel: safeModel(general),
    longModel: safeModel(env.ANTHROPIC_LONG_FORM_SCRIPT_MODEL || general),
    longSource: env.ANTHROPIC_LONG_FORM_SCRIPT_MODEL ? "Modelo específico de documental" : env.ANTHROPIC_SCRIPT_MODEL ? "Modelo general de guion" : "Valor predeterminado",
    input: rate("PRICING_SCRIPT_INPUT_USD_PER_1M_TOKENS", 2),
    output: rate("PRICING_SCRIPT_OUTPUT_USD_PER_1M_TOKENS", 10),
  };
}
