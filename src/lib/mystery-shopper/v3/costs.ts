/**
 * Mystery Shopper 3.0 — matriz de costos para UNA autorización consolidada de generaciones reales.
 * Tarifas tomadas del propio código (src/lib/billing/pricing.ts, providers/*). Son estimaciones;
 * el tope (capUsd) es el límite duro que el worker pasaría como maxCostUsd y que corta la ejecución.
 * Hoy APPROVED_REAL_BUDGET_USD = 0: nada de esto corre sin el cambio revisado y el OK de Hans.
 */
export const RATES = {
  elevenLabsUsdPer1kChars: 0.1, // pricing.ts (PRICING_ELEVENLABS_USD_PER_1K_CHARS, defecto)
  heygenUsdPerSecond: 0.0385, // providers/avatar/heygen.ts
  recraftUsdPerImage: 0.035, // providers/image/recraft.ts
  runwayUsdPerSecond: 0.05, // providers/video-gen/runway.ts
  scriptUsdPerRun: 0.03, // guion corto con el modelo de guion (tokens estimados)
} as const;

export type CostLine = { module: string; runs: string; estimateUsd: number; capUsd: number; providers: string[]; cancel: string };

const r2 = (x: number) => Math.round(x * 100) / 100;

export function costMatrix(): CostLine[] {
  const cancel = "gh run cancel <id> · concurrencia 1 por módulo · maxCostUsd por llamada · variable MYSTERY_SHOPPER_REAL_ENABLED=0 apaga todo";
  const audio = 4 * (800 / 1000 * RATES.elevenLabsUsdPer1kChars + RATES.scriptUsdPerRun);
  const yt = 1800 / 1000 * RATES.elevenLabsUsdPer1kChars + 12 * RATES.recraftUsdPerImage + 5 * RATES.runwayUsdPerSecond + RATES.scriptUsdPerRun;
  const reel = 450 / 1000 * RATES.elevenLabsUsdPer1kChars + 6 * RATES.recraftUsdPerImage + 5 * RATES.runwayUsdPerSecond + RATES.scriptUsdPerRun;
  const vpod = 60 * RATES.heygenUsdPerSecond + 800 / 1000 * RATES.elevenLabsUsdPer1kChars + RATES.scriptUsdPerRun;
  return [
    { module: "Audio Podcast Studio", runs: "4 episodios de ~1 min: 1 y 2 voces, M/F, ES/EN (V4 Turbo solo si la cuenta lo expone)", estimateUsd: r2(audio), capUsd: 1, providers: ["ElevenLabs", "modelo de guion"], cancel },
    { module: "YouTube Studio", runs: "1 video de ~2 min: guion, 12 imágenes, 1 clip de 5 s, narración, música de biblioteca, MP4", estimateUsd: r2(yt), capUsd: 2, providers: ["ElevenLabs", "Recraft", "Runway", "modelo de guion"], cancel },
    { module: "Reels Studio", runs: "1 Reel de 30 s 9:16 con subtítulos y música de biblioteca", estimateUsd: r2(reel), capUsd: 1.5, providers: ["ElevenLabs", "Recraft", "Runway", "modelo de guion"], cancel },
    { module: "Podcast audiovisual", runs: "1 episodio de 60 s con 2 avatares (30 s cada uno), lip-sync", estimateUsd: r2(vpod), capUsd: 4, providers: ["HeyGen", "ElevenLabs", "modelo de guion"], cancel },
    { module: "Biblioteca", runs: "Reutiliza los archivos anteriores (guardar, reabrir, reproducir, descargar, archivar)", estimateUsd: 0, capUsd: 0, providers: [], cancel },
    { module: "Sistema comercial", runs: "Créditos y doble clic en modo prueba; Stripe solo en modo test", estimateUsd: 0, capUsd: 0, providers: ["Stripe (test)"], cancel },
    { module: "Smoke horario + recorridos gratuitos", runs: "GitHub Actions (repo público) + navegador; sin proveedores", estimateUsd: 0, capUsd: 0, providers: [], cancel },
  ];
}

export function costTotals(lines = costMatrix()) {
  return { estimateUsd: r2(lines.reduce((a, l) => a + l.estimateUsd, 0)), capUsd: r2(lines.reduce((a, l) => a + l.capUsd, 0)) };
}

/** Guardia de gasto: rechaza cualquier generación si no hay presupuesto aprobado o si superaría el tope. */
export function spendGuard(input: { approvedBudgetUsd: number; spentUsd: number; nextEstimateUsd: number; enabled: boolean }): { ok: boolean; reason: string } {
  if (!input.enabled) return { ok: false, reason: "Modo real apagado (MYSTERY_SHOPPER_REAL_ENABLED≠1)." };
  if (!(input.approvedBudgetUsd > 0)) return { ok: false, reason: "Presupuesto aprobado USD 0." };
  if (input.spentUsd + input.nextEstimateUsd > input.approvedBudgetUsd) return { ok: false, reason: `Superaría el tope: USD ${(input.spentUsd + input.nextEstimateUsd).toFixed(2)} > ${input.approvedBudgetUsd.toFixed(2)}.` };
  return { ok: true, reason: "Dentro del presupuesto aprobado." };
}
